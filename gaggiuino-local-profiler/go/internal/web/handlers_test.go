package web

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/auth"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/db"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/system"
)

// newTestServer opens a throwaway on-disk SQLite DB (same pattern as
// internal/shots' own helpers_test.go's newTestHandlers) and wires it into
// a fresh web.Handlers routed through a real *http.ServeMux, so
// r.PathValue("id") is populated the same way it would be in cmd/server.
func newTestServer(t *testing.T) (*http.ServeMux, *shots.Repository) {
	t.Helper()
	dbPath := filepath.Join(t.TempDir(), "glp.db")
	sqlDB, err := db.Open(dbPath)
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { sqlDB.Close() })

	repo := shots.NewRepository(sqlDB)
	h := NewHandlers(shots.NewService(repo))
	mux := http.NewServeMux()
	h.RegisterRoutes(mux)
	return mux, repo
}

func upsertTestShot(t *testing.T, repo *shots.Repository, id, timestamp int64, profileName string, annotation map[string]any) {
	t.Helper()
	shot := shots.Shot{
		"id":          id,
		"timestamp":   timestamp,
		"profileName": profileName,
		"machineId":   int64(1),
	}
	if annotation != nil {
		shot["annotation"] = annotation
	}
	if err := repo.Upsert(shot); err != nil {
		t.Fatalf("repo.Upsert(%d): %v", id, err)
	}
}

func doRequest(t *testing.T, mux *http.ServeMux, method, path string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return rec
}

// rootAbsolutePathAttr matches an href/src/hx-get/hx-post/hx-put/hx-delete/
// hx-patch attribute whose value starts with a single leading "/" (a
// root-absolute path) rather than a path-relative one. See
// internal/web/doc.go's "Ingress-safe relative paths" section: a
// root-absolute path in rendered HTML resolves against the browser's
// origin root under real HA Ingress, not the Ingress session prefix,
// breaking CSS/JS/nav/htmx the moment a page is opened through Ingress
// instead of a bare port — the #901 bug this regexp guards against
// regressing on any current or future page.
// sse-connect (#901, orders.templ's live-update EventSource URL) is
// checked here too — the exact same Ingress-prefix-skipping failure mode a
// root-absolute href/src/hx-* would hit applies to it equally, since it's
// also just a URL EventSource resolves against the page's own origin.
var rootAbsolutePathAttr = regexp.MustCompile(`(?:href|src|hx-get|hx-post|hx-put|hx-delete|hx-patch|sse-connect)="/[^/][^"]*"`)

// assertNoRootAbsolutePaths fails t if body (a rendered page's HTML)
// contains any root-absolute href/src/hx-* attribute value. Call this from
// every page-rendering test in this package, not just handlers_test.go's
// own — see internal/web/doc.go for why this must hold for every page.
func assertNoRootAbsolutePaths(t *testing.T, body string) {
	t.Helper()
	if got := rootAbsolutePathAttr.FindAllString(body, -1); len(got) > 0 {
		t.Errorf("rendered HTML has root-absolute href/src/hx-* path(s), which break under HA Ingress (see internal/web/doc.go): %v", got)
	}
}

// TestListPage_RendersShots verifies GET /shots renders the expected
// structural content — profile names, coffee/dose, and a trash action per
// row — not a pixel-exact snapshot (per the dispatch brief's "nicht
// pixelgenau, aber strukturell" requirement).
func TestListPage_RendersShots(t *testing.T) {
	mux, repo := newTestServer(t)
	upsertTestShot(t, repo, 1, 1_700_000_000, "Espresso Classic", map[string]any{
		"coffee": "Ethiopia Yirgacheffe",
		"dose":   18.2,
		"rating": 4,
	})
	upsertTestShot(t, repo, 2, 1_700_000_100, "Filter", nil)

	rec := doRequest(t, mux, "GET", "/shots")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /shots: status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
		t.Errorf("Content-Type = %q, want text/html prefix", ct)
	}

	body := rec.Body.String()
	for _, want := range []string{
		"Espresso Classic",
		"Filter",
		"Ethiopia Yirgacheffe",
		"18.2 g",
		`hx-post="shots/1/trash"`,
		`hx-post="shots/2/trash"`,
	} {
		if !strings.Contains(body, want) {
			t.Errorf("GET /shots body missing %q\nbody:\n%s", want, body)
		}
	}
	if strings.Contains(body, "trash-section") {
		t.Errorf("GET /shots body has a trash section with nothing trashed yet")
	}
	assertNoRootAbsolutePaths(t, body)
}

