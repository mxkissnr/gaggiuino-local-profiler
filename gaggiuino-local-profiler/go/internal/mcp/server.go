package mcp

import (
	"net/http"
	"net/url"
	"strings"
	"time"

	mcpsdk "github.com/modelcontextprotocol/go-sdk/mcp"

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

// Deps is what the MCP server needs from its host application. Later slices
// add the library/analytics services here.
type Deps struct {
	Shots *shots.Service
	// Version is the app version reported as the MCP server identity; mirrors
	// GET /api/version (internal/system.Version). Empty falls back to "dev".
	Version string
	// RateLimitWindow and RateLimitMax mirror the app-level limiter's
	// configuration (GLP_RATE_LIMIT_WINDOW_MS/_MAX); zero falls back to
	// internal/ratelimit's defaults. The mux-wide limiter already covers
	// /api/mcp, so this only matters when the operator has raised the limit.
	RateLimitWindow time.Duration
	RateLimitMax    int
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
	srv := mcpsdk.NewServer(&mcpsdk.Implementation{
		Name:    serverName,
		Title:   serverTitle,
		Version: version,
	}, &mcpsdk.ServerOptions{
		Instructions: "Read-only access to the user's Gaggiuino Local Profiler espresso shot history. " +
			"Call list_shots to discover shot ids, get_shot for one shot's metrics and optional curve, " +
			"and compare_shots to compare two to five shots side by side.",
	})
	registerShotTools(srv, deps.Shots)
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
