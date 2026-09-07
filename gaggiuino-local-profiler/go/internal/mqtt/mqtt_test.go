package mqtt

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"

	paho "github.com/eclipse/paho.mqtt.golang"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/db"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines/proto"
)

func testRepo(t *testing.T) (*Repository, *machines.Registry) {
	t.Helper()
	sqlDB, err := db.Open(filepath.Join(t.TempDir(), "glp.db"))
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { sqlDB.Close() })
	return NewRepository(sqlDB), machines.NewRegistry(sqlDB)
}

// ── settings ───────────────────────────────────────────────────────────

func TestSettings_DefaultTransport(t *testing.T) {
	repo, _ := testRepo(t)
	if s := repo.GetSettings(); s.Transport != TransportWebSocket || s.Port != 1883 || s.Prefix != "gaggiuino" {
		t.Fatalf("defaults = %+v", s)
	}
}

func TestSettings_SaveRoundTrip(t *testing.T) {
	repo, _ := testRepo(t)
	saved, err := repo.SaveSettings(Settings{Transport: TransportMQTT, Host: "192.168.1.50", Port: 1883, Username: "u", Password: "p", Prefix: "gaggiuino"})
	if err != nil {
		t.Fatal(err)
	}
	if saved.Transport != TransportMQTT || saved.Host != "192.168.1.50" {
		t.Fatalf("saved = %+v", saved)
	}
	if got := repo.GetSettings(); got.Host != "192.168.1.50" {
		t.Fatalf("reloaded = %+v", got)
	}
}

// TestConnect_RejectsSSRFBlockedBrokerHost is the #988 regression test:
// connect() must reject a broker host the shared machine-host SSRF guard
// blocks (loopback/link-local/cloud-metadata) before ever calling AddBroker
// or constructing a paho client for it — matching how machine-host
// validation is tested in machines/ssrf_test.go. 169.254.169.254 is a
// literal IP, so this needs no fake DNS resolver (AssertHost's literal-IP
// fast path).
func TestConnect_RejectsSSRFBlockedBrokerHost(t *testing.T) {
	c := NewClient()
	called := false
	c.newPahoClient = func(*paho.ClientOptions) paho.Client {
		called = true
		return nil
	}
	s := c.connect(Conn{Host: "169.254.169.254", Port: 1883, Prefix: "gaggiuino"})
	if called {
		t.Fatal("connect() constructed a paho client for a blocked broker host")
	}
	if s.client != nil {
		t.Fatal("session got a client despite the guard rejecting the host")
	}
}

// TestOpenGuardedMQTTConnection_BlocksSSRFHost is the #990 code-review
// regression test: paho's own SetAutoReconnect redials the broker through
// SetCustomOpenConnectionFn (openGuardedMQTTConnection), entirely
// independent of connect()'s one-time machines.AssertMachineHost check —
// this proves that path is guarded too, not just the initial connect.
func TestOpenGuardedMQTTConnection_BlocksSSRFHost(t *testing.T) {
	_, err := openGuardedMQTTConnection(&url.URL{Host: "169.254.169.254:1883"}, *paho.NewClientOptions())
	if err == nil {
		t.Fatal("expected the SSRF guard to reject a cloud-metadata broker address")
	}
}

// ── validation ─────────────────────────────────────────────────────────

func TestParseSettings(t *testing.T) {
	if _, err := parseSettings(map[string]any{"transport": "mqtt", "host": "h"}); err != nil {
		t.Errorf("valid: %v", err)
	}
	if s, _ := parseSettings(map[string]any{"transport": "websocket"}); s.Port != 1883 || s.Prefix != "gaggiuino" {
		t.Errorf("defaults not applied: %+v", s)
	}
	for _, bad := range []map[string]any{
		{},
		{"transport": "carrier-pigeon"},
		{"transport": "mqtt", "port": float64(70000)},
		{"transport": "mqtt", "prefix": ""},
	} {
		if _, err := parseSettings(bad); err == nil {
			t.Errorf("expected error for %v", bad)
		}
	}
}

// ── payload mapping (the WS-field-name contract) ───────────────────────

func TestToSensorSnap(t *testing.T) {
	snap := toSensorSnap([]byte(`{"brewActive":true,"temperature":92.5,"pumpFlow":1.2,"boilerOn":true,"valveOpen":false,"hotWaterActive":false}`))
	if snap == nil || !snap.BrewActive || snap.Temperature != 92.5 || snap.PumpFlow != 1.2 {
		t.Fatalf("snap = %+v", snap)
	}
	if !snap.BoilerState || snap.ValveState || snap.HotWaterSwitchState {
		t.Errorf("MQTT->WS field mapping wrong: %+v", snap)
	}
	if toSensorSnap([]byte("not json")) != nil {
		t.Error("expected nil for malformed payload")
	}
}