// TestListPage_RendersBadges verifies the Shots list's freshness/firmware/
// "ordered by" badges (#901, design pass 4 follow-up — view.go's
// freshnessDays/orderedByLabel/firmwareVersion): a shot whose annotation
// carries beanAgeDays/orderedBy and whose top-level glpFirmwareVersion is
// set gets all three; a shot with none of that data gets none.
func TestListPage_RendersBadges(t *testing.T) {
	mux, repo := newTestServer(t)
	if err := repo.Upsert(shots.Shot{
		"id": int64(1), "timestamp": int64(1_700_000_000), "profileName": "Espresso Classic",
		"machineId": int64(1), "glpFirmwareVersion": "1.2.3",
		"annotation": map[string]any{
			"coffee":      "Ethiopia Yirgacheffe",
			"beanAgeDays": float64(14),
			"orderedBy": map[string]any{
				"customer": "Alice", "item": "Latte", "variant": "Oat", "note": "extra hot",
			},
		},
	}); err != nil {
		t.Fatalf("Upsert(1): %v", err)
	}
	// A stale bean (>35d) exercises the "old" bucket's badge-err class; a
	// plain shot with no annotation data at all must render none of the
	// three badges.
	upsertTestShot(t, repo, 2, 1_700_000_100, "Filter", map[string]any{
		"beanAgeDays": float64(40),
	})
	upsertTestShot(t, repo, 3, 1_700_000_200, "No Data", nil)

	rec := doRequest(t, mux, "GET", "/shots")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /shots: status = %d, body = %s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	for _, want := range []string{
		`badge-ok">14d`,                     // shot 1: fresh bucket
		"fw 1.2.3",                          // shot 1: firmware badge
		"☕ Alice · Latte · Oat · extra hot", // shot 1: ordered-by
		`badge-err">40d`,                    // shot 2: old bucket
	} {
		if !strings.Contains(body, want) {
			t.Errorf("GET /shots body missing %q\nbody:\n%s", want, body)
		}
	}
	assertNoRootAbsolutePaths(t, body)
}

// TestListPage_Empty verifies the empty-state branch when no shots exist.
func TestListPage_Empty(t *testing.T) {
	mux, _ := newTestServer(t)
	rec := doRequest(t, mux, "GET", "/shots")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /shots: status = %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "No shots yet.") {
		t.Errorf("GET /shots body missing empty-state message:\n%s", rec.Body.String())
	}
}

// failingResponseWriter simulates a client connection that breaks partway
// through the response: its Write only ever accepts half of what it's
// given before returning an error, mimicking templ's bufio-buffered
// Render flushing the fully-rendered HTML in one big underlying Write that
// itself only partially lands on the wire. It records every WriteHeader/
// Write call so a test can assert nothing was attempted after the failure.
type failingResponseWriter struct {
	header           http.Header
	writeHeaderCalls []int
	body             strings.Builder
	writeCalls       int
}

func (f *failingResponseWriter) Header() http.Header {
	if f.header == nil {
		f.header = make(http.Header)
	}
	return f.header
}

func (f *failingResponseWriter) WriteHeader(status int) {
	f.writeHeaderCalls = append(f.writeHeaderCalls, status)
}

func (f *failingResponseWriter) Write(p []byte) (int, error) {
	f.writeCalls++
	n := len(p) / 2
	f.body.Write(p[:n])
	return n, errors.New("simulated broken connection")
}

// TestListPage_RenderFailureOnlyLogs pins the #901 code-review fix: when
// templates.ShotsPage.Render fails after output has already started
// (this handler's own comment says exactly that — a broken client
// connection mid-stream), the handler must only log, never attempt a
// WriteHeader/Write afterward. The previous code called
// httputil.InternalError there, which did both — producing a "superfluous
// WriteHeader" plus a JSON error blob appended straight after the
// truncated HTML, contradicting its own comment.
func TestListPage_RenderFailureOnlyLogs(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "glp.db")
	sqlDB, err := db.Open(dbPath)
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { sqlDB.Close() })
	repo := shots.NewRepository(sqlDB)
	upsertTestShot(t, repo, 1, 1_700_000_000, "Espresso Classic", nil)

	h := NewHandlers(shots.NewService(repo))
	fw := &failingResponseWriter{}
	req := httptest.NewRequest(http.MethodGet, "/shots", nil)

	h.listPage(fw, req)

	if len(fw.writeHeaderCalls) != 0 {
		t.Errorf("WriteHeader called %d time(s) after a render failure, want 0: %v", len(fw.writeHeaderCalls), fw.writeHeaderCalls)
	}
	if fw.writeCalls != 1 {
		t.Errorf("Write called %d time(s) after a render failure, want exactly 1 (the failing flush itself)", fw.writeCalls)
	}
	if strings.Contains(fw.body.String(), `"error"`) {
		t.Errorf("response body contains a JSON error blob appended after partial HTML: %q", fw.body.String())
	}
}

