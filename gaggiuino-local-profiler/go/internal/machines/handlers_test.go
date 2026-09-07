package machines

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
)

func TestHandlers_MachinesCRUD(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)

	// GET seeds the default machine.
	rec := doRequest(mux, httptest.NewRequest(http.MethodGet, "/api/machines", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /api/machines status = %d, body = %s", rec.Code, rec.Body)
	}

	// POST create — empty host is valid (#718 "not configured yet").
	rec = doRequest(mux, httptest.NewRequest(http.MethodPost, "/api/machines", strings.NewReader(`{"name":"Kitchen","type":"gaggimate","host":""}`)))
	if rec.Code != http.StatusOK {
		t.Fatalf("POST /api/machines status = %d, body = %s", rec.Code, rec.Body)
	}
	created := decodeBody(t, rec.Body.Bytes())
	id := int64(created["id"].(float64))
	if created["name"] != "Kitchen" || created["isDefault"] != false {
		t.Fatalf("unexpected created machine: %+v", created)
	}

	// PUT update (partial).
	req := httptest.NewRequest(http.MethodPut, "/api/machines/"+strconv.FormatInt(id, 10), strings.NewReader(`{"name":"Renamed"}`))
	rec = doRequest(mux, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("PUT status = %d, body = %s", rec.Code, rec.Body)
	}
	updated := decodeBody(t, rec.Body.Bytes())
	if updated["name"] != "Renamed" {
		t.Fatalf("PUT did not apply the update: %+v", updated)
	}

	// PUT on an unknown id -> 404.
	rec = doRequest(mux, httptest.NewRequest(http.MethodPut, "/api/machines/999", strings.NewReader(`{"name":"X"}`)))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("PUT unknown id status = %d, want 404", rec.Code)
	}

	// DELETE the default machine -> 400.
	rec = doRequest(mux, httptest.NewRequest(http.MethodDelete, "/api/machines/1", nil))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("DELETE default machine status = %d, want 400, body = %s", rec.Code, rec.Body)
	}

	// DELETE the non-default machine -> 200.
	rec = doRequest(mux, httptest.NewRequest(http.MethodDelete, "/api/machines/"+strconv.FormatInt(id, 10), nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("DELETE non-default machine status = %d, body = %s", rec.Code, rec.Body)
	}

	// DELETE again -> 404 (already gone).
	rec = doRequest(mux, httptest.NewRequest(http.MethodDelete, "/api/machines/"+strconv.FormatInt(id, 10), nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("DELETE already-deleted machine status = %d, want 404", rec.Code)
	}
}

func TestHandlers_CreateMachineValidation(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)

	cases := []struct {
		name string
		body string
	}{
		{"missing name", `{"type":"gaggiuino","host":""}`},
		{"invalid type", `{"name":"X","type":"other","host":""}`},
		{"name too long", `{"name":"` + strings.Repeat("x", 101) + `","type":"gaggiuino","host":""}`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			rec := doRequest(mux, httptest.NewRequest(http.MethodPost, "/api/machines", strings.NewReader(c.body)))
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400, body = %s", rec.Code, rec.Body)
			}
		})
	}
}

