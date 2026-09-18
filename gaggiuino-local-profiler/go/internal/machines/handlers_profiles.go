package machines

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"time"
)

// profileLiveFetchTimeout bounds every live GetStatus/ListProfiles/GetProfile
// call in this file — matches system/handlers.go's machineStatusProbeTimeout.
// Without it, an unreachable machine (e.g. gaggimate.local's mDNS name not
// resolving) blocks on the OS resolver's own multi-retry timeout (tens of
// seconds, observed hanging past 60s in the wild) before the offline
// local-cache fallback below ever gets a chance to run — turning what's
// supposed to be an instant "stale" response into an apparent total outage.
const profileLiveFetchTimeout = 5 * time.Second

// This file ports routes/system.js's "Machine profiles" section
// (GET /api/machine/profiles, POST /api/machine/profile/set,
// GET/POST/PUT/DELETE /api/machine/profile[/{id}]).
//
// 2026-09-09 offline-editor rework: every write (create/update/delete) now
// lands in ProfilesRepository FIRST — a local SQLite table, so it can never
// fail just because the machine is unreachable — then attempts a live push
// opportunistically. On push failure the row stays dirty/pending_* and the
// HTTP response is still 200 (with syncStatus reflecting that), not the old
// hard 502; only a genuine validation error (400) or unsupported-capability
// error (501) is still a real failure. getMachineProfile also gained an
// offline fallback it never had before (see its own comment below —
// opening the editor for an existing profile was completely broken
// offline, not just saving).
//
// setMachineProfile (select the machine's active profile) is deliberately
// NOT changed — it switches what the physical machine is brewing with
// right now, which has no meaningful offline/local-first equivalent.

func (h *Handlers) registerProfileRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/machine/profiles", h.listMachineProfiles)
	mux.HandleFunc("POST /api/machine/profile/set", h.setMachineProfile)
	mux.HandleFunc("GET /api/machine/profile/{id}", h.getMachineProfile)
	mux.HandleFunc("POST /api/machine/profile", h.createMachineProfile)
	mux.HandleFunc("PUT /api/machine/profile/{id}", h.updateMachineProfile)
	mux.HandleFunc("DELETE /api/machine/profile/{id}", h.deleteMachineProfile)
}

func (h *Handlers) listMachineProfiles(w http.ResponseWriter, r *http.Request) {
	machine, adapter, ok := h.resolveWithAdapter(w, queryMachineID(r))
	if !ok {
		return
	}

	liveCtx, cancel := context.WithTimeout(r.Context(), profileLiveFetchTimeout)
	defer cancel()

	status, err := adapter.GetStatus(liveCtx, machine)
	var currentID *int
	var currentName *string
	if err == nil {
		currentID, currentName = status.ProfileID, status.ProfileName
	} // machine unreachable — profile list can still come from the local cache, current stays nil

	respond := func(rows []ProfileRow, stale bool) {
		options := make([]string, len(rows))
		optionsRaw := make([]map[string]any, len(rows))
		for i, row := range rows {
			options[i] = row.Name
			optionsRaw[i] = map[string]any{
				"id": row.PublicID(), "name": row.Name, "utility": row.Utility,
				"syncStatus": row.SyncStatus,
			}
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"available":  len(rows) > 0,
			"stale":      stale,
			"current":    nullOr(currentName),
			"currentId":  nullOrInt(currentID),
			"options":    options,
			"optionsRaw": optionsRaw,
		})
	}

	raw, err := adapter.ListProfiles(liveCtx, machine)
	if err != nil {
		slog.Warn("listing machine profiles failed", "machineId", machine.ID, "err", err)
		cached, lerr := h.profilesRepo.ListByMachine(machine.ID)
		if lerr != nil {
			internalError(w, lerr)
			return
		}
		respond(cached, true)
		return
	}
	// Reconcile: every profile the machine currently reports gets a local
	// row (summary only — ListProfiles never carries the full body, see
	// UpsertListSummary's own doc comment for why `data` isn't touched here).
	remoteIDs := make([]string, len(raw))
	for i, p := range raw {
		if err := h.profilesRepo.UpsertListSummary(machine.ID, p.ID, p.Name, p.Utility); err != nil {
			slog.Warn("reconciling local profile list failed", "machineId", machine.ID, "profileId", p.ID, "err", err)
		}
		remoteIDs[i] = p.ID
	}
	if err := h.profilesRepo.PruneStaleSynced(machine.ID, remoteIDs); err != nil {
		slog.Warn("pruning stale local profiles failed", "machineId", machine.ID, "err", err)
	}
	cached, err := h.profilesRepo.ListByMachine(machine.ID)
	if err != nil {
		internalError(w, err)
		return
	}
	respond(cached, len(raw) == 0)
}