func TestToSysState(t *testing.T) {
	state := toSysState([]byte(`{"operationMode":"STEAM","thermocoupleFaulted":true,"thermocoupleFaultReason":"Open circuit","coreVersion":"1.5.0"}`))
	if state == nil || state.OperationMode != proto.ModeSteam || !state.ThermocoupleFaulted || state.CoreVersion != "1.5.0" {
		t.Fatalf("state = %+v", state)
	}
	if state.ThermocoupleFaultReason != "Open circuit" {
		t.Errorf("fault reason = %q", state.ThermocoupleFaultReason)
	}
	// unknown operationMode must not drop the whole message
	s2 := toSysState([]byte(`{"operationMode":"WAT","coreVersion":"2.0"}`))
	if s2 == nil || s2.CoreVersion != "2.0" {
		t.Errorf("unknown opmode dropped the message: %+v", s2)
	}
}

// ── transport dispatch (ports live-transport.test.js) ─────────────────

func TestTransport_Eligibility(t *testing.T) {
	repo, _ := testRepo(t)
	tr := NewTransport(NewClient(), repo)

	// websocket default -> not MQTT
	if _, ok := tr.SensorSnapshot(true); ok {
		t.Error("websocket transport should not be MQTT-active")
	}
	// mqtt + host, default machine -> MQTT active
	repo.SaveSettings(Settings{Transport: TransportMQTT, Host: "192.168.1.50", Port: 1883, Prefix: "gaggiuino"})
	if _, ok := tr.SystemState(true); !ok {
		t.Error("mqtt + host + default machine should be MQTT-active")
	}
	// non-default machine -> never MQTT
	if _, ok := tr.SensorSnapshot(false); ok {
		t.Error("non-default machine must stay on WS")
	}
	// mqtt selected but no host -> fall back to WS
	repo.SaveSettings(Settings{Transport: TransportMQTT, Host: "", Prefix: "gaggiuino"})
	if _, ok := tr.SensorSnapshot(true); ok {
		t.Error("mqtt with no host should fall back to WS")
	}
}

// ── discovery ─────────────────────────────────────────────────────────

type fakeSupervisor struct {
	body string
	err  error
}

func (f fakeSupervisor) SupervisorGet(_ context.Context, _ string, out any) error {
	if f.err != nil {
		return f.err
	}
	return json.Unmarshal([]byte(f.body), out)
}

func TestDiscovery(t *testing.T) {
	if b := DiscoverSupervisorMQTT(context.Background(), fakeSupervisor{err: errors.New("404")}); b != nil {
		t.Errorf("expected nil on error, got %+v", b)
	}
	if b := DiscoverSupervisorMQTT(context.Background(), fakeSupervisor{body: `{"data":{}}`}); b != nil {
		t.Errorf("expected nil with no host, got %+v", b)
	}
	b := DiscoverSupervisorMQTT(context.Background(), fakeSupervisor{body: `{"data":{"host":"core-mosquitto","port":1883,"username":"ha-mqtt","password":"secret"}}`})
	if b == nil || b.Host != "core-mosquitto" || b.Username != "ha-mqtt" {
		t.Fatalf("broker = %+v", b)
	}
}

// ── routes ────────────────────────────────────────────────────────────

func do(t *testing.T, m *http.ServeMux, method, target, body string) *httptest.ResponseRecorder {
	t.Helper()
	var r *http.Request
	if body == "" {
		r = httptest.NewRequest(method, target, nil)
	} else {
		r = httptest.NewRequest(method, target, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
	}
	rec := httptest.NewRecorder()
	m.ServeHTTP(rec, r)
	return rec
}

func decode(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decoding %q: %v", rec.Body.String(), err)
	}
	return out
}

// fakeAdapter implements just enough of machines.Adapter for apply-to-machine.
type fakeAdapter struct {
	machines.Adapter
	proxy   bool
	system  map[string]any
	getErr  error
	updated json.RawMessage
	updErr  error
}

func (f *fakeAdapter) Capabilities() machines.Capabilities {
	return machines.Capabilities{SettingsProxy: f.proxy}
}
func (f *fakeAdapter) GetSettings(_ context.Context, _ *machines.Machine, _ string) (json.RawMessage, error) {
	if f.getErr != nil {
		return nil, f.getErr
	}
	b, _ := json.Marshal(f.system)
	return b, nil
}
func (f *fakeAdapter) UpdateSettings(_ context.Context, _ *machines.Machine, _ string, payload json.RawMessage) (json.RawMessage, error) {
	f.updated = payload
	if f.updErr != nil {
		return nil, f.updErr
	}
	return []byte(`{"success":true}`), nil
}

