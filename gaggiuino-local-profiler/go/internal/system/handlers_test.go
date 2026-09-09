package system

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/library"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/sse"
)

func newFullTestHandlers(t *testing.T) (*Handlers, *http.ServeMux, *Poller) {
	t.Helper()
	fake := &fakeAdapter{}
	p, sqlDB := newTestPoller(t, fake)
	demo := NewDemoService(sqlDB, shots.NewRepository(sqlDB), library.NewRepository(sqlDB))
	h := NewHandlers(p, demo, testAPIToken)
	return h, newSystemMux(h), p
}

// TestGetPreheat_NeverSwitchedOn ports buildPreheatResponse's "machine off
// / never switched on" branch — ready:false, and stabilityReady must be
// entirely absent from the JSON (Node's object literal omits the key on
// this branch, see preheat.go's PreheatStatus doc comment).
func TestGetPreheat_NeverSwitchedOn(t *testing.T) {
	_, mux, _ := newFullTestHandlers(t)
	rec := doGet(mux, "/api/preheat")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	body := decodeMap(t, rec.Body.Bytes())
	if body["ready"] != false {
		t.Errorf("ready = %v, want false", body["ready"])
	}
	if _, present := body["stabilityReady"]; present {
		t.Errorf("stabilityReady should be entirely absent, got %v", body["stabilityReady"])
	}
	if body["preheatTime"] != float64(20) {
		t.Errorf("preheatTime = %v, want 20 (default)", body["preheatTime"])
	}
}

// TestPostPreheatReadyBy_InvalidTargetAt ports the 400 "targetAt must be
// an epoch-ms number or null" contract.
func TestPostPreheatReadyBy_InvalidTargetAt(t *testing.T) {
	_, mux, _ := newFullTestHandlers(t)
	rec := doPost(mux, "/api/preheat/ready-by", `{"targetAt":"not-a-number"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	body := decodeMap(t, rec.Body.Bytes())
	if body["error"] == nil {
		t.Error("expected an error field")
	}
}

// TestPostPreheatReadyBy_NoSwitchEntity_Rejects ports the 400
// "switch_entity nicht konfiguriert" contract: setting (not clearing) a
// target without a usable HA switch is rejected up front.
func TestPostPreheatReadyBy_NoSwitchEntity_Rejects(t *testing.T) {
	_, mux, _ := newFullTestHandlers(t)
	rec := doPost(mux, "/api/preheat/ready-by", `{"targetAt":9999999999999}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (no switch_entity/HA token configured in this test)", rec.Code)
	}
	body := decodeMap(t, rec.Body.Bytes())
	if body["error"] != "switch_entity nicht konfiguriert" {
		t.Errorf("error = %v, want 'switch_entity nicht konfiguriert'", body["error"])
	}
}