// TestTrashAndRestore_RoundTrip drives the two htmx actions end to end:
// trashing a shot moves it out of the live list and into the trash
// section, and restoring it moves it back — exercising the same
// shots.Service.TrashShot/RestoreShot the JSON API's own handlers call.
func TestTrashAndRestore_RoundTrip(t *testing.T) {
	mux, repo := newTestServer(t)
	upsertTestShot(t, repo, 5, 1_700_000_000, "Espresso Classic", nil)

	trashRec := doRequest(t, mux, "POST", "/shots/5/trash")
	if trashRec.Code != http.StatusOK {
		t.Fatalf("POST /shots/5/trash: status = %d, body = %s", trashRec.Code, trashRec.Body.String())
	}
	if trashRec.Body.Len() != 0 {
		t.Errorf("POST /shots/5/trash: body = %q, want empty (htmx outerHTML-removes the row)", trashRec.Body.String())
	}

	afterTrash := doRequest(t, mux, "GET", "/shots").Body.String()
	if !strings.Contains(afterTrash, `hx-post="shots/5/restore"`) {
		t.Errorf("GET /shots after trash: missing restore action for shot 5\nbody:\n%s", afterTrash)
	}
	if strings.Contains(afterTrash, `hx-post="shots/5/trash"`) {
		t.Errorf("GET /shots after trash: shot 5 still in the live list\nbody:\n%s", afterTrash)
	}

	restoreRec := doRequest(t, mux, "POST", "/shots/5/restore")
	if restoreRec.Code != http.StatusOK {
		t.Fatalf("POST /shots/5/restore: status = %d, body = %s", restoreRec.Code, restoreRec.Body.String())
	}

	afterRestore := doRequest(t, mux, "GET", "/shots").Body.String()
	if !strings.Contains(afterRestore, `hx-post="shots/5/trash"`) {
		t.Errorf("GET /shots after restore: shot 5 not back in the live list\nbody:\n%s", afterRestore)
	}
	if strings.Contains(afterRestore, "trash-section") {
		t.Errorf("GET /shots after restore: trash section should be gone (nothing trashed)\nbody:\n%s", afterRestore)
	}
}

// TestTrashAction_InvalidID verifies the same 400 boundary internal/shots'
// own handlers enforce for a malformed id.
func TestTrashAction_InvalidID(t *testing.T) {
	mux, _ := newTestServer(t)
	rec := doRequest(t, mux, "POST", "/shots/not-a-number/trash")
	if rec.Code != http.StatusBadRequest {
		t.Errorf("POST /shots/not-a-number/trash: status = %d, want 400", rec.Code)
	}
}

// TestTrashAction_NotFound verifies the 404 branch when the shot doesn't
// exist, answered as an HTML fragment (not JSON) since htmx is the only
// consumer of this route.
func TestTrashAction_NotFound(t *testing.T) {
	mux, _ := newTestServer(t)
	rec := doRequest(t, mux, "POST", "/shots/999/trash")
	if rec.Code != http.StatusNotFound {
		t.Errorf("POST /shots/999/trash: status = %d, want 404", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "Shot not found") {
		t.Errorf("POST /shots/999/trash body = %q, want it to mention 'Shot not found'", rec.Body.String())
	}
}

// TestTrashRestore_RequireAuthBehindRequireToken wires this package's
// routes behind auth.RequireToken the same way cmd/server actually does
// (unlike newTestServer's bare mux above, which never applies auth
// middleware and so can't exercise this) and confirms the #901 code-review
// CSRF fix end to end: the two write actions 401 without a token, while
// GET /shots stays reachable without one — see internal/web/doc.go's
// "Auth model" section.
func TestTrashRestore_RequireAuthBehindRequireToken(t *testing.T) {
	const testToken = "test-fixture-token-not-a-real-secret"

	dbPath := filepath.Join(t.TempDir(), "glp.db")
	sqlDB, err := db.Open(dbPath)
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { sqlDB.Close() })

	repo := shots.NewRepository(sqlDB)
	upsertTestShot(t, repo, 1, 1_700_000_000, "Espresso Classic", nil)

	h := NewHandlers(shots.NewService(repo))
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

	if rec := doAuthedRequest("GET", "/shots", ""); rec.Code != http.StatusOK {
		t.Errorf("GET /shots without a token: status = %d, want 200", rec.Code)
	}
	if rec := doAuthedRequest("POST", "/shots/1/trash", ""); rec.Code != http.StatusUnauthorized {
		t.Errorf("POST /shots/1/trash without a token: status = %d, want 401", rec.Code)
	}
	if rec := doAuthedRequest("POST", "/shots/1/restore", ""); rec.Code != http.StatusUnauthorized {
		t.Errorf("POST /shots/1/restore without a token: status = %d, want 401", rec.Code)
	}
	if rec := doAuthedRequest("POST", "/shots/1/trash", testToken); rec.Code != http.StatusOK {
		t.Errorf("POST /shots/1/trash with a valid token: status = %d, want 200", rec.Code)
	}
	if rec := doAuthedRequest("POST", "/shots/1/restore", testToken); rec.Code != http.StatusOK {
		t.Errorf("POST /shots/1/restore with a valid token: status = %d, want 200", rec.Code)
	}
}

