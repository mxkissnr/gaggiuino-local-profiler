package mcp

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	mcpsdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// This file covers the app-stored settings API (#1288) and the per-request
// gating it drives: disabled -> 404, enabling without a restart, and the
// developer-tools dev-build rule. The write/developer tool registration
// itself is covered by tools_write_test.go / tools_developer_test.go.

func newSettingsServer(t *testing.T, repo *Repository) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	NewSettingsHandlers(repo).RegisterRoutes(mux)
	ts := httptest.NewServer(mux)
	t.Cleanup(ts.Close)
	return ts
}

func doJSON(t *testing.T, method, url, body string) (int, map[string]any) {
	t.Helper()
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	req, err := http.NewRequest(method, url, reader)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, url, err)
	}
	defer resp.Body.Close()
	out := map[string]any{}
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

func toolNameSet(t *testing.T, session *mcpsdk.ClientSession) map[string]bool {
	t.Helper()
	res, err := session.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatalf("ListTools: %v", err)
	}
	names := make(map[string]bool, len(res.Tools))
	for _, tool := range res.Tools {
		names[tool.Name] = true
	}
	return names
}

func newMCPHandler(t *testing.T, repo *Repository) *httptest.Server {
	t.Helper()
	_, sqlDB := newSettingsRepo(t)
	mux := http.NewServeMux()
	mux.Handle(Path, NewHandler(Deps{
		Shots:    shots.NewService(shots.NewRepository(sqlDB)),
		Version:  "test",
		Settings: repo,
	}))
	ts := httptest.NewServer(mux)
	t.Cleanup(ts.Close)
	return ts
}

func TestSettingsRoundTrip(t *testing.T) {
	t.Setenv("GLP_DEV_BUILD", "")
	repo, _ := newSettingsRepo(t)
	ts := newSettingsServer(t, repo)

	status, got := doJSON(t, http.MethodGet, ts.URL+"/api/mcp/settings", "")
	if status != http.StatusOK {
		t.Fatalf("GET status = %d, want 200", status)
	}
	if got["enabled"] != false || got["allowWrite"] != false || got["allowDeveloperTools"] != false {
		t.Fatalf("GET defaults = %#v, want all false", got)
	}
	if got["developerToolsAvailable"] != false {
		t.Fatalf("developerToolsAvailable = %v, want false on a non-dev build", got["developerToolsAvailable"])
	}

	status, got = doJSON(t, http.MethodPost, ts.URL+"/api/mcp/settings",
		`{"enabled":true,"allowWrite":true,"allowDeveloperTools":false}`)
	if status != http.StatusOK {
		t.Fatalf("POST status = %d, want 200", status)
	}
	if got["enabled"] != true || got["allowWrite"] != true {
		t.Fatalf("POST response = %#v, want enabled/allowWrite true", got)
	}

	_, got = doJSON(t, http.MethodGet, ts.URL+"/api/mcp/settings", "")
	if got["enabled"] != true || got["allowWrite"] != true {
		t.Fatalf("GET after save = %#v, want persisted values", got)
	}
}