// TestPostPreheatReadyBy_NullClears verifies targetAt: null is always
// accepted (cancelling a target never needs a switch entity).
func TestPostPreheatReadyBy_NullClears(t *testing.T) {
	_, mux, p := newFullTestHandlers(t)
	rec := doPost(mux, "/api/preheat/ready-by", `{"targetAt":null}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200, body=%s", rec.Code, rec.Body.String())
	}
	p.state.mu.Lock()
	readyBy := p.state.readyByTargetAt
	p.state.mu.Unlock()
	if readyBy != nil {
		t.Errorf("readyByTargetAt = %v, want nil after clearing", *readyBy)
	}
}

// TestGetVersion_ReturnsCurrent exercises GET /api/version against no
// network access (the GitHub fetch will fail in this sandboxed test — the
// contract must still degrade to {current, latest: null, update_available:
// false, release_url}, never an error response).
func TestGetVersion_ReturnsCurrent(t *testing.T) {
	_, mux, _ := newFullTestHandlers(t)
	rec := doGet(mux, "/api/version")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	body := decodeMap(t, rec.Body.Bytes())
	if body["current"] != glpVersion {
		t.Errorf("current = %v, want %v", body["current"], glpVersion)
	}
	if _, present := body["release_url"]; !present {
		t.Error("expected a release_url field")
	}
}

// TestDemoSeedAndEnd exercises the full POST /api/demo/seed -> POST
// /api/demo/end round trip against a real temp SQLite DB.
func TestDemoSeedAndEnd(t *testing.T) {
	_, mux, _ := newFullTestHandlers(t)

	rec := doPost(mux, "/api/demo/seed", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("seed status = %d, want 200, body=%s", rec.Code, rec.Body.String())
	}
	body := decodeMap(t, rec.Body.Bytes())
	if body["isDemo"] != true {
		t.Errorf("isDemo = %v, want true", body["isDemo"])
	}

	// Seeding again on top of demo data must 409 (not empty anymore).
	rec = doPost(mux, "/api/demo/seed", "")
	if rec.Code != http.StatusConflict {
		t.Fatalf("second seed status = %d, want 409", rec.Code)
	}

	rec = doPost(mux, "/api/demo/end", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("end status = %d, want 200, body=%s", rec.Code, rec.Body.String())
	}
	body = decodeMap(t, rec.Body.Bytes())
	if body["isDemo"] != false {
		t.Errorf("isDemo = %v, want false", body["isDemo"])
	}

	// Seeding must succeed again now that the demo data is gone.
	rec = doPost(mux, "/api/demo/seed", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("re-seed status = %d, want 200, body=%s", rec.Code, rec.Body.String())
	}
}

// TestLiveData_DefaultShape exercises GET /api/live/data before any poll
// has happened — isLive:false, seq:0, machineReachable: null (never
// checked, distinct from false).
func TestLiveData_DefaultShape(t *testing.T) {
	_, mux, _ := newFullTestHandlers(t)
	rec := doGet(mux, "/api/live/data")
	body := decodeMap(t, rec.Body.Bytes())
	if body["isLive"] != false {
		t.Errorf("isLive = %v, want false", body["isLive"])
	}
	if body["machineReachable"] != nil {
		t.Errorf("machineReachable = %v, want null (never polled)", body["machineReachable"])
	}
	if body["datapoints"] != nil {
		t.Errorf("datapoints = %v, want null", body["datapoints"])
	}
}

// ── GET /api/token (#901 Phase 3b) ─────────────────────────────────────

func TestGetToken_ReturnsAPIToken(t *testing.T) {
	_, mux, _ := newFullTestHandlers(t)
	rec := doGet(mux, "/api/token")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	body := decodeMap(t, rec.Body.Bytes())
	if body["apiToken"] != testAPIToken {
		t.Errorf("apiToken = %v, want %q", body["apiToken"], testAPIToken)
	}
}

// TestGetToken_RateLimited proves the 10/min-per-IP cap (routes/system.js's
// `rateLimit(\`token:${ip}\`, 10)`): every httptest.NewRequest in this test
// shares the same default RemoteAddr, so the 11th call within the window
// must 429.
func TestGetToken_RateLimited(t *testing.T) {
	_, mux, _ := newFullTestHandlers(t)
	for i := 0; i < 10; i++ {
		rec := doGet(mux, "/api/token")
		if rec.Code != http.StatusOK {
			t.Fatalf("request %d: status = %d, want 200", i, rec.Code)
		}
	}
	rec := doGet(mux, "/api/token")
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("11th request status = %d, want 429; body=%s", rec.Code, rec.Body.String())
	}
}

// TestGetToken_IngressGetsHigherRateLimit guards the #901 live-navigation
// fix: a genuine Ingress caller (Supervisor-network RemoteAddr +
// X-Ingress-Path, exactly like auth_test.go's ingress fixtures) shares one
// token:<ip> bucket across every browser tab/user behind that Ingress
// session, and this app — unlike the Node SPA — re-fetches the token on
// every single page's full reload. 10 requests (tokenRateLimitDirect) must
// NOT 429 an Ingress caller; the 121st (past tokenRateLimitIngress) must.
func TestGetToken_IngressGetsHigherRateLimit(t *testing.T) {
	_, mux, _ := newFullTestHandlers(t)
	ingressGet := func() *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/api/token", nil)
		req.RemoteAddr = "172.30.32.1:12345"
		req.Header.Set("X-Ingress-Path", "/api/hassio_ingress/faketoken")
		mux.ServeHTTP(rec, req)
		return rec
	}
	for i := 0; i < tokenRateLimitDirect+1; i++ {
		rec := ingressGet()
		if rec.Code != http.StatusOK {
			t.Fatalf("request %d: status = %d, want 200 (must exceed the direct-port limit without 429ing)", i, rec.Code)
		}
	}
	for i := tokenRateLimitDirect + 1; i < tokenRateLimitIngress; i++ {
		rec := ingressGet()
		if rec.Code != http.StatusOK {
			t.Fatalf("request %d: status = %d, want 200", i, rec.Code)
		}
	}
	rec := ingressGet()
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("request %d (past tokenRateLimitIngress): status = %d, want 429", tokenRateLimitIngress, rec.Code)
	}
}

