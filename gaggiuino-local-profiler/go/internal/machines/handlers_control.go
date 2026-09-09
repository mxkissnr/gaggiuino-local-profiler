package machines

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sync"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/httputil"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines/proto"
)

// This file ports routes/machine-control.js: the #597 Gaggiuino settings/
// control proxy (settings read/write, opmode/tare/service-test, active-
// profile persistence, firmware OTA, live sensor/system state). Every
// route here is gated by requireSettingsProxySupport, same as Node.

var gaggiuinoSettingsCategories = map[string]bool{
	"boiler": true, "system": true, "display": true, "scales": true, "led": true, "theme": true,
}

func (h *Handlers) registerControlRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/machine/settings", h.getSettings)
	// Registered before the /{category} route below so this exact path
	// always wins — Go's ServeMux already prefers the more specific
	// literal pattern regardless of registration order (see
	// shots/handlers.go's header comment on the same non-issue), but kept
	// in the same order as the Node original for readability.
	mux.HandleFunc("POST /api/machine/settings/save", h.saveSettings)
	mux.HandleFunc("POST /api/machine/settings/{category}", h.updateSettings)

	mux.HandleFunc("POST /api/machine/opmode", h.setOperationMode)
	mux.HandleFunc("POST /api/machine/tare", h.tare)
	mux.HandleFunc("POST /api/machine/service-test", h.serviceTest)

	mux.HandleFunc("POST /api/machine/profile/save", h.saveActiveProfile)

	mux.HandleFunc("GET /api/machine/firmware/progress", h.firmwareProgress)
	mux.HandleFunc("POST /api/machine/firmware/update", h.triggerFirmwareUpdate)
	mux.HandleFunc("GET /api/machine/firmware/version", h.firmwareVersion)

	mux.HandleFunc("GET /api/machine/live", h.machineLive)
}

// resolveWithAdapter ports the repeated `resolveMachine + getAdapter` pair
// every route in this file (and handlers_profiles.go) opens with.
func (h *Handlers) resolveWithAdapter(w http.ResponseWriter, machineID *int64) (*Machine, Adapter, bool) {
	machine, err := h.registry.ResolveMachine(machineID)
	if err != nil {
		internalError(w, err)
		return nil, nil, false
	}
	adapter, err := h.GetAdapter(machine)
	if err != nil {
		internalError(w, err)
		return nil, nil, false
	}
	return machine, adapter, true
}

func (h *Handlers) getSettings(w http.ResponseWriter, r *http.Request) {
	machine, adapter, ok := h.resolveWithAdapter(w, queryMachineID(r))
	if !ok {
		return
	}
	if !requireSettingsProxySupport(w, adapter, machine) {
		return
	}
	category := r.URL.Query().Get("category")
	if category != "" && !gaggiuinoSettingsCategories[category] && category != "versions" {
		writeError(w, http.StatusBadRequest, "unknown settings category: "+category)
		return
	}
	settings, err := adapter.GetSettings(r.Context(), machine, category)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	w.Write(settings)
}

