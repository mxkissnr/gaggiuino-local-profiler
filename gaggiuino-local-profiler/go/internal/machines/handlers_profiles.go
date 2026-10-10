package machines

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/httputil"
)

// profileLiveFetchTimeout bounds every live GetStatus/ListProfiles/GetProfile
// call in this file — matches system/handlers.go's machineStatusProbeTimeout.
// Without it, an unreachable machine (e.g. gaggimate.local's mDNS name not
// resolving) blocks on the OS resolver's own multi-retry timeout (tens of
// seconds, observed hanging past 60s in the wild) before the offline
// local-cache fallback below ever gets a chance to run — turning what's
// supposed to be an instant "stale" response into an apparent total outage.
const profileLiveFetchTimeout = 5 * time.Second

// profileLiveWriteTimeout bounds every live SelectProfile/CreateProfile/
// UpdateProfile/DeleteProfile call in this file — and, via its own local copy,
// the background sweep in system/profile_sync.go. A var, not a const, so a test
// can shrink it. A write gets twice the read budget: pushing a full profile
// body to a busy machine can legitimately take longer than a status fetch.
var profileLiveWriteTimeout = 10 * time.Second

// This file is the "Machine profiles" section
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

// profileCurrent is the last live-observed state of one machine's profile list:
// the current profile the machine reported (either field may be nil) and a
// fingerprint of the rows it came with. An entry in Handlers.profilesCurrent
// therefore means "this machine has been read live at least once", which is what
// lets a later GET answer from the local cache at once.
type profileCurrent struct {
	currentID   *int
	currentName *string
	fingerprint string
}

// liveProfiles is the result of one live profile fetch (fetchProfilesLive).
type liveProfiles struct {
	rows        []ProfileRow
	currentID   *int
	currentName *string
	// statused is true when the live GetStatus call succeeded, so currentID/
	// currentName are the machine's own current profile (possibly nil).
	statused bool
	// listed is true when the live ListProfiles call succeeded, so rows reflect
	// the machine's list (after the local reconcile).
	listed bool
	// stale mirrors the response's stale flag: the list could not be read, or
	// the machine reported no profiles at all.
	stale bool
}

