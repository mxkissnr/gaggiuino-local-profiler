package web

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/auth"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/db"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines/proto"
)

// fakeSettingsAdapter is a hand-written stand-in for machines.Adapter — the
// same pattern internal/system/helpers_test.go's own fakeAdapter
// establishes, and for the same reason: it sidesteps internal/machines'
// real SSRF guard entirely, which a loopback httptest.Server (the obvious
// alternative) is exactly what that guard exists to reject for a real
// machine host, and internal/machines/helpers_test.go's own
// allowLoopbackMachineHost seam is unexported and not reachable from this
// package. Only GetSettings/UpdateSettings/Capabilities are ever called by
// handlers_settings.go; every other method panics if this package's code
// ever changed to call it.
type fakeSettingsAdapter struct {
	caps      machines.Capabilities
	settings  map[string]json.RawMessage
	getErr    map[string]error
	updateErr error
	// getDelay, when set, is slept at the top of every GetSettings call —
	// used by TestSettingsPage_FetchesCategoriesConcurrently to prove the 5
	// category fetches run in parallel instead of back to back.
	getDelay time.Duration
	// panicCategories, when set for a category, makes GetSettings panic
	// instead of returning — #994 code-review regression fixture for the
	// per-category fetch goroutine's httputil.SafeCall wrapping (a first
	// cut of SafeCall only logged a recovered panic, leaving that
	// category's slice entry a blank zero-value instead of a visible
	// failed-category state).
	panicCategories map[string]bool
}

var _ machines.Adapter = (*fakeSettingsAdapter)(nil)

func (f *fakeSettingsAdapter) Capabilities() machines.Capabilities { return f.caps }

func (f *fakeSettingsAdapter) GetSettings(ctx context.Context, m *machines.Machine, category string) (json.RawMessage, error) {
	if f.getDelay > 0 {
		time.Sleep(f.getDelay)
	}
	if f.panicCategories[category] {
		panic("fakeSettingsAdapter: simulated panic fetching " + category)
	}
	if err, ok := f.getErr[category]; ok {
		return nil, err
	}
	return f.settings[category], nil
}

func (f *fakeSettingsAdapter) UpdateSettings(ctx context.Context, m *machines.Machine, category string, payload json.RawMessage) (json.RawMessage, error) {
	if f.updateErr != nil {
		return nil, f.updateErr
	}
	f.settings[category] = payload
	return payload, nil
}

func (f *fakeSettingsAdapter) notImplemented(name string) error {
	panic("fakeSettingsAdapter: unexpected call to " + name)
}

func (f *fakeSettingsAdapter) GetStatus(context.Context, *machines.Machine) (machines.Status, error) {
	return machines.Status{}, f.notImplemented("GetStatus")
}
func (f *fakeSettingsAdapter) ListProfiles(context.Context, *machines.Machine) ([]machines.ProfileSummary, error) {
	return nil, f.notImplemented("ListProfiles")
}
func (f *fakeSettingsAdapter) GetProfile(context.Context, *machines.Machine, int) (json.RawMessage, error) {
	return nil, f.notImplemented("GetProfile")
}
func (f *fakeSettingsAdapter) CreateProfile(context.Context, *machines.Machine, machines.ProfileInput) (machines.ProfileSummary, error) {
	return machines.ProfileSummary{}, f.notImplemented("CreateProfile")
}
func (f *fakeSettingsAdapter) UpdateProfile(context.Context, *machines.Machine, machines.ProfileInput) (machines.ProfileSummary, error) {
	return machines.ProfileSummary{}, f.notImplemented("UpdateProfile")
}
func (f *fakeSettingsAdapter) DeleteProfile(context.Context, *machines.Machine, int) ([]machines.ProfileSummary, error) {
	return nil, f.notImplemented("DeleteProfile")
}
func (f *fakeSettingsAdapter) SelectProfile(context.Context, *machines.Machine, int) error {
	return f.notImplemented("SelectProfile")
}
func (f *fakeSettingsAdapter) SaveSettings(context.Context, *machines.Machine) error {
	return f.notImplemented("SaveSettings")
}
func (f *fakeSettingsAdapter) SetOperationMode(context.Context, *machines.Machine, proto.OperationMode) error {
	return f.notImplemented("SetOperationMode")
}
func (f *fakeSettingsAdapter) Tare(context.Context, *machines.Machine) error {
	return f.notImplemented("Tare")
}
func (f *fakeSettingsAdapter) ServiceTest(context.Context, *machines.Machine, proto.ServiceTestPeripheral) error {
	return f.notImplemented("ServiceTest")
}
func (f *fakeSettingsAdapter) SaveActiveProfile(context.Context, *machines.Machine) error {
	return f.notImplemented("SaveActiveProfile")
}
func (f *fakeSettingsAdapter) GetFirmwareProgress(context.Context, *machines.Machine) (json.RawMessage, error) {
	return nil, f.notImplemented("GetFirmwareProgress")
}
func (f *fakeSettingsAdapter) TriggerFirmwareUpdate(context.Context, *machines.Machine) (json.RawMessage, error) {
	return nil, f.notImplemented("TriggerFirmwareUpdate")
}
func (f *fakeSettingsAdapter) GetLiveSensorSnapshot(context.Context, *machines.Machine) (*proto.SensorStateSnapshotDto, error) {
	return nil, f.notImplemented("GetLiveSensorSnapshot")
}
func (f *fakeSettingsAdapter) GetLiveSystemState(context.Context, *machines.Machine) (*proto.SystemStateDto, error) {
	return nil, f.notImplemented("GetLiveSystemState")
}

