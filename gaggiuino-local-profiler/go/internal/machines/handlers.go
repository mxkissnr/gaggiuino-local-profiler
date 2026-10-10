package machines

import (
	"errors"
	"io"
	"net/http"
	"strconv"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/httputil"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/sse"
)

// This file (plus handlers_registry.go, handlers_control.go,
// handlers_profiles.go) is the machines REST surface, built on Go 1.22+'s
// method-and-wildcard http.ServeMux — the same pattern internal/shots and
// internal/library's handlers.go establish. See doc.go for exactly which
// routes this package does and does NOT absorb (the system-domain-dependent
// ones: /api/machine/status, /api/preheat*, /api/live/data).

const jsonBodyLimit = 16 * 1024 // the server-wide default JSON body limit.

// The old in-memory-only profilesCache (#340) is gone — replaced by
// ProfilesRepository (profiles_repo.go), a real local-first cache/outbox
// that also survives restarts and lets create/update/delete succeed while
// offline instead of just degrading reads. See handlers_profiles.go.

// Handlers wires Registry + the two concrete adapters + FirmwareChecker
// into net/http handlers. gaggiuino/gaggimate are typed as the Adapter
// interface (not the concrete *GaggiuinoAdapter/*GaggiMateAdapter
// NewHandlers actually constructs) purely so a same-package test can swap
// in a fake implementation -- GetAdapter's own return type is already
// Adapter, and nothing else in this package reaches past that interface to
// a concrete-type-only method, so this costs no behavior.
type Handlers struct {
	registry      *Registry
	gaggiuino     Adapter
	gaggimate     Adapter
	firmware      *FirmwareChecker
	profilesRepo  *ProfilesRepository
	liveClient    *gaggiuinoLiveClient
	gaggimateLive *gaggiMateLiveClient

	// onFirmwareUpdate runs after a firmware update has been triggered
	// successfully (see triggerFirmwareUpdate in handlers_control.go). Set
	// via SetOnFirmwareUpdate by cmd/server, which uses it to record the
	// update in the machine's maintenance log (#1136). from/to are the
	// installed and target firmware versions, best-effort resolved before the
	// update (either may be empty). A callback rather than a direct import for
	// the same reason as library.Handlers.SetOnGrinderDeleted:
	// internal/maintenance already imports internal/machines, so the wiring
	// has to run this direction.
	onFirmwareUpdate func(m *Machine, from, to string) error

	// onProfileSaved runs after a machine profile create or update has fully
	// succeeded (see createMachineProfile/updateMachineProfile in
	// handlers_profiles.go). Set via SetOnProfileSaved by cmd/server, which
	// uses it to drive the profile achievements (#1286). action is "create"
	// or "update". A callback rather than a direct import for the same
	// import-cycle reason as onFirmwareUpdate: internal/achievements already
	// imports internal/machines, so the wiring has to run this direction.
	onProfileSaved func(action string)

	// onDefaultChanged runs after the default machine has been reassigned
	// (#1543). Set via SetOnDefaultChanged by cmd/server; internal/system
	// uses it to reset the poller's preheat session for the new default — a
	// default switch to an already-on machine otherwise leaves the preheat
	// countdown stuck at the full window. A callback for the same
	// import-cycle reason as onProfileSaved. A nil hook is a no-op.
	onDefaultChanged func()

	// knownUnreachable reports whether the poller's most recent poll of a
	// machine found it unreachable (#1572). Set via SetKnownUnreachable by
	// cmd/server; the profiles and firmware-version handlers use it to answer
	// from local state immediately when the machine is known to be off,
	// instead of paying the live fetch timeouts. A callback rather than a
	// direct import for the same import-cycle reason as onFirmwareUpdate:
	// internal/system already imports internal/machines. A nil hook is a
	// no-op (and machineKnownOffline then always reports false).
	knownUnreachable func(machineID int64) bool
}

