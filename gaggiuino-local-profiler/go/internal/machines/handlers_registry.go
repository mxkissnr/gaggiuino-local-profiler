package machines

import (
	"errors"
	"net/http"
)

// This file ports routes/machines.js: the machine-registry CRUD + probe
// endpoints (#317). NOT ported: the #729/#731 catch-up shot-history sync
// every save/update triggers (syncSoonAfterSave, lib/sync.js) — that's the
// shots-sync domain, which doesn't run as a background process in this Go
// binary yet (see go/README.md's "not wired into a running add-on"
// status). The `?sync=0` query param (#731) is still parsed and accepted
// for request-shape compatibility, but is currently a no-op either way
// since there's no sync to suppress.

func (h *Handlers) registerRegistryRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/machines", h.listMachines)
	mux.HandleFunc("POST /api/machines", h.createMachine)
	mux.HandleFunc("PUT /api/machines/{id}", h.updateMachine)
	mux.HandleFunc("DELETE /api/machines/{id}", h.deleteMachine)
	mux.HandleFunc("POST /api/machines/{id}/default", h.setDefaultMachine)
	mux.HandleFunc("POST /api/machines/{id}/test", h.testMachine)
}

func (h *Handlers) listMachines(w http.ResponseWriter, r *http.Request) {
	if err := h.registry.EnsureDefaultMachine(); err != nil {
		internalError(w, err)
		return
	}
	list, err := h.registry.ListMachines()
	if err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, list)
}

// createMachine ports POST /api/machines — a thin wrapper around
// CreateMachineChecked (create.go), the same validate/SSRF-check/create
// sequence internal/web's "New machine" form also calls.
func (h *Handlers) createMachine(w http.ResponseWriter, r *http.Request) {
	var in MachineInput
	if !decodeJSONBody(w, r, &in) {
		return
	}
	machine, err := CreateMachineChecked(r.Context(), h.registry, in)
	if err != nil {
		var verr *ValidationError
		if errors.As(err, &verr) {
			writeError(w, http.StatusBadRequest, verr.Message)
			return
		}
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, machine)
}

// updateMachine ports routes/machines.js's PUT /api/machines/:id.
//
// #901 code review flagged this handler's up-front GetMachine as a
// "redundant" duplicate of the GetMachine Registry.UpdateMachine already
// does internally, suggesting it be dropped and 404 left to
// UpdateMachine's own not-found return. Verified against the Node
// original (routes/machines.js's own PUT handler) instead of removing it
// blindly: Node does the exact same "redundant" existence check first,
// specifically so an unknown id 404s even when the request body also
// fails schema validation — routes/machines.js:78-82 checks `existing`
// before `machineSchema.partial().safeParse(req.body)`, i.e. 404 always
// wins over 400 for a bad id + bad body. Registry.UpdateMachine's own
// internal GetMachine (registry.go) can't cover that ordering — it only
// runs after this handler has already decoded and validated the body — so
// dropping this check would flip that combination's response from 404 to
// 400, a real behavior change despite the duplicate-looking query. Kept
// as-is; the "redundant" DB round trip is a single indexed lookup by
// primary key, not a meaningful cost.
func (h *Handlers) updateMachine(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID64(r)
	if !ok {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	existing, err := h.registry.GetMachine(id)
	if err != nil {
		internalError(w, err)
		return
	}
	if existing == nil {
		writeError(w, http.StatusNotFound, "not found")
		return
	}

	var in MachineInput
	if !decodeJSONBody(w, r, &in) {
		return
	}
	machine, found, err := UpdateMachineChecked(r.Context(), h.registry, id, in, h.disconnectLiveForHost)
	if err != nil {
		var verr *ValidationError
		if errors.As(err, &verr) {
			writeError(w, http.StatusBadRequest, verr.Message)
			return
		}
		internalError(w, err)
		return
	}
	if !found {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	writeJSON(w, http.StatusOK, machine)
}

func (h *Handlers) deleteMachine(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID64(r)
	if !ok {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	deleted, err := h.registry.DeleteMachine(id, h.disconnectLiveForHost)
	if err != nil {
		if errors.Is(err, ErrCannotDeleteDefault) || errors.Is(err, ErrCannotDeleteLastMachine) {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		internalError(w, err)
		return
	}
	if !deleted {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (h *Handlers) setDefaultMachine(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID64(r)
	if !ok {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	machine, err := h.registry.SetDefaultMachine(id)
	if err != nil {
		internalError(w, err)
		return
	}
	if machine == nil {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	writeJSON(w, http.StatusOK, machine)
}

func (h *Handlers) testMachine(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID64(r)
	if !ok {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	machine, err := h.registry.GetMachine(id)
	if err != nil {
		internalError(w, err)
		return
	}
	if machine == nil {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	adapter, err := h.GetAdapter(machine)
	if err != nil {
		internalError(w, err)
		return
	}
	status, err := adapter.GetStatus(r.Context(), machine)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "reachable": false, "error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "reachable": true, "status": status})
}
