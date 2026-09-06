package system

import (
	"context"
	"log"
	"net/http"
	"os"
	"strconv"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/auth"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/db"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/httputil"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/ratelimit"
)

const jsonBodyLimit = 16 * 1024 // express.json({ limit: '16kb' }) — server.js's global default.

// machineStatusProbeTimeout bounds GET /api/status's ?machineId live
// reachability probe (#464) — short enough that one slow/unreachable
// non-default machine can't make the whole status poll (glp-integration's
// GlpDataCoordinator, every 10s) hang.
const machineStatusProbeTimeout = 5 * time.Second

// Handlers wires Poller + DemoService into net/http handlers — the REST
// surface routes/system.js exposes for the endpoints this phase ports (see
// doc.go for the full list of what's in vs. out of scope). token is the
// same *auth.LoadOrCreateToken result cmd/server passes to
// auth.RequireToken — GET /api/token serves it back, and GET /api/status
// recomputes X-GLP-Token validity itself (independent of Ingress) to decide
// whether to include its authenticated-only fields (#803, mirrors
// server.js's req.glpAuthenticated).
type Handlers struct {
	poller *Poller
	demo   *DemoService
	vc     *versionChecker
	token  string
	rl     *ratelimit.KeyedLimiter
}

func NewHandlers(poller *Poller, demo *DemoService, token string) *Handlers {
	return &Handlers{poller: poller, demo: demo, vc: newVersionChecker(), token: token, rl: ratelimit.NewKeyed()}
}

// RegisterRoutes registers every route this package owns onto mux.
func (h *Handlers) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/machine/status", h.machineStatus)
	mux.HandleFunc("GET /api/live/data", h.liveData)
	mux.HandleFunc("GET /api/preheat", h.getPreheat)
	mux.HandleFunc("POST /api/preheat/ready-by", h.postPreheatReadyBy)
	mux.HandleFunc("GET /api/version", h.getVersion)
	mux.HandleFunc("POST /api/demo/seed", h.postDemoSeed)
	mux.HandleFunc("POST /api/demo/end", h.postDemoEnd)
	mux.HandleFunc("GET /api/token", h.getToken)
	mux.HandleFunc("GET /api/status", h.getStatus)

	// Phase 2a (#901): the remaining routes/system.js endpoints the
	// embedded Vite frontend / glp-integration call — see switch.go,
	// openapi.go, sync.go.
	mux.HandleFunc("GET /api/switch", h.getSwitch)
	mux.HandleFunc("POST /api/switch/toggle", h.postSwitchToggle)
	mux.HandleFunc("GET /api/openapi.json", h.getOpenAPI)
	mux.HandleFunc("POST /api/sync", h.postSync)
}

// postSync ports routes/system.js's POST /api/sync: a 30s-cooldown manual
// trigger of the shot-history pull loop. Responds 200 `{ ok: true }`
// immediately and runs the sync un-awaited (matching Node's `res.json({ ok:
// true }); require('../lib/live-sync').syncAllMachines();` ordering), or 429
// with the German cooldown message. See sync.go for the pull loop itself
// and what of lib/sync.js it does and does not port.
func (h *Handlers) postSync(w http.ResponseWriter, r *http.Request) {
	if !h.poller.tryStartManualSync() {
		writeError(w, http.StatusTooManyRequests, "Bitte 30 Sekunden zwischen manuellen Syncs warten.")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	httputil.SafeGo("system: manual sync", func() { h.poller.RunManualSync(context.Background()) })
}

// machineStatus ports GET /api/machine/status: the default machine's
// latest cached live status, polled every 5s by glp-integration's
// machine_coordinator.py. Always 200 — `available: false` (no other
// fields) means no status has been received yet since startup, `stale:
// true` once the cached status is more than 10 seconds old.
// machineStatusResponse ports the `{ available: true, stale, ...machineStatus }`
// object literal: available/stale plus every MachineStatus field flattened
// into the same JSON level (Go's anonymous-embedding promotion mirrors
// JS's object spread here).
type machineStatusResponse struct {
	Available bool `json:"available"`
	Stale     bool `json:"stale"`
	MachineStatus
}

func (h *Handlers) machineStatus(w http.ResponseWriter, r *http.Request) {
	snap := h.poller.Runtime().Get()
	if snap.MachineStatus == nil {
		writeJSON(w, http.StatusOK, map[string]any{"available": false})
		return
	}
	staleSec := float64(time.Now().UnixMilli()-snap.MachineStatus.UpdatedAt) / 1000
	writeJSON(w, http.StatusOK, machineStatusResponse{
		Available:     true,
		Stale:         staleSec > 10,
		MachineStatus: *snap.MachineStatus,
	})
}

// liveData ports GET /api/live/data.
func (h *Handlers) liveData(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, h.poller.buildLiveDataResponse())
}

