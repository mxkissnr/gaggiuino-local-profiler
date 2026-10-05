package machines

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
)

func TestRedactSystemSettings(t *testing.T) {
	// mqttPassword present and non-empty -> removed, mqttPasswordSet true, the
	// rest of the object preserved.
	got := RedactSystemSettings([]byte(`{"mqttPassword":"secret","releaseChannel":1}`))
	var obj map[string]any
	if err := json.Unmarshal(got, &obj); err != nil {
		t.Fatalf("unmarshal redacted %s: %v", got, err)
	}
	if _, present := obj["mqttPassword"]; present {
		t.Fatalf("mqttPassword not removed: %s", got)
	}
	if obj["mqttPasswordSet"] != true {
		t.Fatalf("mqttPasswordSet = %v, want true", obj["mqttPasswordSet"])
	}
	if obj["releaseChannel"] != float64(1) {
		t.Fatalf("releaseChannel = %v, want 1", obj["releaseChannel"])
	}

	// Empty string -> mqttPasswordSet false.
	got = RedactSystemSettings([]byte(`{"mqttPassword":""}`))
	obj = nil
	if err := json.Unmarshal(got, &obj); err != nil {
		t.Fatalf("unmarshal redacted %s: %v", got, err)
	}
	if obj["mqttPasswordSet"] != false {
		t.Fatalf("mqttPasswordSet = %v, want false", obj["mqttPasswordSet"])
	}

	// No mqttPassword -> returned byte-for-byte unchanged.
	raw := []byte(`{"releaseChannel":2}`)
	if string(RedactSystemSettings(raw)) != string(raw) {
		t.Fatalf("body without mqttPassword changed: %s", RedactSystemSettings(raw))
	}

	// Non-object / invalid JSON -> returned unchanged.
	for _, raw := range [][]byte{[]byte(`[1,2]`), []byte(`"x"`), []byte(`not json`), []byte(`null`)} {
		if string(RedactSystemSettings(raw)) != string(raw) {
			t.Fatalf("non-object body changed: %s -> %s", raw, RedactSystemSettings(raw))
		}
	}
}

func TestRestoreSystemPassword(t *testing.T) {
	// Body omits mqttPassword -> current's password is copied in, marker stripped.
	body := map[string]any{"releaseChannel": float64(1), "mqttPasswordSet": true}
	RestoreSystemPassword(body, map[string]any{"mqttPassword": "current-secret"})
	if body["mqttPassword"] != "current-secret" {
		t.Fatalf("mqttPassword = %v, want the current one", body["mqttPassword"])
	}
	if _, present := body["mqttPasswordSet"]; present {
		t.Fatalf("mqttPasswordSet not stripped: %v", body)
	}

	// Body carries its own password -> left alone; marker still stripped.
	body = map[string]any{"mqttPassword": "typed-secret", "mqttPasswordSet": true}
	RestoreSystemPassword(body, map[string]any{"mqttPassword": "current-secret"})
	if body["mqttPassword"] != "typed-secret" {
		t.Fatalf("mqttPassword = %v, want the body's own value", body["mqttPassword"])
	}
	if _, present := body["mqttPasswordSet"]; present {
		t.Fatalf("mqttPasswordSet not stripped: %v", body)
	}

	// Neither side has a password -> no key added.
	body = map[string]any{"releaseChannel": float64(1)}
	RestoreSystemPassword(body, map[string]any{})
	if _, present := body["mqttPassword"]; present {
		t.Fatalf("unexpected mqttPassword: %v", body)
	}

	// A nil current must not panic.
	body = map[string]any{"mqttPasswordSet": true}
	RestoreSystemPassword(body, nil)
	if _, present := body["mqttPasswordSet"]; present {
		t.Fatalf("mqttPasswordSet not stripped with nil current: %v", body)
	}
}

