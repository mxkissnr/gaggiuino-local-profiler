package machines

import (
	"net/http"
	"net/http/httptest"
	"strconv"
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