// fakeSettingsAdapterProvider ports this package's AdapterProvider around a
// single fakeSettingsAdapter, regardless of which machine is asked for —
// every test here only ever has the one default machine.
type fakeSettingsAdapterProvider struct{ adapter *fakeSettingsAdapter }

func (p fakeSettingsAdapterProvider) GetAdapter(m *machines.Machine) (machines.Adapter, error) {
	return p.adapter, nil
}

func defaultTestSettings() map[string]json.RawMessage {
	return map[string]json.RawMessage{
		"boiler":  json.RawMessage(`{"brewDeltaState":"true","targetBrewTemp":93}`),
		"led":     json.RawMessage(`{"state":"false"}`),
		"scales":  json.RawMessage(`{"hwScalesEnabled":"true"}`),
		"system":  json.RawMessage(`{"releaseChannel":0}`),
		"display": json.RawMessage(`{"lcdDarkMode":"true","brightness":80}`),
	}
}

// newTestSettingsServer opens a throwaway on-disk SQLite DB (same pattern
// as newTestMachinesServer above), seeds the default machine, and wires a
// fresh web.SettingsHandlers around adapter routed through a real
// *http.ServeMux.
func newTestSettingsServer(t *testing.T, adapter *fakeSettingsAdapter) *http.ServeMux {
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

	h := NewSettingsHandlers(registry, fakeSettingsAdapterProvider{adapter: adapter})
	mux := http.NewServeMux()
	h.RegisterRoutes(mux)
	return mux
}

// ── Settings page ─────────────────────────────────────────────────────────

// TestSettingsPage_RendersCategoriesPreservingBoolAsStringQuirk verifies
// GET /settings renders every category's raw JSON verbatim — specifically
// that the bool-as-string quirk (led.state as the JSON *string* "false",
// not a real boolean — see internal/machines/doc.go) survives the
// pretty-print round trip unchanged, pinning that this page never decodes
// a category into a typed struct. Also pins the follow-up to code-review
// finding #1: all five categories get an editable form now that
// machines.ValidateBoilerSettings/ValidateSystemSettings give boiler/system
// their own field-level check — see
// TestSaveAction_BoilerSystem_FieldLevelValidation for that check itself.
func TestSettingsPage_RendersCategoriesPreservingBoolAsStringQuirk(t *testing.T) {
	adapter := &fakeSettingsAdapter{
		caps:     machines.Capabilities{SettingsProxy: true},
		settings: defaultTestSettings(),
	}
	mux := newTestSettingsServer(t, adapter)

	rec := doRequest(t, mux, "GET", "/settings")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /settings: status = %d, body = %s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	for _, want := range []string{
		`&#34;state&#34;: &#34;false&#34;`,         // led's bool-as-string quirk, unmodified (templ HTML-escapes the quotes)
		`&#34;lcdDarkMode&#34;: &#34;true&#34;`,    // display's, in its editable textarea
		`&#34;brewDeltaState&#34;: &#34;true&#34;`, // boiler's, now also editable
		`&#34;releaseChannel&#34;: 0`,              // system's, now also editable
		`hx-post="settings/display"`,
		`hx-post="settings/led"`,
		`hx-post="settings/scales"`,
		`hx-post="settings/boiler"`,
		`hx-post="settings/system"`,
	} {
		if !strings.Contains(body, want) {
			t.Errorf("GET /settings body missing %q\nbody:\n%s", want, body)
		}
	}
	assertNoRootAbsolutePaths(t, body)

	// Code-review finding #2: each category's "settings-{name}" id must
	// appear exactly once in the initial render — an earlier version wrapped
	// settingsCategoryBlock's <section id="settings-{name}"> in its own
	// same-id <div>, so every category had the id twice until saved once.
	for _, cat := range settingsCategoryNames {
		id := `id="settings-` + cat + `"`
		if n := strings.Count(body, id); n != 1 {
			t.Errorf("GET /settings: %q appears %d times, want exactly 1\nbody:\n%s", id, n, body)
		}
	}
}

