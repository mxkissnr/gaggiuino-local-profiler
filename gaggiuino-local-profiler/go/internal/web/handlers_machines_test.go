package web

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/auth"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/db"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines"
)

// newTestMachinesServer opens a throwaway on-disk SQLite DB (same pattern
// as newTestServer/newTestLibraryServer) and wires it into a fresh
// web.MachinesHandlers routed through a real *http.ServeMux, plus the
// static-asset route (normally registered by web.Handlers.RegisterRoutes,
// which these tests don't otherwise construct) so live.js/chart.js
// serving can be exercised too. poller is nil — these tests exercise the
// registry-driven surface (list, set-default, delete), not the reachable
// badge, which is nil-safe by design (see MachinesHandlers.rows' own
// comment).
//
// EnsureDefaultMachine runs up front, deterministically seeding machine #1
// ("Gaggiuino", is_default) before any test creates a second machine —
// otherwise whichever machine a test creates first would silently become
// the seeded "id 1, not actually flagged default" row instead (rows()'s
// own lazy EnsureDefaultMachine call only seeds when the registry is still
// completely empty), breaking every assumption below about id 1 being the
// default and id 2+ being the one under test.
func newTestMachinesServer(t *testing.T) (*http.ServeMux, *machines.Registry) {
	t.Helper()
	dbPath := filepath.Join(t.TempDir(), "glp.db")
	sqlDB, err := db.Open(dbPath)
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { sqlDB.Close() })

	registry := machines.NewRegistry(sqlDB)
	if err := registry.EnsureDefaultMachine(); err != nil {
		t.Fatalf("EnsureDefaultMachine: %v", err)
	}
	h := NewMachinesHandlers(registry, nil)
	mux := http.NewServeMux()
	h.RegisterRoutes(mux)
	mux.Handle("GET /web/static/", staticHandler())
	return mux, registry
}

func createTestMachine(t *testing.T, registry *machines.Registry, name, typ, host string) machines.Machine {
	t.Helper()
	m, err := registry.CreateMachine(machines.MachineInput{Name: &name, Type: &typ, Host: &host})
	if err != nil {
		t.Fatalf("CreateMachine(%s): %v", name, err)
	}
	return *m
}

// ── Machines list ──────────────────────────────────────────────────────

// TestMachinesPage_RendersMachines verifies GET /machines' structural
// content: the seeded default machine's name/type/badge, a second
// non-default machine's set-default/delete actions, and that the default
// machine itself offers neither (machines.templ's `if !row.IsDefault`).
func TestMachinesPage_RendersMachines(t *testing.T) {
	mux, registry := newTestMachinesServer(t)
	second := createTestMachine(t, registry, "Kitchen Gaggiuino", "gaggiuino", "192.168.1.50")

	rec := doRequest(t, mux, "GET", "/machines")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /machines: status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
		t.Errorf("Content-Type = %q, want text/html prefix", ct)
	}

	body := rec.Body.String()
	for _, want := range []string{
		"Gaggiuino", // seeded default machine's name
		"default",
		"Kitchen Gaggiuino",
		"192.168.1.50",
		`id="machine-row-1"`,
		`hx-post="machines"`, // the "New machine" create form (#901)
		`name="name"`,
	} {
		if !strings.Contains(body, want) {
			t.Errorf("GET /machines body missing %q\nbody:\n%s", want, body)
		}
	}
	wantActions := []string{
		`hx-post="machines/` + strconv.FormatInt(second.ID, 10) + `/default"`,
		`hx-post="machines/` + strconv.FormatInt(second.ID, 10) + `/delete"`,
	}
	for _, want := range wantActions {
		if !strings.Contains(body, want) {
			t.Errorf("GET /machines body missing %q for non-default machine\nbody:\n%s", want, body)
		}
	}
	if strings.Contains(body, `hx-post="machines/1/default"`) {
		t.Errorf("GET /machines: default machine (id 1) should not offer a set-default action\nbody:\n%s", body)
	}
	if strings.Contains(body, `hx-post="machines/1/delete"`) {
		t.Errorf("GET /machines: default machine (id 1) should not offer a delete action\nbody:\n%s", body)
	}
	assertNoRootAbsolutePaths(t, body)
}