// getPreheat ports GET /api/preheat.
func (h *Handlers) getPreheat(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, h.poller.buildPreheatResponse())
}

// postPreheatReadyBy ports POST /api/preheat/ready-by (#541).
func (h *Handlers) postPreheatReadyBy(w http.ResponseWriter, r *http.Request) {
	body, ok := decodeOptionalJSONBody(w, r)
	if !ok {
		return
	}
	raw, present := body["targetAt"]
	if !present {
		raw = nil
	}
	var targetAt *int64
	if raw != nil {
		n, isNum := raw.(float64)
		if !isNum {
			writeError(w, http.StatusBadRequest, "targetAt must be an epoch-ms number or null")
			return
		}
		v := int64(n)
		targetAt = &v
	}
	if targetAt != nil {
		entity := h.poller.defaultSwitchEntity()
		if !h.poller.ha.Enabled() || entity == "" {
			writeError(w, http.StatusBadRequest, "switch_entity nicht konfiguriert")
			return
		}
	}
	h.poller.SetReadyByTarget(targetAt)
	writeJSON(w, http.StatusOK, h.poller.buildPreheatResponse())
}

// getVersion ports GET /api/version.
func (h *Handlers) getVersion(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, h.vc.CheckForUpdate(r.Context()))
}

// postDemoSeed ports POST /api/demo/seed (#274).
func (h *Handlers) postDemoSeed(w http.ResponseWriter, r *http.Request) {
	empty, err := h.demo.IsEmpty()
	if err != nil {
		internalError(w, err)
		return
	}
	if !empty {
		writeError(w, http.StatusConflict, "Database is not empty")
		return
	}
	if err := h.demo.SeedDemoData(); err != nil {
		log.Printf("system: demo seed error: %v", err)
		internalError(w, err)
		return
	}
	log.Printf("system: demo data seeded")
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "isDemo": true})
}

// postDemoEnd ports POST /api/demo/end (#274).
func (h *Handlers) postDemoEnd(w http.ResponseWriter, r *http.Request) {
	if err := h.demo.EndDemo(); err != nil {
		log.Printf("system: demo end error: %v", err)
		internalError(w, err)
		return
	}
	log.Printf("system: demo data removed")
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "isDemo": false})
}

// tokenRateLimitDirect is routes/system.js's original 10/min-per-IP cap,
// still applied verbatim to non-Ingress (direct-port/LAN) callers — see
// getToken's doc comment.
//
// tokenRateLimitIngress is a Go-rewrite-only carve-out (#901 live bug,
// found via real multi-page browser navigation through a prefix-stripping
// Ingress proxy, not curl/smoke tests): the Node app is a client-routed
// SPA, so glp-token.js's Node counterpart (public-src/api.js's
// initToken()) fetches the token once per browser session. This Go
// rewrite is a traditional multi-page app — every nav-link click is a full
// page reload, re-running templates/layout.templ's glp-token.js and
// re-fetching GET /api/token on every single page. Worse, HA Ingress
// proxies every request from one shared internal address (see
// auth.IsSupervisorIP's #801 comment and internal/ratelimit/doc.go's own
// note on "the single shared Supervisor-Ingress address"), so the
// token:<ip> bucket this rate limit keys on is shared across every
// browser tab and every user of the same HA instance, not scoped per
// visitor the way it would be for a direct-port LAN caller. 10/min was
// never enough headroom for that: a single person clicking through this
// app's ~15 single-segment routes (go/internal/web/doc.go) inside a
// minute exhausts the budget for the whole household. Kept meaningfully
// lower than the app-wide 600/min backstop (ratelimit.DefaultMax) so this
// endpoint specifically still bounds a runaway client/bug, just no longer
// at a threshold ordinary MPA browsing trips by accident.
const (
	tokenRateLimitDirect  = 10
	tokenRateLimitIngress = 120
)