// TestSettingsPage_UnsupportedAdapter verifies the "this machine type
// doesn't support the settings proxy" branch (GaggiMate — see
// internal/machines.Capabilities.SettingsProxy) renders instead of trying
// to fetch any category.
func TestSettingsPage_UnsupportedAdapter(t *testing.T) {
	adapter := &fakeSettingsAdapter{caps: machines.Capabilities{SettingsProxy: false}}
	mux := newTestSettingsServer(t, adapter)

	rec := doRequest(t, mux, "GET", "/settings")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /settings: status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "does not support the settings proxy") {
		t.Errorf("GET /settings body missing the unsupported-adapter message\nbody:\n%s", rec.Body.String())
	}
}

// TestSettingsPage_CategoryFetchErrorIsPerBlock verifies one category's
// fetch failure (e.g. the machine went unreachable mid-page) doesn't fail
// the whole page — every other category, and the editable form, must still
// render.
func TestSettingsPage_CategoryFetchErrorIsPerBlock(t *testing.T) {
	adapter := &fakeSettingsAdapter{
		caps:     machines.Capabilities{SettingsProxy: true},
		settings: defaultTestSettings(),
		getErr:   map[string]error{"boiler": errUnreachable},
	}
	mux := newTestSettingsServer(t, adapter)

	rec := doRequest(t, mux, "GET", "/settings")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /settings: status = %d, body = %s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	if !strings.Contains(body, "Could not reach machine") {
		t.Errorf("GET /settings body missing the boiler fetch-error message\nbody:\n%s", body)
	}
	if !strings.Contains(body, `hx-post="settings/display"`) {
		t.Errorf("GET /settings: editable display form missing even though only boiler failed\nbody:\n%s", body)
	}
}

// TestSettingsPage_CategoryFetchPanicIsPerBlock is #994's regression test:
// a panic inside one category's fetch goroutine (wrapped in
// httputil.SafeCall) must render that category as a visible failed state,
// not a silent blank category built from SettingsCategory's zero value as
// if the fetch had quietly returned nothing.
func TestSettingsPage_CategoryFetchPanicIsPerBlock(t *testing.T) {
	adapter := &fakeSettingsAdapter{
		caps:            machines.Capabilities{SettingsProxy: true},
		settings:        defaultTestSettings(),
		panicCategories: map[string]bool{"boiler": true},
	}
	mux := newTestSettingsServer(t, adapter)

	rec := doRequest(t, mux, "GET", "/settings")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /settings: status = %d, body = %s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	if !strings.Contains(body, "badge-err") {
		t.Errorf("GET /settings body missing a failed-category badge for the panicking boiler fetch\nbody:\n%s", body)
	}
	if strings.Contains(body, `hx-post="settings/boiler"`) {
		t.Errorf("GET /settings: boiler rendered as editable even though its fetch panicked\nbody:\n%s", body)
	}
	if !strings.Contains(body, `hx-post="settings/display"`) {
		t.Errorf("GET /settings: editable display form missing even though only boiler panicked\nbody:\n%s", body)
	}
}