// TestListPage_LoadsTokenScript pins that GET /shots actually ships
// glp-token.js — the follow-up fix to the CSRF gap
// TestTrashRestore_RequireAuthBehindRequireToken above pins server-side.
// Without this <script> tag present in the rendered page, a real browser
// would never run the code that fetches a token and attaches it to htmx's
// write requests, and the Trash/Restore buttons would 401 exactly like
// they did before this fix (see static/glp-token.js's own doc comment and
// templates/layout.templ).
func TestListPage_LoadsTokenScript(t *testing.T) {
	mux, _ := newTestServer(t)
	rec := doRequest(t, mux, "GET", "/shots")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /shots: status = %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), `src="web/static/glp-token.js"`) {
		t.Errorf("GET /shots body missing glp-token.js <script> tag\nbody:\n%s", rec.Body.String())
	}
}

// TestGlpTokenJS_UsesRelativeTokenFetchForIngress pins the #901 code-review
// fix for a root-absolute fetch("/api/token") silently breaking token
// fetching under HA Ingress: every route this package registers sits at a
// per-session Ingress prefix (/api/hassio_ingress/<token>/...), and a
// root-absolute fetch resolves against the origin root instead of that
// prefix — missing the add-on's own GET /api/token handler entirely (a
// 404 against HA Core's root, swallowed by fetchToken()'s .catch(), token
// stays null forever). The served script must fetch the relative
// "api/token" instead, exactly like public-src/api.js's initToken()
// already does for the SPA — see glp-token.js's own doc comment for the
// full reasoning. A full browser/Ingress-proxy round trip isn't exercised
// here (no headless browser in this test suite); this instead pins the
// exact served source text, which is what actually determines how the
// browser resolves the fetch.
func TestGlpTokenJS_UsesRelativeTokenFetchForIngress(t *testing.T) {
	mux, _ := newTestServer(t)
	rec := doRequest(t, mux, "GET", "/web/static/glp-token.js")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /web/static/glp-token.js: status = %d", rec.Code)
	}
	body := rec.Body.String()
	if strings.Contains(body, `fetch("/api/token"`) {
		t.Errorf("glp-token.js fetches the root-absolute \"/api/token\" — breaks under HA Ingress's session-prefixed URLs\nbody:\n%s", body)
	}
	if !strings.Contains(body, `fetch("api/token"`) {
		t.Errorf("glp-token.js does not fetch the relative \"api/token\" (mirroring public-src/api.js's initToken())\nbody:\n%s", body)
	}
}

// upsertDetailTestShot builds a shot with real datapoints (not just the
// id/timestamp/profileName/annotation upsertTestShot covers) so the
// Phase B (#901) master-detail tests below can exercise
// shots.ComputeShotMetrics/ComputeGrindAdvice's actual math instead of
// just the "no data" branch. Values mirror a realistic ~28s pull: dose 18g
// -> 36g yield (ratio 1:2.0), pressure ramping through preinfusion (2 bar)
// into a 9-bar plateau, no channeling.
func upsertDetailTestShot(t *testing.T, repo *shots.Repository, id int64) {
	t.Helper()
	shot := shots.Shot{
		"id":          id,
		"timestamp":   int64(1_700_000_000),
		"duration":    int64(280), // 28.0s
		"profileName": "Espresso Classic",
		"machineId":   int64(1),
		"datapoints": map[string]any{
			// tenths of a second: 0, 1, 5, 10, 15, 20, 25, 28s
			"timeInShot": []any{float64(0), float64(10), float64(50), float64(100), float64(150), float64(200), float64(250), float64(280)},
			// tenths of a bar: 0, 2, 8.5, 9, 9.2, 9, 8.8, 7 bar
			"pressure": []any{float64(0), float64(20), float64(85), float64(90), float64(92), float64(90), float64(88), float64(85)},
			// tenths of a gram: 0, 0, 2, 8, 15, 23, 30, 36 g
			"shotWeight": []any{float64(0), float64(0), float64(20), float64(80), float64(150), float64(230), float64(300), float64(360)},
		},
		"annotation": map[string]any{
			"coffee":       "Ethiopia Yirgacheffe",
			"dose":         18.0,
			"grinder":      "Niche Zero",
			"grindSetting": "18",
			"rating":       4,
		},
	}
	if err := repo.Upsert(shot); err != nil {
		t.Fatalf("repo.Upsert(%d): %v", id, err)
	}
}

