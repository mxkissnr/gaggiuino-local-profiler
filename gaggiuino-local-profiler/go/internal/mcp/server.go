package mcp

import (
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	mcpsdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/library"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/maintenance"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/perfstats"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/ratelimit"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/system"
)

// Path is where cmd/server mounts this handler. Living under /api/ is load
// bearing: auth.RequireToken guards every /api/* route, so the MCP endpoint
// inherits the same X-GLP-Token auth as the REST API and does NOT get the
// static-asset GET bypass.
const Path = "/api/mcp"

const (
	serverName  = "glp"
	serverTitle = "Gaggiuino Local Profiler"
)

// Deps is what the MCP server needs from its host application: the shots
// service (shot tools and analytics), the shots repository (annotated doses
// for bean stock and the maintenance shot counts), the library and
// maintenance repositories, the machines registry, and the poller's
// read-only status snapshot.
type Deps struct {
	Shots *shots.Service
	// ShotsRepo backs the maintenance shot counts and bean stock maths; the
	// service above bundles the same repository but does not expose it.
	ShotsRepo   *shots.Repository
	Library     *library.Repository
	Maintenance *maintenance.Repository
	Registry    *machines.Registry
	// Poller is a narrow interface over internal/system.Poller so tests can
	// fake the machine status/preheat snapshot without a live poller.
	Poller MachineStatus
	// Logs is the app's in-memory ring of its own recent log lines
	// (internal/logbuf), read by the get_diagnostics developer tool. Nil-safe:
	// when unset (every test that does not set it) the tool returns an empty
	// log_lines list.
	Logs LogSource
	// Sync is the poller's sync-progress snapshot for get_diagnostics. A
	// separate, nil-safe interface rather than a wider MachineStatus so tests
	// can fake sync state without touching the existing poller fake.
	Sync SyncSource
	// Preheat is the poller's recorded preheat-run history for the
	// get_preheat_history developer tool. A separate, nil-safe interface rather
	// than a wider MachineStatus so tests can fake history without a live
	// poller; nil reports that the history is unavailable.
	Preheat PreheatHistorySource
	// Recorder is the request-timing snapshot source for the get_perf_stats
	// developer tool. A separate, nil-safe interface rather than
	// *perfstats.Recorder so tests can supply a canned snapshot; nil reports
	// that performance stats are unavailable.
	Recorder PerfStatsSource
	// Machines is the machine-traffic snapshot source for the get_perf_stats
	// developer tool. A separate, nil-safe interface rather than
	// *perfstats.MachineCounter so tests can supply a canned snapshot; nil
	// reports an empty machine-traffic section rather than failing the tool
	// (the routes/process/database sections stay available).
	Machines MachineTrafficSource
	// OnDataChanged, when non-nil, is called once after each successful write
	// tool with the changed data kind and, for a single entity, its id, so the
	// host can publish a data-changed SSE event. A callback rather than an
	// internal/sse dependency keeps the MCP package free of the SSE wiring.
	// Nil-safe: the write tools then publish nothing (every test that does not
	// set it).
	OnDataChanged func(kind, id string)
	// DBPath is the SQLite database file get_perf_stats reports the size of,
	// together with its -wal sidecar when present. Empty is tolerated and
	// reports a size of zero.
	DBPath string
	// Version is the app version reported as the MCP server identity; mirrors
	// GET /api/version (internal/system.Version). Empty falls back to "dev".
	Version string
	// RateLimitWindow and RateLimitMax mirror the app-level limiter's
	// configuration (GLP_RATE_LIMIT_WINDOW_MS/_MAX); zero falls back to
	// internal/ratelimit's defaults. The mux-wide limiter already covers
	// /api/mcp, so this only matters when the operator has raised the limit.
	RateLimitWindow time.Duration
	RateLimitMax    int
	// Settings supplies the MCP toggles that apply right now: the app-stored
	// kv row 'mcp_settings' (#1288), with the dev-build rule already applied
	// (Settings.Effective). Read per request, so enabling MCP or flipping the
	// write/developer opt-ins takes effect without a restart. A nil source
	// means everything off — the endpoint then answers 404 like an unmounted
	// route. cmd/server passes the *Repository.
	Settings SettingsSource
}

// LogSource is the narrow slice of internal/logbuf.Buffer the get_diagnostics
// tool reads: the most recent lines, oldest first.
type LogSource interface {
	Lines(n int) []string
}

// SyncSource is the narrow slice of internal/system.Poller get_diagnostics
// reads for sync progress.
type SyncSource interface {
	SyncState() system.SyncState
}

// PreheatHistorySource is the narrow slice of internal/system.Poller the
// get_preheat_history developer tool reads: the recorded runs, newest first
// with the open run first. Nil-safe: without it the tool reports that the
// history is unavailable.
type PreheatHistorySource interface {
	PreheatHistory() []system.PreheatRun
}

// PerfStatsSource is the narrow slice of internal/perfstats.Recorder the
// get_perf_stats developer tool reads: a snapshot of per-route timings and
// process stats. Nil-safe: without it the tool reports that performance stats
// are unavailable.
type PerfStatsSource interface {
	Snapshot(time.Time) perfstats.Snapshot
}

// MachineTrafficSource is the narrow slice of *perfstats.MachineCounter the
// get_perf_stats developer tool reads: per-host traffic resolved to machine
// ids through resolve, plus one aggregate unknown entry for hosts that do not
// resolve. Nil-safe: without it the tool reports an empty machines list.
type MachineTrafficSource interface {
	Snapshot(time.Time, func(host string) (machineID int64, ok bool)) []perfstats.MachineTrafficSnapshot
}