// TestSettingsPage_FetchesCategoriesConcurrently verifies GET /settings
// fetches its 5 categories (4 read-only + the editable one) in parallel
// rather than sequentially (#901 code review) — with a 50ms artificial delay
// per GetSettings call, 5 sequential calls would take ~250ms; a concurrent
// fetch should be bounded by roughly one call's duration.
func TestSettingsPage_FetchesCategoriesConcurrently(t *testing.T) {
	const perCallDelay = 50 * time.Millisecond
	adapter := &fakeSettingsAdapter{
		caps:     machines.Capabilities{SettingsProxy: true},
		settings: defaultTestSettings(),
		getDelay: perCallDelay,
	}
	mux := newTestSettingsServer(t, adapter)

	start := time.Now()
	rec := doRequest(t, mux, "GET", "/settings")
	elapsed := time.Since(start)

	if rec.Code != http.StatusOK {
		t.Fatalf("GET /settings: status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if elapsed >= 3*perCallDelay {
		t.Errorf("GET /settings took %v, want well under %v (5 sequential calls) — categories are not being fetched concurrently", elapsed, 5*perCallDelay)
	}
}

// ── Save (POST /settings/{category}) ─────────────────────────────────────

// TestSaveAction_EditableCategoryRoundTrip verifies a POST /settings/{category}
// for a genuinely editable category (led here — display already has its own
// dedicated tests below) round-trips.
func TestSaveAction_EditableCategoryRoundTrip(t *testing.T) {
	adapter := &fakeSettingsAdapter{
		caps:     machines.Capabilities{SettingsProxy: true},
		settings: defaultTestSettings(),
	}
	mux := newTestSettingsServer(t, adapter)

	submitted := `{"state":"true"}`
	rec := doFormPost(t, mux, "/settings/led", url.Values{"raw": {submitted}})
	if rec.Code != http.StatusOK {
		t.Fatalf("POST /settings/led: status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if string(adapter.settings["led"]) != submitted {
		t.Errorf("UpdateSettings(led) received %q, want the exact submitted bytes %q", adapter.settings["led"], submitted)
	}
	if !strings.Contains(rec.Body.String(), `&#34;state&#34;: &#34;true&#34;`) {
		t.Errorf("POST /settings/led response doesn't reflect the saved value\nbody:\n%s", rec.Body.String())
	}
	// display must be untouched by a led save.
	if string(adapter.settings["display"]) != string(defaultTestSettings()["display"]) {
		t.Errorf("POST /settings/led unexpectedly changed the display category")
	}
}

// TestSaveAction_BoilerSystem_EditableRoundTrip is the follow-up to what
// used to be TestSaveAction_ReadOnlyCategoryRejected (code-review finding
// #1): boiler/system are editable again, now that
// machines.ValidateBoilerSettings/ValidateSystemSettings give them their
// own field-level check instead of just machines.ValidateSettingsPayload's
// generic "is this JSON" one — a valid payload reaches
// adapter.UpdateSettings exactly like any other category.
func TestSaveAction_BoilerSystem_EditableRoundTrip(t *testing.T) {
	cases := []struct {
		category  string
		submitted string
	}{
		{"boiler", `{"brewDeltaState":"true","steamSetPoint":150}`},
		{"system", `{"releaseChannel":1}`},
	}
	for _, c := range cases {
		t.Run(c.category, func(t *testing.T) {
			adapter := &fakeSettingsAdapter{
				caps:     machines.Capabilities{SettingsProxy: true},
				settings: defaultTestSettings(),
			}
			mux := newTestSettingsServer(t, adapter)

			rec := doFormPost(t, mux, "/settings/"+c.category, url.Values{"raw": {c.submitted}})
			if rec.Code != http.StatusOK {
				t.Fatalf("POST /settings/%s: status = %d, body = %s", c.category, rec.Code, rec.Body.String())
			}
			if string(adapter.settings[c.category]) != c.submitted {
				t.Errorf("UpdateSettings(%s) received %q, want the exact submitted bytes %q", c.category, adapter.settings[c.category], c.submitted)
			}
		})
	}
}

// TestSaveAction_BoilerSystem_FieldLevelValidation is the actual safety
// check code-review finding #1 asked for: boiler/system must reject a bad
// payload before it ever reaches adapter.UpdateSettings, not merely accept
// or reject based on "is this JSON" — see
// internal/machines/settings_validation.go's own doc comment for exactly
// what each field check does and doesn't claim.
func TestSaveAction_BoilerSystem_FieldLevelValidation(t *testing.T) {
	cases := []struct {
		name      string
		category  string
		submitted string
	}{
		{"boiler numeric field holds a string", "boiler", `{"steamSetPoint":"not a number"}`},
		{"boiler steamSetPoint wildly out of range", "boiler", `{"steamSetPoint":1500}`},
		{"boiler bool-as-string field holds a real bool", "boiler", `{"brewDeltaState":true}`},
		{"system releaseChannel out of range", "system", `{"releaseChannel":9}`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			adapter := &fakeSettingsAdapter{
				caps:     machines.Capabilities{SettingsProxy: true},
				settings: defaultTestSettings(),
			}
			mux := newTestSettingsServer(t, adapter)

			before := string(defaultTestSettings()[c.category])
			rec := doFormPost(t, mux, "/settings/"+c.category, url.Values{"raw": {c.submitted}})
			if rec.Code != http.StatusOK {
				t.Fatalf("POST /settings/%s: status = %d, want 200 (validation errors render inline, not a non-2xx), body = %s", c.category, rec.Code, rec.Body.String())
			}
			if !strings.Contains(rec.Body.String(), "badge-err") {
				t.Errorf("POST /settings/%s (%s) response missing a validation error\nbody:\n%s", c.category, c.name, rec.Body.String())
			}
			if string(adapter.settings[c.category]) != before {
				t.Errorf("POST /settings/%s (%s) reached adapter.UpdateSettings despite failing field-level validation", c.category, c.name)
			}
		})
	}
}

// TestSaveAction_UnknownCategoryRejected verifies a {category} path value
// outside settingsCategoryNames (a stale link, a hand-crafted request)
// 404s before ever reaching the adapter, rather than forwarding an
// arbitrary category name to adapter.UpdateSettings.
func TestSaveAction_UnknownCategoryRejected(t *testing.T) {
	adapter := &fakeSettingsAdapter{
		caps:     machines.Capabilities{SettingsProxy: true},
		settings: defaultTestSettings(),
	}
	mux := newTestSettingsServer(t, adapter)

	rec := doFormPost(t, mux, "/settings/not-a-real-category", url.Values{"raw": {`{}`}})
	if rec.Code != http.StatusNotFound {
		t.Errorf("POST /settings/not-a-real-category: status = %d, want 404, body = %s", rec.Code, rec.Body.String())
	}
}

// ── Save (POST /settings/display) ────────────────────────────────────────

// TestSaveEditableAction_ForwardsRawBytesUnmodified pins the core contract
// this page's one write action must hold: the submitted textarea's bytes
// reach adapter.UpdateSettings byte-for-byte, including the bool-as-string
// quirk (a real bool true must NOT be re-quoted, and a quirky quoted
// "false" must NOT be unquoted) — see handlers_settings.go's doc comment.
func TestSaveEditableAction_ForwardsRawBytesUnmodified(t *testing.T) {
	adapter := &fakeSettingsAdapter{
		caps:     machines.Capabilities{SettingsProxy: true},
		settings: defaultTestSettings(),
	}
	mux := newTestSettingsServer(t, adapter)

	submitted := `{"lcdDarkMode":"false","brightness":true}`
	rec := doFormPost(t, mux, "/settings/display", url.Values{"raw": {submitted}})
	if rec.Code != http.StatusOK {
		t.Fatalf("POST /settings/display: status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if string(adapter.settings["display"]) != submitted {
		t.Errorf("UpdateSettings received %q, want the exact submitted bytes %q", adapter.settings["display"], submitted)
	}
	if !strings.Contains(rec.Body.String(), `&#34;lcdDarkMode&#34;: &#34;false&#34;`) {
		t.Errorf("POST /settings/display response doesn't reflect the saved value\nbody:\n%s", rec.Body.String())
	}
}

// TestSaveEditableAction_InvalidJSONRejected verifies a non-object payload
// is rejected by machines.ValidateSettingsPayload before ever reaching
// UpdateSettings.
func TestSaveEditableAction_InvalidJSONRejected(t *testing.T) {
	adapter := &fakeSettingsAdapter{
		caps:     machines.Capabilities{SettingsProxy: true},
		settings: defaultTestSettings(),
	}
	mux := newTestSettingsServer(t, adapter)

	rec := doFormPost(t, mux, "/settings/display", url.Values{"raw": {"not json"}})
	if rec.Code != http.StatusOK { // htmx fragment error, not an HTTP-level failure — the form itself re-renders
		t.Fatalf("POST /settings/display with invalid JSON: status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "invalid settings payload") {
		t.Errorf("POST /settings/display body missing the validation error\nbody:\n%s", rec.Body.String())
	}
	if _, changed := adapter.settings["display"]; changed && string(adapter.settings["display"]) != string(defaultTestSettings()["display"]) {
		t.Errorf("UpdateSettings was called despite invalid JSON")
	}
}

// TestSettingsPagesRequireAuthBehindRequireToken verifies the one write
// action this page registers — POST /settings/display — requires either
// genuine HA Ingress or a valid X-GLP-Token, while GET /settings stays
// reachable without one, exactly like every earlier phase's write actions.
func TestSettingsPagesRequireAuthBehindRequireToken(t *testing.T) {
	const testToken = "test-fixture-token-not-a-real-secret"

	adapter := &fakeSettingsAdapter{
		caps:     machines.Capabilities{SettingsProxy: true},
		settings: defaultTestSettings(),
	}
	mux := newTestSettingsServer(t, adapter)
	handler := auth.RequireToken(testToken)(mux)

	doAuthedRequest := func(method, path, token string, body url.Values) *httptest.ResponseRecorder {
		var req *http.Request
		if body != nil {
			req = httptest.NewRequest(method, path, strings.NewReader(body.Encode()))
			req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		} else {
			req = httptest.NewRequest(method, path, nil)
		}
		req.RemoteAddr = "192.168.1.50:1234" // LAN, not Ingress/Supervisor
		if token != "" {
			req.Header.Set("X-GLP-Token", token)
		}
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		return rec
	}

	if rec := doAuthedRequest("GET", "/settings", "", nil); rec.Code != http.StatusOK {
		t.Errorf("GET /settings without a token: status = %d, want 200", rec.Code)
	}
	form := url.Values{"raw": {`{"lcdDarkMode":"true"}`}}
	if rec := doAuthedRequest("POST", "/settings/display", "", form); rec.Code != http.StatusUnauthorized {
		t.Errorf("POST /settings/display without a token: status = %d, want 401", rec.Code)
	}
	if rec := doAuthedRequest("POST", "/settings/display", testToken, form); rec.Code != http.StatusOK {
		t.Errorf("POST /settings/display with a valid token: status = %d, want 200, body = %s", rec.Code, rec.Body.String())
	}

	// led/scales are editable too, each its own POST /settings/{category}
	// route — spot-check one of them (led) gets the same auth treatment as
	// display, not just the original editable category.
	ledForm := url.Values{"raw": {`{"state":"true"}`}}
	if rec := doAuthedRequest("POST", "/settings/led", "", ledForm); rec.Code != http.StatusUnauthorized {
		t.Errorf("POST /settings/led without a token: status = %d, want 401", rec.Code)
	}
	if rec := doAuthedRequest("POST", "/settings/led", testToken, ledForm); rec.Code != http.StatusOK {
		t.Errorf("POST /settings/led with a valid token: status = %d, want 200, body = %s", rec.Code, rec.Body.String())
	}

	// boiler is editable (see TestSaveAction_BoilerSystem_EditableRoundTrip)
	// but still behind the same auth boundary as every other write action —
	// the auth middleware 401s it unauthenticated (auth is checked before
	// this page's own handler ever runs) regardless of what saveAction's own
	// field-level validation would have done with the body.
	boilerForm := url.Values{"raw": {`{"brewDeltaState":"true"}`}}
	if rec := doAuthedRequest("POST", "/settings/boiler", "", boilerForm); rec.Code != http.StatusUnauthorized {
		t.Errorf("POST /settings/boiler without a token: status = %d, want 401", rec.Code)
	}
	if rec := doAuthedRequest("POST", "/settings/boiler", testToken, boilerForm); rec.Code != http.StatusOK {
		t.Errorf("POST /settings/boiler with a valid token: status = %d, want 200, body = %s", rec.Code, rec.Body.String())
	}
}

var errUnreachable = &testError{"connection refused"}

type testError struct{ msg string }

func (e *testError) Error() string { return e.msg }