// TestListPage_RendersNewestShotDetail verifies Phase B's (#901)
// master-detail structure: GET /shots' initial render pre-selects the
// newest live shot's own detail panel (ShotDetailFragment) inline, with
// its Metrics-Grid/bean-grinder-line/chart-mount content all present and
// no root-absolute path anywhere in it (the same Ingress-safety
// requirement every page must satisfy).
func TestListPage_RendersNewestShotDetail(t *testing.T) {
	mux, repo := newTestServer(t)
	upsertDetailTestShot(t, repo, 10)

	rec := doRequest(t, mux, "GET", "/shots")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /shots: status = %d, body = %s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	for _, want := range []string{
		"18.0 g → 36.0 g",
		"1:2.0",
		"00:28",
		"Preinfusion 00:05 · Extraction 00:23",
		"Niche Zero · 18",
		`data-shot-id="10"`,
		`hx-get="shots/10"`,
		`hx-target="#shot-detail"`,
	} {
		if !strings.Contains(body, want) {
			t.Errorf("GET /shots body missing %q\nbody:\n%s", want, body)
		}
	}
	assertNoRootAbsolutePaths(t, body)
}

// TestDetailFragment_RoundTrip drives GET /shots/{id} — the htmx fragment
// a compact-row click swaps into #shot-detail — end to end, and pins that
// it renders the identical content the initial page's own inline render
// does (so a click can never show something visually different from what
// GET /shots already pre-selected for the same shot).
func TestDetailFragment_RoundTrip(t *testing.T) {
	mux, repo := newTestServer(t)
	upsertDetailTestShot(t, repo, 10)

	rec := doRequest(t, mux, "GET", "/shots/10")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /shots/10: status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
		t.Errorf("Content-Type = %q, want text/html prefix", ct)
	}
	body := rec.Body.String()
	for _, want := range []string{"1:2.0", "18.0 g → 36.0 g", "Ethiopia Yirgacheffe"} {
		if !strings.Contains(body, want) {
			t.Errorf("GET /shots/10 body missing %q\nbody:\n%s", want, body)
		}
	}
	assertNoRootAbsolutePaths(t, body)
}

// TestDetailFragment_NotFound mirrors trashAction/restoreAction's own
// 404 handling for an id with no matching shot.
func TestDetailFragment_NotFound(t *testing.T) {
	mux, _ := newTestServer(t)
	rec := doRequest(t, mux, "GET", "/shots/999")
	if rec.Code != http.StatusNotFound {
		t.Errorf("GET /shots/999: status = %d, want 404", rec.Code)
	}
}

// TestDetailFragment_InvalidID mirrors TestTrashAction_InvalidID's 400
// boundary for a non-numeric id.
func TestDetailFragment_InvalidID(t *testing.T) {
	mux, _ := newTestServer(t)
	rec := doRequest(t, mux, "GET", "/shots/not-a-number")
	if rec.Code != http.StatusBadRequest {
		t.Errorf("GET /shots/not-a-number: status = %d, want 400", rec.Code)
	}
}

// TestDetailFragment_ScoreDeltaAndGhostOverlay pins design pass 4's
// follow-up (#901): a same-profile earlier shot on the same machine makes
// GET /shots/{id} show a score-delta chip against it and feed its id to
// the chart canvas as data-ghost-shot-id, for static/shot-chart.js's
// dashed-overlay branch.
func TestDetailFragment_ScoreDeltaAndGhostOverlay(t *testing.T) {
	mux, repo := newTestServer(t)
	upsertDetailTestShot(t, repo, 10) // earlier, same profile/machine
	shot20 := shots.Shot{
		"id": int64(20), "timestamp": int64(1_700_001_000), "duration": int64(280),
		"profileName": "Espresso Classic", "machineId": int64(1),
		"datapoints": map[string]any{
			"timeInShot": []any{float64(0), float64(10), float64(50), float64(100), float64(150), float64(200), float64(250), float64(280)},
			"pressure":   []any{float64(0), float64(20), float64(85), float64(90), float64(92), float64(90), float64(88), float64(85)},
			"shotWeight": []any{float64(0), float64(0), float64(20), float64(80), float64(150), float64(230), float64(300), float64(360)},
		},
		"annotation": map[string]any{"coffee": "Ethiopia Yirgacheffe", "dose": 18.0},
	}
	if err := repo.Upsert(shot20); err != nil {
		t.Fatalf("Upsert(20): %v", err)
	}

	rec := doRequest(t, mux, "GET", "/shots/20")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /shots/20: status = %d, body = %s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	if !strings.Contains(body, "verdict-delta") {
		t.Errorf("GET /shots/20 body missing the score-delta chip\nbody:\n%s", body)
	}
	if !strings.Contains(body, `data-ghost-shot-id="10"`) {
		t.Errorf("GET /shots/20 body missing data-ghost-shot-id=\"10\"\nbody:\n%s", body)
	}
	assertNoRootAbsolutePaths(t, body)
}

