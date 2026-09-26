package maintenance

import (
	"net/http"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/library"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
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

// TestTaskDone_UnknownCustomTask404 verifies canonicalTask checks a
// custom_* key against the machine's actual maintenance rows instead of
// accepting anything shaped like custom_[a-z0-9_-]+ — a request naming a
// never-created (or already-deleted) custom key must 404, not silently
// create a phantom task row.
func TestTaskDone_UnknownCustomTask404(t *testing.T) {
	h, _, _, _ := newTestHandlers(t)
	mux := newMux(h)
	rec := doJSON(t, mux, http.MethodPost, "/api/maintenance/custom_never_created/done", mustMarshal(t, map[string]any{}))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d; want 404; body=%s", rec.Code, rec.Body.String())
	}

	rec = doJSON(t, mux, http.MethodGet, "/api/maintenance", nil)
	stats := decodeBody(t, rec.Body.Bytes())
	if _, exists := stats["custom_never_created"]; exists {
		t.Errorf("phantom task row was created: %+v", stats)
	}
}

// TestCustomTaskThreshold_UnknownCustomTask404 mirrors the same check for
// POST .../threshold, the other write path that used to accept an
// unchecked custom_* key.
func TestCustomTaskThreshold_UnknownCustomTask404(t *testing.T) {
	h, _, _, _ := newTestHandlers(t)
	mux := newMux(h)
	rec := doJSON(t, mux, http.MethodPost, "/api/maintenance/custom_never_created/threshold",
		mustMarshal(t, map[string]any{"threshold_days": 30}))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d; want 404; body=%s", rec.Code, rec.Body.String())
	}
}

// TestCustomTaskLog_UnknownCustomTask400 mirrors the same check for
// POST /api/maintenance/log referencing a custom_* task.
func TestCustomTaskLog_UnknownCustomTask400(t *testing.T) {
	h, _, _, _ := newTestHandlers(t)
	mux := newMux(h)
	rec := doJSON(t, mux, http.MethodPost, "/api/maintenance/log",
		mustMarshal(t, map[string]any{"task": "custom_never_created"}))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d; want 400; body=%s", rec.Code, rec.Body.String())
	}
}

// TestCustomTask_CreateThenDoneWorks verifies a custom task created via
// POST .../custom can then be marked done — the existence check must not
// reject a real, just-created custom key.
func TestCustomTask_CreateThenDoneWorks(t *testing.T) {
	h, _, _, _ := newTestHandlers(t)
	mux := newMux(h)
	rec := doJSON(t, mux, http.MethodPost, "/api/maintenance/custom", mustMarshal(t, map[string]any{"label": "Descale line"}))
	if rec.Code != http.StatusOK {
		t.Fatalf("create status = %d; body=%s", rec.Code, rec.Body.String())
	}
	created := decodeBody(t, rec.Body.Bytes())
	if _, exists := created["custom_descale_line"]; !exists {
		t.Fatalf("expected custom_descale_line in create response: %+v", created)
	}

	rec = doJSON(t, mux, http.MethodPost, "/api/maintenance/custom_descale_line/done", mustMarshal(t, map[string]any{}))
	if rec.Code != http.StatusOK {
		t.Fatalf("done status = %d; body=%s", rec.Code, rec.Body.String())
	}
}

// TestCustomTask_LabelTruncatesByRunesNotBytes verifies a label over 100
// runes is truncated on a rune boundary — slicing by byte index (label[:100])
// would panic or split a multi-byte character mid-encoding for non-ASCII
// input like this one (each "é" is 2 bytes, so 60 of them is 120 bytes but
// only 60 runes).
func TestCustomTask_LabelTruncatesByRunesNotBytes(t *testing.T) {
	h, _, _, _ := newTestHandlers(t)
	mux := newMux(h)
	// "ä" is 2 bytes in UTF-8, and slugifyLabel maps it to ASCII "a" (still
	// producing a valid non-empty key) while the raw (truncated) label
	// stored on the task keeps the original character.
	label := strings.Repeat("ä", 150) // 150 runes, 300 bytes
	rec := doJSON(t, mux, http.MethodPost, "/api/maintenance/custom", mustMarshal(t, map[string]any{"label": label}))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d; body=%s", rec.Code, rec.Body.String())
	}
	created := decodeBody(t, rec.Body.Bytes())
	for _, stat := range created {
		s, ok := stat.(map[string]any)
		if !ok {
			continue
		}
		if lbl, ok := s["label"].(string); ok && strings.HasPrefix(lbl, "ä") {
			if got := len([]rune(lbl)); got != 100 {
				t.Errorf("label rune count = %d, want 100", got)
			}
			return
		}
	}
	t.Fatalf("created task not found in response: %+v", created)
}