func TestHandlers_SetDefaultAndTestMachine(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)

	doRequest(mux, httptest.NewRequest(http.MethodGet, "/api/machines", nil)) // seed default
	rec := doRequest(mux, httptest.NewRequest(http.MethodPost, "/api/machines", strings.NewReader(`{"name":"B","type":"gaggimate","host":""}`)))
	created := decodeBody(t, rec.Body.Bytes())
	id := int64(created["id"].(float64))

	rec = doRequest(mux, httptest.NewRequest(http.MethodPost, "/api/machines/"+strconv.FormatInt(id, 10)+"/default", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("set default status = %d, body = %s", rec.Code, rec.Body)
	}
	body := decodeBody(t, rec.Body.Bytes())
	if body["isDefault"] != true {
		t.Fatalf("machine not flagged default: %+v", body)
	}

	rec = doRequest(mux, httptest.NewRequest(http.MethodPost, "/api/machines/999/default", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("set default unknown id status = %d, want 404", rec.Code)
	}

	// /test always answers 200 even when unreachable (empty host).
	rec = doRequest(mux, httptest.NewRequest(http.MethodPost, "/api/machines/"+strconv.FormatInt(id, 10)+"/test", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("test status = %d, want 200, body = %s", rec.Code, rec.Body)
	}
	result := decodeBody(t, rec.Body.Bytes())
	if result["reachable"] != false {
		t.Fatalf("expected reachable=false for an empty-host machine, got %+v", result)
	}
}

func TestHandlers_SettingsProxy_CapabilityGating(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)

	doRequest(mux, httptest.NewRequest(http.MethodGet, "/api/machines", nil)) // seed default (gaggiuino)
	rec := doRequest(mux, httptest.NewRequest(http.MethodPost, "/api/machines", strings.NewReader(`{"name":"GM","type":"gaggimate","host":""}`)))
	created := decodeBody(t, rec.Body.Bytes())
	id := int64(created["id"].(float64))

	rec = doRequest(mux, httptest.NewRequest(http.MethodGet, "/api/machine/settings?machineId="+strconv.FormatInt(id, 10), nil))
	if rec.Code != http.StatusNotImplemented {
		t.Fatalf("GaggiMate settings status = %d, want 501, body = %s", rec.Code, rec.Body)
	}

	rec = doRequest(mux, httptest.NewRequest(http.MethodPost, "/api/machine/tare", strings.NewReader(`{"machineId":`+strconv.FormatInt(id, 10)+`}`)))
	if rec.Code != http.StatusNotImplemented {
		t.Fatalf("GaggiMate tare status = %d, want 501, body = %s", rec.Code, rec.Body)
	}

	rec = doRequest(mux, httptest.NewRequest(http.MethodGet, "/api/machine/live?machineId="+strconv.FormatInt(id, 10), nil))
	if rec.Code != http.StatusNotImplemented {
		t.Fatalf("GaggiMate live status = %d, want 501, body = %s", rec.Code, rec.Body)
	}
}

func TestHandlers_SettingsQuirkPassthrough_EndToEnd(t *testing.T) {
	allowLoopbackMachineHost(t)
	fake := newFakeGaggiuinoMachine()
	fake.settingsBody = []byte(`{"brewDeltaState":"true","dreamSteamState":"false","lcdCloseOnBrewOff":true}`)
	defer fake.Close()

	h, registry, _ := newTestHandlers(t)
	if _, err := registry.CreateMachine(MachineInput{Name: strPtr("Real"), Type: strPtr("gaggiuino"), Host: strPtr(fake.URL), Enabled: boolPtr(true)}); err != nil {
		t.Fatalf("CreateMachine: %v", err)
	}
	// Make the freshly-created machine the default so it's the one
	// resolveMachine(nil) picks — simpler than threading its id through
	// every request below.
	list, _ := registry.ListMachines()
	if _, err := registry.SetDefaultMachine(list[len(list)-1].ID); err != nil {
		t.Fatalf("SetDefaultMachine: %v", err)
	}

	mux := newMux(h)
	rec := doRequest(mux, httptest.NewRequest(http.MethodGet, "/api/machine/settings?category=boiler", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET settings status = %d, body = %s", rec.Code, rec.Body)
	}
	body := rec.Body.String()
	if !jsonContains(body, `"brewDeltaState":"true"`) || !jsonContains(body, `"dreamSteamState":"false"`) {
		t.Errorf("settings quirk fields were normalized across the HTTP handler: %s", body)
	}
	if !jsonContains(body, `"lcdCloseOnBrewOff":true`) {
		t.Errorf("a genuine boolean field was corrupted across the HTTP handler: %s", body)
	}
}

func TestHandlers_OpModeValidation(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)
	doRequest(mux, httptest.NewRequest(http.MethodGet, "/api/machines", nil)) // seed default (gaggiuino, unreachable)

	rec := doRequest(mux, httptest.NewRequest(http.MethodPost, "/api/machine/opmode", strings.NewReader(`{"mode":"BREW_MANUAL"}`)))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("BREW_MANUAL status = %d, want 400, body = %s", rec.Code, rec.Body)
	}

	rec = doRequest(mux, httptest.NewRequest(http.MethodPost, "/api/machine/opmode", strings.NewReader(`{"mode":99}`)))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("out-of-range mode status = %d, want 400, body = %s", rec.Code, rec.Body)
	}

	// A structurally valid mode against an unreachable machine -> 502, not 400/501.
	rec = doRequest(mux, httptest.NewRequest(http.MethodPost, "/api/machine/opmode", strings.NewReader(`{"mode":"STEAM"}`)))
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("STEAM against unreachable machine status = %d, want 502, body = %s", rec.Code, rec.Body)
	}
}

// fakeNoProfileEditAdapter stands in for an adapter type that hasn't wired up
// profile editing — both real adapters (gaggiuino, gaggimate) now report
// ProfileEdit: true, so the 501 gate below is no longer reachable through
// either of them and needs a fake to exercise it.
type fakeNoProfileEditAdapter struct{ fakePanicAdapter }

func (fakeNoProfileEditAdapter) Capabilities() Capabilities { return Capabilities{} }

func TestHandlers_MachineProfileCreate_RequiresProfileEditSupport(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	h.gaggimate = fakeNoProfileEditAdapter{}
	mux := newMux(h)

	rec := doRequest(mux, httptest.NewRequest(http.MethodPost, "/api/machines", strings.NewReader(`{"name":"GM","type":"gaggimate","host":""}`)))
	created := decodeBody(t, rec.Body.Bytes())
	id := int64(created["id"].(float64))

	body := `{"name":"P","phases":[{"type":"PRESSURE"}],"machineId":` + strconv.FormatInt(id, 10) + `}`
	rec = doRequest(mux, httptest.NewRequest(http.MethodPost, "/api/machine/profile", strings.NewReader(body)))
	if rec.Code != http.StatusNotImplemented {
		t.Fatalf("create profile on GaggiMate status = %d, want 501, body = %s", rec.Code, rec.Body)
	}
}