// TestDetailFragment_ComparativeGrindAdvice pins the comparative
// grind-advice panel (#901, internal/shots/comparative.go): comparable
// same-bean/grinder/profile shots at a different grind setting must
// surface as a panel below the single-shot verdict.
func TestDetailFragment_ComparativeGrindAdvice(t *testing.T) {
	mux, repo := newTestServer(t)
	makeShot := func(id int64, grindSetting string) shots.Shot {
		return shots.Shot{
			"id": id, "timestamp": int64(1_700_000_000) + id, "duration": int64(280),
			"profileName": "Espresso Classic", "machineId": int64(1),
			"datapoints": map[string]any{
				"timeInShot": []any{float64(0), float64(10), float64(50), float64(100), float64(150), float64(200), float64(250), float64(280)},
				"pressure":   []any{float64(0), float64(20), float64(85), float64(90), float64(92), float64(90), float64(88), float64(85)},
				"shotWeight": []any{float64(0), float64(0), float64(20), float64(80), float64(150), float64(230), float64(300), float64(360)},
			},
			"annotation": map[string]any{
				"coffee": "Ethiopia Yirgacheffe", "grinder": "Niche Zero",
				"grindSetting": grindSetting, "dose": 18.0,
			},
		}
	}
	current := makeShot(1, "5.0")
	if err := repo.Upsert(current); err != nil {
		t.Fatalf("Upsert(1): %v", err)
	}
	if err := repo.Upsert(makeShot(2, "3.0")); err != nil {
		t.Fatalf("Upsert(2): %v", err)
	}
	if err := repo.Upsert(makeShot(3, "3.0")); err != nil {
		t.Fatalf("Upsert(3): %v", err)
	}

	rec := doRequest(t, mux, "GET", "/shots/1")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /shots/1: status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "comparative-advice") {
		t.Errorf("GET /shots/1 body missing the comparative grind-advice panel\nbody:\n%s", rec.Body.String())
	}
}

// TestDetailFragment_CompareMode drives A/B compare mode end to end:
// GET /shots/{idA}?compare={idB} renders ShotCompareFragment (both shots'
// verdict/metrics side by side) with the chart canvas carrying both ids —
// data-shot-id for A, data-compare-shot-id for B, per static/shot-chart.js's
// own compare-mode branch.
func TestDetailFragment_CompareMode(t *testing.T) {
	mux, repo := newTestServer(t)
	upsertDetailTestShot(t, repo, 10)
	upsertDetailTestShot(t, repo, 20)

	rec := doRequest(t, mux, "GET", "/shots/10?compare=20")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /shots/10?compare=20: status = %d, body = %s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	for _, want := range []string{
		"shot-compare",
		`data-shot-id="10"`, `data-compare-shot-id="20"`,
		"Compare: Shot 10 vs. Shot 20",
		`hx-get="shots/10"`, // the Exit compare link
	} {
		if !strings.Contains(body, want) {
			t.Errorf("GET /shots/10?compare=20 body missing %q\nbody:\n%s", want, body)
		}
	}
	assertNoRootAbsolutePaths(t, body)
}

// TestDetailFragment_CompareMode_UnknownIDFallsBackToSingle verifies an
// invalid/unknown ?compare= value is ignored rather than erroring the
// whole request — see detailFragment's own doc comment for why single-shot
// mode is always a safe fallback.
func TestDetailFragment_CompareMode_UnknownIDFallsBackToSingle(t *testing.T) {
	mux, repo := newTestServer(t)
	upsertDetailTestShot(t, repo, 10)

	rec := doRequest(t, mux, "GET", "/shots/10?compare=999")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /shots/10?compare=999: status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "shot-compare") {
		t.Errorf("GET /shots/10?compare=999 rendered compare mode for an unknown shot id\nbody:\n%s", rec.Body.String())
	}
}