func nullOrInt(n *int) any {
	if n == nil {
		return nil
	}
	return *n
}

func (h *Handlers) setMachineProfile(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Option    *string         `json:"option"`
		IDRaw     json.RawMessage `json:"id"`
		MachineID *int64          `json:"machineId"`
	}
	if !decodeJSONBody(w, r, &body) {
		return
	}
	if body.Option == nil && body.IDRaw == nil {
		writeError(w, http.StatusBadRequest, "option or id required")
		return
	}
	machine, adapter, ok := h.resolveWithAdapter(w, body.MachineID)
	if !ok {
		return
	}

	var profileID string
	if body.IDRaw != nil {
		profileID = jsonRawToProfileID(body.IDRaw)
	} else {
		rows, err := h.profilesRepo.ListByMachine(machine.ID)
		if err != nil {
			internalError(w, err)
			return
		}
		if len(rows) == 0 {
			fetched, err := adapter.ListProfiles(r.Context(), machine)
			if err != nil {
				writeError(w, http.StatusInternalServerError, err.Error())
				return
			}
			for _, p := range fetched {
				_ = h.profilesRepo.UpsertListSummary(machine.ID, p.ID, p.Name, p.Utility)
			}
			rows, err = h.profilesRepo.ListByMachine(machine.ID)
			if err != nil {
				internalError(w, err)
				return
			}
		}
		var match *ProfileRow
		for i := range rows {
			if rows[i].Name == *body.Option {
				match = &rows[i]
				break
			}
		}
		if match == nil {
			writeError(w, http.StatusNotFound, "Profile not found: "+*body.Option)
			return
		}
		profileID = match.PublicID()
	}

	if _, isLocal := parseLocalPlaceholder(profileID); isLocal {
		writeError(w, http.StatusConflict, "profile has not synced to the machine yet")
		return
	}
	if err := adapter.SelectProfile(r.Context(), machine, profileID); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "profileId": profileID})
}

// getMachineProfile: previously hard-502'd on any adapter error with no
// fallback whatsoever — opening the editor for an existing profile was
// completely broken while the machine was unreachable, not just saving one.
// Now falls back to the local row's stored body.
func (h *Handlers) getMachineProfile(w http.ResponseWriter, r *http.Request) {
	id := pathIDStr(r)
	if id == "" {
		writeError(w, http.StatusBadGateway, "invalid profile id")
		return
	}
	machine, adapter, ok := h.resolveWithAdapter(w, queryMachineID(r))
	if !ok {
		return
	}

	if _, isLocal := parseLocalPlaceholder(id); isLocal {
		// A profile that's never synced to the machine only exists locally
		// — there's nothing to fetch live for it at all.
		row, err := h.profilesRepo.Get(machine.ID, id)
		if err != nil {
			internalError(w, err)
			return
		}
		if row == nil {
			writeError(w, http.StatusNotFound, "profile not found")
			return
		}
		writeRawProfile(w, row.Data)
		return
	}

	liveCtx, cancel := context.WithTimeout(r.Context(), profileLiveFetchTimeout)
	defer cancel()
	profile, err := adapter.GetProfile(liveCtx, machine, id)
	if err != nil {
		slog.Warn("fetching machine profile failed, falling back to local copy", "machineId", machine.ID, "profileId", id, "err", err)
		row, lerr := h.profilesRepo.Get(machine.ID, id)
		if lerr != nil {
			internalError(w, lerr)
			return
		}
		if row == nil {
			writeError(w, http.StatusBadGateway, err.Error())
			return
		}
		writeRawProfile(w, row.Data)
		return
	}
	if name := profileName(machine.Type, profile); name != "" {
		if err := h.profilesRepo.UpsertSynced(machine.ID, id, name, profile, false); err != nil {
			slog.Warn("caching fetched profile locally failed", "machineId", machine.ID, "profileId", id, "err", err)
		}
	}
	writeRawProfile(w, profile)
}

