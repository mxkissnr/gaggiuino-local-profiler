package maintenance

import (
	"net/http"
	"strconv"
	"testing"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines"
)

func strPtr(s string) *string { return &s }

// TestWriteMachineID_RejectsUnknownAndInvalid is #1605's regression test for
// the maintenance write routes: an unknown machineId is a 404, "all" or an
// unparseable value is a 400, and none of them writes anything; an absent
// machineId still writes for the registry's default machine.
func TestWriteMachineID_RejectsUnknownAndInvalid(t *testing.T) {
	h, repo, _, _ := newTestHandlers(t)
	mux := newMux(h)

	cases := []struct {
		path string
		want int
	}{
		{"/api/maintenance/backflush/done?machineId=999", http.StatusNotFound},
		{"/api/maintenance/backflush/done?machineId=all", http.StatusBadRequest},
		{"/api/maintenance/backflush/done?machineId=abc", http.StatusBadRequest},
	}
	for _, c := range cases {
		rec := doJSON(t, mux, http.MethodPost, c.path, mustMarshal(t, map[string]any{}))
		if rec.Code != c.want {
			t.Fatalf("POST %s status = %d, want %d, body=%s", c.path, rec.Code, c.want, rec.Body.String())
		}
	}

	log, err := repo.GetMaintenanceLog(1)
	if err != nil {
		t.Fatalf("GetMaintenanceLog: %v", err)
	}
	if len(log) != 0 {
		t.Fatalf("rejected writes recorded %d log entries, want 0", len(log))
	}

	// An absent machineId still writes for the registry default machine (#1).
	rec := doJSON(t, mux, http.MethodPost, "/api/maintenance/backflush/done", mustMarshal(t, map[string]any{}))
	if rec.Code != http.StatusOK {
		t.Fatalf("default-machine done status = %d, body=%s", rec.Code, rec.Body.String())
	}
	log, err = repo.GetMaintenanceLog(1)
	if err != nil {
		t.Fatalf("GetMaintenanceLog: %v", err)
	}
	if len(log) != 1 {
		t.Fatalf("default-machine write recorded %d log entries, want 1", len(log))
	}
}

// TestPostLog_StampsTargetMachineHost verifies a log entry written for a
// non-default machine is stamped with THAT machine's host, not the default
// machine's (the #1605 bug: every entry got machineHostname(registry)).
func TestPostLog_StampsTargetMachineHost(t *testing.T) {
	h, _, _, _ := newTestHandlers(t)
	mux := newMux(h)

	if _, err := h.registry.GetDefaultMachine(); err != nil { // seed default machine #1
		t.Fatalf("seed default machine: %v", err)
	}
	m2, err := h.registry.CreateMachine(machines.MachineInput{
		Name: strPtr("Second"), Type: strPtr("gaggiuino"), Host: strPtr("http://secondmachine.local"),
	})
	if err != nil {
		t.Fatalf("CreateMachine: %v", err)
	}

	rec := doJSON(t, mux, http.MethodPost, "/api/maintenance/log?machineId="+strconv.FormatInt(m2.ID, 10),
		mustMarshal(t, map[string]any{"task": "backflush"}))
	if rec.Code != http.StatusOK {
		t.Fatalf("POST log status = %d, body=%s", rec.Code, rec.Body.String())
	}
	entry := decodeBody(t, rec.Body.Bytes())
	if entry["machineId"] != float64(m2.ID) {
		t.Fatalf("machineId = %v, want %d", entry["machineId"], m2.ID)
	}
	if entry["machine"] != "secondmachine.local" {
		t.Fatalf("machine = %v, want secondmachine.local (the target machine's host)", entry["machine"])
	}
}