// NewHandler builds the stateless Streamable-HTTP MCP endpoint: the SDK
// server, an Origin (DNS-rebinding) check, and a rate limiter sharing the
// REST API's defaults. The settings source is consulted per request, so a
// disabled server answers 404 (exactly like an unmounted route) and a
// newly-enabled one works without rebuilding the process. One SDK server is
// cached per (allowWrite, allowDeveloperTools) combination — at most four —
// and built lazily.
func NewHandler(deps Deps) http.Handler {
	opts := &mcpsdk.StreamableHTTPOptions{
		Stateless:    true,
		JSONResponse: true,
	}
	endpoint := &mcpEndpoint{deps: deps}
	sdk := mcpsdk.NewStreamableHTTPHandler(endpoint.serverFor, opts)
	window := deps.RateLimitWindow
	if window <= 0 {
		window = ratelimit.DefaultWindow
	}
	max := deps.RateLimitMax
	if max <= 0 {
		max = ratelimit.DefaultMax
	}
	limiter := ratelimit.New(window, max)
	return sameOrigin(limiter.Middleware(endpoint.gate(sdk)))
}

// mcpEndpoint gates the SDK handler on the current settings and caches one SDK
// server per (allowWrite, allowDeveloperTools) combination.
type mcpEndpoint struct {
	deps Deps

	mu      sync.Mutex
	servers map[[2]bool]*mcpsdk.Server
}

// settings returns the effective settings, treating a nil source as off.
func (e *mcpEndpoint) settings() Settings {
	if e.deps.Settings == nil {
		return Settings{}
	}
	return e.deps.Settings.EffectiveSettings()
}

// gate answers 404 before the SDK sees the request when MCP is disabled — the
// same response an unmounted route would give, so a non-enabled install can't
// tell the endpoint exists.
func (e *mcpEndpoint) gate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !e.settings().Enabled {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// serverFor is the SDK's per-request factory; it returns the cached server for
// the current tool combination, building it on first use.
func (e *mcpEndpoint) serverFor(*http.Request) *mcpsdk.Server {
	s := e.settings()
	key := [2]bool{s.AllowWrite, s.AllowDeveloperTools}
	e.mu.Lock()
	defer e.mu.Unlock()
	if srv, ok := e.servers[key]; ok {
		return srv
	}
	srv := newServer(e.deps, s.AllowWrite, s.AllowDeveloperTools)
	if e.servers == nil {
		e.servers = make(map[[2]bool]*mcpsdk.Server, 4)
	}
	e.servers[key] = srv
	return srv
}

func newServer(deps Deps, allowWrite, allowDeveloperTools bool) *mcpsdk.Server {
	version := deps.Version
	if version == "" {
		version = "dev"
	}
	instructions := "Read-only access to the user's Gaggiuino Local Profiler data. " +
		"Call list_shots to discover shot ids, get_shot for one shot's metrics and optional curve, " +
		"and compare_shots to compare two to five shots side by side. " +
		"list_beans and get_library describe the coffee/equipment library, " +
		"get_maintenance_status and get_machine_status report upkeep and machine reachability, " +
		"and get_analytics_summary aggregates shots over a period. " +
		"The dial_in_bean and analyse_shot prompts hand you a ready-made plan for " +
		"dialling in a bean or reviewing a shot."
	if allowWrite {
		instructions += " This server can also change a few things on the user's behalf: " +
			"annotate_shot merges rating, notes and grind setting into one shot, " +
			"set_known_grind remembers a bean's winning grind setting, " +
			"and mark_maintenance_done records that a maintenance task was completed."
	}
	if allowDeveloperTools {
		instructions += " Developer tools are enabled: " +
			"get_shot_raw returns a shot's full-resolution brew data for detailed analysis, " +
			"explain_score breaks a shot's score into its weighted parts and the targets used, " +
			"export_shots_dataset returns a filtered batch of shots as one flat dataset for comparing a scoring idea against the user's ratings, " +
			"get_diagnostics returns the app's own recent log lines plus sync and machine-reachability state for bug triage, " +
			"get_preheat_history returns the machine's recent preheat runs with their predicted and actual ready times for tuning the preheat and ready-by logic, " +
			"and get_perf_stats reports the running install's own performance: API response times per route, process memory, database size and requests per minute to each machine split by idle and brewing."
	}
	srv := mcpsdk.NewServer(&mcpsdk.Implementation{
		Name:    serverName,
		Title:   serverTitle,
		Version: version,
	}, &mcpsdk.ServerOptions{
		Instructions: instructions,
	})
	registerShotTools(srv, deps.Shots)
	registerLibraryTools(srv, deps)
	registerStatusTools(srv, deps)
	registerAnalyticsTools(srv, deps.Shots)
	registerPrompts(srv, allowWrite)
	if allowDeveloperTools {
		registerDeveloperTools(srv, deps)
	}
	if allowWrite {
		registerWriteTools(srv, deps)
	}
	return srv
}

// sameOrigin rejects any request whose Origin header is present and does not
// match the request Host — the MCP spec's DNS-rebinding MUST. A request with
// no Origin (every non-browser client, including the SDK's own client) is
// allowed through; the SDK's localhost Host protection stays enabled too.
func sameOrigin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if origin := r.Header.Get("Origin"); origin != "" && !sameOriginHost(origin, r.Host) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(`{"error":"cross-origin request rejected"}`))
			return
		}
		next.ServeHTTP(w, r)
	})
}

func sameOriginHost(origin, host string) bool {
	u, err := url.Parse(origin)
	if err != nil || u.Host == "" || host == "" {
		return false
	}
	return strings.EqualFold(u.Host, host)
}
