package maintenance

import (
	"net/http"
	"testing"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/library"
)

func TestGetMaintenance_DefaultMachine(t *testing.T) {
	h, _, _, _ := newTestHandlers(t)
	mux := newMux(h)
	rec := doJSON(t, mux, http.MethodGet, "/api/maintenance", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d; body=%s", rec.Code, rec.Body.String())
	}
	stats := decodeBody(t, rec.Body.Bytes())
	descaling, ok := stats["descaling"].(map[string]any)
	if !ok {
		t.Fatalf("expected descaling task in response: %+v", stats)
	}
	if descaling["status"] != "never" {
		t.Errorf("status = %v; want never (no lastDate yet)", descaling["status"])
	}
	if descaling["threshold_shots"] != float64(200) {
		t.Errorf("threshold_shots = %v; want default 200", descaling["threshold_shots"])
	}
}

func TestTaskDone_UnknownTask404(t *testing.T) {
	h, _, _, _ := newTestHandlers(t)
	mux := newMux(h)
	rec := doJSON(t, mux, http.MethodPost, "/api/maintenance/not-a-real-task/done", mustMarshal(t, map[string]any{}))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d; want 404; body=%s", rec.Code, rec.Body.String())
	}
}

func TestTaskDone_MarksLastDateAndLogs(t *testing.T) {
	h, _, _, _ := newTestHandlers(t)
	mux := newMux(h)

	rec := doJSON(t, mux, http.MethodPost, "/api/maintenance/descaling/done", mustMarshal(t, map[string]any{"notes": "ran citric acid cycle"}))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d; body=%s", rec.Code, rec.Body.String())
	}
	stats := decodeBody(t, rec.Body.Bytes())
	descaling, _ := stats["descaling"].(map[string]any)
	if descaling == nil || descaling["lastDate"] == nil {
		t.Fatalf("expected lastDate to be set: %+v", stats["descaling"])
	}
	if descaling["status"] != "ok" {
		t.Errorf("status right after marking done = %v; want ok", descaling["status"])
	}

	rec = doJSON(t, mux, http.MethodGet, "/api/maintenance/log", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("log status = %d", rec.Code)
	}
	var log []map[string]any
	decodeBodyArrayInto(t, rec.Body.Bytes(), &log)
	if len(log) != 1 {
		t.Fatalf("expected 1 log entry, got %d", len(log))
	}
	if log[0]["notes"] != "ran citric acid cycle" {
		t.Errorf("notes = %v", log[0]["notes"])
	}
	if log[0]["task"] != "descaling" {
		t.Errorf("task = %v", log[0]["task"])
	}
}

// TestTaskDone_NoBodyIsNotAnError guards against a Go-migration regression
// (#901) found verifying glp-integration against a standalone Go backend:
// its maintenance_done HA service posts with no body at all (unlike its
// other write calls, which all send at least `json={}`), and
// routes/maintenance.js already tolerates that via req.body's optional
// chaining default (empty string).
// decodeJSONBody must treat a genuinely empty body as {} (io.EOF), not a
// 400 "Invalid JSON body".
func TestTaskDone_NoBodyIsNotAnError(t *testing.T) {
	h, _, _, _ := newTestHandlers(t)
	mux := newMux(h)

	rec := doJSON(t, mux, http.MethodPost, "/api/maintenance/descaling/done", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d; want 200 for a bodyless request; body=%s", rec.Code, rec.Body.String())
	}
}

func TestTaskThreshold_ClampsAndRejectsOutOfRange(t *testing.T) {
	h, _, _, _ := newTestHandlers(t)
	mux := newMux(h)

	rec := doJSON(t, mux, http.MethodPost, "/api/maintenance/backflush/threshold", mustMarshal(t, map[string]any{
		"threshold_shots": 50, "threshold_days": 99999,
	}))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d; body=%s", rec.Code, rec.Body.String())
	}
	stats := decodeBody(t, rec.Body.Bytes())
	backflush, _ := stats["backflush"].(map[string]any)
	if backflush["threshold_shots"] != float64(50) {
		t.Errorf("threshold_shots = %v", backflush["threshold_shots"])
	}
	if backflush["threshold_days"] != nil {
		t.Errorf("threshold_days = %v; want nil (99999 is out of the 1-365 range)", backflush["threshold_days"])
	}
}

