package mcp

import (
	"net/http"
	"net/url"
	"strings"
	"time"

	mcpsdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/library"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/maintenance"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/ratelimit"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
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
	// Version is the app version reported as the MCP server identity; mirrors
	// GET /api/version (internal/system.Version). Empty falls back to "dev".
	Version string
	// RateLimitWindow and RateLimitMax mirror the app-level limiter's
	// configuration (GLP_RATE_LIMIT_WINDOW_MS/_MAX); zero falls back to
	// internal/ratelimit's defaults. The mux-wide limiter already covers
	// /api/mcp, so this only matters when the operator has raised the limit.
	RateLimitWindow time.Duration
	RateLimitMax    int
	// AllowWrite turns on the write tools (annotate_shot, set_known_grind,
	// mark_maintenance_done). Off by default and a second opt-in on top of
	// Enabled: when false the tools are never registered, so a client cannot
	// list or call them. cmd/server sets it from mcp.WriteEnabled().
	AllowWrite bool
	// AllowDeveloperTools turns on the read-only analysis tools that return
	// full-resolution or bulk data (currently get_shot_raw). A third,
	// independent opt-in on top of Enabled and independent of AllowWrite: when
	// false the tools are never registered, so a client cannot list or call
	// them. cmd/server sets it from mcp.DeveloperToolsEnabled().
	AllowDeveloperTools bool
}

// NewHandler builds the stateless Streamable-HTTP MCP endpoint: the SDK
// server, an Origin (DNS-rebinding) check, and a rate limiter sharing the
// REST API's defaults.
func NewHandler(deps Deps) http.Handler {
	srv := newServer(deps)
	opts := &mcpsdk.StreamableHTTPOptions{
		Stateless:    true,
		JSONResponse: true,
	}
	handler := mcpsdk.NewStreamableHTTPHandler(func(*http.Request) *mcpsdk.Server { return srv }, opts)
	window := deps.RateLimitWindow
	if window <= 0 {
		window = ratelimit.DefaultWindow
	}
	max := deps.RateLimitMax
	if max <= 0 {
		max = ratelimit.DefaultMax
	}
	limiter := ratelimit.New(window, max)
	return sameOrigin(limiter.Middleware(handler))
}

func newServer(deps Deps) *mcpsdk.Server {
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
	if deps.AllowWrite {
		instructions += " This server can also change a few things on the user's behalf: " +
			"annotate_shot merges rating, notes and grind setting into one shot, " +
			"set_known_grind remembers a bean's winning grind setting, " +
			"and mark_maintenance_done records that a maintenance task was completed."
	}
	if deps.AllowDeveloperTools {
		instructions += " Developer tools are enabled: " +
			"get_shot_raw returns a shot's full-resolution brew data for detailed analysis."
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
	registerPrompts(srv, deps.AllowWrite)
	if deps.AllowDeveloperTools {
		registerDeveloperTools(srv, deps)
	}
	if deps.AllowWrite {
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