// TestMachineSystemSettings_RedactAndRestore exercises the settings proxy
// end-to-end (#1431): a GET of the system category must not leak the
// machine's mqttPassword (reporting mqttPasswordSet instead), and a POST that
// omits it — as the browser form now does — must forward the machine's
// current password rather than wiping it.
func TestMachineSystemSettings_RedactAndRestore(t *testing.T) {
	allowLoopbackMachineHost(t)
	h, registry, _ := newTestHandlers(t)
	mux := newMux(h)

	fake := newFakeGaggiuinoMachine()
	defer fake.Close()
	fake.settingsBody = []byte(`{"mqttPassword":"s3cret","releaseChannel":1}`)

	machine, err := registry.CreateMachine(MachineInput{
		Name: strPtr("Fake"), Type: strPtr("gaggiuino"), Host: strPtr(fake.URL),
	})
	if err != nil {
		t.Fatalf("CreateMachine: %v", err)
	}
	id := strconv.FormatInt(machine.ID, 10)

	rec := doRequest(mux, httptest.NewRequest(http.MethodGet, "/api/machine/settings?category=system&machineId="+id, nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET status = %d, body=%s", rec.Code, rec.Body.Bytes())
	}
	if strings.Contains(rec.Body.String(), "s3cret") {
		t.Fatalf("GET leaked the machine mqttPassword: %s", rec.Body.Bytes())
	}
	if got := decodeBody(t, rec.Body.Bytes())["mqttPasswordSet"]; got != true {
		t.Fatalf("mqttPasswordSet = %v, want true", got)
	}

	rec = doRequest(mux, httptest.NewRequest(http.MethodPost, "/api/machine/settings/system",
		strings.NewReader(`{"machineId":`+id+`,"releaseChannel":1}`)))
	if rec.Code != http.StatusOK {
		t.Fatalf("POST status = %d, body=%s", rec.Code, rec.Body.Bytes())
	}
	fake.mu.Lock()
	forwarded := string(fake.lastUpdateSettingsBody)
	fake.mu.Unlock()
	if !strings.Contains(forwarded, `"mqttPassword":"s3cret"`) {
		t.Fatalf("POST forwarded body missing the machine's current password: %s", forwarded)
	}
	if strings.Contains(rec.Body.String(), "s3cret") {
		t.Fatalf("POST response leaked the machine mqttPassword: %s", rec.Body.Bytes())
	}
}

// TestRedactSystemSettings_NestedAllCategories covers the all-categories
// shape (GET /api/machine/settings with no category): the categories are
// nested, so mqttPassword sits under `system` rather than at the top level.
func TestRedactSystemSettings_NestedAllCategories(t *testing.T) {
	raw := []byte(`{"boiler":{"temperature":93},"system":{"mqttPassword":"s3cret","releaseChannel":1}}`)
	got := RedactSystemSettings(raw)
	if strings.Contains(string(got), "s3cret") {
		t.Fatalf("nested mqttPassword leaked: %s", got)
	}
	var obj map[string]any
	if err := json.Unmarshal(got, &obj); err != nil {
		t.Fatalf("unmarshal %s: %v", got, err)
	}
	sys, ok := obj["system"].(map[string]any)
	if !ok {
		t.Fatalf("system category missing: %s", got)
	}
	if _, present := sys["mqttPassword"]; present {
		t.Fatalf("system.mqttPassword not removed: %s", got)
	}
	if sys["mqttPasswordSet"] != true {
		t.Fatalf("system.mqttPasswordSet = %v, want true", sys["mqttPasswordSet"])
	}
	if obj["boiler"] == nil {
		t.Fatalf("boiler category lost: %s", got)
	}
}

// TestMachineSystemSettings_RedactAllCategories is the handler-level
// counterpart: an empty category (all-categories read) must not leak the
// nested system mqttPassword either.
func TestMachineSystemSettings_RedactAllCategories(t *testing.T) {
	allowLoopbackMachineHost(t)
	h, registry, _ := newTestHandlers(t)
	mux := newMux(h)

	fake := newFakeGaggiuinoMachine()
	defer fake.Close()
	fake.settingsBody = []byte(`{"boiler":{"temperature":93},"system":{"mqttPassword":"s3cret","releaseChannel":1}}`)

	machine, err := registry.CreateMachine(MachineInput{
		Name: strPtr("Fake"), Type: strPtr("gaggiuino"), Host: strPtr(fake.URL),
	})
	if err != nil {
		t.Fatalf("CreateMachine: %v", err)
	}
	id := strconv.FormatInt(machine.ID, 10)

	rec := doRequest(mux, httptest.NewRequest(http.MethodGet, "/api/machine/settings?machineId="+id, nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET status = %d, body=%s", rec.Code, rec.Body.Bytes())
	}
	if strings.Contains(rec.Body.String(), "s3cret") {
		t.Fatalf("all-categories GET leaked the machine mqttPassword: %s", rec.Body.Bytes())
	}
	sys, _ := decodeBody(t, rec.Body.Bytes())["system"].(map[string]any)
	if sys == nil || sys["mqttPasswordSet"] != true {
		t.Fatalf("system.mqttPasswordSet = %v, want true (body=%s)", sys, rec.Body.Bytes())
	}
}

// TestMachineSystemSettings_UpdateParseFailureIs502: if the browser omits
// mqttPassword and the machine's current settings can't be parsed, the save
// must 502 rather than forward a payload that silently wipes the password.
func TestMachineSystemSettings_UpdateParseFailureIs502(t *testing.T) {
	allowLoopbackMachineHost(t)
	h, registry, _ := newTestHandlers(t)
	mux := newMux(h)

	fake := newFakeGaggiuinoMachine()
	defer fake.Close()
	fake.settingsBody = []byte(`not json`)

	machine, err := registry.CreateMachine(MachineInput{
		Name: strPtr("Fake"), Type: strPtr("gaggiuino"), Host: strPtr(fake.URL),
	})
	if err != nil {
		t.Fatalf("CreateMachine: %v", err)
	}
	id := strconv.FormatInt(machine.ID, 10)

	rec := doRequest(mux, httptest.NewRequest(http.MethodPost, "/api/machine/settings/system",
		strings.NewReader(`{"machineId":`+id+`,"releaseChannel":1}`)))
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("POST status = %d, want 502; body=%s", rec.Code, rec.Body.Bytes())
	}
	fake.mu.Lock()
	forwarded := len(fake.lastUpdateSettingsBody)
	fake.mu.Unlock()
	if forwarded != 0 {
		t.Fatalf("settings update was forwarded despite unparseable current settings")
	}
}