// NewHandlers builds Handlers around registry (backed by the same *sql.DB
// cmd/server already opens once, see registry.go's NewRegistry), hub
// (internal/sse's pub/sub broker — see live.go for how machine-pushed live
// data reaches it), and profilesRepo (the local-first profile
// cache/outbox, offline-editor rework — see profiles_repo.go; replaces the
// old in-memory-only profilesCache).
func NewHandlers(registry *Registry, hub *sse.Hub, profilesRepo *ProfilesRepository) *Handlers {
	live := newGaggiuinoLiveClient(hub)
	gmLive := newGaggiMateLiveClient()
	return &Handlers{
		registry:      registry,
		gaggiuino:     NewGaggiuinoAdapter(live),
		gaggimate:     NewGaggiMateAdapter(gmLive),
		firmware:      NewFirmwareChecker(),
		profilesRepo:  profilesRepo,
		liveClient:    live,
		gaggimateLive: gmLive,
	}
}

// SetOnFirmwareUpdate wires the side effect to run after a machine
// firmware update has been triggered successfully (#1136). cmd/server uses
// it to add a `firmware_update` entry to the machine's maintenance log;
// from/to are the installed and target firmware versions, best-effort
// resolved before the update (either may be empty).
// internal/maintenance imports internal/machines, so wiring this as a
// callback here avoids the import cycle a direct dependency would create.
// A nil hook (never wired, e.g. in this package's own unit tests) is a
// no-op. The callback's error is logged, never surfaced to the client --
// the update itself already succeeded.
func (h *Handlers) SetOnFirmwareUpdate(fn func(m *Machine, from, to string) error) {
	h.onFirmwareUpdate = fn
}

// SetOnProfileSaved wires the side effect to run after a machine profile
// create or update has fully succeeded (#1286). cmd/server uses it to let
// the achievements service see a `profile-saved` event, which unlocks the
// first_profile/profile_edit badges. action is "create" or "update".
// internal/achievements imports internal/machines, so wiring this as a
// callback here avoids the import cycle a direct dependency would create.
// A nil hook (never wired, e.g. in this package's own unit tests) is a
// no-op, and the callback never changes the response -- the save itself
// already succeeded.
func (h *Handlers) SetOnProfileSaved(fn func(action string)) {
	h.onProfileSaved = fn
}

// SetOnDefaultChanged wires the side effect to run after the default machine
// has actually changed (#1543). cmd/server uses it to reset the poller's
// preheat session for the new default. internal/system imports
// internal/machines, so this is a callback for the same import-cycle reason as
// SetOnProfileSaved. A nil hook (never wired, e.g. in this package's own unit
// tests) is a no-op, and the callback never changes the response — the
// reassignment itself already succeeded.
func (h *Handlers) SetOnDefaultChanged(fn func()) {
	h.onDefaultChanged = fn
}

// SetKnownUnreachable wires the offline fast-path check (#1572): it reports
// whether the poller's most recent poll of a machine found it unreachable.
// cmd/server passes a closure over poller.MachineStatus, so the profiles and
// firmware-version handlers can answer immediately from local state when the
// machine is switched off rather than waiting on live fetch timeouts.
// internal/system imports internal/machines, so this is a callback for the same
// import-cycle reason as SetOnDefaultChanged. A nil hook (never wired, e.g. in
// this package's own unit tests) is a no-op: machineKnownOffline then reports
// false and every handler keeps its existing live behavior.
func (h *Handlers) SetKnownUnreachable(fn func(machineID int64) bool) {
	h.knownUnreachable = fn
}

// machineKnownOffline reports whether the poller's last poll for the machine
// said it was unreachable (#1572). Unknown poller state (hook nil, or the hook
// itself reporting "no state yet") counts as not offline, so behavior is
// unchanged until the poller has actually observed a failed poll.
func (h *Handlers) machineKnownOffline(id int64) bool {
	if h.knownUnreachable == nil {
		return false
	}
	return h.knownUnreachable(id)
}

// SetOnShotSaved wires the side effect to run when the GaggiMate controller
// reports a new shot was saved (evt:history-shot-saved, firmware v1.9.0+;
// #1409). cmd/server uses it to pull the default machine's shot history right
// away instead of waiting for the post-brew timer. internal/system imports
// internal/machines, so wiring this as a callback here avoids the import cycle
// a direct dependency would create, same reason as SetOnProfileSaved. A nil
// hook (never wired, e.g. in this package's own unit tests) is a no-op. The
// callback runs on the live read loop and must not block.
func (h *Handlers) SetOnShotSaved(fn func()) {
	h.gaggimateLive.setOnShotSaved(fn)
}

