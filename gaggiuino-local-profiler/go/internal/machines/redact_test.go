package machines

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
)

func TestRedactSettings(t *testing.T) {
	// mqttPassword present and non-empty -> removed, mqttPasswordSet true, the
	// rest of the object preserved.
	got := RedactSettings([]byte(`{"mqttPassword":"secret","releaseChannel":1}`))
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
	got = RedactSettings([]byte(`{"mqttPassword":""}`))
	obj = nil
	if err := json.Unmarshal(got, &obj); err != nil {
		t.Fatalf("unmarshal redacted %s: %v", got, err)
	}
	if obj["mqttPasswordSet"] != false {
		t.Fatalf("mqttPasswordSet = %v, want false", obj["mqttPasswordSet"])
	}

	// No mqttPassword -> returned byte-for-byte unchanged.
	raw := []byte(`{"releaseChannel":2}`)
	if string(RedactSettings(raw)) != string(raw) {
		t.Fatalf("body without mqttPassword changed: %s", RedactSettings(raw))
	}

	// Non-object / invalid JSON -> returned unchanged.
	for _, raw := range [][]byte{[]byte(`[1,2]`), []byte(`"x"`), []byte(`not json`), []byte(`null`)} {
		if string(RedactSettings(raw)) != string(raw) {
			t.Fatalf("non-object body changed: %s -> %s", raw, RedactSettings(raw))
		}
	}
}

func TestPrepareSettingsWrite_System(t *testing.T) {
	machine := func() ([]byte, error) {
		return []byte(`{"mqttPassword":"cur-pw","visualizerToken":"cur-vis","sprofilerToken":"cur-spro","releaseChannel":0}`), nil
	}
	decode := func(raw []byte) map[string]any {
		t.Helper()
		var obj map[string]any
		if err := json.Unmarshal(raw, &obj); err != nil {
			t.Fatalf("unmarshal %s: %v", raw, err)
		}
		return obj
	}

	// The browser's form lacks every secret -> all come back, marker dropped.
	out, err := prepareSettingsWrite("system", []byte(`{"releaseChannel":1,"mqttPasswordSet":true,"brewDeltaState":"true"}`), machine)
	if err != nil {
		t.Fatalf("prepareSettingsWrite: %v", err)
	}
	got := decode(out)
	for key, want := range map[string]any{"mqttPassword": "cur-pw", "visualizerToken": "cur-vis", "sprofilerToken": "cur-spro", "releaseChannel": float64(1), "brewDeltaState": "true"} {
		if got[key] != want {
			t.Errorf("%s = %#v, want %#v", key, got[key], want)
		}
	}
	if _, present := got["mqttPasswordSet"]; present {
		t.Errorf("mqttPasswordSet not stripped: %s", out)
	}

	// The body carries every secret itself -> kept, the machine is not asked.
	out, err = prepareSettingsWrite("system", []byte(`{"mqttPassword":"typed","visualizerToken":"","sprofilerToken":"t"}`), func() ([]byte, error) {
		t.Fatal("current settings read although the body carries every secret")
		return nil, nil
	})
	if err != nil {
		t.Fatalf("prepareSettingsWrite: %v", err)
	}
	if got := decode(out); got["mqttPassword"] != "typed" || got["visualizerToken"] != "" || got["sprofilerToken"] != "t" {
		t.Errorf("body secrets not kept: %s", out)
	}

	// Errors: a broken body is the caller's fault, an unreadable machine is not.
	if _, err := prepareSettingsWrite("system", []byte(`[1]`), machine); !errors.Is(err, errInvalidSettingsPayload) {
		t.Errorf("array body error = %v, want errInvalidSettingsPayload", err)
	}
	for _, current := range []string{`not json`, `null`, `[]`} {
		_, err := prepareSettingsWrite("system", []byte(`{}`), func() ([]byte, error) { return []byte(current), nil })
		if !errors.Is(err, errUnreadableMachineSettings) {
			t.Errorf("current %s error = %v, want errUnreadableMachineSettings", current, err)
		}
	}
	boom := errors.New("boom")
	if _, err := prepareSettingsWrite("system", []byte(`{}`), func() ([]byte, error) { return nil, boom }); !errors.Is(err, boom) {
		t.Errorf("fetch error = %v, want boom", err)
	}
}

