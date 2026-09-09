package web

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/auth"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/db"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/library"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// newTestLibraryServer opens a throwaway on-disk SQLite DB (same pattern as
// newTestServer above and internal/library's own helpers_test.go) and wires
// it into a fresh web.LibraryHandlers routed through a real *http.ServeMux.
func newTestLibraryServer(t *testing.T) (*http.ServeMux, *library.Repository, *shots.Repository) {
	t.Helper()
	dbPath := filepath.Join(t.TempDir(), "glp.db")
	sqlDB, err := db.Open(dbPath)
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { sqlDB.Close() })

	libRepo := library.NewRepository(sqlDB)
	shotsRepo := shots.NewRepository(sqlDB)
	h := NewLibraryHandlers(libRepo, shotsRepo)
	mux := http.NewServeMux()
	h.RegisterRoutes(mux)
	return mux, libRepo, shotsRepo
}

// ── Beans ──────────────────────────────────────────────────────────────

func TestBeansPage_RendersBeans(t *testing.T) {
	mux, libRepo, _ := newTestLibraryServer(t)
	lib := library.Library{
		Beans: []library.Entity{
			{
				"id": int64(1), "name": "Ethiopia Yirgacheffe", "roaster": "Roaster A",
				"category": "speciality", "stock_g": 250.0,
				"bags": []any{library.Entity{"roastDate": "2026-01-01"}},
			},
			{
				"id": int64(2), "name": "Decaf Blend", "decaf": true, "enabled": false,
			},
		},
	}
	if err := libRepo.SaveLibrary(lib); err != nil {
		t.Fatalf("SaveLibrary: %v", err)
	}

	rec := doRequest(t, mux, "GET", "/beans")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /beans: status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
		t.Errorf("Content-Type = %q, want text/html prefix", ct)
	}

	body := rec.Body.String()
	for _, want := range []string{
		"Ethiopia Yirgacheffe",
		"Roaster A",
		"speciality",
		"roasted 2026-01-01",
		"250 g",
		"250 g left", // remaining == full stock, nothing consumed yet
		"Decaf Blend",
		"decaf",
		"disabled",
		`hx-post="beans/1/toggle-active"`,
		`hx-post="beans/2/toggle-active"`,
		"Disable",         // bean 1: enabled -> offers Disable
		"Enable",          // bean 2: disabled -> offers Enable
		`hx-post="beans"`, // the "New bean" create form (#901)
		`name="name"`,
		`name="roaster"`,
	} {
		if !strings.Contains(body, want) {
			t.Errorf("GET /beans body missing %q\nbody:\n%s", want, body)
		}
	}
	assertNoRootAbsolutePaths(t, body)
}

