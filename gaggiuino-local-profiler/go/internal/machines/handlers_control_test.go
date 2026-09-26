package machines

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
)

// stubReleasesAPINoMatch points the GitHub-releases API at a local server that
// answers with an empty release list, keeping the best-effort from/to lookup in
// triggerFirmwareUpdate hermetic (no real network call) when a test only cares
// about other behavior.
func stubReleasesAPINoMatch(t *testing.T) {
	t.Helper()
	overrideReleasesAPI(t, fakeGitHubReleases(t, []githubRelease{}).URL)
}

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

// #1046: firmware/version now auto-loads for every Gaggiuino row as soon as
// the Settings view renders (previously only on an explicit "open Edit
// form" click), so an ordinary unreachable machine hits this on every
// Settings open. Unlike a recovered panic (still 502, see
// TestFirmwareVersion_PanicDuringSettingsFetchReturns502), a plain
// GetSettings failure must degrade to a 200 "unknown" body -- a 502 here is
// a real network response the browser itself logs as a console error
// (`Failed to load resource: ... 502`) regardless of any client-side
// .catch(), which the E2E smoke test correctly flags as broken UX for the
// common case of an offline machine. Mirrors testMachine()'s
// (handlers_registry.go) always-200 "reachable: false" shape for the same
// kind of expected, non-buggy failure.
func TestFirmwareVersion_UnreachableMachineDegradesTo200(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)
	doRequest(mux, httptest.NewRequest(http.MethodGet, "/api/machines", nil)) // seed default (gaggiuino, unreachable)

	req := httptest.NewRequest(http.MethodGet, "/api/machine/firmware/version", nil)
	rec := doRequest(mux, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("firmware/version against unreachable machine status = %d, want 200, body = %s", rec.Code, rec.Body)
	}
	body := decodeBody(t, rec.Body.Bytes())
	if body["installed"] != nil {
		t.Fatalf("installed = %v, want nil", body["installed"])
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

// callbackError lets the firmware-update callback tests fail the hook
// without pulling an extra import into this file.
type callbackError struct{}

func (callbackError) Error() string { return "callback boom" }

// #1136: a successful firmware-update trigger must run the
// OnFirmwareUpdate hook exactly once, with the machine that was updated.
func TestTriggerFirmwareUpdate_CallbackRunsOnceOnSuccess(t *testing.T) {
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

	var seen []int64
	stubReleasesAPINoMatch(t)
	h.SetOnFirmwareUpdate(func(m *Machine, _, _ string) error {
		seen = append(seen, m.ID)
		return nil
	})

	body := `{"machineId":` + strconv.FormatInt(machine.ID, 10) + `}`
	rec := doRequest(mux, httptest.NewRequest(http.MethodPost, "/api/machine/firmware/update", strings.NewReader(body)))
	if rec.Code != http.StatusOK {
		t.Fatalf("POST firmware/update status = %d, body = %s", rec.Code, rec.Body)
	}
	if len(seen) != 1 || seen[0] != machine.ID {
		t.Fatalf("callback calls = %v, want exactly one call with machine id %d", seen, machine.ID)
	}
}

// #1136: the hook is a best-effort side effect -- its own error (or panic)
// must never turn an already-successful update into a non-200 response.
func TestTriggerFirmwareUpdate_CallbackFailureDoesNotAffectResponse(t *testing.T) {
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

	stubReleasesAPINoMatch(t)
	h.SetOnFirmwareUpdate(func(*Machine, string, string) error { return callbackError{} })
	rec := doRequest(mux, httptest.NewRequest(http.MethodPost, "/api/machine/firmware/update", strings.NewReader(body)))
	if rec.Code != http.StatusOK {
		t.Fatalf("returned-error callback: status = %d, want 200, body = %s", rec.Code, rec.Body)
	}

	h.SetOnFirmwareUpdate(func(*Machine, string, string) error { panic("callback boom") })
	rec = doRequest(mux, httptest.NewRequest(http.MethodPost, "/api/machine/firmware/update", strings.NewReader(body)))
	if rec.Code != http.StatusOK {
		t.Fatalf("panicking callback: status = %d, want 200, body = %s", rec.Code, rec.Body)
	}
	if !jsonContains(rec.Body.String(), `"success":true`) {
		t.Fatalf("unexpected firmware update result: %s", rec.Body.String())
	}
}

// #1136: an adapter error means the update never started, so the hook must
// not run (and a nil hook must be a no-op rather than a panic).
func TestTriggerFirmwareUpdate_CallbackSkippedOnAdapterErrorAndNil(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)
	doRequest(mux, httptest.NewRequest(http.MethodGet, "/api/machines", nil)) // seed default (gaggiuino, unreachable)

	called := false
	stubReleasesAPINoMatch(t)
	h.SetOnFirmwareUpdate(func(*Machine, string, string) error {
		called = true
		return nil
	})

	rec := doRequest(mux, httptest.NewRequest(http.MethodPost, "/api/machine/firmware/update", strings.NewReader(`{}`)))
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("firmware/update against unreachable machine: status = %d, want 502, body = %s", rec.Code, rec.Body)
	}
	if called {
		t.Fatalf("callback ran even though the adapter errored")
	}

	h.SetOnFirmwareUpdate(nil)
	rec = doRequest(mux, httptest.NewRequest(http.MethodPost, "/api/machine/firmware/update", strings.NewReader(`{}`)))
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("firmware/update with nil hook: status = %d, want 502, body = %s", rec.Code, rec.Body)
	}
}