func TestPrepareSettingsWrite_DisplayKeepsHomeUsersAndTokens(t *testing.T) {
	machine := func() ([]byte, error) {
		return []byte(`{"energyCostPerKwh":0.35,"lcdBrightness":80,"homeUsers":[` +
			`{"id":1,"name":"Ana","preferences":{"ledR":255,"visualizerToken":"u1-vis","sprofilerToken":"u1-spro"}},` +
			`{"id":2,"name":"Ben","preferences":{"ledR":10,"visualizerToken":"","sprofilerToken":"u2-spro"}}]}`), nil
	}

	// A write of one field keeps everything else, homeUsers with its tokens included.
	out, err := prepareSettingsWrite("display", []byte(`{"machineId":1,"lcdBrightness":50}`), machine)
	if err != nil {
		t.Fatalf("prepareSettingsWrite: %v", err)
	}
	for _, want := range []string{`"lcdBrightness":50`, `"energyCostPerKwh":0.35`, `"u1-vis"`, `"u1-spro"`, `"u2-spro"`, `"name":"Ben"`} {
		if !strings.Contains(string(out), want) {
			t.Errorf("forwarded display lacks %s: %s", want, out)
		}
	}

	// A write of the redacted users (no tokens, other order, a new colour)
	// gets each user's tokens back by id and keeps the new colour.
	out, err = prepareSettingsWrite("display", []byte(`{"homeUsers":[`+
		`{"id":2,"name":"Ben","preferences":{"ledR":11}},{"id":1,"name":"Ana","preferences":{"ledR":254}}]}`), machine)
	if err != nil {
		t.Fatalf("prepareSettingsWrite: %v", err)
	}
	want := `"homeUsers":[{"id":2,"name":"Ben","preferences":{"ledR":11,"sprofilerToken":"u2-spro","visualizerToken":""}},` +
		`{"id":1,"name":"Ana","preferences":{"ledR":254,"sprofilerToken":"u1-spro","visualizerToken":"u1-vis"}}]`
	if !strings.Contains(string(out), want) {
		t.Errorf("forwarded display = %s, want it to contain %s", out, want)
	}
	if !strings.Contains(string(out), `"lcdBrightness":80`) {
		t.Errorf("forwarded display dropped a field the body did not send: %s", out)
	}
}