type fakeAdapters struct{ a *fakeAdapter }

func (f fakeAdapters) GetAdapter(*machines.Machine) (machines.Adapter, error) { return f.a, nil }

func newRoutes(t *testing.T, ad *fakeAdapter, sup SupervisorAPI) (*Handlers, *Repository, *http.ServeMux) {
	t.Helper()
	repo, registry := testRepo(t)
	tr := NewTransport(NewClient(), repo)
	h := NewHandlers(repo, tr, registry, fakeAdapters{a: ad}, sup)
	m := http.NewServeMux()
	h.RegisterRoutes(m)
	return h, repo, m
}

func TestRoute_DiscoveryUnavailable(t *testing.T) {
	_, _, m := newRoutes(t, &fakeAdapter{}, fakeSupervisor{err: errors.New("no service")})
	rec := do(t, m, http.MethodGet, "/api/mqtt/discovery", "")
	if rec.Code != 200 || decode(t, rec)["available"] != false {
		t.Fatalf("code=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestRoute_SettingsGetPost(t *testing.T) {
	_, repo, m := newRoutes(t, &fakeAdapter{}, fakeSupervisor{err: errors.New("x")})
	if decode(t, do(t, m, http.MethodGet, "/api/mqtt/settings", ""))["transport"] != "websocket" {
		t.Fatal("default transport not websocket")
	}
	rec := do(t, m, http.MethodPost, "/api/mqtt/settings", `{"transport":"mqtt","host":"192.168.1.50","port":1883,"username":"u","password":"p","prefix":"gaggiuino"}`)
	if rec.Code != 200 || decode(t, rec)["host"] != "192.168.1.50" {
		t.Fatalf("code=%d body=%s", rec.Code, rec.Body.String())
	}
	if repo.GetSettings().Host != "192.168.1.50" {
		t.Error("not persisted")
	}
	if do(t, m, http.MethodPost, "/api/mqtt/settings", `{"transport":"carrier-pigeon"}`).Code != 400 {
		t.Error("invalid transport should 400")
	}
}

// TestRoute_SettingsPost_RejectsSSRFBlockedHost is the #988 regression
// test's HTTP-handler-level counterpart: POSTing a broker host the shared
// machine-host SSRF guard blocks must 400 and must not persist.
func TestRoute_SettingsPost_RejectsSSRFBlockedHost(t *testing.T) {
	_, repo, m := newRoutes(t, &fakeAdapter{}, fakeSupervisor{err: errors.New("x")})
	rec := do(t, m, http.MethodPost, "/api/mqtt/settings", `{"transport":"mqtt","host":"169.254.169.254","port":1883,"prefix":"gaggiuino"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for a cloud-metadata broker host, got %d: %s", rec.Code, rec.Body.String())
	}
	if repo.GetSettings().Host == "169.254.169.254" {
		t.Fatal("blocked host must not be persisted")
	}
}

func TestRoute_ApplyToMachine(t *testing.T) {
	ad := &fakeAdapter{proxy: true, system: map[string]any{"wifiEnabled": true, "mqttEnabled": false}}
	_, repo, m := newRoutes(t, ad, fakeSupervisor{err: errors.New("x")})

	// no broker configured yet
	if do(t, m, http.MethodPost, "/api/mqtt/apply-to-machine", "").Code != 400 {
		t.Fatal("expected 400 without a broker")
	}

	repo.SaveSettings(Settings{Transport: TransportMQTT, Host: "192.168.1.50", Port: 1883, Username: "u", Password: "p", Prefix: "gaggiuino"})
	rec := do(t, m, http.MethodPost, "/api/mqtt/apply-to-machine", "")
	if rec.Code != 200 {
		t.Fatalf("code=%d body=%s", rec.Code, rec.Body.String())
	}
	var sent map[string]any
	if err := json.Unmarshal(ad.updated, &sent); err != nil {
		t.Fatal(err)
	}
	if sent["mqttEnabled"] != true || sent["mqttHost"] != "192.168.1.50" || sent["mqttTopicPrefix"] != "gaggiuino" || sent["wifiEnabled"] != true {
		t.Fatalf("merged payload wrong: %v", sent)
	}
}

func TestRoute_ApplyToMachine_NoProxy(t *testing.T) {
	_, repo, m := newRoutes(t, &fakeAdapter{proxy: false}, fakeSupervisor{err: errors.New("x")})
	repo.SaveSettings(Settings{Transport: TransportMQTT, Host: "h", Prefix: "gaggiuino"})
	if rec := do(t, m, http.MethodPost, "/api/mqtt/apply-to-machine", ""); rec.Code != 501 {
		t.Fatalf("expected 501, got %d", rec.Code)
	}
}
