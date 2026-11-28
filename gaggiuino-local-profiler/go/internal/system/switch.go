package system

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines"
)

// This file implements the machine-switch endpoints: GET /api/switch and
// POST /api/switch/toggle — a read/toggle of a machine's HA switch
// entity (?machineId, the default machine when absent, #2202), used by the
// app's "turn the machine on/off" control and by
// glp-integration. Both route through the same ha.Client + registry the
// preheat watcher (poll.go) already uses, so the switch state this reports
// and the one checkAndApplyMachinePower() acts on never diverge.

// getSwitch serves GET /api/switch: `{ configured: false }` when no
// switch_entity is set on the requested machine (default machine without
// ?machineId), otherwise `{ configured: true, entity, state }` where state is
// true/false/null (null = HA unreachable or no token).
func (h *Handlers) getSwitch(w http.ResponseWriter, r *http.Request) {
	entity, ok := h.switchEntityForRequest(w, r)
	if !ok {
		return
	}
	if entity == "" {
		writeJSON(w, http.StatusOK, map[string]any{"configured": false})
		return
	}
	state := h.poller.ha.GetSwitchState(r.Context(), entity) // *bool
	writeJSON(w, http.StatusOK, map[string]any{
		"configured": true,
		"entity":     entity,
		"state":      state,
	})
}

// postSwitchToggle serves POST /api/switch/toggle: flips the switch to the
// opposite of its current state (a null current state — HA unreachable —
// falls through to turn_on). 400 when no token/entity, 500 when the service
// call itself fails.
func (h *Handlers) postSwitchToggle(w http.ResponseWriter, r *http.Request) {
	entity, ok := h.switchEntityForRequest(w, r)
	if !ok {
		return
	}
	if !h.poller.ha.Enabled() || entity == "" {
		writeError(w, http.StatusBadRequest, "switch_entity nicht konfiguriert")
		return
	}
	current := h.poller.ha.GetSwitchState(r.Context(), entity) // *bool, nil = unknown
	on := current != nil && *current
	action := "turn_on"
	if on {
		action = "turn_off"
	}
	if err := h.poller.ha.CallHaService(r.Context(), "switch", action, map[string]any{"entity_id": entity}); err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "state": !on})
}

// switchEntityForRequest resolves the request's ?machineId to that machine's
// HA switch entity (#2202), "" when the machine has none; see
// targetForRequest.
func (h *Handlers) switchEntityForRequest(w http.ResponseWriter, r *http.Request) (string, bool) {
	t, ok := h.targetForRequest(w, r)
	return t.switchEntity, ok
}

// targetForRequest resolves the request's ?machineId to that machine through
// the machine registry (#2202, #2247): the switch, live-data, preheat and
// ready-by routes all read it here. No machineId keeps the default machine
// (glp-integration, the Orders view and older clients call without one). ok
// is false once an error response has been written: 400 for a machineId that
// is not a number, 404 for one that names no machine (never silently the
// default machine), 500 for a registry error.
func (h *Handlers) targetForRequest(w http.ResponseWriter, r *http.Request) (liveTarget, bool) {
	raw := r.URL.Query().Get("machineId")
	if raw == "" {
		return h.poller.defaultTarget(), true
	}
	id, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "Invalid machineId")
		return liveTarget{}, false
	}
	machine, err := h.poller.registry.ResolveMachine(&id)
	if errors.Is(err, machines.ErrUnknownMachine) {
		writeError(w, http.StatusNotFound, "Unknown machine")
		return liveTarget{}, false
	}
	if err != nil {
		internalError(w, err)
		return liveTarget{}, false
	}
	return targetOf(machine), true
}