// disconnectLiveForHost tears down both persistent live sessions for a host
// whose machine record's host changed or was deleted — the Gaggiuino WS
// session (d_sensor_snap/d_sys_state cache) and the GaggiMate WS session
// (evt:status cache, #952).
func (h *Handlers) disconnectLiveForHost(host string) {
	h.liveClient.DisconnectForHost(host)
	h.gaggimateLive.DisconnectForHost(host)
}

// RegisterRoutes registers every /api/machines* and /api/machine/* route
// this package implements onto mux.
func (h *Handlers) RegisterRoutes(mux *http.ServeMux) {
	h.registerRegistryRoutes(mux)
	h.registerControlRoutes(mux)
	h.registerProfileRoutes(mux)
	h.registerMachineControlRoutes(mux)
}

// ── response helpers (see internal/httputil) ─────────────────────────────

var (
	writeJSON  = httputil.WriteJSON
	writeError = httputil.WriteError
)

func internalError(w http.ResponseWriter, err error) {
	httputil.InternalError(w, "machines", err)
}

// decodeJSONBody reads and decodes r's body into v, bounded to
// jsonBodyLimit — mirrors library/handlers.go's decodeJSONBody. An empty
// body decodes to v's zero value rather than erroring (every route this
// package registers that reads a body treats a missing body the same as
// `{}`).
func decodeJSONBody(w http.ResponseWriter, r *http.Request, v any) bool {
	return httputil.DecodeJSONBodyInto(w, r, jsonBodyLimit, v)
}

// readRawJSONBody reads r's body as raw bytes (bounded to jsonBodyLimit)
// without decoding — used by the settings-proxy write path, which must
// forward the client's exact bytes unmodified (see gaggiuino_adapter.go's
// UpdateSettings doc comment).
func readRawJSONBody(w http.ResponseWriter, r *http.Request) ([]byte, bool) {
	r.Body = http.MaxBytesReader(w, r.Body, jsonBodyLimit)
	body, err := io.ReadAll(r.Body)
	if err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			writeError(w, http.StatusRequestEntityTooLarge, "request entity too large")
		} else {
			writeError(w, http.StatusBadRequest, "Invalid request body")
		}
		return nil, false
	}
	if len(body) == 0 {
		body = []byte("{}")
	}
	return body, true
}

// queryMachineID reads the machineId query parameter, the repeated read
// every route in this package does before calling registry.ResolveMachine —
// nil means "not given at all", matching ResolveMachine's own
// nil-vs-absent distinction.
func queryMachineID(r *http.Request) *int64 {
	raw := r.URL.Query().Get("machineId")
	if raw == "" {
		return nil
	}
	n, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return nil
	}
	return &n
}

// pathID64 parses the {id} path wildcard as an int64.
func pathID64(r *http.Request) (int64, bool) {
	n, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	return n, err == nil
}

// pathIDStr returns the raw {id} path wildcard as a string — used for
// profile operations where IDs may be either numeric (Gaggiuino) or
// alphanumeric (GaggiMate, e.g. "lever", "adapt").
func pathIDStr(r *http.Request) string {
	return r.PathValue("id")
}

// requireProfileEditSupport returns 501 when an adapter cannot edit
// profiles.
func requireProfileEditSupport(w http.ResponseWriter, adapter Adapter, m *Machine) bool {
	if adapter.Capabilities().ProfileEdit {
		return true
	}
	writeJSON(w, http.StatusNotImplemented, map[string]string{
		"error":  "not supported",
		"reason": m.Type + " machines do not support remote profile editing yet",
	})
	return false
}

// requireSettingsProxySupport returns 501 when an adapter has no
// settings/control proxy.
func requireSettingsProxySupport(w http.ResponseWriter, adapter Adapter, m *Machine) bool {
	if adapter.Capabilities().SettingsProxy {
		return true
	}
	writeJSON(w, http.StatusNotImplemented, map[string]string{
		"error":  "not supported",
		"reason": m.Type + " machines do not support the settings/control proxy",
	})
	return false
}
