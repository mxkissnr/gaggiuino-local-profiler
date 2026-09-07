package machines

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
)

// This file ports routes/system.js's "Machine profiles" section
// (GET /api/machine/profiles, POST /api/machine/profile/set,
// GET/POST/PUT/DELETE /api/machine/profile[/{id}]). NOT ported: the
// default-machine special case that reads defaultRuntime.machineStatus
// (lib/poll.js's cache) instead of calling adapter.GetStatus() directly.
// go/internal/system's RuntimeState now exists (#901 Phase 1g) and holds
// that exact cache, but this package doesn't depend on it (system depends
// on machines, not the reverse — see system/doc.go's layering) so wiring
// this optimization in would need this package to accept an optional
// cache-reader callback the way internal/orders now does for its own
// system dependency. Every machine, default or not, still goes through the
// `else` branch here (a live adapter.GetStatus() call) — see doc.go for
// the full rationale; the user-visible difference is one extra round trip
// to the machine on this one endpoint for the default machine
// specifically, not a behavior change to the response shape.

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

	status, err := adapter.GetStatus(r.Context(), machine)
	var currentID *int
	var currentName *string
	if err == nil {
		currentID, currentName = status.ProfileID, status.ProfileName
	} // machine unreachable — profile list can still come from cache, current stays nil

	respond := func(profiles []ProfileSummary, stale bool) {
		options := make([]string, len(profiles))
		optionsRaw := make([]map[string]any, len(profiles))
		for i, p := range profiles {
			options[i] = p.Name
			optionsRaw[i] = map[string]any{"id": p.ID, "name": p.Name, "utility": p.Utility}
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"available":  len(profiles) > 0,
			"stale":      stale,
			"current":    nullOr(currentName),
			"currentId":  nullOrInt(currentID),
			"options":    options,
			"optionsRaw": optionsRaw,
		})
	}

	raw, err := adapter.ListProfiles(r.Context(), machine)
	if err != nil {
		slog.Warn("listing machine profiles failed", "machineId", machine.ID, "err", err)
		cached := h.profilesCache.get(machine.ID)
		respond(cached, true)
		return
	}
	if len(raw) > 0 {
		h.profilesCache.set(machine.ID, raw)
	}
	respond(h.profilesCache.get(machine.ID), len(raw) == 0)
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
		profiles := h.profilesCache.get(machine.ID)
		if len(profiles) == 0 {
			fetched, err := adapter.ListProfiles(r.Context(), machine)
			if err != nil {
				writeError(w, http.StatusInternalServerError, err.Error())
				return
			}
			h.profilesCache.set(machine.ID, fetched)
			profiles = fetched
		}
		var match *ProfileSummary
		for i := range profiles {
			if profiles[i].Name == *body.Option {
				match = &profiles[i]
				break
			}
		}
		if match == nil {
			writeError(w, http.StatusNotFound, "Profile not found: "+*body.Option)
			return
		}
		profileID = match.ID
	}

	if err := adapter.SelectProfile(r.Context(), machine, profileID); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "profileId": profileID})
}

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
	profile, err := adapter.GetProfile(r.Context(), machine, id)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	w.Write(profile)
}

func (h *Handlers) createMachineProfile(w http.ResponseWriter, r *http.Request) {
	rawBody, ok := readRawJSONBody(w, r)
	if !ok {
		return
	}
	// Extract machineId before full decode so we can resolve the machine
	// type and branch: GaggiMate passes raw JSON through unchanged;
	// Gaggiuino goes through ProfileInput/Validate/ToWireProfile.
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
		created, err := adapter.CreateProfile(r.Context(), machine, ProfileInput{RawBody: rawBody})
		if err != nil {
			writeError(w, http.StatusBadGateway, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, created)
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
	created, err := adapter.CreateProfile(r.Context(), machine, in)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, created)
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
	if machine.Type == "gaggimate" {
		if err := validateGaggiMateProfileBody(rawBody); err != nil {
			writeError(w, http.StatusBadRequest, "invalid profile: "+err.Error())
			return
		}
		// Inject the path {id} into the body when the client omitted it —
		// without an id GaggiMate's save creates a duplicate instead of updating.
		rawBody = injectIDIfAbsent(rawBody, pathIDStr(r))
		updated, err := adapter.UpdateProfile(r.Context(), machine, ProfileInput{RawBody: rawBody})
		if err != nil {
			writeError(w, http.StatusBadGateway, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, updated)
		return
	}
	// Gaggiuino: numeric path ID used as the canonical profile ID.
	pathId, ok := pathID64(r)
	if !ok {
		writeError(w, http.StatusBadGateway, "invalid profile id")
		return
	}
	var in ProfileInput
	if err := json.Unmarshal(rawBody, &in); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return
	}
	in.ID = &pathId
	if err := in.Validate(); err != nil {
		writeError(w, http.StatusBadRequest, "invalid profile: "+err.Error())
		return
	}
	updated, err := adapter.UpdateProfile(r.Context(), machine, in)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, updated)
}

func (h *Handlers) deleteMachineProfile(w http.ResponseWriter, r *http.Request) {
	id := pathIDStr(r)
	if id == "" {
		writeError(w, http.StatusBadGateway, "invalid profile id")
		return
	}
	// Best-effort, non-failing body read: a body-less DELETE (or one with a
	// malformed body) is common and must not itself error out — Node's
	// req.body?.machineId ?? req.query.machineId falls through to the query
	// param the same way on any body that doesn't parse.
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
	remaining, err := adapter.DeleteProfile(r.Context(), machine, id)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "remaining": remaining})
}
