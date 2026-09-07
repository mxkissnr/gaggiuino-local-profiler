package system

import "net/http"

// This file ports routes/system.js's machine-switch endpoints (Phase 2a,
// #901): GET /api/switch and POST /api/switch/toggle — a read/toggle of the
// default machine's HA switch entity, used by the app's "turn the machine
// on/off" control and by glp-integration. Both route through the same
// ha.Client + registry the preheat watcher (poll.go) already uses, so the
// switch state this reports and the one checkAndApplyMachinePower() acts on
// never diverge.

// getSwitch ports GET /api/switch: `{ configured: false }` when no
// switch_entity is set on the default machine, otherwise `{ configured:
// true, entity, state }` where state is true/false/null (null = HA
// unreachable or no token, matching getSwitchState's null return).
func (h *Handlers) getSwitch(w http.ResponseWriter, r *http.Request) {
	entity := h.poller.defaultSwitchEntity()
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

// postSwitchToggle ports POST /api/switch/toggle: flips the switch to the
// opposite of its current state (a null current state — HA unreachable —
// falls through to turn_on, exactly like `current ? 'turn_off' :
// 'turn_on'` with a null current). 400 when no token/entity, 500 when the
// service call itself fails.
func (h *Handlers) postSwitchToggle(w http.ResponseWriter, r *http.Request) {
	entity := h.poller.defaultSwitchEntity()
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