// getToken ports GET /api/token (#803, #533): serves the API token to any
// caller that can reach this port, rate-limited per IP (see
// tokenRateLimitDirect/tokenRateLimitIngress above) — unless the
// expose_api_port add-on option has been explicitly turned off for a
// direct (non-Ingress) caller.
//
// This deliberately reverses the older #276 restriction to HA-internal
// callers. Direct-port access (http://<host>:8099) is how the installable
// PWA runs, and it has no other way to obtain a token: the UI has no token
// input, and a token is no longer cached client-side since #524. The
// trade-off, accepted knowingly for a home LAN: anything that can reach
// this port can obtain the token and therefore call every endpoint, so
// token auth is no longer a boundary within the LAN by default — reaching
// the port at all is the boundary. expose_api_port (#803) is the opt-in
// escape hatch instead: default true (identical to the behavior above, so
// no existing install regresses), and only when a user explicitly sets it
// to false does this endpoint start rejecting non-Ingress callers. See
// routes/system.js's own (longer) version of this comment for the full
// #276/#524/#803 history, and auth.RequireToken for why this path (like
// GET /api/status) bypasses the app-wide token-auth middleware entirely.
func (h *Handlers) getToken(w http.ResponseWriter, r *http.Request) {
	ip := auth.RemoteIP(r)
	ingress := auth.IsIngressRequest(r)
	limit := tokenRateLimitDirect
	if ingress {
		limit = tokenRateLimitIngress
	}
	if !h.rl.Allow("token:"+ip, limit) {
		writeError(w, http.StatusTooManyRequests, "Rate limit exceeded")
		return
	}
	if !ingress && !isApiPortExposed() {
		writeError(w, http.StatusForbidden, "API token endpoint disabled for direct-port access (expose_api_port=false); use HA Ingress")
		return
	}
	var apiToken any
	if h.token != "" {
		apiToken = h.token
	}
	writeJSON(w, http.StatusOK, map[string]any{"apiToken": apiToken})
}

// getStatus ports GET /api/status (public — no auth required per
// openapi.yaml's `security: []`): glp-integration's config-flow discovery
// probe and every GlpDataCoordinator poll (every 10s) depend on this
// endpoint responding successfully, making it the actual bootstrap
// dependency doc.go's earlier scope cut had missed (#901 Phase 3b).
//
// Sensitive fields (machineUrl/machineHostname/lastSyncError/
// lastMachineError/switchEntity/isDemo) are only included when the request
// carries a valid X-GLP-Token — recomputed here independent of Ingress,
// exactly matching server.js's req.glpAuthenticated (set once, before the
// Ingress bypass, from the header alone; Ingress makes the middleware let
// the request through, it does NOT make req.glpAuthenticated true).
//
// Phase 2a (#901) wired lastSync/lastSyncError: POST /api/sync's manual
// pull loop (sync.go) now records them, so GET /api/status reports real
// values once a sync has run (null until then, as before). syncRetryCount
// stays permanently 0 — the automatic retry/backoff scheduler
// (scheduleNextSync) is still not ported, there being no automatic sync
// loop in this Go port for it to hang off; it's present in the response
// (matching openapi.yaml's Status schema) so a client parsing it doesn't
// break.
func (h *Handlers) getStatus(w http.ResponseWriter, r *http.Request) {
	registry := h.poller.registry

	shotCount, err := h.demo.shots.Count()
	if err != nil {
		shotCount = 0
	}

	installID, err := db.EnsureInstallID(h.demo.db)
	if err != nil {
		internalError(w, err)
		return
	}

	defaultMachine, err := registry.GetDefaultMachine()
	if err != nil {
		internalError(w, err)
		return
	}
	var defaultHost string
	if defaultMachine != nil {
		defaultHost = defaultMachine.Host
	}
	machineURL, machineHostname := apiURLAndHostnameFor(defaultHost)

	info := h.poller.StatusInfo()
	syncInfo := h.poller.SyncState()
	snap := h.poller.Runtime().Get()
	machineReachable := info.MachineReachable
	lastMachineError := info.LastMachineError

	// #464: ?machineId for a non-default machine live-probes THAT machine
	// (same adapter.GetStatus() call POST /api/machines/:id/test uses)
	// instead of describing the default one. No machineId, or one that
	// resolves back to the default machine, keeps the behavior above
	// unchanged — this endpoint is polled unparameterized by every other
	// caller (glp-integration included).
	if raw := r.URL.Query().Get("machineId"); raw != "" {
		if id, perr := strconv.ParseInt(raw, 10, 64); perr == nil {
			if requested, rerr := registry.ResolveMachine(&id); rerr == nil && requested != nil && !requested.IsDefault {
				machineHostname = hostnameOnly(requested.Host)
				// routes/system.js's equivalent branch wraps getAdapter()
				// AND adapter.getStatus() in the same try/catch, so a
				// GetAdapter failure (e.g. an orphaned registry row with an
				// empty/unknown Type from an incomplete migration) reports
				// as a probe failure for THIS machine, same as a reachable
				// probe that errors out -- never silently falls through to
				// leave machineReachable/lastMachineError describing the
				// default machine while machineHostname above already
				// switched to the requested one (#901 code review).
				adapter, aerr := h.poller.adapters.GetAdapter(requested)
				if aerr == nil {
					ctx, cancel := context.WithTimeout(r.Context(), machineStatusProbeTimeout)
					_, aerr = adapter.GetStatus(ctx, requested)
					cancel()
				}
				if aerr == nil {
					reachable := true
					machineReachable = &reachable
					lastMachineError = nil
				} else {
					reachable := false
					machineReachable = &reachable
					msg := aerr.Error()
					lastMachineError = &msg
				}
			}
		}
	}

	machinesList, err := registry.ListMachines()
	if err != nil {
		machinesList = nil
	}

	resp := map[string]any{
		"shotCount":                   shotCount,
		"lastSync":                    nullableStr(syncInfo.LastSync),
		"syncRetryCount":              0,
		"machineVersion":              info.CachedMachineVersion,
		"syncInterval":                loadSyncIntervalMinutes(),
		"haConnected":                 h.poller.ha.Enabled(),
		"glpVersion":                  glpVersion,
		"ordersFeature":               isOrdersEnabled(),
		"exposeApiPort":               isApiPortExposed(),
		"machineReachable":            machineReachable,
		"lastMachineSuccess":          info.LastMachineSuccess,
		"machineOn":                   snap.MachineOn,
		"machineOnSince":              snap.SwitchOnAt,
		"legacyMachineOptionsPending": hasUnconfirmedLegacyMachineOptions(),
		"installId":                   installID,
		"machines":                    buildStatusMachines(machinesList, machineReachable, snap.MachineOn),
	}
	if devBuild := os.Getenv("GLP_DEV_BUILD"); devBuild != "" {
		resp["devBuild"] = devBuild
	}

	// Sensitive fields only exposed to authenticated callers (H1).
	if auth.IsTokenValid(h.token, r.Header.Get("X-GLP-Token")) {
		resp["machineUrl"] = machineURL
		resp["machineHostname"] = machineHostname
		resp["lastSyncError"] = nullableStr(syncInfo.LastSyncError)
		resp["lastMachineError"] = lastMachineError
		var switchEntity any
		if entity := h.poller.defaultSwitchEntity(); entity != "" {
			switchEntity = entity
		}
		resp["switchEntity"] = switchEntity
		resp["isDemo"] = h.demo.IsDemoActive()
	}

	writeJSON(w, http.StatusOK, resp)
}