func (h *Handlers) listMachineProfiles(w http.ResponseWriter, r *http.Request) {
	machine, adapter, ok := h.resolveWithAdapter(w, queryMachineID(r))
	if !ok {
		return
	}

	respond := func(rows []ProfileRow, stale bool, currentID *int, currentName *string) {
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

	// #1572: when the poller already knows this machine is unreachable, serve
	// the local cache right away — same shape as the post-failure fallback
	// below (cached rows, stale: true, no current profile) — instead of paying
	// the live GetStatus/ListProfiles timeouts. Reachable or unknown machines
	// fall through.
	if h.machineKnownOffline(machine.ID) {
		cached, err := h.profilesRepo.ListByMachine(machine.ID)
		if err != nil {
			internalError(w, err)
			return
		}
		respond(cached, true, nil, nil)
		return
	}

	// #1539 slice 5 — cache-first: once this machine's list has been read live
	// at least once (a remembered current exists) and the local cache still has
	// rows, answer from the cache immediately (stale: false) instead of paying
	// the live timeouts again, then refresh in the background so a machine-side
	// change still lands. Before the first successful live read there is
	// nothing to serve from, so the request takes the live path below and
	// remembers what it sees.
	if current, ok := h.rememberedProfilesCurrent(machine.ID); ok {
		cached, err := h.profilesRepo.ListByMachine(machine.ID)
		if err != nil {
			internalError(w, err)
			return
		}
		if len(cached) > 0 {
			respond(cached, false, current.currentID, current.currentName)
			h.refreshProfilesAsync(machine, adapter)
			return
		}
	}

	res, err := h.fetchProfilesLive(r.Context(), machine, adapter)
	if err != nil {
		internalError(w, err)
		return
	}
	if res.statused {
		h.rememberProfilesCurrent(machine.ID, res.currentID, res.currentName, res.rows)
	}
	respond(res.rows, res.stale, res.currentID, res.currentName)
}

// fetchProfilesLive runs the live half of the profiles list: one bounded
// GetStatus (best-effort current) and one bounded ListProfiles, reconciling the
// local cache with the machine's list and pruning rows the machine no longer
// reports. It returns the rows to serve and whether each live call succeeded, so
// both the synchronous handler and the background refresh share exactly one
// implementation. A non-nil error means the local cache itself could not be
// read.
func (h *Handlers) fetchProfilesLive(ctx context.Context, machine *Machine, adapter Adapter) (liveProfiles, error) {
	liveCtx, cancel := context.WithTimeout(ctx, profileLiveFetchTimeout)
	defer cancel()

	var out liveProfiles
	status, serr := adapter.GetStatus(liveCtx, machine)
	if serr == nil {
		out.statused, out.currentID, out.currentName = true, status.ProfileID, status.ProfileName
	} // machine unreachable — profile list can still come from the local cache, current stays nil

	raw, lerr := adapter.ListProfiles(liveCtx, machine)
	if lerr != nil {
		slog.Warn("listing machine profiles failed", "machineId", machine.ID, "err", lerr)
		cached, cerr := h.profilesRepo.ListByMachine(machine.ID)
		if cerr != nil {
			return liveProfiles{}, cerr
		}
		out.rows, out.stale = cached, true
		return out, nil
	}
	out.listed = true
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
	cached, cerr := h.profilesRepo.ListByMachine(machine.ID)
	if cerr != nil {
		return liveProfiles{}, cerr
	}
	out.rows, out.stale = cached, len(raw) == 0
	return out, nil
}

// refreshProfilesAsync refreshes a machine's cached list in the background
// after a cache-first response, so the request that just returned instantly
// still converges on the machine's current list. Single-flight per machine: a
// refresh already in flight makes this a no-op (it reads the same live state).
// The context is background, not the request's — the request has already
// returned — bounded by the same profile live timeout as the synchronous path.
func (h *Handlers) refreshProfilesAsync(machine *Machine, adapter Adapter) {
	h.profilesMu.Lock()
	if h.profilesRefreshing == nil {
		h.profilesRefreshing = map[int64]bool{}
	}
	if h.profilesRefreshing[machine.ID] {
		h.profilesMu.Unlock()
		return
	}
	h.profilesRefreshing[machine.ID] = true
	h.profilesMu.Unlock()

	httputil.SafeGo("machines.profiles-refresh", func() {
		defer func() {
			h.profilesMu.Lock()
			delete(h.profilesRefreshing, machine.ID)
			h.profilesMu.Unlock()
		}()

		ctx, cancel := context.WithTimeout(context.Background(), profileLiveFetchTimeout)
		defer cancel()
		res, err := h.fetchProfilesLive(ctx, machine, adapter)
		if err != nil || !res.listed {
			// The live list could not be read: drop the remembered current so
			// the next GET goes live again, and tell open pages to refetch —
			// their cache-first answer may be showing a machine that has since
			// gone away.
			h.forgetProfilesCurrent(machine.ID)
			h.notifyProfilesChanged(machine.ID)
			return
		}
		if h.updateProfilesCurrent(machine.ID, res.statused, res.currentID, res.currentName, res.rows) {
			h.notifyProfilesChanged(machine.ID)
		}
	})
}

// rememberedProfilesCurrent returns the remembered live state for a machine and
// whether it exists. Existence, not a non-nil current profile, is the signal: a
// machine that has been read live once is cache-first even if it reports no
// active profile.
func (h *Handlers) rememberedProfilesCurrent(machineID int64) (profileCurrent, bool) {
	h.profilesMu.Lock()
	defer h.profilesMu.Unlock()
	current, ok := h.profilesCurrent[machineID]
	return current, ok
}

// rememberProfilesCurrent stores the current profile a successful live read
// observed, together with a fingerprint of the rows it came with.
func (h *Handlers) rememberProfilesCurrent(machineID int64, currentID *int, currentName *string, rows []ProfileRow) {
	h.profilesMu.Lock()
	defer h.profilesMu.Unlock()
	if h.profilesCurrent == nil {
		h.profilesCurrent = map[int64]profileCurrent{}
	}
	h.profilesCurrent[machineID] = profileCurrent{
		currentID:   currentID,
		currentName: currentName,
		fingerprint: profileRowsFingerprint(rows, currentID),
	}
}

// updateProfilesCurrent stores a freshly refreshed state and reports whether the
// rendered fingerprint changed since the last remembered one. When the refresh
// could not read the machine's status (statused false) the previously
// remembered current is kept rather than being clobbered with nil — a transient
// status failure must not make the list look like it has no active profile.
func (h *Handlers) updateProfilesCurrent(machineID int64, statused bool, currentID *int, currentName *string, rows []ProfileRow) bool {
	h.profilesMu.Lock()
	defer h.profilesMu.Unlock()
	prev, had := h.profilesCurrent[machineID]
	if !statused && had {
		currentID, currentName = prev.currentID, prev.currentName
	}
	next := profileCurrent{
		currentID:   currentID,
		currentName: currentName,
		fingerprint: profileRowsFingerprint(rows, currentID),
	}
	if had && prev.fingerprint == next.fingerprint {
		return false
	}
	if h.profilesCurrent == nil {
		h.profilesCurrent = map[int64]profileCurrent{}
	}
	h.profilesCurrent[machineID] = next
	return true
}

// forgetProfilesCurrent drops a machine's remembered current so the next GET
// goes live again — after a profile was just selected (setMachineProfile), or
// after a background refresh found the machine unreachable.
func (h *Handlers) forgetProfilesCurrent(machineID int64) {
	h.profilesMu.Lock()
	defer h.profilesMu.Unlock()
	delete(h.profilesCurrent, machineID)
}

// profileRowsFingerprint is a stable hash of everything a client renders from a
// machine's profile list — each row's public id, name, utility and sync status,
// plus the current profile's id — so a background refresh notifies only when
// something actually visible changed. Rows are already ordered by the
// repository's ListByMachine query.
func profileRowsFingerprint(rows []ProfileRow, currentID *int) string {
	var b strings.Builder
	for _, row := range rows {
		fmt.Fprintf(&b, "%s\x00%s\x00%t\x00%s\x1f", row.PublicID(), row.Name, row.Utility, row.SyncStatus)
	}
	if currentID != nil {
		fmt.Fprintf(&b, "cur:%d", *currentID)
	}
	return b.String()
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
	selectCtx, cancel := context.WithTimeout(r.Context(), profileLiveWriteTimeout)
	err := adapter.SelectProfile(selectCtx, machine, profileID)
	cancel()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	// #1539 slice 5: the machine's active profile just changed, so the
	// remembered current is stale — forget it so the next GET reads live and
	// reflects the selection, instead of the cache-first path flipping the
	// caller's choice back to the old current (the HA profile select).
	h.forgetProfilesCurrent(machine.ID)
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

// notifyProfileSaved runs the onProfileSaved hook (if wired) after a profile
// create or update has fully succeeded. It is synchronous and best-effort by
// design: the hook is a single achievements DB pass, and its outcome must
// never change the response the save already earned.
func (h *Handlers) notifyProfileSaved(action string) {
	if h.onProfileSaved != nil {
		h.onProfileSaved(action)
	}
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

	// Serialize the local write + live push against the background sweep
	// (system.Poller.PushDirtyProfiles): both take the same per-machine lock
	// from the repository, so a sweep can't push this same pending row (and
	// leave a duplicate on the machine) while this handler is mid-flight.
	mu := h.profilesRepo.MachineLock(machine.ID)
	mu.Lock()
	defer mu.Unlock()

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
		createCtx, cancel := context.WithTimeout(r.Context(), profileLiveWriteTimeout)
		created, err := adapter.CreateProfile(createCtx, machine, ProfileInput{RawBody: rawBody})
		cancel()
		if err != nil {
			slog.Warn("creating machine profile failed, saved locally instead", "machineId", machine.ID, "err", err)
			if merr := h.profilesRepo.MarkSyncError(row.LocalID, err.Error()); merr != nil {
				slog.Warn("recording profile sync error also failed", "localId", row.LocalID, "err", merr)
			}
			writeJSON(w, http.StatusOK, map[string]any{"id": row.PublicID(), "name": row.Name, "utility": false, "syncStatus": row.SyncStatus})
			return
		}
		if err := h.profilesRepo.ReplaceRemoteID(row.LocalID, row.UpdatedAt, created.ID, created.Name); err != nil {
			internalError(w, err)
			return
		}
		h.notifyProfileSaved("create")
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
	createCtx, cancel := context.WithTimeout(r.Context(), profileLiveWriteTimeout)
	created, err := adapter.CreateProfile(createCtx, machine, in)
	cancel()
	if err != nil {
		slog.Warn("creating machine profile failed, saved locally instead", "machineId", machine.ID, "err", err)
		if merr := h.profilesRepo.MarkSyncError(row.LocalID, err.Error()); merr != nil {
			slog.Warn("recording profile sync error also failed", "localId", row.LocalID, "err", merr)
		}
		writeJSON(w, http.StatusOK, map[string]any{"id": row.PublicID(), "name": row.Name, "utility": false, "syncStatus": row.SyncStatus})
		return
	}
	if err := h.profilesRepo.ReplaceRemoteID(row.LocalID, row.UpdatedAt, created.ID, created.Name); err != nil {
		internalError(w, err)
		return
	}
	h.notifyProfileSaved("create")
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

	// Same per-machine lock as createMachineProfile (and the sweep) — see its
	// comment for why the handlers and PushDirtyProfiles must share it.
	mu := h.profilesRepo.MachineLock(machine.ID)
	mu.Lock()
	defer mu.Unlock()

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
		updateCtx, cancel := context.WithTimeout(r.Context(), profileLiveWriteTimeout)
		updated, err := adapter.UpdateProfile(updateCtx, machine, ProfileInput{RawBody: pushBody})
		cancel()
		if err != nil {
			slog.Warn("updating machine profile failed, saved locally instead", "machineId", machine.ID, "profileId", *row.RemoteID, "err", err)
			if merr := h.profilesRepo.MarkSyncError(row.LocalID, err.Error()); merr != nil {
				slog.Warn("recording profile sync error also failed", "localId", row.LocalID, "err", merr)
			}
			writeJSON(w, http.StatusOK, map[string]any{"id": row.PublicID(), "name": row.Name, "utility": false, "syncStatus": row.SyncStatus})
			return
		}
		if err := h.profilesRepo.MarkSynced(row.LocalID, row.UpdatedAt); err != nil {
			internalError(w, err)
			return
		}
		h.notifyProfileSaved("update")
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
	updateCtx, cancel := context.WithTimeout(r.Context(), profileLiveWriteTimeout)
	updated, err := adapter.UpdateProfile(updateCtx, machine, in)
	cancel()
	if err != nil {
		slog.Warn("updating machine profile failed, saved locally instead", "machineId", machine.ID, "profileId", numericID, "err", err)
		if merr := h.profilesRepo.MarkSyncError(row.LocalID, err.Error()); merr != nil {
			slog.Warn("recording profile sync error also failed", "localId", row.LocalID, "err", merr)
		}
		writeJSON(w, http.StatusOK, map[string]any{"id": row.PublicID(), "name": row.Name, "utility": false, "syncStatus": row.SyncStatus})
		return
	}
	if err := h.profilesRepo.MarkSynced(row.LocalID, row.UpdatedAt); err != nil {
		internalError(w, err)
		return
	}
	h.notifyProfileSaved("update")
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

	// Same per-machine lock as createMachineProfile (and the sweep) — see its
	// comment for why the handlers and PushDirtyProfiles must share it.
	mu := h.profilesRepo.MachineLock(machine.ID)
	mu.Lock()
	defer mu.Unlock()

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
	deleteCtx, cancel := context.WithTimeout(r.Context(), profileLiveWriteTimeout)
	remaining, err := adapter.DeleteProfile(deleteCtx, machine, *wasRemoteID)
	cancel()
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