func (h *Handlers) saveSettings(w http.ResponseWriter, r *http.Request) {
	var body struct {
		MachineID *int64 `json:"machineId"`
	}
	if !decodeJSONBody(w, r, &body) {
		return
	}
	machine, adapter, ok := h.resolveWithAdapter(w, body.MachineID)
	if !ok {
		return
	}
	if !requireSettingsProxySupport(w, adapter, machine) {
		return
	}
	if err := adapter.SaveSettings(r.Context(), machine); err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (h *Handlers) updateSettings(w http.ResponseWriter, r *http.Request) {
	rawBody, ok := readRawJSONBody(w, r)
	if !ok {
		return
	}
	var body struct {
		MachineID *int64 `json:"machineId"`
	}
	_ = json.Unmarshal(rawBody, &body) // best-effort: only used to resolve the machine

	machine, adapter, ok := h.resolveWithAdapter(w, body.MachineID)
	if !ok {
		return
	}
	if !requireSettingsProxySupport(w, adapter, machine) {
		return
	}
	category := r.PathValue("category")
	if !gaggiuinoSettingsCategories[category] {
		writeError(w, http.StatusBadRequest, "unknown or read-only settings category: "+category)
		return
	}
	if err := ValidateSettingsPayload(rawBody); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	result, err := adapter.UpdateSettings(r.Context(), machine, category, rawBody)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	w.Write(result)
}

func (h *Handlers) setOperationMode(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Mode      proto.OperationMode `json:"mode"`
		MachineID *int64              `json:"machineId"`
	}
	if !decodeJSONBody(w, r, &body) {
		return
	}
	machine, adapter, ok := h.resolveWithAdapter(w, body.MachineID)
	if !ok {
		return
	}
	if !requireSettingsProxySupport(w, adapter, machine) {
		return
	}
	if err := ValidateOperationMode(body.Mode); err != nil {
		writeError(w, http.StatusBadRequest, "invalid mode: "+err.Error())
		return
	}
	if err := adapter.SetOperationMode(r.Context(), machine, body.Mode); err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (h *Handlers) tare(w http.ResponseWriter, r *http.Request) {
	var body struct {
		MachineID *int64 `json:"machineId"`
	}
	if !decodeJSONBody(w, r, &body) {
		return
	}
	machine, adapter, ok := h.resolveWithAdapter(w, body.MachineID)
	if !ok {
		return
	}
	if !requireSettingsProxySupport(w, adapter, machine) {
		return
	}
	if err := adapter.Tare(r.Context(), machine); err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (h *Handlers) serviceTest(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Peripheral proto.ServiceTestPeripheral `json:"peripheral"`
		MachineID  *int64                      `json:"machineId"`
	}
	if !decodeJSONBody(w, r, &body) {
		return
	}
	machine, adapter, ok := h.resolveWithAdapter(w, body.MachineID)
	if !ok {
		return
	}
	if !requireSettingsProxySupport(w, adapter, machine) {
		return
	}
	if err := ValidateServiceTestPeripheral(body.Peripheral); err != nil {
		writeError(w, http.StatusBadRequest, "invalid peripheral: "+err.Error())
		return
	}
	if err := adapter.ServiceTest(r.Context(), machine, body.Peripheral); err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (h *Handlers) saveActiveProfile(w http.ResponseWriter, r *http.Request) {
	var body struct {
		MachineID *int64 `json:"machineId"`
	}
	if !decodeJSONBody(w, r, &body) {
		return
	}
	machine, adapter, ok := h.resolveWithAdapter(w, body.MachineID)
	if !ok {
		return
	}
	if !requireSettingsProxySupport(w, adapter, machine) {
		return
	}
	if err := adapter.SaveActiveProfile(r.Context(), machine); err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (h *Handlers) firmwareProgress(w http.ResponseWriter, r *http.Request) {
	machine, adapter, ok := h.resolveWithAdapter(w, queryMachineID(r))
	if !ok {
		return
	}
	if !requireSettingsProxySupport(w, adapter, machine) {
		return
	}
	progress, err := adapter.GetFirmwareProgress(r.Context(), machine)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	w.Write(progress)
}

func (h *Handlers) triggerFirmwareUpdate(w http.ResponseWriter, r *http.Request) {
	var body struct {
		MachineID *int64 `json:"machineId"`
	}
	if !decodeJSONBody(w, r, &body) {
		return
	}
	machine, adapter, ok := h.resolveWithAdapter(w, body.MachineID)
	if !ok {
		return
	}
	if !requireSettingsProxySupport(w, adapter, machine) {
		return
	}
	result, err := adapter.TriggerFirmwareUpdate(r.Context(), machine)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	w.Write(result)
}

// firmwareVersion ports GET /api/machine/firmware/version (#620 Phase 1).
func (h *Handlers) firmwareVersion(w http.ResponseWriter, r *http.Request) {
	machine, adapter, ok := h.resolveWithAdapter(w, queryMachineID(r))
	if !ok {
		return
	}
	if !requireSettingsProxySupport(w, adapter, machine) {
		return
	}
	// Ports Node's Promise.all([getSettings('versions'), getSettings('system')])
	// (#901 code review) — the two reads are independent, so fetch them
	// concurrently instead of paying two round-trips back to back.
	var versionsRaw, systemRaw json.RawMessage
	var versionsErr, systemErr error
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		if httputil.SafeCall("machines: firmware version fetch", func() {
			versionsRaw, versionsErr = adapter.GetSettings(r.Context(), machine, "versions")
		}) {
			versionsErr = fmt.Errorf("internal error fetching versions settings")
		}
	}()
	go func() {
		defer wg.Done()
		if httputil.SafeCall("machines: firmware version fetch", func() {
			systemRaw, systemErr = adapter.GetSettings(r.Context(), machine, "system")
		}) {
			systemErr = fmt.Errorf("internal error fetching system settings")
		}
	}()
	wg.Wait()
	if versionsErr != nil {
		writeError(w, http.StatusBadGateway, versionsErr.Error())
		return
	}
	if systemErr != nil {
		writeError(w, http.StatusBadGateway, systemErr.Error())
		return
	}
	var versions struct {
		CoreVersion *string `json:"coreVersion"`
	}
	_ = json.Unmarshal(versionsRaw, &versions)
	var system map[string]any
	_ = json.Unmarshal(systemRaw, &system)

	channel := ParseReleaseChannel(system["releaseChannel"])
	latest, err := h.firmware.GetLatestFirmwareRelease(r.Context(), channel)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}

	installed := versions.CoreVersion
	updateAvailable := installed != nil && *installed != "" && latest != nil && *installed != latest.Hash
	resp := map[string]any{
		"installed":       nullOr(installed),
		"latest":          nil,
		"updateAvailable": updateAvailable,
		"releaseUrl":      nil,
	}
	if latest != nil {
		resp["latest"] = latest.Hash
		resp["releaseUrl"] = latest.ReleaseURL
	}
	writeJSON(w, http.StatusOK, resp)
}

func nullOr(s *string) any {
	if s == nil {
		return nil
	}
	return *s
}

// machineLive ports GET /api/machine/live: latest cached live sensor/
// system-state pushes from the machine's persistent WebSocket session
// (live.go) — null until the first push arrives.
func (h *Handlers) machineLive(w http.ResponseWriter, r *http.Request) {
	machine, adapter, ok := h.resolveWithAdapter(w, queryMachineID(r))
	if !ok {
		return
	}
	if !requireSettingsProxySupport(w, adapter, machine) {
		return
	}
	sensorSnap, err := adapter.GetLiveSensorSnapshot(r.Context(), machine)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	sysState, err := adapter.GetLiveSystemState(r.Context(), machine)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"sensorSnap": sensorSnap,
		"sysState":   sysState,
	})
}
