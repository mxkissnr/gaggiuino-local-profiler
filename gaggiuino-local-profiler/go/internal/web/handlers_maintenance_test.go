package web

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/auth"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/db"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/library"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/maintenance"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// newTestMaintenanceServer opens a throwaway on-disk SQLite DB (same
// pattern as newTestServer/newTestLibraryServer above) and wires it into a
// fresh web.MaintenanceHandlers routed through a real *http.ServeMux, with
// the default machine already seeded (EnsureDefaultMachine).
func newTestMaintenanceServer(t *testing.T) (*http.ServeMux, *maintenance.Repository, *library.Repository, *machines.Registry) {
	t.Helper()
	dbPath := filepath.Join(t.TempDir(), "glp.db")
	sqlDB, err := db.Open(dbPath)
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { sqlDB.Close() })

	libRepo := library.NewRepository(sqlDB)
	shotsRepo := shots.NewRepository(sqlDB)
	registry := machines.NewRegistry(sqlDB)
	if err := registry.EnsureDefaultMachine(); err != nil {
		t.Fatalf("EnsureDefaultMachine: %v", err)
	}
	maintRepo := maintenance.NewRepository(sqlDB, libRepo)

	h := NewMaintenanceHandlers(maintRepo, shotsRepo, libRepo, registry)
	mux := http.NewServeMux()
	h.RegisterRoutes(mux)
	return mux, maintRepo, libRepo, registry
}

// ── Maintenance list ─────────────────────────────────────────────────────

// TestMaintenancePage_RendersTasks verifies GET /maintenance's structural
// content: the five static tasks (all "never done" — MAINTENANCE_DEFAULTS'
// zero state) plus a currently-registered grinder's own grinder_<id> tile,
// titled with the grinder's name (not the raw task key) — see
// view_maintenance.go's toMaintTile.
func TestMaintenancePage_RendersTasks(t *testing.T) {
	mux, _, libRepo, _ := newTestMaintenanceServer(t)
	if err := libRepo.SaveLibrary(library.Library{
		Grinders: []library.Entity{{"id": int64(5), "name": "Niche Zero"}},
	}); err != nil {
		t.Fatalf("SaveLibrary: %v", err)
	}

	rec := doRequest(t, mux, "GET", "/maintenance")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /maintenance: status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
		t.Errorf("Content-Type = %q, want text/html prefix", ct)
	}

	body := rec.Body.String()
	for _, want := range []string{
		"Descaling", "Backflush", "Grouphead", "Gaskets", "Water filter",
		"Niche Zero", // grinder_5's title, not the raw "grinder_5" key
		"never done",
		`hx-post="maintenance/descaling/done?machineId=1"`,
		`hx-post="maintenance/grinder_5/done?machineId=1"`,
	} {
		if !strings.Contains(body, want) {
			t.Errorf("GET /maintenance body missing %q\nbody:\n%s", want, body)
		}
	}
	assertNoRootAbsolutePaths(t, body)
}

// TestMaintenancePage_MachineSwitcher verifies the machine switcher only
// appears once more than one machine is registered, and links to the
// non-current machine.
func TestMaintenancePage_MachineSwitcher(t *testing.T) {
	mux, _, _, registry := newTestMaintenanceServer(t)

	rec := doRequest(t, mux, "GET", "/maintenance")
	if strings.Contains(rec.Body.String(), "maint-switcher") {
		t.Errorf("GET /maintenance with one machine: switcher should be absent\nbody:\n%s", rec.Body.String())
	}

	name, typ, host := "Kitchen Gaggiuino", "gaggiuino", "192.168.1.50"
	if _, err := registry.CreateMachine(machines.MachineInput{Name: &name, Type: &typ, Host: &host}); err != nil {
		t.Fatalf("CreateMachine: %v", err)
	}

	rec = doRequest(t, mux, "GET", "/maintenance")
	body := rec.Body.String()
	if !strings.Contains(body, "maint-switcher") {
		t.Errorf("GET /maintenance with two machines: switcher should be present\nbody:\n%s", body)
	}
	if !strings.Contains(body, "Kitchen Gaggiuino") {
		t.Errorf("GET /maintenance: switcher missing the second machine's name\nbody:\n%s", body)
	}
	if !strings.Contains(body, `href="maintenance?machineId=`) {
		t.Errorf("GET /maintenance: switcher link should be path-relative (no leading slash)\nbody:\n%s", body)
	}
	assertNoRootAbsolutePaths(t, body)
}

