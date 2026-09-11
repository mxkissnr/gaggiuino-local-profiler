package machines

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
)

// TestFirmwareVersion_ParallelSettingsFetch is the #901 code-review
// regression test for firmwareVersion (routes/machine-control.js's
// GET /api/machine/firmware/version): the Node original fetches
// getSettings('versions') and getSettings('system') via Promise.all, but
// this handler originally issued them as two sequential adapter calls.
// Exercises the handler end-to-end against a fake machine server and a
// fake GitHub-releases server to confirm both concurrent GetSettings
// results actually make it into the response, not just that the handler
// compiles.
func TestFirmwareVersion_ParallelSettingsFetch(t *testing.T) {
	allowLoopbackMachineHost(t)
	h, registry, _ := newTestHandlers(t)
	mux := newMux(h)

	fake := newFakeGaggiuinoMachine()
	defer fake.Close()
	fake.settingsBody = []byte(`{"coreVersion":"aaa1111","releaseChannel":0}`)

	releases := fakeGitHubReleases(t, []githubRelease{
		{TagName: "main-bbb2222", PublishedAt: "2026-02-01T00:00:00Z", HTMLURL: "https://example.com/main"},
	})
	overrideReleasesAPI(t, releases.URL)

	machine, err := registry.CreateMachine(MachineInput{
		Name: strPtr("Fake"), Type: strPtr("gaggiuino"), Host: strPtr(fake.URL),
	})
	if err != nil {
		t.Fatalf("CreateMachine: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/machine/firmware/version?machineId="+strconv.FormatInt(machine.ID, 10), nil)
	rec := doRequest(mux, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET firmware/version status = %d, body = %s", rec.Code, rec.Body)
	}

	body := decodeBody(t, rec.Body.Bytes())
	if body["installed"] != "aaa1111" {
		t.Fatalf("installed = %v, want %q (from the 'versions' category fetch)", body["installed"], "aaa1111")
	}
	if body["latest"] != "bbb2222" {
		t.Fatalf("latest = %v, want %q (release channel came from the 'system' category fetch)", body["latest"], "bbb2222")
	}
	if body["updateAvailable"] != true {
		t.Fatalf("updateAvailable = %v, want true", body["updateAvailable"])
	}
}

// #1037: a failing GitHub latest-release lookup must not 502 the whole
// endpoint -- the locally-known installed coreVersion still has to reach
// Home Assistant, with latest: null.
func TestFirmwareVersion_GitHubFailureStillReportsInstalled(t *testing.T) {
	allowLoopbackMachineHost(t)
	h, registry, _ := newTestHandlers(t)
	mux := newMux(h)

	fake := newFakeGaggiuinoMachine()
	defer fake.Close()
	fake.settingsBody = []byte(`{"coreVersion":"aaa1111","releaseChannel":0}`)

	github := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		w.Write([]byte(`{"message":"API rate limit exceeded"}`))
	}))
	defer github.Close()
	overrideReleasesAPI(t, github.URL)

	machine, err := registry.CreateMachine(MachineInput{
		Name: strPtr("Fake"), Type: strPtr("gaggiuino"), Host: strPtr(fake.URL),
	})
	if err != nil {
		t.Fatalf("CreateMachine: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/machine/firmware/version?machineId="+strconv.FormatInt(machine.ID, 10), nil)
	rec := doRequest(mux, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s; want 200 despite GitHub failure", rec.Code, rec.Body)
	}
	body := decodeBody(t, rec.Body.Bytes())
	if body["installed"] != "aaa1111" {
		t.Fatalf("installed = %v, want aaa1111", body["installed"])
	}
	if body["latest"] != nil {
		t.Fatalf("latest = %v, want nil", body["latest"])
	}
	if body["updateAvailable"] != false {
		t.Fatalf("updateAvailable = %v, want false", body["updateAvailable"])
	}
}

// #1044: handler-level coverage for POST /api/machine/firmware/update and
// GET /api/machine/firmware/progress -- the version endpoint above already
// had HTTP-level tests, these two didn't (the adapter-level behavior itself
// is covered by gaggiuino_adapter_test.go's TestGaggiuinoAdapter_Firmware;
// this is specifically about route registration, the requireSettingsProxySupport
// gate, and status-code mapping at the handlers.go layer).

