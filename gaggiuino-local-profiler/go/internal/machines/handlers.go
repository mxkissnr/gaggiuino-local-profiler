package machines

import (
	"errors"
	"io"
	"net/http"
	"strconv"
	"sync"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/httputil"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/sse"
)

// This file (plus handlers_registry.go, handlers_control.go,
// handlers_profiles.go) ports routes/machines.js, routes/machine-control.js,
// and the machine-profile/live-status portion of routes/system.js onto Go
// 1.22+'s method-and-wildcard http.ServeMux — the same pattern
// internal/shots and internal/library's handlers.go establish. See
// doc.go for exactly which routes.js/system.js/machine-control.js routes
// this package does and does NOT absorb (the system-domain-dependent ones:
// /api/machine/status, /api/preheat*, /api/live/data).

const jsonBodyLimit = 16 * 1024 // express.json({ limit: '16kb' }) — server.js's global default.

// profilesCache ports routes/system.js's getProfilesCacheFor/setProfilesCacheFor
// (#340): a last-known profile list per machine, served when a live fetch
// fails. In-memory only for every machine including the default one — Node
// additionally persists the default machine's cache to PROFILES_CACHE_FILE
// across restarts (defaultRuntime.machineProfiles); this Go port doesn't,
// since this binary isn't wired into a running add-on process where
// restart-persistence matters yet (see go/README.md) — a real gap to close
// before cutover, not before this phase, tracked here rather than silently
// dropped.
type profilesCache struct {
	mu        sync.Mutex
	byMachine map[int64][]ProfileSummary
}

func newProfilesCache() *profilesCache {
	return &profilesCache{byMachine: make(map[int64][]ProfileSummary)}
}

func (c *profilesCache) get(machineID int64) []ProfileSummary {
	c.mu.Lock()
	defer c.mu.Unlock()
	if p, ok := c.byMachine[machineID]; ok {
		return p
	}
	return []ProfileSummary{}
}

func (c *profilesCache) set(machineID int64, profiles []ProfileSummary) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.byMachine[machineID] = profiles
}

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
	profilesCache *profilesCache
	liveClient    *gaggiuinoLiveClient
	gaggimateLive *gaggiMateLiveClient
}

// NewHandlers builds Handlers around registry (backed by the same *sql.DB
// cmd/server already opens once, see registry.go's NewRegistry) and hub
// (internal/sse's pub/sub broker — see live.go for how machine-pushed live
// data reaches it).
func NewHandlers(registry *Registry, hub *sse.Hub) *Handlers {
	live := newGaggiuinoLiveClient(hub)
	gmLive := newGaggiMateLiveClient()
	return &Handlers{
		registry:      registry,
		gaggiuino:     NewGaggiuinoAdapter(live),
		gaggimate:     NewGaggiMateAdapter(gmLive),
		firmware:      NewFirmwareChecker(),
		profilesCache: newProfilesCache(),
		liveClient:    live,
		gaggimateLive: gmLive,
	}
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
// `{}`, matching Express's req.body ?? {} convention throughout
// routes/machine-control.js).
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

// queryMachineID ports the repeated `req.query.machineId` /
// `req.body?.machineId` read every route in this package does before
// calling registry.resolveMachine — nil means "not given at all",
// matching resolveMachine's own nil-vs-NaN distinction.
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

// pathID64/pathIDInt parse the {id} path wildcard as an int64/int —
// mirrors `parseInt(req.params.id, 10)`.
func pathID64(r *http.Request) (int64, bool) {
	n, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	return n, err == nil
}

func pathIDInt(r *http.Request) (int, bool) {
	n, err := strconv.Atoi(r.PathValue("id"))
	return n, err == nil
}

// pathIDStr returns the raw {id} path wildcard as a string — used for
// profile operations where IDs may be either numeric (Gaggiuino) or
// alphanumeric (GaggiMate, e.g. "lever", "adapt").
func pathIDStr(r *http.Request) string {
	return r.PathValue("id")
}

// requireProfileEditSupport ports routes/system.js's
// requireProfileEditSupport(adapter, machine, res).
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

// requireSettingsProxySupport ports routes/machine-control.js's
// requireSettingsProxySupport(adapter, machine, res).
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