// TestMaintenanceLog_NotesTruncateByRunesNotBytes verifies the 500-char cap
// on POST /api/maintenance/log notes is applied on a rune boundary. Slicing
// by byte index (notes[:500]) would split a multi-byte character
// mid-encoding for non-ASCII input like this one ("€" is 3 bytes but one
// rune), leaving invalid UTF-8 in the stored notes.
func TestMaintenanceLog_NotesTruncateByRunesNotBytes(t *testing.T) {
	h, repo, _, _ := newTestHandlers(t)
	mux := newMux(h)

	notes := strings.Repeat("€", 600) // 600 runes, 1800 bytes
	rec := doJSON(t, mux, http.MethodPost, "/api/maintenance/log", mustMarshal(t, map[string]any{"task": "backflush", "notes": notes}))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d; body=%s", rec.Code, rec.Body.String())
	}

	entries, err := repo.GetMaintenanceLog(0)
	if err != nil {
		t.Fatalf("GetMaintenanceLog: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("expected 1 log entry, got %d", len(entries))
	}
	if got := len([]rune(entries[0].Notes)); got != 500 {
		t.Errorf("notes rune count = %d, want 500", got)
	}
	if !utf8.ValidString(entries[0].Notes) {
		t.Errorf("notes is not valid UTF-8 after truncation: %q", entries[0].Notes)
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

// TestMaintenanceLog_CustomTaskEntryCarriesLabel guards the maintenance-log
// vs. dashboard mismatch bug report: the dashboard resolves a custom_ task's
// display name from its stored `label`, but log entries only carried the
// raw custom_<slug> key with no way to recover that label — GetMaintenanceLog
// must now enrich each custom_ entry with the label of the task as it exists
// for that entry's own machineId (two machines can slugify to the same key
// with different labels, since customCreate scopes tasks per machine).
func TestMaintenanceLog_CustomTaskEntryCarriesLabel(t *testing.T) {
	h, repo, _, _ := newTestHandlers(t)
	mux := newMux(h)

	rec := doJSON(t, mux, http.MethodPost, "/api/maintenance/custom", mustMarshal(t, map[string]any{"label": "Rückspülen mit Reiniger"}))
	if rec.Code != http.StatusOK {
		t.Fatalf("customCreate status = %d; body=%s", rec.Code, rec.Body.String())
	}

	rec = doJSON(t, mux, http.MethodPost, "/api/maintenance/log", mustMarshal(t, map[string]any{"task": "custom_ruckspulen_mit_reiniger", "notes": "done"}))
	if rec.Code != http.StatusOK {
		t.Fatalf("post log status = %d; body=%s", rec.Code, rec.Body.String())
	}

	entries, err := repo.GetMaintenanceLog(0)
	if err != nil {
		t.Fatalf("GetMaintenanceLog: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("expected 1 log entry, got %d", len(entries))
	}
	if entries[0].Label != "Rückspülen mit Reiniger" {
		t.Errorf("Label = %q, want %q", entries[0].Label, "Rückspülen mit Reiniger")
	}
}

// TestFirmwareUpdate_LogEntryRecordedWithoutDisturbingStats is #1136's
// maintenance-side guarantee: a `firmware_update` row written straight to
// the log (as cmd/server's machines.Handlers.SetOnFirmwareUpdate callback
// does) must be listed by GetMaintenanceLog, must survive a backup restore,
// and must NOT become a tracked task in ComputeMaintenanceStats --
// firmware_update is a log-only event, never a due/soon/ok tile.
func TestFirmwareUpdate_LogEntryRecordedWithoutDisturbingStats(t *testing.T) {
	h, repo, _, _ := newTestHandlers(t)
	mux := newMux(h)

	if _, err := repo.AddMaintenanceLogEntry("firmware_update", "", "192.0.2.10", 0, 1); err != nil {
		t.Fatalf("AddMaintenanceLogEntry: %v", err)
	}

	log, err := repo.GetMaintenanceLog(0)
	if err != nil {
		t.Fatalf("GetMaintenanceLog: %v", err)
	}
	found := false
	for _, e := range log {
		if e.Task == "firmware_update" {
			found = true
			if e.Machine != "192.0.2.10" {
				t.Errorf("machine = %q, want %q", e.Machine, "192.0.2.10")
			}
		}
	}
	if !found {
		t.Fatalf("firmware_update entry missing from log: %+v", log)
	}

	raw, err := repo.GetAllMaintenanceLogRaw()
	if err != nil {
		t.Fatalf("GetAllMaintenanceLogRaw: %v", err)
	}
	if err := repo.RestoreMaintenanceLogRaw(raw); err != nil {
		t.Fatalf("RestoreMaintenanceLogRaw rejected the firmware_update entry: %v", err)
	}

	rec := doJSON(t, mux, http.MethodGet, "/api/maintenance", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /api/maintenance status = %d; body=%s", rec.Code, rec.Body.String())
	}
	stats := decodeBody(t, rec.Body.Bytes())
	if _, ok := stats["firmware_update"]; ok {
		t.Errorf("firmware_update must not appear as a maintenance stat: %+v", stats)
	}
	if _, ok := stats["descaling"]; !ok {
		t.Errorf("descaling missing from stats: %+v", stats)
	}
}

// FirmwareUpdateNote must render every from/to combination, including the
// one-sided and both-unknown cases an offline machine or a failed release
// lookup produce.
func TestFirmwareUpdateNote(t *testing.T) {
	tests := []struct {
		name     string
		from, to string
		want     string
	}{
		{"both known", "aaa1111", "bbb2222", "aaa1111 → bbb2222"},
		{"only from", "aaa1111", "", "aaa1111 →"},
		{"only to", "", "bbb2222", "→ bbb2222"},
		{"neither", "", "", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := FirmwareUpdateNote(tt.from, tt.to); got != tt.want {
				t.Fatalf("FirmwareUpdateNote(%q, %q) = %q, want %q", tt.from, tt.to, got, tt.want)
			}
		})
	}
}

// ShotCountFor (exported for cmd/server's firmware-update hook) scopes a
// non-global task like firmware_update to the machine, while a global task
// still counts every machine's shots.
func TestShotCountFor_ScopesToMachine(t *testing.T) {
	_, _, _, sqlDB := newTestHandlers(t)
	shotsRepo := shots.NewRepository(sqlDB)
	for _, s := range []shots.Shot{
		{"id": int64(1), "timestamp": int64(1), "machineId": int64(7)},
		{"id": int64(2), "timestamp": int64(2), "machineId": int64(7)},
		{"id": int64(3), "timestamp": int64(3), "machineId": int64(8)},
	} {
		if err := shotsRepo.Upsert(s); err != nil {
			t.Fatalf("Upsert: %v", err)
		}
	}

	if got := ShotCountFor(shotsRepo, "firmware_update", 7); got != 2 {
		t.Fatalf("ShotCountFor(firmware_update, 7) = %d, want 2 (machine-scoped)", got)
	}
	if got := ShotCountFor(shotsRepo, "firmware_update", 8); got != 1 {
		t.Fatalf("ShotCountFor(firmware_update, 8) = %d, want 1 (machine-scoped)", got)
	}
	if got := ShotCountFor(shotsRepo, "waterfilter", 7); got != 3 {
		t.Fatalf("ShotCountFor(waterfilter, 7) = %d, want 3 (global)", got)
	}
}