func TestTriggerFirmwareUpdate_HappyPath(t *testing.T) {
	allowLoopbackMachineHost(t)
	h, registry, _ := newTestHandlers(t)
	mux := newMux(h)

	fake := newFakeGaggiuinoMachine()
	defer fake.Close()

	machine, err := registry.CreateMachine(MachineInput{
		Name: strPtr("Fake"), Type: strPtr("gaggiuino"), Host: strPtr(fake.URL),
	})
	if err != nil {
		t.Fatalf("CreateMachine: %v", err)
	}

	body := `{"machineId":` + strconv.FormatInt(machine.ID, 10) + `}`
	req := httptest.NewRequest(http.MethodPost, "/api/machine/firmware/update", strings.NewReader(body))
	rec := doRequest(mux, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("POST firmware/update status = %d, body = %s", rec.Code, rec.Body)
	}
	if !jsonContains(rec.Body.String(), `"success":true`) {
		t.Fatalf("unexpected firmware update result: %s", rec.Body.String())
	}
}

func TestFirmwareProgress_HappyPath(t *testing.T) {
	allowLoopbackMachineHost(t)
	h, registry, _ := newTestHandlers(t)
	mux := newMux(h)

	fake := newFakeGaggiuinoMachine()
	defer fake.Close()

	machine, err := registry.CreateMachine(MachineInput{
		Name: strPtr("Fake"), Type: strPtr("gaggiuino"), Host: strPtr(fake.URL),
	})
	if err != nil {
		t.Fatalf("CreateMachine: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/machine/firmware/progress?machineId="+strconv.FormatInt(machine.ID, 10), nil)
	rec := doRequest(mux, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET firmware/progress status = %d, body = %s", rec.Code, rec.Body)
	}
	if !jsonContains(rec.Body.String(), `"status":"IDLE"`) {
		t.Fatalf("unexpected firmware progress: %s", rec.Body.String())
	}
}

// #1044: mirrors TestHandlers_SettingsProxy_CapabilityGating (handlers_test.go)
// for the two firmware routes that test didn't cover.
func TestFirmwareUpdateAndProgress_RequireSettingsProxySupport(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)

	rec := doRequest(mux, httptest.NewRequest(http.MethodPost, "/api/machines", strings.NewReader(`{"name":"GM","type":"gaggimate","host":""}`)))
	created := decodeBody(t, rec.Body.Bytes())
	id := int64(created["id"].(float64))

	rec = doRequest(mux, httptest.NewRequest(http.MethodPost, "/api/machine/firmware/update", strings.NewReader(`{"machineId":`+strconv.FormatInt(id, 10)+`}`)))
	if rec.Code != http.StatusNotImplemented {
		t.Fatalf("GaggiMate firmware/update status = %d, want 501, body = %s", rec.Code, rec.Body)
	}

	rec = doRequest(mux, httptest.NewRequest(http.MethodGet, "/api/machine/firmware/progress?machineId="+strconv.FormatInt(id, 10), nil))
	if rec.Code != http.StatusNotImplemented {
		t.Fatalf("GaggiMate firmware/progress status = %d, want 501, body = %s", rec.Code, rec.Body)
	}
}

// #1044: mirrors TestHandlers_OpModeValidation's "structurally valid request
// against an unreachable machine -> 502" case for the two firmware routes.
func TestFirmwareUpdateAndProgress_AdapterErrorMapsTo502(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)
	doRequest(mux, httptest.NewRequest(http.MethodGet, "/api/machines", nil)) // seed default (gaggiuino, unreachable)

	rec := doRequest(mux, httptest.NewRequest(http.MethodPost, "/api/machine/firmware/update", strings.NewReader(`{}`)))
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("firmware/update against unreachable machine status = %d, want 502, body = %s", rec.Code, rec.Body)
	}

	rec = doRequest(mux, httptest.NewRequest(http.MethodGet, "/api/machine/firmware/progress", nil))
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("firmware/progress against unreachable machine status = %d, want 502, body = %s", rec.Code, rec.Body)
	}
}
