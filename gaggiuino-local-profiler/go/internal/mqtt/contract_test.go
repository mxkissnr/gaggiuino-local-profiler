package mqtt

import (
	"errors"
	"net/http"
	"testing"
)

// This file pins routes/mqtt.js's wire contract (#608) — the "pin the
// essential shape" check orders/shots/library's contract_test.go
// established. Transport-dispatch and payload-mapping assertions live in
// mqtt_test.go; this file pins what the four routes guarantee on the wire.

// TestContract_MQTTSettings_RoundTripShape: GET returns a settings object
// with transport/host/port/prefix; POST persists and echoes it; an
// unknown transport is 400.
func TestContract_MQTTSettings_RoundTripShape(t *testing.T) {
	_, repo, m := newRoutes(t, &fakeAdapter{}, fakeSupervisor{err: errors.New("no supervisor")})

	get := decode(t, do(t, m, http.MethodGet, "/api/mqtt/settings", ""))
	for _, key := range []string{"transport", "host", "port", "prefix"} {
		if _, present := get[key]; !present {
			t.Errorf("GET /api/mqtt/settings missing %q: %v", key, get)
		}
	}
	if get["transport"] != "websocket" {
		t.Errorf("default transport = %v, want websocket", get["transport"])
	}

	post := do(t, m, http.MethodPost, "/api/mqtt/settings",
		`{"transport":"mqtt","host":"192.168.1.50","port":1883,"username":"u","password":"p","prefix":"gaggiuino"}`)
	if post.Code != http.StatusOK {
		t.Fatalf("POST status = %d, body=%s", post.Code, post.Body.String())
	}
	if decode(t, post)["host"] != "192.168.1.50" {
		t.Errorf("POST did not echo the saved settings: %s", post.Body.String())
	}
	if repo.GetSettings().Host != "192.168.1.50" {
		t.Error("POST did not persist")
	}

	if bad := do(t, m, http.MethodPost, "/api/mqtt/settings", `{"transport":"carrier-pigeon"}`); bad.Code != http.StatusBadRequest {
		t.Errorf("invalid transport: status = %d, want 400", bad.Code)
	}
}

// TestContract_MQTTDiscovery_AlwaysAnswers200WithAvailable: discovery
// never errors out to the client — { available: false } when the
// Supervisor MQTT service isn't there, { available: true, host, port, ... }
// when it is.
func TestContract_MQTTDiscovery_AlwaysAnswers200WithAvailable(t *testing.T) {
	_, _, unavailable := newRoutes(t, &fakeAdapter{}, fakeSupervisor{err: errors.New("404")})
	rec := do(t, unavailable, http.MethodGet, "/api/mqtt/discovery", "")
	if rec.Code != http.StatusOK || decode(t, rec)["available"] != false {
		t.Fatalf("unavailable: code=%d body=%s", rec.Code, rec.Body.String())
	}

	_, _, available := newRoutes(t, &fakeAdapter{}, fakeSupervisor{
		body: `{"data":{"host":"core-mosquitto","port":1883,"username":"ha","password":"s"}}`,
	})
	rec = do(t, available, http.MethodGet, "/api/mqtt/discovery", "")
	body := decode(t, rec)
	if rec.Code != http.StatusOK || body["available"] != true || body["host"] != "core-mosquitto" {
		t.Fatalf("available: code=%d body=%s", rec.Code, rec.Body.String())
	}
}

// TestContract_MQTTApplyToMachine_Contract: 400 when no broker is
// configured, 501 when the default machine's adapter has no settings
// proxy, 200 + a merged system-settings payload otherwise.
func TestContract_MQTTApplyToMachine_Contract(t *testing.T) {
	// no broker yet
	_, _, m := newRoutes(t, &fakeAdapter{proxy: true, system: map[string]any{}}, fakeSupervisor{err: errors.New("x")})
	if rec := do(t, m, http.MethodPost, "/api/mqtt/apply-to-machine", ""); rec.Code != http.StatusBadRequest {
		t.Errorf("no broker: status = %d, want 400", rec.Code)
	}

	// no proxy support
	_, noProxyRepo, noProxy := newRoutes(t, &fakeAdapter{proxy: false}, fakeSupervisor{err: errors.New("x")})
	noProxyRepo.SaveSettings(Settings{Transport: TransportMQTT, Host: "h", Port: 1883, Prefix: "gaggiuino"})
	if rec := do(t, noProxy, http.MethodPost, "/api/mqtt/apply-to-machine", ""); rec.Code != http.StatusNotImplemented {
		t.Errorf("no proxy: status = %d, want 501", rec.Code)
	}

	// happy path
	ad := &fakeAdapter{proxy: true, system: map[string]any{"wifiEnabled": true}}
	_, okRepo, ok := newRoutes(t, ad, fakeSupervisor{err: errors.New("x")})
	okRepo.SaveSettings(Settings{Transport: TransportMQTT, Host: "192.168.1.50", Port: 1883, Username: "u", Password: "p", Prefix: "gaggiuino"})
	rec := do(t, ok, http.MethodPost, "/api/mqtt/apply-to-machine", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("happy path: status = %d, body=%s", rec.Code, rec.Body.String())
	}
	if len(ad.updated) == 0 {
		t.Error("adapter UpdateSettings was never called")
	}
}