// TestGetToken_DirectPortDeniedWhenExposeApiPortFalse guards #803: a
// non-Ingress caller (every httptest.NewRequest's default RemoteAddr is
// outside the Supervisor's 172.30.0.0/16 network, so auth.IsIngressRequest
// is always false here) is rejected with 403 once expose_api_port is
// explicitly false.
func TestGetToken_DirectPortDeniedWhenExposeApiPortFalse(t *testing.T) {
	resetPreheatMinutesCacheForTest(t)
	path := filepath.Join(t.TempDir(), "options.json")
	if err := os.WriteFile(path, []byte(`{"expose_api_port":false}`), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	defaultOptionsFile = path

	_, mux, _ := newFullTestHandlers(t)
	rec := doGet(mux, "/api/token")
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403; body=%s", rec.Code, rec.Body.String())
	}
}

// ── GET /api/status (#901 Phase 3b) ─────────────────────────────────────

func TestGetStatus_PublicFieldsAndNoSensitiveLeak(t *testing.T) {
	_, mux, _ := newFullTestHandlers(t)
	rec := doGet(mux, "/api/status")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	body := decodeMap(t, rec.Body.Bytes())

	if body["glpVersion"] != glpVersion {
		t.Errorf("glpVersion = %v, want %q", body["glpVersion"], glpVersion)
	}
	if body["shotCount"] != float64(0) {
		t.Errorf("shotCount = %v, want 0", body["shotCount"])
	}
	if body["exposeApiPort"] != true {
		t.Errorf("exposeApiPort = %v, want true (default open, #803)", body["exposeApiPort"])
	}
	if body["ordersFeature"] != false {
		t.Errorf("ordersFeature = %v, want false", body["ordersFeature"])
	}
	if body["haConnected"] != false {
		t.Errorf("haConnected = %v, want false (no HA configured in test env)", body["haConnected"])
	}
	if id, ok := body["installId"].(string); !ok || id == "" {
		t.Errorf("installId = %v, want a non-empty string", body["installId"])
	}
	if body["lastSync"] != nil {
		t.Errorf("lastSync = %v, want null (sync engine not ported yet)", body["lastSync"])
	}

	machinesArr, ok := body["machines"].([]any)
	if !ok || len(machinesArr) != 1 {
		t.Fatalf("expected exactly one machine, got %+v", body["machines"])
	}
	m, ok := machinesArr[0].(map[string]any)
	if !ok || m["isDefault"] != true {
		t.Fatalf("machines[0] = %+v, want isDefault:true", machinesArr[0])
	}
	if _, present := m["on"]; !present || m["on"] == nil {
		t.Errorf("machines[0].on = %v, want a boolean for the default machine", m["on"])
	}

	// H1: sensitive fields must be entirely absent (not just null) for an
	// unauthenticated caller.
	for _, key := range []string{"machineUrl", "machineHostname", "lastSyncError", "lastMachineError", "switchEntity", "isDemo"} {
		if _, present := body[key]; present {
			t.Errorf("unauthenticated GET /api/status leaked sensitive field %q = %v", key, body[key])
		}
	}
}

// TestGetStatus_AuthenticatedIncludesSensitiveFields proves H1's other
// half: a caller presenting a valid X-GLP-Token (independent of Ingress —
// see getStatus's own doc comment) gets machineUrl/machineHostname/
// switchEntity/isDemo/lastMachineError included.
func TestGetStatus_AuthenticatedIncludesSensitiveFields(t *testing.T) {
	_, mux, _ := newFullTestHandlers(t)
	req := httptest.NewRequest(http.MethodGet, "/api/status", nil)
	req.Header.Set("X-GLP-Token", testAPIToken)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	body := decodeMap(t, rec.Body.Bytes())

	if _, present := body["machineUrl"]; !present {
		t.Error("authenticated response missing machineUrl")
	}
	if body["machineHostname"] != "fake-machine.invalid" {
		t.Errorf("machineHostname = %v, want fake-machine.invalid", body["machineHostname"])
	}
	if _, present := body["isDemo"]; !present {
		t.Error("authenticated response missing isDemo")
	}
	if body["isDemo"] != false {
		t.Errorf("isDemo = %v, want false", body["isDemo"])
	}
	if _, present := body["switchEntity"]; !present {
		t.Error("authenticated response missing switchEntity key (should be present, value null)")
	}
	if body["switchEntity"] != nil {
		t.Errorf("switchEntity = %v, want null (no switch entity configured)", body["switchEntity"])
	}
}

