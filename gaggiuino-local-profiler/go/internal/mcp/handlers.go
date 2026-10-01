package mcp

import (
	"net/http"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/httputil"
)

// This file serves the app-stored MCP settings (#1288): GET/POST
// /api/mcp/settings. They live under /api/ alongside the MCP endpoint itself
// (server.go's Path), so auth.RequireToken protects them with the same
// X-GLP-Token header as every other API route.

// SettingsView is the client-facing settings shape: the stored toggles plus
// developerToolsAvailable, which reports whether this build even offers the
// developer tools (the GLP_DEV_BUILD channel) — allowDeveloperTools can only
// ever be stored true on such a build.
type SettingsView struct {
	Enabled                 bool `json:"enabled"`
	AllowWrite              bool `json:"allowWrite"`
	AllowDeveloperTools     bool `json:"allowDeveloperTools"`
	DeveloperToolsAvailable bool `json:"developerToolsAvailable"`
}

func viewOf(s Settings) SettingsView {
	return SettingsView{
		Enabled:                 s.Enabled,
		AllowWrite:              s.AllowWrite,
		AllowDeveloperTools:     s.AllowDeveloperTools,
		DeveloperToolsAvailable: DevBuild(),
	}
}

// SettingsHandlers serves GET/POST /api/mcp/settings.
type SettingsHandlers struct{ repo *Repository }

func NewSettingsHandlers(repo *Repository) *SettingsHandlers {
	return &SettingsHandlers{repo: repo}
}

// RegisterRoutes mounts the settings API. The patterns are more specific than
// server.go's "/api/mcp", so net/http's ServeMux routes /api/mcp/settings here
// and everything else under /api/mcp to the MCP endpoint (see
// TestSettingsRoutesDoNotCollideWithMCPEndpoint). The route contract test in
// go/cmd/server/openapi_routes_test.go keeps both paths in sync with the
// OpenAPI description.
func (h *SettingsHandlers) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/mcp/settings", h.get)
	mux.HandleFunc("POST /api/mcp/settings", h.post)
}

func (h *SettingsHandlers) get(w http.ResponseWriter, _ *http.Request) {
	httputil.WriteJSON(w, http.StatusOK, viewOf(h.repo.GetSettings()))
}

func (h *SettingsHandlers) post(w http.ResponseWriter, r *http.Request) {
	body, ok := httputil.DecodeJSONBody[map[string]any](w, r, 1<<20)
	if !ok {
		return
	}
	// All three toggles are required booleans: the body is a full replace, so
	// a stale client can't silently leave one at its old value.
	enabled, hasEnabled := boolField(body, "enabled")
	allowWrite, hasWrite := boolField(body, "allowWrite")
	allowDev, hasDev := boolField(body, "allowDeveloperTools")
	if !hasEnabled || !hasWrite || !hasDev {
		httputil.WriteError(w, http.StatusBadRequest, "invalid MCP settings")
		return
	}
	if allowDev && !DevBuild() {
		httputil.WriteError(w, http.StatusBadRequest, "developer tools are not available on this build")
		return
	}
	saved, err := h.repo.SaveSettings(Settings{
		Enabled:             enabled,
		AllowWrite:          allowWrite,
		AllowDeveloperTools: allowDev,
	})
	if err != nil {
		httputil.InternalError(w, "mcp", err)
		return
	}
	httputil.WriteJSON(w, http.StatusOK, viewOf(saved))
}

// boolField returns (value, present-and-a-bool) for one key of a decoded JSON
// object.
func boolField(body map[string]any, key string) (bool, bool) {
	v, present := body[key]
	if !present {
		return false, false
	}
	b, isBool := v.(bool)
	return b, isBool
}