func TestGrinderTask_ValidOnlyForExistingGrinder(t *testing.T) {
	h, _, libRepo, _ := newTestHandlers(t)
	mux := newMux(h)

	// grinder_1 doesn't exist yet -> Unknown task.
	rec := doJSON(t, mux, http.MethodPost, "/api/maintenance/grinder_1/done", mustMarshal(t, map[string]any{}))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status before grinder exists = %d; want 404", rec.Code)
	}

	if err := libRepo.SaveLibrary(library.Library{
		Grinders: []library.Entity{{"id": int64(1), "name": "Niche Zero"}},
	}); err != nil {
		t.Fatalf("SaveLibrary: %v", err)
	}

	rec = doJSON(t, mux, http.MethodPost, "/api/maintenance/grinder_1/done", mustMarshal(t, map[string]any{}))
	if rec.Code != http.StatusOK {
		t.Fatalf("status after grinder exists = %d; body=%s", rec.Code, rec.Body.String())
	}
	stats := decodeBody(t, rec.Body.Bytes())
	grinderTask, _ := stats["grinder_1"].(map[string]any)
	if grinderTask == nil {
		t.Fatalf("expected grinder_1 task in response: %+v", stats)
	}
	if grinderTask["grinderName"] != "Niche Zero" {
		t.Errorf("grinderName = %v", grinderTask["grinderName"])
	}
}

func TestGetMaintenance_All(t *testing.T) {
	h, _, _, _ := newTestHandlers(t)
	mux := newMux(h)
	rec := doJSON(t, mux, http.MethodGet, "/api/maintenance?machineId=all", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d; body=%s", rec.Code, rec.Body.String())
	}
	result := decodeBody(t, rec.Body.Bytes())
	if result["all"] != true {
		t.Errorf("all = %v", result["all"])
	}
	machinesList, _ := result["machines"].([]any)
	if len(machinesList) != 1 {
		t.Fatalf("expected 1 default machine, got %d", len(machinesList))
	}
	global, _ := result["global"].(map[string]any)
	if _, ok := global["waterfilter"]; !ok {
		t.Errorf("expected waterfilter under global: %+v", global)
	}
	if _, ok := global["descaling"]; ok {
		t.Errorf("descaling must not be under global (it's per-machine): %+v", global)
	}
}

func TestMaintenanceLog_PostAndDelete(t *testing.T) {
	h, _, _, _ := newTestHandlers(t)
	mux := newMux(h)

	rec := doJSON(t, mux, http.MethodPost, "/api/maintenance/log", mustMarshal(t, map[string]any{
		"task": "backflush", "notes": "manual entry", "date": "2026-01-15",
	}))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d; body=%s", rec.Code, rec.Body.String())
	}
	entry := decodeBody(t, rec.Body.Bytes())
	id, ok := entry["id"].(float64)
	if !ok {
		t.Fatalf("expected numeric id: %+v", entry)
	}

	rec = doJSON(t, mux, http.MethodPost, "/api/maintenance/log", mustMarshal(t, map[string]any{
		"task": "backflush", "date": "not-a-date",
	}))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("invalid date status = %d; want 400", rec.Code)
	}

	rec = doJSON(t, mux, http.MethodPost, "/api/maintenance/log", mustMarshal(t, map[string]any{
		"task": "unknown-task",
	}))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("invalid task status = %d; want 400", rec.Code)
	}

	idStr := formatFloatID(id)
	rec = doJSON(t, mux, http.MethodDelete, "/api/maintenance/log/"+idStr, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("delete status = %d; body=%s", rec.Code, rec.Body.String())
	}

	rec = doJSON(t, mux, http.MethodDelete, "/api/maintenance/log/"+idStr, nil)
	if rec.Code != http.StatusNotFound {
		t.Errorf("delete-again status = %d; want 404", rec.Code)
	}
}

// TestMaintenanceLog_PostRequiresTask_EmptyBody guards against a
// Go-migration regression (#901, the flip side of
// TestTaskDone_NoBodyIsNotAnError): POST /api/maintenance/log requires a
// valid `task` field, so a genuinely empty request body (no bytes at all)
// must still 400 with "Invalid task" -- httputil.DecodeJSONBody's io.EOF
// tolerance (which lets task/done's bodyless case above succeed) must not
// let this endpoint's required field silently pass validation instead.
func TestMaintenanceLog_PostRequiresTask_EmptyBody(t *testing.T) {
	h, _, _, _ := newTestHandlers(t)
	mux := newMux(h)

	rec := doJSON(t, mux, http.MethodPost, "/api/maintenance/log", nil)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d; want 400 for a bodyless request; body=%s", rec.Code, rec.Body.String())
	}
}