func TestHandlers_MachineProfileCreate_ValidatesBody(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)
	doRequest(mux, httptest.NewRequest(http.MethodGet, "/api/machines", nil)) // seed default (gaggiuino)

	rec := doRequest(mux, httptest.NewRequest(http.MethodPost, "/api/machine/profile", strings.NewReader(`{"name":"","phases":[]}`)))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400, body = %s", rec.Code, rec.Body)
	}
}

// TestHandlers_MachineProfileCRUD_EndToEnd closes the full loop this
// phase's task brief asked for — REST request in, over ws.go's real
// WebSocket client, against a real (fake) machine, and back out as a REST
// response — using the same fakeGaggiuinoMachine the adapter-level tests
// use, but this time driven entirely through net/http (mux.ServeHTTP),
// exactly the path a real HA-integration/Lovelace-card request takes.
func TestHandlers_MachineProfileCRUD_EndToEnd(t *testing.T) {
	allowLoopbackMachineHost(t)
	fake := newFakeGaggiuinoMachine()
	fake.restProfileCreate404 = true // force the create onto the WS path, same as the adapter-level test
	defer fake.Close()

	h, registry, _ := newTestHandlers(t)
	m, err := registry.CreateMachine(MachineInput{Name: strPtr("Real"), Type: strPtr("gaggiuino"), Host: strPtr(fake.URL), Enabled: boolPtr(true)})
	if err != nil {
		t.Fatalf("CreateMachine: %v", err)
	}
	if _, err := registry.SetDefaultMachine(m.ID); err != nil {
		t.Fatalf("SetDefaultMachine: %v", err)
	}
	mux := newMux(h)

	rec := doRequest(mux, httptest.NewRequest(http.MethodPost, "/api/machine/profile", strings.NewReader(`{"name":"Espresso","phases":[{"type":"PRESSURE"}]}`)))
	if rec.Code != http.StatusOK {
		t.Fatalf("create status = %d, body = %s", rec.Code, rec.Body)
	}
	created := decodeBody(t, rec.Body.Bytes())
	profileID := created["id"].(string)
	if created["name"] != "Espresso" {
		t.Fatalf("unexpected created profile: %+v", created)
	}

	rec = doRequest(mux, httptest.NewRequest(http.MethodPut, "/api/machine/profile/"+profileID, strings.NewReader(`{"name":"Espresso v2","phases":[{"type":"FLOW"}]}`)))
	if rec.Code != http.StatusOK {
		t.Fatalf("update status = %d, body = %s", rec.Code, rec.Body)
	}
	updated := decodeBody(t, rec.Body.Bytes())
	if updated["name"] != "Espresso v2" {
		t.Fatalf("update did not apply: %+v", updated)
	}

	rec = doRequest(mux, httptest.NewRequest(http.MethodDelete, "/api/machine/profile/"+profileID, nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("delete status = %d, body = %s", rec.Code, rec.Body)
	}
	deleteResult := decodeBody(t, rec.Body.Bytes())
	if remaining, ok := deleteResult["remaining"].([]any); !ok || len(remaining) != 0 {
		t.Fatalf("expected an empty remaining list after deleting the only profile, got %+v", deleteResult)
	}
}

// TestDecodeJSONBody_EmptyBodyKeepsDefaults and
// TestDecodeJSONBody_MalformedBodyStill400s pin decodeJSONBody's behavior
// (#901's httputil.DecodeJSONBodyInto extraction) at the unit level rather
// than through a full HTTP endpoint: this package's decodeJSONBody already
// tolerated a genuinely empty body before the #901 dedup (unlike every
// other domain's own decodeJSONBody, which all 400ed on it) -- these two
// tests prove the extraction into internal/httputil didn't change that
// behavior, without needing a working machine adapter/registry fixture
// just to reach a POST /api/machine/* handler.
func TestDecodeJSONBody_EmptyBodyKeepsDefaults(t *testing.T) {
	body := struct {
		Foo string `json:"foo"`
	}{Foo: "default"}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/x", nil)
	if !decodeJSONBody(rec, req, &body) {
		t.Fatalf("decodeJSONBody returned false for an empty body; want true (tolerant, #901)")
	}
	if body.Foo != "default" {
		t.Fatalf("body.Foo = %q, want preserved default %q", body.Foo, "default")
	}
}

func TestDecodeJSONBody_MalformedBodyStill400s(t *testing.T) {
	var body struct {
		Foo string `json:"foo"`
	}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/x", strings.NewReader("{not valid json"))
	if decodeJSONBody(rec, req, &body) {
		t.Fatalf("decodeJSONBody returned true for malformed JSON; want false (400)")
	}
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
}