// TestCreateBeanAction_RoundTrip drives the "New bean" form (#901) end to
// end: a successful submission persists the bean via library.CreateBean —
// the exact same function POST /api/library/bean's own handler now also
// calls — and the re-rendered fragment shows it in the list with a cleared
// form (no formError).
func TestCreateBeanAction_RoundTrip(t *testing.T) {
	mux, libRepo, _ := newTestLibraryServer(t)

	rec := doFormPost(t, mux, "/beans", url.Values{
		"name":     {"Kenya AA"},
		"roaster":  {"Roaster B"},
		"category": {"speciality"},
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("POST /beans: status = %d, body = %s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	if !strings.Contains(body, "Kenya AA") || !strings.Contains(body, "Roaster B") {
		t.Errorf("POST /beans response missing the new bean\nbody:\n%s", body)
	}
	if strings.Contains(body, "badge-err") {
		t.Errorf("POST /beans response has an error badge on a valid submission\nbody:\n%s", body)
	}
	assertNoRootAbsolutePaths(t, body)

	lib, err := libRepo.GetLibrary()
	if err != nil {
		t.Fatalf("GetLibrary: %v", err)
	}
	if len(lib.Beans) != 1 {
		t.Fatalf("library has %d beans after create, want 1", len(lib.Beans))
	}
}

// TestCreateBeanAction_ValidationError verifies a blank name is rejected by
// library.CreateBean's own validation, answered as a 200 with formError set
// in the re-rendered fragment (not a non-2xx status — see library.templ's
// doc comment on why htmx's default responseHandling would otherwise drop
// the error).
func TestCreateBeanAction_ValidationError(t *testing.T) {
	mux, libRepo, _ := newTestLibraryServer(t)

	rec := doFormPost(t, mux, "/beans", url.Values{"name": {"  "}})
	if rec.Code != http.StatusOK {
		t.Fatalf("POST /beans (blank name): status = %d, want 200, body = %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "name required") {
		t.Errorf("POST /beans (blank name) body missing validation error\nbody:\n%s", rec.Body.String())
	}

	lib, err := libRepo.GetLibrary()
	if err != nil {
		t.Fatalf("GetLibrary: %v", err)
	}
	if len(lib.Beans) != 0 {
		t.Errorf("library has %d beans after a rejected create, want 0", len(lib.Beans))
	}
}

func TestBeansPage_Empty(t *testing.T) {
	mux, _, _ := newTestLibraryServer(t)
	rec := doRequest(t, mux, "GET", "/beans")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /beans: status = %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "No beans yet.") {
		t.Errorf("GET /beans body missing empty-state message:\n%s", rec.Body.String())
	}
}

// TestToggleBeanActiveAction_RoundTrip drives the one write action Beans
// gets in this phase end to end: toggling flips the enabled flag (persisted
// via library.ToggleBeanActive, the same function
// internal/library/handlers_beans.go's REST handler now also calls) and the
// returned fragment reflects the new state.
func TestToggleBeanActiveAction_RoundTrip(t *testing.T) {
	mux, libRepo, _ := newTestLibraryServer(t)
	if err := libRepo.SaveLibrary(library.Library{
		Beans: []library.Entity{{"id": int64(10), "name": "Kenya AA"}},
	}); err != nil {
		t.Fatalf("SaveLibrary: %v", err)
	}

	rec := doRequest(t, mux, "POST", "/beans/10/toggle-active")
	if rec.Code != http.StatusOK {
		t.Fatalf("POST /beans/10/toggle-active: status = %d, body = %s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	if !strings.Contains(body, `id="bean-row-10"`) {
		t.Errorf("toggle response missing bean-row-10 fragment\nbody:\n%s", body)
	}
	if !strings.Contains(body, "disabled") || !strings.Contains(body, "Enable") {
		t.Errorf("toggle response should show the bean as disabled with an Enable action\nbody:\n%s", body)
	}

	lib, err := libRepo.GetLibrary()
	if err != nil {
		t.Fatalf("GetLibrary: %v", err)
	}
	if enabled, _ := lib.Beans[0]["enabled"].(bool); enabled {
		t.Errorf("bean 10: enabled = true after toggle, want false")
	}

	// Toggle back.
	rec = doRequest(t, mux, "POST", "/beans/10/toggle-active")
	if rec.Code != http.StatusOK {
		t.Fatalf("POST /beans/10/toggle-active (2nd): status = %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "Disable") {
		t.Errorf("toggle-back response should show the bean as enabled with a Disable action\nbody:\n%s", rec.Body.String())
	}
}

// TestToggleBeanActiveAction_SingleLibraryRead guards against a #901
// code-review regression: toggleBeanActiveAction used to call
// h.repo.GetLibrary() a second time, right after library.ToggleBeanActive
// had already read (and saved) the same Library, purely to re-render one
// row. Asserting on the response alone can't catch this (both the buggy and
// fixed handler answer identically), so this drives the request through a
// countingDriver-backed DB (counting_driver_test.go) and counts how many
// `SELECT ... FROM library` reads the toggle request actually issues.
func TestToggleBeanActiveAction_SingleLibraryRead(t *testing.T) {
	mux, libRepo, tracker := newCountingTestLibraryServer(t)
	if err := libRepo.SaveLibrary(library.Library{
		Beans: []library.Entity{{"id": int64(10), "name": "Kenya AA"}},
	}); err != nil {
		t.Fatalf("SaveLibrary: %v", err)
	}
	tracker.reset() // drop the fixture SaveLibrary's own traffic before measuring

	rec := doRequest(t, mux, "POST", "/beans/10/toggle-active")
	if rec.Code != http.StatusOK {
		t.Fatalf("POST /beans/10/toggle-active: status = %d, body = %s", rec.Code, rec.Body.String())
	}

	if got := tracker.count("FROM library"); got != 1 {
		t.Errorf("GetLibrary reads during one toggle-active request = %d, want 1 (ToggleBeanActive's own read should be reused, not re-fetched)", got)
	}
}

func TestToggleBeanActiveAction_InvalidID(t *testing.T) {
	mux, _, _ := newTestLibraryServer(t)
	rec := doRequest(t, mux, "POST", "/beans/not-a-number/toggle-active")
	if rec.Code != http.StatusBadRequest {
		t.Errorf("POST /beans/not-a-number/toggle-active: status = %d, want 400", rec.Code)
	}
}

func TestToggleBeanActiveAction_NotFound(t *testing.T) {
	mux, _, _ := newTestLibraryServer(t)
	rec := doRequest(t, mux, "POST", "/beans/999/toggle-active")
	if rec.Code != http.StatusNotFound {
		t.Errorf("POST /beans/999/toggle-active: status = %d, want 404", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "Bean not found") {
		t.Errorf("POST /beans/999/toggle-active body = %q, want it to mention 'Bean not found'", rec.Body.String())
	}
}

// TestBeanEditAction_RendersForm verifies GET /beans/{id}/edit swaps the
// row for a pre-filled edit form (#901 Edit UI).
func TestBeanEditAction_RendersForm(t *testing.T) {
	mux, libRepo, _ := newTestLibraryServer(t)
	if err := libRepo.SaveLibrary(library.Library{
		Beans: []library.Entity{{"id": int64(1), "name": "Kenya AA", "roaster": "Roaster B", "category": "speciality"}},
	}); err != nil {
		t.Fatalf("SaveLibrary: %v", err)
	}

	rec := doRequest(t, mux, "GET", "/beans/1/edit")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /beans/1/edit: status = %d, body = %s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	for _, want := range []string{`hx-put="beans/1"`, `value="Kenya AA"`, `value="Roaster B"`} {
		if !strings.Contains(body, want) {
			t.Errorf("GET /beans/1/edit body missing %q\nbody:\n%s", want, body)
		}
	}
}

// TestUpdateBeanAction_RoundTrip drives the Edit form's save action end to
// end, including the decaf checkbox's decaf_present hidden-field trick
// (BeanEditFragment's own doc comment) — unchecking (i.e. omitting) decaf
// while decaf_present is still submitted must clear a previously-true decaf
// flag, not silently leave it set.
func TestUpdateBeanAction_RoundTrip(t *testing.T) {
	mux, libRepo, _ := newTestLibraryServer(t)
	if err := libRepo.SaveLibrary(library.Library{
		Beans: []library.Entity{{"id": int64(1), "name": "Kenya AA", "decaf": true}},
	}); err != nil {
		t.Fatalf("SaveLibrary: %v", err)
	}

	rec := doFormPut(t, mux, "/beans/1", url.Values{
		"name":          {"Kenya AA Updated"},
		"roaster":       {"New Roaster"},
		"category":      {"speciality"},
		"stock_g":       {"180"},
		"decaf_present": {"1"}, // decaf checkbox itself omitted -> unchecked
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("PUT /beans/1: status = %d, body = %s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	if !strings.Contains(body, "Kenya AA Updated") || !strings.Contains(body, "New Roaster") {
		t.Errorf("PUT /beans/1 response missing updated fields\nbody:\n%s", body)
	}
	if strings.Contains(body, ">decaf<") {
		t.Errorf("PUT /beans/1 response still shows the decaf badge after unchecking it\nbody:\n%s", body)
	}

	lib, err := libRepo.GetLibrary()
	if err != nil {
		t.Fatalf("GetLibrary: %v", err)
	}
	if lib.Beans[0]["name"] != "Kenya AA Updated" {
		t.Errorf("bean name = %v, want %q", lib.Beans[0]["name"], "Kenya AA Updated")
	}
	if decaf, _ := lib.Beans[0]["decaf"].(bool); decaf {
		t.Errorf("bean decaf = true, want false after unchecking the Edit form's checkbox")
	}
}

func TestUpdateBeanAction_NotFound(t *testing.T) {
	mux, _, _ := newTestLibraryServer(t)
	rec := doFormPut(t, mux, "/beans/999", url.Values{"name": {"x"}})
	if rec.Code != http.StatusNotFound {
		t.Errorf("PUT /beans/999: status = %d, want 404", rec.Code)
	}
}

// ── Grinders ───────────────────────────────────────────────────────────

func TestGrindersPage_RendersGrinders(t *testing.T) {
	mux, libRepo, shotsRepo := newTestLibraryServer(t)
	if err := libRepo.SaveLibrary(library.Library{
		Grinders: []library.Entity{
			{"id": int64(1), "name": "Niche Zero", "burrType": "conical", "purchaseDate": "2025-01-01"},
		},
	}); err != nil {
		t.Fatalf("SaveLibrary: %v", err)
	}
	upsertTestShot(t, shotsRepo, 1, 1_700_000_000, "Espresso", map[string]any{
		"grinder": "Niche Zero",
		"dose":    18.0,
	})

	rec := doRequest(t, mux, "GET", "/grinders")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /grinders: status = %d, body = %s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	for _, want := range []string{
		"Niche Zero",
		"conical",
		"purchased 2025-01-01",
		"1 shots / 18 g since burr swap",
		`hx-post="grinders"`, // the "New grinder" create form (#901)
		`name="name"`,
	} {
		if !strings.Contains(body, want) {
			t.Errorf("GET /grinders body missing %q\nbody:\n%s", want, body)
		}
	}
	assertNoRootAbsolutePaths(t, body)
}

func TestGrindersPage_Empty(t *testing.T) {
	mux, _, _ := newTestLibraryServer(t)
	rec := doRequest(t, mux, "GET", "/grinders")
	if !strings.Contains(rec.Body.String(), "No grinders yet.") {
		t.Errorf("GET /grinders body missing empty-state message:\n%s", rec.Body.String())
	}
}

// TestCreateGrinderAction_RoundTrip drives the "New grinder" form (#901)
// end to end, built on library.CreateGrinder.
func TestCreateGrinderAction_RoundTrip(t *testing.T) {
	mux, libRepo, _ := newTestLibraryServer(t)

	rec := doFormPost(t, mux, "/grinders", url.Values{
		"name":         {"Niche Zero"},
		"burrType":     {"conical"},
		"purchaseDate": {"2025-01-01"},
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("POST /grinders: status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "Niche Zero") {
		t.Errorf("POST /grinders response missing the new grinder\nbody:\n%s", rec.Body.String())
	}

	lib, err := libRepo.GetLibrary()
	if err != nil {
		t.Fatalf("GetLibrary: %v", err)
	}
	if len(lib.Grinders) != 1 {
		t.Fatalf("library has %d grinders after create, want 1", len(lib.Grinders))
	}
}

// ── Baskets ────────────────────────────────────────────────────────────

func TestBasketsPage_RendersBaskets(t *testing.T) {
	mux, libRepo, _ := newTestLibraryServer(t)
	if err := libRepo.SaveLibrary(library.Library{
		Baskets: []library.Entity{
			{"id": int64(1), "name": "VST 18g", "wallType": "straight", "shape": "round", "doseCapacity": "18g", "holeCount": "20"},
		},
	}); err != nil {
		t.Fatalf("SaveLibrary: %v", err)
	}

	rec := doRequest(t, mux, "GET", "/baskets")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /baskets: status = %d, body = %s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	for _, want := range []string{"VST 18g", "straight", "round", "18g", "20 holes", `hx-post="baskets"`} {
		if !strings.Contains(body, want) {
			t.Errorf("GET /baskets body missing %q\nbody:\n%s", want, body)
		}
	}
	assertNoRootAbsolutePaths(t, body)
}

func TestBasketsPage_Empty(t *testing.T) {
	mux, _, _ := newTestLibraryServer(t)
	rec := doRequest(t, mux, "GET", "/baskets")
	if !strings.Contains(rec.Body.String(), "No baskets yet.") {
		t.Errorf("GET /baskets body missing empty-state message:\n%s", rec.Body.String())
	}
}

// TestCreateBasketAction_RoundTrip drives the "New basket" form (#901) end
// to end, built on library.CreateBasket.
func TestCreateBasketAction_RoundTrip(t *testing.T) {
	mux, libRepo, _ := newTestLibraryServer(t)

	rec := doFormPost(t, mux, "/baskets", url.Values{
		"name":     {"VST 20g"},
		"wallType": {"precision-machined"},
		"shape":    {"straight"},
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("POST /baskets: status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "VST 20g") {
		t.Errorf("POST /baskets response missing the new basket\nbody:\n%s", rec.Body.String())
	}

	lib, err := libRepo.GetLibrary()
	if err != nil {
		t.Fatalf("GetLibrary: %v", err)
	}
	if len(lib.Baskets) != 1 {
		t.Fatalf("library has %d baskets after create, want 1", len(lib.Baskets))
	}
}

// TestCreateBasketAction_InvalidWallTypeRejected pins CreateBasket's enum
// validation (an exact port of the REST endpoint's own check) round trips
// through the web form's own error path.
func TestCreateBasketAction_InvalidWallTypeRejected(t *testing.T) {
	mux, libRepo, _ := newTestLibraryServer(t)

	rec := doFormPost(t, mux, "/baskets", url.Values{
		"name":     {"Bad basket"},
		"wallType": {"not-a-real-type"},
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("POST /baskets (bad wallType): status = %d, want 200, body = %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "invalid wallType") {
		t.Errorf("POST /baskets (bad wallType) body missing validation error\nbody:\n%s", rec.Body.String())
	}
	lib, err := libRepo.GetLibrary()
	if err != nil {
		t.Fatalf("GetLibrary: %v", err)
	}
	if len(lib.Baskets) != 0 {
		t.Errorf("library has %d baskets after a rejected create, want 0", len(lib.Baskets))
	}
}

// TestUpdateBasketAction_InvalidWallTypeRejected verifies the Edit form's
// save action carries the same wallType/shape enum validation
// library.UpdateBasket enforces — not just the New-basket create form.
func TestUpdateBasketAction_InvalidWallTypeRejected(t *testing.T) {
	mux, libRepo, _ := newTestLibraryServer(t)
	if err := libRepo.SaveLibrary(library.Library{
		Baskets: []library.Entity{{"id": int64(1), "name": "VST", "wallType": "single-wall"}},
	}); err != nil {
		t.Fatalf("SaveLibrary: %v", err)
	}

	rec := doFormPut(t, mux, "/baskets/1", url.Values{"name": {"VST"}, "wallType": {"not-a-real-type"}})
	if rec.Code != http.StatusOK {
		t.Fatalf("PUT /baskets/1 (bad wallType): status = %d, want 200, body = %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "invalid wallType") {
		t.Errorf("PUT /baskets/1 (bad wallType) body missing validation error\nbody:\n%s", rec.Body.String())
	}
	lib, err := libRepo.GetLibrary()
	if err != nil {
		t.Fatalf("GetLibrary: %v", err)
	}
	if lib.Baskets[0]["wallType"] != "single-wall" {
		t.Errorf("basket wallType = %v, want unchanged %q after a rejected update", lib.Baskets[0]["wallType"], "single-wall")
	}
}

// ── Puck screens ───────────────────────────────────────────────────────

func TestPuckScreensPage_RendersPuckScreens(t *testing.T) {
	mux, libRepo, _ := newTestLibraryServer(t)
	if err := libRepo.SaveLibrary(library.Library{
		PuckScreens: []library.Entity{
			{"id": int64(1), "name": "IMS puck screen", "thickness": "1.4mm", "material": "stainless"},
		},
	}); err != nil {
		t.Fatalf("SaveLibrary: %v", err)
	}

	rec := doRequest(t, mux, "GET", "/puckscreens")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /puckscreens: status = %d, body = %s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	for _, want := range []string{"IMS puck screen", "1.4mm", "stainless", `hx-post="puckscreens"`} {
		if !strings.Contains(body, want) {
			t.Errorf("GET /puckscreens body missing %q\nbody:\n%s", want, body)
		}
	}
	assertNoRootAbsolutePaths(t, body)
}

func TestPuckScreensPage_Empty(t *testing.T) {
	mux, _, _ := newTestLibraryServer(t)
	rec := doRequest(t, mux, "GET", "/puckscreens")
	if !strings.Contains(rec.Body.String(), "No puck screens yet.") {
		t.Errorf("GET /puckscreens body missing empty-state message:\n%s", rec.Body.String())
	}
}

// TestCreatePuckScreenAction_RoundTrip drives the "New puck screen" form
// (#901) end to end, built on library.CreatePuckScreen.
func TestCreatePuckScreenAction_RoundTrip(t *testing.T) {
	mux, libRepo, _ := newTestLibraryServer(t)

	rec := doFormPost(t, mux, "/puckscreens", url.Values{
		"name":      {"IMS puck screen"},
		"thickness": {"thin"},
		"material":  {"stainless"},
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("POST /puckscreens: status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "IMS puck screen") {
		t.Errorf("POST /puckscreens response missing the new puck screen\nbody:\n%s", rec.Body.String())
	}

	lib, err := libRepo.GetLibrary()
	if err != nil {
		t.Fatalf("GetLibrary: %v", err)
	}
	if len(lib.PuckScreens) != 1 {
		t.Fatalf("library has %d puck screens after create, want 1", len(lib.PuckScreens))
	}
}

// ── Milks ──────────────────────────────────────────────────────────────

func TestMilksPage_RendersMilks(t *testing.T) {
	mux, libRepo, _ := newTestLibraryServer(t)
	if err := libRepo.SaveLibrary(library.Library{
		Milks: []library.Entity{
			{"id": int64(1), "name": "Oat Milk", "emoji": "🌾", "stockMl": 500.0},
			{"id": int64(2), "name": "Whole Milk", "stockMl": 1000.0}, // no emoji -> defaults to 🥛
		},
	}); err != nil {
		t.Fatalf("SaveLibrary: %v", err)
	}

	rec := doRequest(t, mux, "GET", "/milks")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /milks: status = %d, body = %s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	for _, want := range []string{"Oat Milk", "🌾", "500 ml", "Whole Milk", "🥛", "1000 ml", `hx-post="milks"`} {
		if !strings.Contains(body, want) {
			t.Errorf("GET /milks body missing %q\nbody:\n%s", want, body)
		}
	}
	assertNoRootAbsolutePaths(t, body)
}

func TestMilksPage_Empty(t *testing.T) {
	mux, _, _ := newTestLibraryServer(t)
	rec := doRequest(t, mux, "GET", "/milks")
	if !strings.Contains(rec.Body.String(), "No milks yet.") {
		t.Errorf("GET /milks body missing empty-state message:\n%s", rec.Body.String())
	}
}

// TestCreateMilkAction_RoundTrip drives the "New milk" form (#901) end to
// end, built on library.CreateMilk — including the stockMl numeric field's
// own strconv.ParseFloat parse step (handlers_library.go's
// createMilkAction, the one create form that parses a non-string field
// itself before calling into internal/library).
func TestCreateMilkAction_RoundTrip(t *testing.T) {
	mux, libRepo, _ := newTestLibraryServer(t)

	rec := doFormPost(t, mux, "/milks", url.Values{
		"name":    {"Oat Milk"},
		"emoji":   {"🌾"},
		"stockMl": {"500"},
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("POST /milks: status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "Oat Milk") || !strings.Contains(rec.Body.String(), "500 ml") {
		t.Errorf("POST /milks response missing the new milk\nbody:\n%s", rec.Body.String())
	}

	lib, err := libRepo.GetLibrary()
	if err != nil {
		t.Fatalf("GetLibrary: %v", err)
	}
	if len(lib.Milks) != 1 {
		t.Fatalf("library has %d milks after create, want 1", len(lib.Milks))
	}
}

// TestCreateMilkAction_InvalidStockCoercedToZero verifies a non-numeric
// stockMl no longer gets its own stricter pre-validation (#901 code review
// finding #6: createMilkAction used to strconv.ParseFloat stockMl itself
// and reject a bad value outright — the only one of the six create actions
// with parsing behavior stricter than, and different from, its own REST
// counterpart for the same field). It's now handed to library.CreateMilk
// exactly like every other field, whose own floatOrZero coercion silently
// treats an unparseable value as 0 — the same behavior POST
// /api/library/milk already has for a non-numeric stockMl, so a form
// submission and the REST endpoint now agree.
func TestCreateMilkAction_InvalidStockCoercedToZero(t *testing.T) {
	mux, libRepo, _ := newTestLibraryServer(t)

	rec := doFormPost(t, mux, "/milks", url.Values{"name": {"Oat Milk"}, "stockMl": {"not-a-number"}})
	if rec.Code != http.StatusOK {
		t.Fatalf("POST /milks (bad stockMl): status = %d, want 200, body = %s", rec.Code, rec.Body.String())
	}
	lib, err := libRepo.GetLibrary()
	if err != nil {
		t.Fatalf("GetLibrary: %v", err)
	}
	if len(lib.Milks) != 1 {
		t.Fatalf("library has %d milks after create, want 1", len(lib.Milks))
	}
	if stock := lib.Milks[0]["stockMl"]; stock != float64(0) {
		t.Errorf("milk.stockMl = %v, want 0 (non-numeric input coerced, not rejected)", stock)
	}
}

// ── Recipes ────────────────────────────────────────────────────────────

func TestRecipesPage_RendersRecipes(t *testing.T) {
	mux, libRepo, _ := newTestLibraryServer(t)
	if err := libRepo.SaveLibrary(library.Library{
		Recipes: []library.Entity{
			{"id": int64(1), "name": "V60", "brewMethod": "pourover", "drinkType": "filter"},
		},
	}); err != nil {
		t.Fatalf("SaveLibrary: %v", err)
	}

	rec := doRequest(t, mux, "GET", "/recipes")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /recipes: status = %d, body = %s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	for _, want := range []string{"V60", "pourover", "filter", `hx-post="recipes"`} {
		if !strings.Contains(body, want) {
			t.Errorf("GET /recipes body missing %q\nbody:\n%s", want, body)
		}
	}
	assertNoRootAbsolutePaths(t, body)
}

func TestRecipesPage_Empty(t *testing.T) {
	mux, _, _ := newTestLibraryServer(t)
	rec := doRequest(t, mux, "GET", "/recipes")
	if !strings.Contains(rec.Body.String(), "No recipes yet.") {
		t.Errorf("GET /recipes body missing empty-state message:\n%s", rec.Body.String())
	}
}

// TestCreateRecipeAction_RoundTrip drives the "New recipe" form (#901) end
// to end, built on library.CreateRecipe.
func TestCreateRecipeAction_RoundTrip(t *testing.T) {
	mux, libRepo, _ := newTestLibraryServer(t)

	rec := doFormPost(t, mux, "/recipes", url.Values{
		"name":       {"V60"},
		"brewMethod": {"v60"},
		"drinkType":  {"filter"},
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("POST /recipes: status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "V60") {
		t.Errorf("POST /recipes response missing the new recipe\nbody:\n%s", rec.Body.String())
	}

	lib, err := libRepo.GetLibrary()
	if err != nil {
		t.Fatalf("GetLibrary: %v", err)
	}
	if len(lib.Recipes) != 1 {
		t.Fatalf("library has %d recipes after create, want 1", len(lib.Recipes))
	}
}

// ── Auth ───────────────────────────────────────────────────────────────

// TestLibraryPagesRequireAuthBehindRequireToken wires this package's Library
// routes behind auth.RequireToken the same way cmd/server actually does
// (mirroring handlers_test.go's TestTrashRestore_RequireAuthBehindRequireToken
// for the Shots page) and confirms every GET /beans, /grinders, /baskets,
// /puckscreens, /milks, /recipes page stays reachable without a token, while
// the one write action this phase adds — POST /beans/{id}/toggle-active —
// requires either genuine HA Ingress or a valid X-GLP-Token, exactly like
// the Shots page's trash/restore actions. This is the check #901's own
// dispatch brief calls out: Phase 2a shipped with exactly this class of bug
// (a write route missing RequireToken's CSRF-relevant GET/HEAD scoping)
// before it was caught in review, so this page's write action is verified
// the same way from the start.
func TestLibraryPagesRequireAuthBehindRequireToken(t *testing.T) {
	const testToken = "test-fixture-token-not-a-real-secret"

	dbPath := filepath.Join(t.TempDir(), "glp.db")
	sqlDB, err := db.Open(dbPath)
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { sqlDB.Close() })

	libRepo := library.NewRepository(sqlDB)
	shotsRepo := shots.NewRepository(sqlDB)
	if err := libRepo.SaveLibrary(library.Library{
		Beans: []library.Entity{{"id": int64(1), "name": "Kenya AA"}},
	}); err != nil {
		t.Fatalf("SaveLibrary: %v", err)
	}

	h := NewLibraryHandlers(libRepo, shotsRepo)
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

	for _, path := range []string{"/beans", "/grinders", "/baskets", "/puckscreens", "/milks", "/recipes"} {
		if rec := doAuthedRequest("GET", path, ""); rec.Code != http.StatusOK {
			t.Errorf("GET %s without a token: status = %d, want 200", path, rec.Code)
		}
	}

	if rec := doAuthedRequest("POST", "/beans/1/toggle-active", ""); rec.Code != http.StatusUnauthorized {
		t.Errorf("POST /beans/1/toggle-active without a token: status = %d, want 401", rec.Code)
	}
	if rec := doAuthedRequest("POST", "/beans/1/toggle-active", testToken); rec.Code != http.StatusOK {
		t.Errorf("POST /beans/1/toggle-active with a valid token: status = %d, want 200, body = %s", rec.Code, rec.Body.String())
	}

	// The six "New ..." create actions #901 adds must be behind the exact
	// same GET/HEAD-scoped bypass — same rationale as toggle-active above,
	// checked for every one of them since createBeanAction et al. are each
	// their own route registration in handlers_library.go's RegisterRoutes,
	// not a single shared one that a single check here could vouch for all
	// six.
	for _, path := range []string{"/beans", "/grinders", "/baskets", "/puckscreens", "/milks", "/recipes"} {
		if rec := doAuthedRequest("POST", path, ""); rec.Code != http.StatusUnauthorized {
			t.Errorf("POST %s without a token: status = %d, want 401", path, rec.Code)
		}
		if rec := doAuthedRequest("POST", path, testToken); rec.Code != http.StatusOK {
			t.Errorf("POST %s with a valid token: status = %d, want 200, body = %s", path, rec.Code, rec.Body.String())
		}
	}

	// The Edit UI's PUT save action must be behind the same bypass — GET
	// (view/edit fragment) stays public, PUT (the actual write) doesn't.
	if rec := doAuthedRequest("GET", "/beans/1", ""); rec.Code != http.StatusOK {
		t.Errorf("GET /beans/1 without a token: status = %d, want 200", rec.Code)
	}
	if rec := doAuthedRequest("GET", "/beans/1/edit", ""); rec.Code != http.StatusOK {
		t.Errorf("GET /beans/1/edit without a token: status = %d, want 200", rec.Code)
	}
	if rec := doAuthedRequest("PUT", "/beans/1", ""); rec.Code != http.StatusUnauthorized {
		t.Errorf("PUT /beans/1 without a token: status = %d, want 401", rec.Code)
	}
	if rec := doAuthedRequest("PUT", "/beans/1", testToken); rec.Code != http.StatusOK {
		t.Errorf("PUT /beans/1 with a valid token: status = %d, want 200, body = %s", rec.Code, rec.Body.String())
	}
}