// #1136 follow-up: with a reachable machine and a matching release on the
// machine's channel, the hook receives the installed version as `from` and the
// channel's latest release hash as `to`.
func TestTriggerFirmwareUpdate_CallbackReceivesFromToVersions(t *testing.T) {
	allowLoopbackMachineHost(t)
	h, registry, _ := newTestHandlers(t)
	mux := newMux(h)

	fake := newFakeGaggiuinoMachine()
	defer fake.Close()
	// The fake machine returns the same body for every settings category, so
	// this single payload satisfies both the `versions` (coreVersion) and
	// `system` (releaseChannel) reads firmwareFromTo performs.
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

	type fromTo struct{ from, to string }
	var calls []fromTo
	h.SetOnFirmwareUpdate(func(_ *Machine, from, to string) error {
		calls = append(calls, fromTo{from: from, to: to})
		return nil
	})

	body := `{"machineId":` + strconv.FormatInt(machine.ID, 10) + `}`
	rec := doRequest(mux, httptest.NewRequest(http.MethodPost, "/api/machine/firmware/update", strings.NewReader(body)))
	if rec.Code != http.StatusOK {
		t.Fatalf("POST firmware/update status = %d, body = %s", rec.Code, rec.Body)
	}
	if len(calls) != 1 {
		t.Fatalf("callback calls = %d, want exactly 1", len(calls))
	}
	if calls[0].from != "aaa1111" || calls[0].to != "bbb2222" {
		t.Fatalf("callback from/to = %q/%q, want %q/%q", calls[0].from, calls[0].to, "aaa1111", "bbb2222")
	}
}

// firmwareFromToErrorAdapter is a machines.Adapter whose settings reads always
// fail, while the firmware update itself succeeds -- the fixture for proving
// the from/to lookup is best-effort.
type firmwareFromToErrorAdapter struct{ fakePanicAdapter }

func (firmwareFromToErrorAdapter) GetSettings(context.Context, *Machine, string) (json.RawMessage, error) {
	return nil, errors.New("settings unavailable")
}

func (firmwareFromToErrorAdapter) TriggerFirmwareUpdate(context.Context, *Machine) (json.RawMessage, error) {
	return json.RawMessage(`{"success":true}`), nil
}

// #1136 follow-up: when the version lookups fail, the update still succeeds
// with an unchanged 200/body, and the hook runs once with empty from/to rather
// than being skipped or surfacing the failure.
func TestTriggerFirmwareUpdate_VersionsFetchFailureStillSucceedsWithEmptyVersions(t *testing.T) {
	registry, _ := newTestRegistry(t)
	h := &Handlers{registry: registry, gaggiuino: firmwareFromToErrorAdapter{}, firmware: NewFirmwareChecker()}
	mux := newMux(h)

	// Releases also fail, so `to` is unknown too.
	github := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	}))
	defer github.Close()
	overrideReleasesAPI(t, github.URL)

	machine, err := registry.CreateMachine(MachineInput{
		Name: strPtr("Fake"), Type: strPtr("gaggiuino"), Host: strPtr("http://192.0.2.1"),
	})
	if err != nil {
		t.Fatalf("CreateMachine: %v", err)
	}

	var calls []string
	h.SetOnFirmwareUpdate(func(_ *Machine, from, to string) error {
		calls = append(calls, from+"|"+to)
		return nil
	})

	body := `{"machineId":` + strconv.FormatInt(machine.ID, 10) + `}`
	rec := doRequest(mux, httptest.NewRequest(http.MethodPost, "/api/machine/firmware/update", strings.NewReader(body)))
	if rec.Code != http.StatusOK {
		t.Fatalf("POST firmware/update status = %d, want 200, body = %s", rec.Code, rec.Body)
	}
	if len(calls) != 1 || calls[0] != "|" {
		t.Fatalf("callback from/to calls = %v, want exactly one empty/empty call", calls)
	}
	if !jsonContains(rec.Body.String(), `"success":true`) {
		t.Fatalf("unexpected firmware update result: %s", rec.Body.String())
	}
}