// TestGlpTokenJS_WaitsForTokenBeforeIssuingHtmxRequests pins the #901
// code-review fix for the click-before-fetch-resolves race: a Trash/
// Restore click landing before fetchToken()'s GET /api/token settled used
// to fire immediately with no X-GLP-Token header attached and 401, even
// though the fetch would have succeeded moments later. The fix defers
// htmx's actual request dispatch via the async htmx:confirm/issueRequest
// pattern (see htmx-2.0.10.min.js's confirm-event dispatch) until the
// token fetch has settled. Like the sibling test above, this pins the
// served source rather than driving a real browser/timing race, which
// this test suite has no infrastructure for.
func TestGlpTokenJS_WaitsForTokenBeforeIssuingHtmxRequests(t *testing.T) {
	mux, _ := newTestServer(t)
	rec := doRequest(t, mux, "GET", "/web/static/glp-token.js")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /web/static/glp-token.js: status = %d", rec.Code)
	}
	body := rec.Body.String()
	if !strings.Contains(body, `"htmx:confirm"`) {
		t.Errorf("glp-token.js does not listen for htmx:confirm — nothing defers a click until the token fetch settles\nbody:\n%s", body)
	}
	if !strings.Contains(body, "evt.detail.issueRequest") {
		t.Errorf("glp-token.js does not call evt.detail.issueRequest — htmx request would never actually be issued after the wait\nbody:\n%s", body)
	}
}

// TestBrowserFlow_FetchedTokenAuthorizesTrash simulates the actual browser
// sequence glp-token.js drives end to end through the real
// auth.RequireToken middleware stack, the same pattern
// TestTrashRestore_RequireAuthBehindRequireToken above established but
// carried one step further: instead of a token the test already knows,
// this fetches GET /api/token — the exact request glp-token.js's
// fetchToken() issues on page load — through internal/system's real
// handler, and then uses whatever token that endpoint actually returned to
// authorize the htmx:configRequest-attached POST /shots/{id}/trash — the
// exact request glp-token.js's htmx:configRequest listener produces for a
// browser's Trash click. If RegisterRoutes ever registered a route under a
// different token, or getToken and RequireToken ever fell out of sync,
// this (unlike a test with a hardcoded shared token) would catch it.
func TestBrowserFlow_FetchedTokenAuthorizesTrash(t *testing.T) {
	const testToken = "test-fixture-token-not-a-real-secret"
	const remoteAddr = "192.168.1.50:1234" // LAN, not Ingress/Supervisor

	dbPath := filepath.Join(t.TempDir(), "glp.db")
	sqlDB, err := db.Open(dbPath)
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { sqlDB.Close() })

	repo := shots.NewRepository(sqlDB)
	upsertTestShot(t, repo, 1, 1_700_000_000, "Espresso Classic", nil)

	mux := http.NewServeMux()
	NewHandlers(shots.NewService(repo)).RegisterRoutes(mux)
	// getToken (called below) only reads h.token/h.rl, never poller/demo —
	// nil is safe for a token-only test, and keeps this test from having
	// to fake an HA adapter just to exercise an unrelated handler.
	system.NewHandlers(nil, nil, testToken).RegisterRoutes(mux)
	handler := auth.RequireToken(testToken)(mux)

	// Step 1: page load. A real browser would run glp-token.js from here
	// (TestListPage_LoadsTokenScript above pins that it's actually linked).
	pageReq := httptest.NewRequest(http.MethodGet, "/shots", nil)
	pageReq.RemoteAddr = remoteAddr
	pageRec := httptest.NewRecorder()
	handler.ServeHTTP(pageRec, pageReq)
	if pageRec.Code != http.StatusOK {
		t.Fatalf("GET /shots: status = %d, want 200", pageRec.Code)
	}

	// Step 2: glp-token.js's fetchToken() — GET /api/token, no header yet
	// (fresh page load, no token cached).
	tokenReq := httptest.NewRequest(http.MethodGet, "/api/token", nil)
	tokenReq.RemoteAddr = remoteAddr
	tokenRec := httptest.NewRecorder()
	handler.ServeHTTP(tokenRec, tokenReq)
	if tokenRec.Code != http.StatusOK {
		t.Fatalf("GET /api/token: status = %d, want 200, body = %s", tokenRec.Code, tokenRec.Body.String())
	}
	var tokenBody struct {
		APIToken string `json:"apiToken"`
	}
	if err := json.Unmarshal(tokenRec.Body.Bytes(), &tokenBody); err != nil {
		t.Fatalf("decoding GET /api/token body: %v (body = %s)", err, tokenRec.Body.String())
	}
	if tokenBody.APIToken == "" {
		t.Fatalf("GET /api/token returned an empty apiToken")
	}

	// Step 3: htmx:configRequest attaches the fetched token as
	// X-GLP-Token to the Trash button's POST.
	trashReq := httptest.NewRequest(http.MethodPost, "/shots/1/trash", nil)
	trashReq.RemoteAddr = remoteAddr
	trashReq.Header.Set("X-GLP-Token", tokenBody.APIToken)
	trashRec := httptest.NewRecorder()
	handler.ServeHTTP(trashRec, trashReq)
	if trashRec.Code != http.StatusOK {
		t.Errorf("POST /shots/1/trash with the fetched token: status = %d, want 200, body = %s", trashRec.Code, trashRec.Body.String())
	}
}