func TestRedactSettings_DropsTokensAtAnyDepth(t *testing.T) {
	raw := []byte(`{"system":{"mqttPassword":"pw","visualizerToken":"sys-vis","sprofilerToken":"sys-spro","releaseChannel":1},` +
		`"display":{"lcdBrightness":80,"homeUsers":[{"id":1,"preferences":{"brewDeltaState":"true","ledR":255,"visualizerToken":"u1-vis","sprofilerToken":"u1-spro"}}]}}`)
	got := string(RedactSettings(raw))
	for _, secret := range []string{`"pw"`, "sys-vis", "sys-spro", "u1-vis", "u1-spro", "visualizerToken", "sprofilerToken"} {
		if strings.Contains(got, secret) {
			t.Errorf("redacted body still contains %s: %s", secret, got)
		}
	}
	for _, want := range []string{`"mqttPasswordSet":true`, `"releaseChannel":1`, `"brewDeltaState":"true"`, `"ledR":255`, `"lcdBrightness":80`} {
		if !strings.Contains(got, want) {
			t.Errorf("redacted body lost %s: %s", want, got)
		}
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
	got := RedactSettings(raw)
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

func TestStripHomeUserTokens(t *testing.T) {
	display := map[string]any{"homeUsers": []any{
		map[string]any{"id": json.Number("1"), "preferences": map[string]any{"ledR": json.Number("255"), "visualizerToken": "v1", "sprofilerToken": "s1"}},
		"not a user",
		map[string]any{"id": json.Number("2"), "preferences": "not an object"},
		map[string]any{"id": json.Number("3")},
	}}
	StripHomeUserTokens(display)
	StripHomeUserTokens(map[string]any{"homeUsers": "not a list"})
	prefs := display["homeUsers"].([]any)[0].(map[string]any)["preferences"].(map[string]any)
	if _, present := prefs["visualizerToken"]; present {
		t.Errorf("visualizerToken not removed: %v", prefs)
	}
	if _, present := prefs["sprofilerToken"]; present {
		t.Errorf("sprofilerToken not removed: %v", prefs)
	}
	if prefs["ledR"] != json.Number("255") {
		t.Errorf("ledR = %#v, want 255 kept", prefs["ledR"])
	}
}

func TestRestoreHomeUserTokens_MatchesUsersByID(t *testing.T) {
	user := func(id any, prefs any) map[string]any {
		u := map[string]any{"id": id}
		if prefs != nil {
			u["preferences"] = prefs
		}
		return u
	}
	target := map[string]any{"homeUsers": []any{
		user(json.Number("1"), map[string]any{"ledR": json.Number("1")}),
		user("2", map[string]any{}),
		user(json.Number("4"), nil),
		user(json.Number("5"), map[string]any{"visualizerToken": "typed"}),
	}}
	current := map[string]any{"homeUsers": []any{
		user(json.Number("2"), map[string]any{"visualizerToken": "cur-2"}),
		user(json.Number("4"), map[string]any{"visualizerToken": "cur-4"}),
		user(json.Number("5"), map[string]any{"visualizerToken": "cur-5v", "sprofilerToken": "cur-5s"}),
		user(json.Number("1"), map[string]any{"ledR": json.Number("9"), "visualizerToken": "cur-1v", "sprofilerToken": "cur-1s"}),
	}}
	if copied := RestoreHomeUserTokens(target, current); copied != 3 {
		t.Errorf("copied = %d, want 3", copied)
	}
	users := target["homeUsers"].([]any)
	first := users[0].(map[string]any)["preferences"].(map[string]any)
	if first["visualizerToken"] != "cur-1v" || first["sprofilerToken"] != "cur-1s" || first["ledR"] != json.Number("1") {
		t.Errorf("user 1 preferences = %v, want the current tokens and its own ledR", first)
	}
	if second := users[1].(map[string]any)["preferences"].(map[string]any); len(second) != 0 {
		t.Errorf("string id \"2\" matched number 2: %v", second)
	}
	if _, present := users[2].(map[string]any)["preferences"]; present {
		t.Errorf("a user without preferences got some: %v", users[2])
	}
	fifth := users[3].(map[string]any)["preferences"].(map[string]any)
	if fifth["visualizerToken"] != "typed" || fifth["sprofilerToken"] != "cur-5s" {
		t.Errorf("user 5 preferences = %v, want the typed visualizerToken kept and the current sprofilerToken", fifth)
	}
}

// TestMachineSettings_TokensNeverReachTheBrowser is the handler-level check
// for #2231: no category read or write answer carries a token, and display
// and system writes forward the machine's current tokens and keep homeUsers.
func TestMachineSettings_TokensNeverReachTheBrowser(t *testing.T) {
	allowLoopbackMachineHost(t)
	h, registry, _ := newTestHandlers(t)
	mux := newMux(h)

	fake := newFakeGaggiuinoMachine()
	defer fake.Close()
	// The fake answers every category with this body.
	fake.settingsBody = []byte(`{"mqttPassword":"s3cret","visualizerToken":"sys-vis","sprofilerToken":"sys-spro","releaseChannel":1,` +
		`"energyCostPerKwh":0.35,"homeUsers":[{"id":1,"name":"Ana","preferences":{"ledR":255,"visualizerToken":"u1-vis","sprofilerToken":"u1-spro"}}]}`)
	secrets := []string{"s3cret", "sys-vis", "sys-spro", "u1-vis", "u1-spro"}

	machine, err := registry.CreateMachine(MachineInput{
		Name: strPtr("Fake"), Type: strPtr("gaggiuino"), Host: strPtr(fake.URL),
	})
	if err != nil {
		t.Fatalf("CreateMachine: %v", err)
	}
	id := strconv.FormatInt(machine.ID, 10)

	for _, query := range []string{"", "&category=system", "&category=display"} {
		rec := doRequest(mux, httptest.NewRequest(http.MethodGet, "/api/machine/settings?machineId="+id+query, nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("GET %s status = %d, body=%s", query, rec.Code, rec.Body.Bytes())
		}
		for _, secret := range secrets {
			if strings.Contains(rec.Body.String(), secret) {
				t.Errorf("GET %s leaked %s: %s", query, secret, rec.Body.Bytes())
			}
		}
	}

	for category, body := range map[string]string{"display": `"lcdBrightness":50`, "system": `"releaseChannel":2`} {
		rec := doRequest(mux, httptest.NewRequest(http.MethodPost, "/api/machine/settings/"+category,
		strings.NewReader(`{"machineId":`+id+`,`+body+`}`)))
		if rec.Code != http.StatusOK {
			t.Fatalf("POST %s status = %d, body=%s", category, rec.Code, rec.Body.Bytes())
		}
		for _, secret := range secrets {
			if strings.Contains(rec.Body.String(), secret) {
				t.Errorf("POST %s response leaked %s: %s", category, secret, rec.Body.Bytes())
			}
		}
		fake.mu.Lock()
		forwarded := string(fake.lastUpdateSettingsBody)
		fake.mu.Unlock()
		wants := []string{body, `"sys-vis"`, `"sys-spro"`, `"s3cret"`}
		if category == "display" {
			wants = []string{body, `"u1-vis"`, `"u1-spro"`, `"energyCostPerKwh":0.35`, `"name":"Ana"`}
		}
		for _, want := range wants {
			if !strings.Contains(forwarded, want) {
				t.Errorf("POST %s forwarded %s, want it to contain %s", category, forwarded, want)
			}
		}
	}
}