func writeRawProfile(w http.ResponseWriter, body json.RawMessage) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	w.Write(body)
}

// profileName extracts the display name out of a raw profile body —
// GaggiMate uses "label", Gaggiuino uses "name".
func profileName(machineType string, raw json.RawMessage) string {
	var body map[string]any
	if err := json.Unmarshal(raw, &body); err != nil {
		return ""
	}
	key := "name"
	if machineType == "gaggimate" {
		key = "label"
	}
	name, _ := body[key].(string)
	return name
}

func (h *Handlers) createMachineProfile(w http.ResponseWriter, r *http.Request) {
	rawBody, ok := readRawJSONBody(w, r)
	if !ok {
		return
	}
	var mid struct {
		MachineID *int64 `json:"machineId"`
	}
	_ = json.Unmarshal(rawBody, &mid)
	machine, adapter, ok := h.resolveWithAdapter(w, mid.MachineID)
	if !ok {
		return
	}
	if !requireProfileEditSupport(w, adapter, machine) {
		return
	}

	if machine.Type == "gaggimate" {
		if err := validateGaggiMateProfileBody(rawBody); err != nil {
			writeError(w, http.StatusBadRequest, "invalid profile: "+err.Error())
			return
		}
		name := profileName("gaggimate", rawBody)
		row, err := h.profilesRepo.UpsertDirty(machine.ID, nil, nil, name, rawBody)
		if err != nil {
			internalError(w, err)
			return
		}
		created, err := adapter.CreateProfile(r.Context(), machine, ProfileInput{RawBody: rawBody})
		if err != nil {
			slog.Warn("creating machine profile failed, saved locally instead", "machineId", machine.ID, "err", err)
			_ = h.profilesRepo.MarkSyncError(row.LocalID, err.Error())
			writeJSON(w, http.StatusOK, map[string]any{"id": row.PublicID(), "name": row.Name, "utility": false, "syncStatus": row.SyncStatus})
			return
		}
		if err := h.profilesRepo.ReplaceRemoteID(row.LocalID, created.ID, created.Name); err != nil {
			internalError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"id": created.ID, "name": created.Name, "utility": created.Utility, "syncStatus": ProfileSyncSynced})
		return
	}

	var in ProfileInput
	if err := json.Unmarshal(rawBody, &in); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return
	}
	if err := in.Validate(); err != nil {
		writeError(w, http.StatusBadRequest, "invalid profile: "+err.Error())
		return
	}
	row, err := h.profilesRepo.UpsertDirty(machine.ID, nil, nil, in.Name, rawBody)
	if err != nil {
		internalError(w, err)
		return
	}
	created, err := adapter.CreateProfile(r.Context(), machine, in)
	if err != nil {
		slog.Warn("creating machine profile failed, saved locally instead", "machineId", machine.ID, "err", err)
		_ = h.profilesRepo.MarkSyncError(row.LocalID, err.Error())
		writeJSON(w, http.StatusOK, map[string]any{"id": row.PublicID(), "name": row.Name, "utility": false, "syncStatus": row.SyncStatus})
		return
	}
	if err := h.profilesRepo.ReplaceRemoteID(row.LocalID, created.ID, created.Name); err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": created.ID, "name": created.Name, "utility": created.Utility, "syncStatus": ProfileSyncSynced})
}

