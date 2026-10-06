package machines

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/db"
)

// machine_control.go is the opt-in machine-control surface (#1324): flush
// start/stop for a GaggiMate controller on firmware v1.9.0+. It is deliberately
// separate from the #597 settings/control proxy, which GaggiMate does not
// support (Capabilities().SettingsProxy is false there).
//
// Invariants:
//   - GLP never starts a brew on its own. The only control action exposed here
//     is a flush the user explicitly asked for.
//   - Machine control is opt-in: every entry point goes through
//     ControlStateFor, which requires the machineControlEnabled setting.
//   - Control frames carry a short TTL (gaggimateControlFrameTTL). A command
//     queued while the WS connection is down is dropped rather than written
//     after a later reconnect, so a stale flush can never fire later.

// ControlState is the snapshot the UI reads before offering the flush control
// and after every command.
type ControlState struct {
	MachineID int64 `json:"machineId"`
	CanFlush  bool  `json:"canFlush"`
	Flushing  bool  `json:"flushing"`
}

// MachineController is implemented by adapters that support opt-in machine
// control. GaggiMate does; Gaggiuino does not.
type MachineController interface {
	ControlState(m *Machine) (ControlState, bool)
	FlushStart(ctx context.Context, m *Machine) error
	FlushStop(ctx context.Context, m *Machine) error
}

var _ MachineController = (*GaggiMateAdapter)(nil)

var (
	// ErrMachineControlUnsupported means the machine's type has no machine
	// control (surfaced as 501).
	ErrMachineControlUnsupported = errors.New("machine type does not support machine control")
	// ErrMachineControlDisabled means the opt-in machine-control setting is off
	// (surfaced as 403).
	ErrMachineControlDisabled = errors.New("machine control is disabled")
	// ErrMachineControlUnavailable means control needs a connected GaggiMate on
	// firmware v1.9.0+ (surfaced as 409).
	ErrMachineControlUnavailable = errors.New("machine control needs a connected GaggiMate on firmware v1.9.0 or newer")
	// errFlushBusy means a flush was requested while the machine is not idle in
	// brew mode (surfaced as 409).
	errFlushBusy = errors.New("machine is not idle in brew mode")
	// errGaggiMateNotConnected means no connected live session exists for the
	// machine (surfaced as 409).
	errGaggiMateNotConnected = errors.New("gaggimate machine is not connected")
)

const machineControlKVKey = "machine_control_enabled"

// MachineControlEnabled reports whether the opt-in machine-control setting is
// on. It is false unless the user explicitly enabled it, including on any KV
// read error.
func (r *Registry) MachineControlEnabled() bool {
	if r == nil || r.db == nil {
		return false
	}
	v, err := db.GetKVBool(r.db, machineControlKVKey)
	if err != nil {
		return false
	}
	return v
}

// ControlStateFor is the single gate every machine-control entry point goes
// through: capability, then the opt-in setting, then a live snapshot. It reads
// only the registry cache and one KV row — no network. The returned state is a
// fresh value with MachineID set.
func ControlStateFor(reg *Registry, a Adapter, m *Machine) (*ControlState, error) {
	if !a.Capabilities().MachineControl {
		return nil, ErrMachineControlUnsupported
	}
	mc, ok := a.(MachineController)
	if !ok {
		return nil, ErrMachineControlUnsupported
	}
	if reg == nil || !reg.MachineControlEnabled() {
		return nil, ErrMachineControlDisabled
	}
	state, ok := mc.ControlState(m)
	if !ok {
		return nil, ErrMachineControlUnavailable
	}
	state.MachineID = m.ID
	return &state, nil
}

var gaggiMateVersionRe = regexp.MustCompile(`^v?(\d+)\.(\d+)(?:\.(\d+))?`)

// parseGaggiMateVersion parses the leading major.minor[.patch] of a firmware
// version string. A leading "v" is optional, any build suffix is ignored
// ("v1.9.0-12-gabc"), and a missing patch defaults to 0.
func parseGaggiMateVersion(s string) (maj, min, patch int, ok bool) {
	m := gaggiMateVersionRe.FindStringSubmatch(s)
	if m == nil {
		return 0, 0, 0, false
	}
	maj, _ = strconv.Atoi(m[1])
	min, _ = strconv.Atoi(m[2])
	if m[3] != "" {
		patch, _ = strconv.Atoi(m[3])
	}
	return maj, min, patch, true
}