// TestCreateMachineAction_RoundTrip drives the "New machine" form (#901)
// end to end, built on machines.CreateMachineChecked — the exact same
// validate -> SSRF-check -> Registry.CreateMachine sequence POST
// /api/machines' own handler now also calls.
func TestCreateMachineAction_RoundTrip(t *testing.T) {
	mux, registry := newTestMachinesServer(t)

	rec := doFormPost(t, mux, "/machines", url.Values{
		"name": {"Kitchen Gaggiuino"},
		"type": {"gaggiuino"},
		"host": {""}, // blank host is valid — see MachineInput.validate
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("POST /machines: status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "Kitchen Gaggiuino") {
		t.Errorf("POST /machines response missing the new machine\nbody:\n%s", rec.Body.String())
	}

	list, err := registry.ListMachines()
	if err != nil {
		t.Fatalf("ListMachines: %v", err)
	}
	if len(list) != 2 { // the seeded default + the newly created one
		t.Fatalf("registry has %d machines after create, want 2", len(list))
	}
}

// TestCreateMachineAction_ValidationError verifies a blank name is rejected
// by MachineInput.validate before reaching Registry.CreateMachine, answered
// as a 200 with formError set (not a non-2xx status — see machines.templ's
// MachinesContentFragment doc comment for why).
func TestCreateMachineAction_ValidationError(t *testing.T) {
	mux, registry := newTestMachinesServer(t)

	rec := doFormPost(t, mux, "/machines", url.Values{"name": {""}, "type": {"gaggiuino"}})
	if rec.Code != http.StatusOK {
		t.Fatalf("POST /machines (blank name): status = %d, want 200, body = %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "invalid machine") {
		t.Errorf("POST /machines (blank name) body missing validation error\nbody:\n%s", rec.Body.String())
	}

	list, err := registry.ListMachines()
	if err != nil {
		t.Fatalf("ListMachines: %v", err)
	}
	if len(list) != 1 { // only the seeded default machine
		t.Errorf("registry has %d machines after a rejected create, want 1", len(list))
	}
}

// TestUpdateAction_RoundTrip drives the Edit form's save action end to end
// on the seeded default machine (id 1) — Edit is offered for the default
// machine too, unlike Set default/Delete (machines.templ's own
// `if !row.IsDefault` gate on those two).
func TestUpdateAction_RoundTrip(t *testing.T) {
	mux, registry := newTestMachinesServer(t)

	rec := doFormPut(t, mux, "/machines/1", url.Values{
		"name": {"Renamed Gaggiuino"},
		"type": {"gaggiuino"},
		"host": {""},
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("PUT /machines/1: status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "Renamed Gaggiuino") {
		t.Errorf("PUT /machines/1 response missing the renamed machine\nbody:\n%s", rec.Body.String())
	}

	m, err := registry.GetMachine(1)
	if err != nil {
		t.Fatalf("GetMachine(1): %v", err)
	}
	if m == nil || m.Name != "Renamed Gaggiuino" {
		t.Errorf("machine 1 name = %v, want %q", m, "Renamed Gaggiuino")
	}
}

// TestUpdateAction_ValidationError verifies a blank name is rejected by
// MachineInput.validate before reaching Registry.UpdateMachine, answered as
// a 200 with formError set in the re-rendered edit form (same "success and
// failure share one fragment" convention MachinesContentFragment's own doc
// comment documents for the create form).
func TestUpdateAction_ValidationError(t *testing.T) {
	mux, registry := newTestMachinesServer(t)

	rec := doFormPut(t, mux, "/machines/1", url.Values{"name": {""}, "type": {"gaggiuino"}})
	if rec.Code != http.StatusOK {
		t.Fatalf("PUT /machines/1 (blank name): status = %d, want 200, body = %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "invalid machine") {
		t.Errorf("PUT /machines/1 (blank name) body missing validation error\nbody:\n%s", rec.Body.String())
	}

	m, err := registry.GetMachine(1)
	if err != nil {
		t.Fatalf("GetMachine(1): %v", err)
	}
	if m == nil || m.Name == "" {
		t.Errorf("machine 1 lost its name after a rejected update: %v", m)
	}
}

// TestSetDefaultAction_RoundTrip drives the one two-row-changing write
// action this page has: setting machine 2 as default flips both rows'
// badges/actions in the re-rendered list fragment.
func TestSetDefaultAction_RoundTrip(t *testing.T) {
	mux, registry := newTestMachinesServer(t)
	second := createTestMachine(t, registry, "Kitchen Gaggiuino", "gaggiuino", "192.168.1.50")

	rec := doRequest(t, mux, "POST", "/machines/"+strconv.FormatInt(second.ID, 10)+"/default")
	if rec.Code != http.StatusOK {
		t.Fatalf("POST /machines/%d/default: status = %d, body = %s", second.ID, rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	if !strings.Contains(body, `id="machine-list"`) {
		t.Errorf("set-default response should re-render the whole #machine-list container\nbody:\n%s", body)
	}
	if !strings.Contains(body, `hx-post="machines/1/default"`) {
		t.Errorf("set-default response: machine 1 should now offer a set-default action (no longer default)\nbody:\n%s", body)
	}
	if strings.Contains(body, `hx-post="machines/`+strconv.FormatInt(second.ID, 10)+`/default"`) {
		t.Errorf("set-default response: machine %d should no longer offer a set-default action (now default)\nbody:\n%s", second.ID, body)
	}

	updated, err := registry.GetMachine(second.ID)
	if err != nil {
		t.Fatalf("GetMachine: %v", err)
	}
	if !updated.IsDefault {
		t.Errorf("machine %d: IsDefault = false after SetDefaultMachine, want true", second.ID)
	}
}

func TestSetDefaultAction_InvalidID(t *testing.T) {
	mux, _ := newTestMachinesServer(t)
	rec := doRequest(t, mux, "POST", "/machines/not-a-number/default")
	if rec.Code != http.StatusBadRequest {
		t.Errorf("POST /machines/not-a-number/default: status = %d, want 400", rec.Code)
	}
}

func TestSetDefaultAction_NotFound(t *testing.T) {
	mux, _ := newTestMachinesServer(t)
	rec := doRequest(t, mux, "POST", "/machines/999/default")
	if rec.Code != http.StatusNotFound {
		t.Errorf("POST /machines/999/default: status = %d, want 404", rec.Code)
	}
}

// TestDeleteAction_RoundTrip verifies deleting a non-default machine
// removes its row (an empty 200 body, matching handlers.go's trashAction
// convention — htmx's outerHTML swap removes the element).
func TestDeleteAction_RoundTrip(t *testing.T) {
	mux, registry := newTestMachinesServer(t)
	second := createTestMachine(t, registry, "Kitchen Gaggiuino", "gaggiuino", "192.168.1.50")

	rec := doRequest(t, mux, "POST", "/machines/"+strconv.FormatInt(second.ID, 10)+"/delete")
	if rec.Code != http.StatusOK {
		t.Fatalf("POST /machines/%d/delete: status = %d, body = %s", second.ID, rec.Code, rec.Body.String())
	}
	if rec.Body.Len() != 0 {
		t.Errorf("POST /machines/%d/delete: body = %q, want empty", second.ID, rec.Body.String())
	}

	m, err := registry.GetMachine(second.ID)
	if err != nil {
		t.Fatalf("GetMachine: %v", err)
	}
	if m != nil {
		t.Errorf("machine %d still exists after delete", second.ID)
	}
}

// TestDeleteAction_CannotDeleteDefault pins Registry.DeleteMachine's
// ErrCannotDeleteDefault guard mapping to a 400 fragment — reachable via a
// direct request even though machines.templ's own markup never offers a
// delete button for the default row (a stale page, or a client bypassing
// the UI, could still send this).
func TestDeleteAction_CannotDeleteDefault(t *testing.T) {
	mux, registry := newTestMachinesServer(t)
	createTestMachine(t, registry, "Kitchen Gaggiuino", "gaggiuino", "192.168.1.50") // second machine, so "last machine" doesn't also fire

	rec := doRequest(t, mux, "POST", "/machines/1/delete")
	if rec.Code != http.StatusBadRequest {
		t.Errorf("POST /machines/1/delete (the default machine): status = %d, want 400", rec.Code)
	}
}

func TestDeleteAction_InvalidID(t *testing.T) {
	mux, _ := newTestMachinesServer(t)
	rec := doRequest(t, mux, "POST", "/machines/not-a-number/delete")
	if rec.Code != http.StatusBadRequest {
		t.Errorf("POST /machines/not-a-number/delete: status = %d, want 400", rec.Code)
	}
}

func TestDeleteAction_NotFound(t *testing.T) {
	mux, _ := newTestMachinesServer(t)
	rec := doRequest(t, mux, "POST", "/machines/999/delete")
	if rec.Code != http.StatusNotFound {
		t.Errorf("POST /machines/999/delete: status = %d, want 404", rec.Code)
	}
}

// ── Live page ──────────────────────────────────────────────────────────

// TestLivePage_RendersShell verifies GET /live's static chrome: the
// current (default) machine's name, the canvas element static/live.js
// draws onto, and both script tags that load the actual live-rendering
// logic (Chart.js, then live.js itself) — not the live data itself, which
// is entirely client-side (see templates/live.templ's own doc comment).
func TestLivePage_RendersShell(t *testing.T) {
	mux, _ := newTestMachinesServer(t)
	rec := doRequest(t, mux, "GET", "/live")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /live: status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
		t.Errorf("Content-Type = %q, want text/html prefix", ct)
	}
	body := rec.Body.String()
	for _, want := range []string{
		"Gaggiuino", // seeded default machine's name
		`id="liveChart"`,
		`src="web/static/vendor/chart-4.5.1.umd.min.js"`,
		`src="web/static/live.js"`,
		`id="live-status-badge"`,
	} {
		if !strings.Contains(body, want) {
			t.Errorf("GET /live body missing %q\nbody:\n%s", want, body)
		}
	}
	assertNoRootAbsolutePaths(t, body)
}

// ── Static assets ──────────────────────────────────────────────────────

// TestLiveJS_Served pins that /web/static/live.js is actually reachable and
// contains the SSE wiring the live page depends on — the same
// "prove the served source, not a browser run" pattern
// TestGlpTokenJS_UsesRelativeTokenFetchForIngress uses in handlers_test.go,
// since this test suite has no headless browser to drive the chart/SSE
// consumption end to end (noted as out of scope by the dispatch brief).
func TestLiveJS_Served(t *testing.T) {
	mux, _ := newTestMachinesServer(t)
	rec := doRequest(t, mux, "GET", "/web/static/live.js")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /web/static/live.js: status = %d", rec.Code)
	}
	body := rec.Body.String()
	for _, want := range []string{
		"EventSource('api/events')",
		"'live-snapshot'",
		"'preheat-update'",
		"api/live/data",
		"api/preheat",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("live.js body missing %q\nbody:\n%s", want, body)
		}
	}
}

// TestChartJS_Vendored_Served verifies the vendored Chart.js UMD build is
// reachable — a build-time embed.FS wiring bug (or a missed `cp` when
// vendoring it) would 404 here even though `go build` itself stays green,
// same rationale as TestStaticAssets_Served in handlers_test.go.
func TestChartJS_Vendored_Served(t *testing.T) {
	mux, _ := newTestMachinesServer(t)
	rec := doRequest(t, mux, "GET", "/web/static/vendor/chart-4.5.1.umd.min.js")
	if rec.Code != http.StatusOK {
		t.Errorf("GET /web/static/vendor/chart-4.5.1.umd.min.js: status = %d, want 200", rec.Code)
	}
}

// ── Auth ───────────────────────────────────────────────────────────────

// TestMachinesPagesRequireAuthBehindRequireToken wires this package's
// Machines/Live routes behind auth.RequireToken the same way cmd/server
// actually does (mirroring handlers_test.go's
// TestTrashRestore_RequireAuthBehindRequireToken and
// handlers_library_test.go's TestLibraryPagesRequireAuthBehindRequireToken)
// and confirms GET /machines and GET /live stay reachable without a token,
// while the two write actions this phase adds — POST /machines/{id}/default
// and POST /machines/{id}/delete — require either genuine HA Ingress or a
// valid X-GLP-Token, exactly like every earlier phase's write actions. This
// is the check #901's own dispatch brief calls out every new write route
// must get: Phase 2a shipped with exactly this class of CSRF gap before it
// was caught in review.
func TestMachinesPagesRequireAuthBehindRequireToken(t *testing.T) {
	const testToken = "test-fixture-token-not-a-real-secret"

	dbPath := filepath.Join(t.TempDir(), "glp.db")
	sqlDB, err := db.Open(dbPath)
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { sqlDB.Close() })

	registry := machines.NewRegistry(sqlDB)
	if err := registry.EnsureDefaultMachine(); err != nil {
		t.Fatalf("EnsureDefaultMachine: %v", err)
	}
	second := createTestMachine(t, registry, "Kitchen Gaggiuino", "gaggiuino", "192.168.1.50")

	h := NewMachinesHandlers(registry, nil)
	mux := http.NewServeMux()
	h.RegisterRoutes(mux)
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

	for _, path := range []string{"/machines", "/live"} {
		if rec := doAuthedRequest("GET", path, ""); rec.Code != http.StatusOK {
			t.Errorf("GET %s without a token: status = %d, want 200", path, rec.Code)
		}
	}

	if rec := doAuthedRequest("POST", "/machines", ""); rec.Code != http.StatusUnauthorized {
		t.Errorf("POST /machines without a token: status = %d, want 401", rec.Code)
	}
	if rec := doAuthedRequest("POST", "/machines", testToken); rec.Code != http.StatusOK {
		t.Errorf("POST /machines with a valid token: status = %d, want 200, body = %s", rec.Code, rec.Body.String())
	}

	// The Edit UI's PUT save action — GET (view/edit fragment) stays public,
	// PUT (the actual write) requires the same token every other write here
	// does.
	if rec := doAuthedRequest("GET", "/machines/1", ""); rec.Code != http.StatusOK {
		t.Errorf("GET /machines/1 without a token: status = %d, want 200", rec.Code)
	}
	if rec := doAuthedRequest("GET", "/machines/1/edit", ""); rec.Code != http.StatusOK {
		t.Errorf("GET /machines/1/edit without a token: status = %d, want 200", rec.Code)
	}
	if rec := doAuthedRequest("PUT", "/machines/1", ""); rec.Code != http.StatusUnauthorized {
		t.Errorf("PUT /machines/1 without a token: status = %d, want 401", rec.Code)
	}
	if rec := doAuthedRequest("PUT", "/machines/1", testToken); rec.Code != http.StatusOK {
		t.Errorf("PUT /machines/1 with a valid token: status = %d, want 200, body = %s", rec.Code, rec.Body.String())
	}

	defaultPath := "/machines/" + strconv.FormatInt(second.ID, 10) + "/default"
	if rec := doAuthedRequest("POST", defaultPath, ""); rec.Code != http.StatusUnauthorized {
		t.Errorf("POST %s without a token: status = %d, want 401", defaultPath, rec.Code)
	}
	if rec := doAuthedRequest("POST", defaultPath, testToken); rec.Code != http.StatusOK {
		t.Errorf("POST %s with a valid token: status = %d, want 200, body = %s", defaultPath, rec.Code, rec.Body.String())
	}

	// The successful default-switch above just made machine `second` the
	// new default, and machine 1 (the seeded "Gaggiuino" row) the non-
	// default one — deleting id 1 (not `second`) is the one now guaranteed
	// to hit DeleteMachine's success path rather than its
	// ErrCannotDeleteDefault guard.
	deletePath := "/machines/1/delete"
	if rec := doAuthedRequest("POST", deletePath, ""); rec.Code != http.StatusUnauthorized {
		t.Errorf("POST %s without a token: status = %d, want 401", deletePath, rec.Code)
	}
	if rec := doAuthedRequest("POST", deletePath, testToken); rec.Code != http.StatusOK {
		t.Errorf("POST %s with a valid token: status = %d, want 200, body = %s", deletePath, rec.Code, rec.Body.String())
	}
}