// extractRow returns the HTML between id="maint-row-<task>" and the next
// row's own id="maint-row-" anchor (or the end of body), so a test can
// assert on that one row's content without a false match against a sibling
// row that still says "never done".
func extractRow(body, task string) string {
	anchor := `id="maint-row-` + task + `"`
	start := strings.Index(body, anchor)
	if start < 0 {
		return ""
	}
	rest := body[start+len(anchor):]
	if next := strings.Index(rest, `id="maint-row-`); next >= 0 {
		return rest[:next]
	}
	return rest
}

// ── Mark done ─────────────────────────────────────────────────────────────

// TestDoneAction_MarksTaskDoneAndLogs drives the "mark done" htmx action end
// to end through maintenance.MarkTaskDone, verifying both of its side
// effects: the task's own lastDate/status flips to "ok", and a
// maintenance_log entry is added — the same log entry
// POST /api/maintenance/:task/done writes (see maintenance/service.go's
// MarkTaskDone doc comment on why this must not silently diverge from the
// REST path, the Phase 2d lesson this phase's dispatch brief calls out).
func TestDoneAction_MarksTaskDoneAndLogs(t *testing.T) {
	mux, maintRepo, _, _ := newTestMaintenanceServer(t)

	rec := doRequest(t, mux, "POST", "/maintenance/descaling/done?machineId=1")
	if rec.Code != http.StatusOK {
		t.Fatalf("POST /maintenance/descaling/done: status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if descalingRow := extractRow(rec.Body.String(), "descaling"); strings.Contains(descalingRow, "never done") {
		t.Errorf("descaling row still shows 'never done' after mark-done: %q", descalingRow)
	}

	entries, err := maintRepo.GetMaintenanceLog(1)
	if err != nil {
		t.Fatalf("GetMaintenanceLog: %v", err)
	}
	found := false
	for _, e := range entries {
		if e.Task == "descaling" {
			found = true
		}
	}
	if !found {
		t.Errorf("maintenance_log has no entry for descaling after mark-done — MarkTaskDone's AddMaintenanceLogEntry side effect is missing")
	}
}

// TestDoneAction_UnknownTask verifies the 404 branch for a task name that
// doesn't canonicalize (see internal/maintenance's canonicalTask) — a
// static-task typo or a grinder_<id> for a grinder that doesn't exist.
func TestDoneAction_UnknownTask(t *testing.T) {
	mux, _, _, _ := newTestMaintenanceServer(t)
	rec := doRequest(t, mux, "POST", "/maintenance/not-a-task/done")
	if rec.Code != http.StatusNotFound {
		t.Errorf("POST /maintenance/not-a-task/done: status = %d, want 404", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "Unknown task") {
		t.Errorf("POST /maintenance/not-a-task/done body = %q, want it to mention 'Unknown task'", rec.Body.String())
	}
}

// TestMaintenancePagesRequireAuthBehindRequireToken verifies the one write
// action this page registers — POST /maintenance/{task}/done — requires
// either genuine HA Ingress or a valid X-GLP-Token, while GET /maintenance
// stays reachable without one, exactly like every earlier phase's write
// actions (this is the check #901's dispatch brief calls out every new
// write route must get).
func TestMaintenancePagesRequireAuthBehindRequireToken(t *testing.T) {
	const testToken = "test-fixture-token-not-a-real-secret"

	mux, _, _, _ := newTestMaintenanceServer(t)
	handler := auth.RequireToken(testToken)(mux)

	doAuthedRequest := func(method, path, token string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, nil)
		req.RemoteAddr = "192.168.1.50:1234" // LAN, not Ingress/Supervisor
		if token != "" {
			req.Header.Set("X-GLP-Token", token)
		}
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		return rec
	}

	if rec := doAuthedRequest("GET", "/maintenance", ""); rec.Code != http.StatusOK {
		t.Errorf("GET /maintenance without a token: status = %d, want 200", rec.Code)
	}
	donePath := "/maintenance/descaling/done"
	if rec := doAuthedRequest("POST", donePath, ""); rec.Code != http.StatusUnauthorized {
		t.Errorf("POST %s without a token: status = %d, want 401", donePath, rec.Code)
	}
	if rec := doAuthedRequest("POST", donePath, testToken); rec.Code != http.StatusOK {
		t.Errorf("POST %s with a valid token: status = %d, want 200, body = %s", donePath, rec.Code, rec.Body.String())
	}
}