// gaggiMateControlFirmware reports whether v is new enough for machine control
// (>= 1.9.0). The patch component is irrelevant to that threshold.
func gaggiMateControlFirmware(v string) bool {
	maj, min, _, ok := parseGaggiMateVersion(v)
	if !ok {
		return false
	}
	if maj != 1 {
		return maj > 1
	}
	return min >= 9
}

// ControlState reads the live cache for a GaggiMate machine and derives the
// flush state. ok is false when there is no connected session, the cached
// status is stale, or the firmware is older than v1.9.0.
func (a *GaggiMateAdapter) ControlState(m *Machine) (ControlState, bool) {
	if a.live == nil || m == nil {
		return ControlState{}, false
	}
	baseURL, ok := normalizeBaseURL(m.Host)
	if !ok {
		return ControlState{}, false
	}
	status, version, ok := a.live.controlSnapshot(baseURL)
	if !ok || !gaggiMateControlFirmware(version) {
		return ControlState{}, false
	}

	process, _ := status["process"].(map[string]any)
	active := looseFloat(process["a"]) == 1
	utility := looseFloat(process["u"]) == 1

	// sys.s is "ready" when the controller is idle. An absent sys is treated as
	// ready (older/short frames), but a present sys with a non-"ready" state is
	// not.
	ready := true
	if sys, ok := status["sys"].(map[string]any); ok {
		s, _ := sys["s"].(string)
		ready = s == "ready"
	}

	return ControlState{
		CanFlush: looseFloat(status["m"]) == 1 && !active && ready,
		Flushing: active && utility,
	}, true
}

// FlushStart asks a GaggiMate to run its configured flush. It is a no-op and
// errFlushBusy is returned when the machine is not idle in brew mode.
func (a *GaggiMateAdapter) FlushStart(ctx context.Context, m *Machine) error {
	baseURL, err := BaseURLFor(ctx, m)
	if err != nil {
		return err
	}
	state, ok := a.ControlState(m)
	if !ok || !state.CanFlush {
		return errFlushBusy
	}
	res, err := a.live.controlRequest(ctx, baseURL, "req:flush:start")
	if err != nil {
		return err
	}
	if !looseTruthy(res["success"]) {
		return fmt.Errorf("machine rejected the flush start")
	}
	return nil
}

// FlushStop ends a hold-to-flush on a GaggiMate.
func (a *GaggiMateAdapter) FlushStop(ctx context.Context, m *Machine) error {
	baseURL, err := BaseURLFor(ctx, m)
	if err != nil {
		return err
	}
	_, err = a.live.controlRequest(ctx, baseURL, "req:flush:stop")
	return err
}

func (h *Handlers) registerMachineControlRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/machine/flush/start", h.flushStart)
	mux.HandleFunc("POST /api/machine/flush/stop", h.flushStop)
}

func (h *Handlers) flushStart(w http.ResponseWriter, r *http.Request) {
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
	if _, err := ControlStateFor(h.registry, adapter, machine); err != nil {
		writeControlError(w, machine, err)
		return
	}
	mc, ok := adapter.(MachineController)
	if !ok {
		writeControlError(w, machine, ErrMachineControlUnsupported)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	if err := mc.FlushStart(ctx, machine); err != nil {
		writeControlError(w, machine, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (h *Handlers) flushStop(w http.ResponseWriter, r *http.Request) {
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
	if _, err := ControlStateFor(h.registry, adapter, machine); err != nil {
		writeControlError(w, machine, err)
		return
	}
	mc, ok := adapter.(MachineController)
	if !ok {
		writeControlError(w, machine, ErrMachineControlUnsupported)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	if err := mc.FlushStop(ctx, machine); err != nil {
		writeControlError(w, machine, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// writeControlError maps a machine-control error to its HTTP response, mirroring
// the shapes the settings/control proxy already uses.
func writeControlError(w http.ResponseWriter, m *Machine, err error) {
	switch {
	case errors.Is(err, ErrMachineControlUnsupported):
		writeJSON(w, http.StatusNotImplemented, map[string]string{
			"error":  "not supported",
			"reason": m.Type + " machines do not support machine control",
		})
	case errors.Is(err, ErrMachineControlDisabled):
		writeError(w, http.StatusForbidden, "machine control is disabled")
	case errors.Is(err, ErrMachineControlUnavailable), errors.Is(err, errGaggiMateNotConnected):
		writeError(w, http.StatusConflict, ErrMachineControlUnavailable.Error())
	case errors.Is(err, errFlushBusy):
		writeError(w, http.StatusConflict, errFlushBusy.Error())
	default:
		writeError(w, http.StatusBadGateway, err.Error())
	}
}