// TestStaticAssets_Served verifies the vendored htmx/Alpine files are
// reachable at /web/static/ — a build-time embed.FS wiring bug would 404
// here even though `go build` itself stays green.
func TestStaticAssets_Served(t *testing.T) {
	mux, _ := newTestServer(t)
	for _, path := range []string{
		"/web/static/style.css",
		"/web/static/vendor/htmx-2.0.10.min.js",
		"/web/static/vendor/alpine-csp-3.16.2.min.js",
		"/web/static/glp-token.js",
		"/web/static/shot-chart.js",
	} {
		rec := doRequest(t, mux, "GET", path)
		if rec.Code != http.StatusOK {
			t.Errorf("GET %s: status = %d, want 200", path, rec.Code)
		}
	}
}

// TestShotChartJS_ServesGhostAndCompareBranches pins that the embedded
// static/shot-chart.js actually contains the ghost-overlay/compare-mode
// branches (#901, design pass 4 follow-up) — a build-time embed.FS wiring
// bug (or an edit that silently dropped a branch) would still 200 the
// request but miss this content, same "prove the served source" rationale
// TestLiveJS_Served (handlers_machines_test.go) already uses for the
// sibling vanilla-JS module.
func TestShotChartJS_ServesGhostAndCompareBranches(t *testing.T) {
	mux, _ := newTestServer(t)
	rec := doRequest(t, mux, "GET", "/web/static/shot-chart.js")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /web/static/shot-chart.js: status = %d", rec.Code)
	}
	body := rec.Body.String()
	for _, want := range []string{
		"data-ghost-shot-id",
		"data-compare-shot-id",
		"buildDatasets",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("shot-chart.js body missing %q\nbody:\n%s", want, body)
		}
	}
}

// TestListPage_CapsAtWebListCap pins #957 decision 7: the no-JS templ list
// never renders more than webListCap (200) shot rows regardless of history
// size, and shows the "showing latest N" note when it caps. The SPA is the
// paginated experience; this page is a bounded fallback.
func TestListPage_CapsAtWebListCap(t *testing.T) {
	mux, repo := newTestServer(t)
	for i := int64(1); i <= 230; i++ {
		upsertTestShot(t, repo, i, i*1000, "V60", nil)
	}

	rec := doRequest(t, mux, "GET", "/shots")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /shots: status = %d", rec.Code)
	}
	body := rec.Body.String()
	if n := strings.Count(body, `id="shot-row-`); n != webListCap {
		t.Errorf("rendered %d live shot rows, want the cap of %d", n, webListCap)
	}
	if !strings.Contains(body, "Showing the latest 200 shots") {
		t.Errorf("capped list is missing the 'showing latest' note\nbody:\n%s", body[:min(len(body), 2000)])
	}
	// Newest first: shot 230 present, shot 1 (beyond the cap) absent.
	if !strings.Contains(body, "shot-row-230") || strings.Contains(body, `id="shot-row-1"`) {
		t.Errorf("cap should keep the newest 200, dropping the oldest")
	}
}

// TestDetailFragment_CompareDropdownStillRenders pins that GET /shots/{id}
// still renders a full single-shot detail plus the "Compare with…"
// dropdown after #957 switched its list load to the bounded GetRecent call.
func TestDetailFragment_CompareDropdownStillRenders(t *testing.T) {
	mux, repo := newTestServer(t)
	for i := int64(1); i <= 5; i++ {
		upsertTestShot(t, repo, i, i*1000, "V60", nil)
	}
	rec := doRequest(t, mux, "GET", "/shots/3")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /shots/3: status = %d, body=%s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	for _, want := range []string{"Compare with", `hx-get="shots/3`} {
		if !strings.Contains(body, want) {
			t.Errorf("detail fragment missing %q\nbody:\n%s", want, body)
		}
	}
}