// ── response/body helpers (see internal/httputil: WriteJSON/WriteError were
// byte-identical copies across every domain package's handlers.go; this
// package's own internalError stays a one-line wrapper so every call site
// below keeps its existing internalError(w, err) shape) ──────────────────

var (
	writeJSON  = httputil.WriteJSON
	writeError = httputil.WriteError
)

func internalError(w http.ResponseWriter, err error) {
	httputil.InternalError(w, "system", err)
}

// nullableStr renders a *string as its value or JSON null — GET /api/status's
// lastSync/lastSyncError, which are null until the first manual sync runs.
func nullableStr(s *string) any {
	if s == nil {
		return nil
	}
	return *s
}

func decodeJSONBody(w http.ResponseWriter, r *http.Request) (map[string]any, bool) {
	body, ok := httputil.DecodeJSONBody[map[string]any](w, r, jsonBodyLimit)
	if !ok {
		return nil, false
	}
	if body == nil {
		body = map[string]any{}
	}
	return body, true
}

// decodeOptionalJSONBody ports internal/orders/handlers.go's own helper of
// the same name: a request body that's allowed to be entirely absent
// (POST /api/preheat/ready-by's Node handler reads `req.body || {}`,
// tolerant of no body at all) decodes to {} instead of a 400. decodeJSONBody
// itself is now equally EOF-tolerant (httputil.DecodeJSONBody), so this
// ContentLength==0 short-circuit is no longer load-bearing -- kept as a
// distinct name at this call site for readability (it documents that an
// absent body is expected/fine here), not because the behavior differs.
func decodeOptionalJSONBody(w http.ResponseWriter, r *http.Request) (map[string]any, bool) {
	if r.ContentLength == 0 {
		return map[string]any{}, true
	}
	return decodeJSONBody(w, r)
}