func (h *Handlers) updateMachineProfile(w http.ResponseWriter, r *http.Request) {
	rawBody, ok := readRawJSONBody(w, r)
	if !ok {
		return
	}
	var mid struct {
		MachineID *int64 `json:"machineId"`
	}
	_ = json.Unmarshal(rawBody, &mid)
	machine, adapter, ok := h.resolveWithAdapter(w, mid.MachineID)
	if !ok {
		return
	}
	if !requireProfileEditSupport(w, adapter, machine) {
		return
	}

	pathID := pathIDStr(r)
	existing, err := h.profilesRepo.Get(machine.ID, pathID)
	if err != nil {
		internalError(w, err)
		return
	}
	var localID *int64
	var remoteID *string
	if existing != nil {
		localID = &existing.LocalID
		remoteID = existing.RemoteID
	} else if _, isLocal := parseLocalPlaceholder(pathID); isLocal {
		// local:<n> placeholder not found in our DB → the profile never existed;
		// return 404 rather than silently creating an unrelated pending_create row.
		writeError(w, http.StatusNotFound, "profile not found")
		return
	} else {
		// pathID is a real machine-assigned remote id that was never locally
		// cached (e.g. it existed before the offline-editor feature shipped)
		// — without this, UpsertDirty below sees remoteID == nil and treats
		// this as a brand-new profile (pending_create), so the next sync
		// creates a duplicate on the machine instead of updating this one.
		remoteIDVal := pathID
		remoteID = &remoteIDVal
	}

	if machine.Type == "gaggimate" {
		if err := validateGaggiMateProfileBody(rawBody); err != nil {
			writeError(w, http.StatusBadRequest, "invalid profile: "+err.Error())
			return
		}
		name := profileName("gaggimate", rawBody)
		row, err := h.profilesRepo.UpsertDirty(machine.ID, localID, remoteID, name, rawBody)
		if err != nil {
			internalError(w, err)
			return
		}
		if row.RemoteID == nil {
			// Never made it to the machine yet — nothing to PUT; the next
			// sync sweep will CreateProfile it instead once reachable.
			writeJSON(w, http.StatusOK, map[string]any{"id": row.PublicID(), "name": row.Name, "utility": false, "syncStatus": row.SyncStatus})
			return
		}
		// Inject the id into the body when the client omitted it — without
		// one GaggiMate's save creates a duplicate instead of updating.
		pushBody := InjectIDIfAbsent(rawBody, *row.RemoteID)
		updated, err := adapter.UpdateProfile(r.Context(), machine, ProfileInput{RawBody: pushBody})
		if err != nil {
			slog.Warn("updating machine profile failed, saved locally instead", "machineId", machine.ID, "profileId", *row.RemoteID, "err", err)
			_ = h.profilesRepo.MarkSyncError(row.LocalID, err.Error())
			writeJSON(w, http.StatusOK, map[string]any{"id": row.PublicID(), "name": row.Name, "utility": false, "syncStatus": row.SyncStatus})
			return
		}
		if err := h.profilesRepo.MarkSynced(row.LocalID); err != nil {
			internalError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"id": updated.ID, "name": updated.Name, "utility": updated.Utility, "syncStatus": ProfileSyncSynced})
		return
	}

	// Gaggiuino: if this is still a local:N placeholder (pending_create, never
	// pushed to the machine), validate and save locally — the sync sweep will
	// create it on the remote side later. pathID64 would fail on "local:N".
	if _, isLocal := parseLocalPlaceholder(pathID); isLocal {
		var in ProfileInput
		if err := json.Unmarshal(rawBody, &in); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
			return
		}
		if err := in.Validate(); err != nil {
			writeError(w, http.StatusBadRequest, "invalid profile: "+err.Error())
			return
		}
		row, err := h.profilesRepo.UpsertDirty(machine.ID, localID, remoteID, in.Name, rawBody)
		if err != nil {
			internalError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"id": row.PublicID(), "name": row.Name, "utility": false, "syncStatus": row.SyncStatus})
		return
	}

	// Gaggiuino: numeric path ID used as the canonical profile ID.
	numericID, ok := pathID64(r)
	if !ok {
		writeError(w, http.StatusBadGateway, "invalid profile id")
		return
	}
	var in ProfileInput
	if err := json.Unmarshal(rawBody, &in); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return
	}
	in.ID = &numericID
	if err := in.Validate(); err != nil {
		writeError(w, http.StatusBadRequest, "invalid profile: "+err.Error())
		return
	}
	row, err := h.profilesRepo.UpsertDirty(machine.ID, localID, remoteID, in.Name, rawBody)
	if err != nil {
		internalError(w, err)
		return
	}
	updated, err := adapter.UpdateProfile(r.Context(), machine, in)
	if err != nil {
		slog.Warn("updating machine profile failed, saved locally instead", "machineId", machine.ID, "profileId", numericID, "err", err)
		_ = h.profilesRepo.MarkSyncError(row.LocalID, err.Error())
		writeJSON(w, http.StatusOK, map[string]any{"id": row.PublicID(), "name": row.Name, "utility": false, "syncStatus": row.SyncStatus})
		return
	}
	if err := h.profilesRepo.MarkSynced(row.LocalID); err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": updated.ID, "name": updated.Name, "utility": updated.Utility, "syncStatus": ProfileSyncSynced})
}