func TestSettingsPostValidation(t *testing.T) {
	t.Setenv("GLP_DEV_BUILD", "")
	repo, _ := newSettingsRepo(t)
	ts := newSettingsServer(t, repo)

	for _, tc := range []struct{ name, body string }{
		{"missing field", `{"enabled":true,"allowWrite":false}`},
		{"non-boolean", `{"enabled":"yes","allowWrite":false,"allowDeveloperTools":false}`},
		{"empty body", ``},
		{"developer tools on non-dev build", `{"enabled":true,"allowWrite":false,"allowDeveloperTools":true}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			status, _ := doJSON(t, http.MethodPost, ts.URL+"/api/mcp/settings", tc.body)
			if status != http.StatusBadRequest {
				t.Fatalf("POST %s status = %d, want 400", tc.body, status)
			}
		})
	}
	if got := repo.GetSettings(); got != (Settings{}) {
		t.Fatalf("settings after rejected POSTs = %+v, want unchanged defaults", got)
	}

	t.Setenv("GLP_DEV_BUILD", "1")
	status, got := doJSON(t, http.MethodPost, ts.URL+"/api/mcp/settings",
		`{"enabled":true,"allowWrite":false,"allowDeveloperTools":true}`)
	if status != http.StatusOK {
		t.Fatalf("POST developer tools on a dev build status = %d, want 200", status)
	}
	if got["allowDeveloperTools"] != true || got["developerToolsAvailable"] != true {
		t.Fatalf("dev-build response = %#v, want allowDeveloperTools/developerToolsAvailable true", got)
	}
}

func TestSettingsRoutesDoNotCollideWithMCPEndpoint(t *testing.T) {
	repo, sqlDB := newSettingsRepo(t)
	mux := http.NewServeMux()
	mux.Handle(Path, NewHandler(Deps{
		Shots:    shots.NewService(shots.NewRepository(sqlDB)),
		Version:  "test",
		Settings: settingsSource(true, false, false),
	}))
	NewSettingsHandlers(repo).RegisterRoutes(mux)

	for method, want := range map[string]string{
		http.MethodGet:  "GET /api/mcp/settings",
		http.MethodPost: "POST /api/mcp/settings",
	} {
		if _, pattern := mux.Handler(httptest.NewRequest(method, "/api/mcp/settings", nil)); pattern != want {
			t.Fatalf("%s /api/mcp/settings matched %q, want %q", method, pattern, want)
		}
	}
	if _, pattern := mux.Handler(httptest.NewRequest(http.MethodPost, "/api/mcp", nil)); pattern != Path {
		t.Fatalf("/api/mcp matched %q, want %q", pattern, Path)
	}
}

func TestMCPDisabledAnswers404(t *testing.T) {
	repo, _ := newSettingsRepo(t)
	ts := newMCPHandler(t, repo)

	for _, method := range []string{http.MethodGet, http.MethodPost} {
		status, _ := doJSON(t, method, ts.URL+Path, `{}`)
		if status != http.StatusNotFound {
			t.Fatalf("%s %s status = %d, want 404 while disabled", method, Path, status)
		}
	}
}

func TestMCPEnableTakesEffectWithoutRestart(t *testing.T) {
	t.Setenv("GLP_DEV_BUILD", "")
	repo, _ := newSettingsRepo(t)
	ts := newMCPHandler(t, repo)

	if status, _ := doJSON(t, http.MethodGet, ts.URL+Path, ""); status != http.StatusNotFound {
		t.Fatalf("GET %s status = %d, want 404 before enable", Path, status)
	}

	if _, err := repo.SaveSettings(Settings{Enabled: true}); err != nil {
		t.Fatalf("SaveSettings: %v", err)
	}

	names := toolNameSet(t, connect(t, ts.URL+Path))
	if !names["list_shots"] {
		t.Fatalf("read tools missing after enabling without a restart: %v", names)
	}
	if names["annotate_shot"] {
		t.Fatalf("write tools registered without allowWrite: %v", names)
	}
	if names["get_shot_raw"] {
		t.Fatalf("developer tools registered without allowDeveloperTools: %v", names)
	}
}

func TestDeveloperToolsOnlyOnDevBuildEvenIfStored(t *testing.T) {
	t.Setenv("GLP_DEV_BUILD", "")
	repo, _ := newSettingsRepo(t)
	if _, err := repo.SaveSettings(Settings{Enabled: true, AllowDeveloperTools: true}); err != nil {
		t.Fatalf("SaveSettings: %v", err)
	}
	ts := newMCPHandler(t, repo)

	if names := toolNameSet(t, connect(t, ts.URL+Path)); names["get_shot_raw"] {
		t.Fatalf("developer tools registered on a non-dev build despite stored true: %v", names)
	}

	// Same stored row, now a dev build: the cached non-dev server must not be
	// reused, so the tools appear without a restart.
	t.Setenv("GLP_DEV_BUILD", "1")
	if names := toolNameSet(t, connect(t, ts.URL+Path)); !names["get_shot_raw"] {
		t.Fatalf("developer tools missing on a dev build: %v", names)
	}
}