// TestGetStatus_WrongTokenStaysUnauthenticated proves an invalid
// X-GLP-Token doesn't accidentally unlock the sensitive block.
func TestGetStatus_WrongTokenStaysUnauthenticated(t *testing.T) {
	_, mux, _ := newFullTestHandlers(t)
	req := httptest.NewRequest(http.MethodGet, "/api/status", nil)
	req.Header.Set("X-GLP-Token", "wrong-token")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	body := decodeMap(t, rec.Body.Bytes())
	if _, present := body["machineUrl"]; present {
		t.Error("wrong X-GLP-Token still leaked machineUrl")
	}
}

// erroringAdapterProvider ports fakeAdapterProvider but lets a test force
// GetAdapter itself to fail for specific machine IDs -- standing in for the
// real machines.Handlers.GetAdapter's "unknown machine type"/"requires a
// type" error path (see adapter.go), which a real orphaned registry row
// (Type left empty or invalid by an incomplete migration) would hit but
// which the machines table's own CHECK constraint prevents constructing
// directly in a test DB.
type erroringAdapterProvider struct {
	ok      *fakeAdapter
	failIDs map[int64]bool
}

func (p erroringAdapterProvider) GetAdapter(m *machines.Machine) (machines.Adapter, error) {
	if p.failIDs[m.ID] {
		return nil, fmt.Errorf("unknown machine type: %s", m.Type)
	}
	return p.ok, nil
}

// TestGetStatus_MachineIdProbe_GetAdapterFailureNoMismatch is the #901 code
// review regression: a ?machineId probe against a machine whose GetAdapter
// call fails (an orphaned registry row from an incomplete migration is the
// real-world trigger, see erroringAdapterProvider above) must not leave the
// response mixing the requested machine's hostname with the DEFAULT
// machine's reachability/error state. GetAdapter failing must be treated as
// a probe failure for the REQUESTED machine, exactly like routes/system.js's
// single try/catch wrapping both getAdapter() and getStatus().
func TestGetStatus_MachineIdProbe_GetAdapterFailureNoMismatch(t *testing.T) {
	sqlDB := newTestDB(t)
	registry := machines.NewRegistry(sqlDB)
	if err := registry.EnsureDefaultMachine(); err != nil {
		t.Fatalf("EnsureDefaultMachine: %v", err)
	}
	defaultHost := "default-machine.invalid"
	if _, err := registry.UpdateMachine(1, machines.MachineInput{Host: &defaultHost}, nil); err != nil {
		t.Fatalf("UpdateMachine: %v", err)
	}
	name, typ, host := "Orphaned", "gaggimate", "orphaned.invalid"
	created, err := registry.CreateMachine(machines.MachineInput{Name: &name, Type: &typ, Host: &host})
	if err != nil {
		t.Fatalf("CreateMachine: %v", err)
	}

	fake := &fakeAdapter{}
	provider := erroringAdapterProvider{ok: fake, failIDs: map[int64]bool{created.ID: true}}
	p := NewPoller(registry, provider, sse.NewHub(), newDisabledHAClient())
	demo := NewDemoService(sqlDB, shots.NewRepository(sqlDB), library.NewRepository(sqlDB))
	h := NewHandlers(p, demo, testAPIToken)
	mux := newSystemMux(h)

	req := httptest.NewRequest(http.MethodGet, fmt.Sprintf("/api/status?machineId=%d", created.ID), nil)
	req.Header.Set("X-GLP-Token", testAPIToken)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	body := decodeMap(t, rec.Body.Bytes())

	if body["machineHostname"] != "orphaned.invalid" {
		t.Errorf("machineHostname = %v, want orphaned.invalid (the requested machine)", body["machineHostname"])
	}
	msg, ok := body["lastMachineError"].(string)
	if !ok || msg == "" {
		t.Fatalf("lastMachineError = %v, want a non-empty GetAdapter-failure message describing the requested machine", body["lastMachineError"])
	}
	// Before the fix, a GetAdapter failure left lastMachineError/
	// lastMachineError describing the DEFAULT machine (nil here, since the
	// fake adapter's default-machine poll never ran) while machineHostname
	// above already named the requested one -- the mismatch this test
	// guards against.
}