func (h *Handlers) deleteMachineProfile(w http.ResponseWriter, r *http.Request) {
	id := pathIDStr(r)
	if id == "" {
		writeError(w, http.StatusBadGateway, "invalid profile id")
		return
	}
	// Best-effort, non-failing body read: a body-less DELETE (or one with a
	// malformed body) is common and must not itself error out.
	var body struct {
		MachineID *int64 `json:"machineId"`
	}
	if raw, err := io.ReadAll(io.LimitReader(r.Body, jsonBodyLimit)); err == nil && len(raw) > 0 {
		_ = json.Unmarshal(raw, &body)
	}
	machineID := body.MachineID
	if machineID == nil {
		machineID = queryMachineID(r)
	}
	machine, adapter, ok := h.resolveWithAdapter(w, machineID)
	if !ok {
		return
	}
	if !requireProfileEditSupport(w, adapter, machine) {
		return
	}

	row, err := h.profilesRepo.Get(machine.ID, id)
	if err != nil {
		internalError(w, err)
		return
	}
	if row == nil {
		writeError(w, http.StatusNotFound, "profile not found")
		return
	}
	wasRemoteID := row.RemoteID
	if err := h.profilesRepo.MarkPendingDelete(machine.ID, id); err != nil {
		internalError(w, err)
		return
	}
	if wasRemoteID == nil {
		// Never synced — MarkPendingDelete already hard-deleted the local
		// row, nothing to push remotely.
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "syncStatus": "deleted"})
		return
	}
	remaining, err := adapter.DeleteProfile(r.Context(), machine, *wasRemoteID)
	if err != nil {
		slog.Warn("deleting machine profile failed, queued for later", "machineId", machine.ID, "profileId", *wasRemoteID, "err", err)
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "syncStatus": ProfileSyncPendingDelete})
		return
	}
	if err := h.profilesRepo.HardDelete(row.LocalID); err != nil {
		internalError(w, err)
		return
	}
	for _, p := range remaining {
		_ = h.profilesRepo.UpsertListSummary(machine.ID, p.ID, p.Name, p.Utility)
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "remaining": remaining, "syncStatus": "deleted"})
}
