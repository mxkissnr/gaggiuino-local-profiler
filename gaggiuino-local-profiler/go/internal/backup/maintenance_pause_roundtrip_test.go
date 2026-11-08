package backup

import (
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/maintenance"
)

// TestStreamRoundTrip_MaintenancePauseFields: a paused task's two numeric
// pause keys survive a backup and restore unchanged, and the restored task
// still computes as paused.
func TestStreamRoundTrip_MaintenancePauseFields(t *testing.T) {
	useImageDir(t)
	h1, deps1, _ := newTestHandlers(t)
	seedShot(t, deps1, 1)

	lastDate := time.Now().UTC().Add(-100 * 24 * time.Hour).Format("2006-01-02T15:04:05.000Z")
	pausedAt := time.Now().Add(-60 * 24 * time.Hour).UnixMilli()
	var pausedMs int64 = 30 * 24 * 60 * 60 * 1000
	if err := deps1.MaintenanceRepo.SaveTask(1, "descaling", maintenance.Task{
		"lastDate": lastDate, "pausedAt": pausedAt, "pausedMs": pausedMs,
	}); err != nil {
		t.Fatalf("seeding maintenance pause state: %v", err)
	}

	rec := doJSON(t, newMux(h1), http.MethodPost, "/api/backup", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("export status = %d; body=%s", rec.Code, rec.Body.String())
	}
	zipBytes := append([]byte(nil), rec.Body.Bytes()...)

	h2, deps2, _ := newTestHandlersInDir(t)
	rr := doZip(t, newMux(h2), "/api/restore", zipBytes, nil)
	if rr.Code != http.StatusOK {
		t.Fatalf("restore status = %d; body=%s", rr.Code, rr.Body.String())
	}

	maint, err := deps2.MaintenanceRepo.GetMaintenance(1)
	if err != nil {
		t.Fatalf("GetMaintenance: %v", err)
	}
	task := maint["descaling"]
	if task == nil {
		t.Fatalf("restored maintenance is missing descaling: %+v", maint)
	}
	if got := numericValue(task["pausedAt"]); got != pausedAt {
		t.Errorf("pausedAt = %v (%T), want %d", task["pausedAt"], task["pausedAt"], pausedAt)
	}
	if got := numericValue(task["pausedMs"]); got != pausedMs {
		t.Errorf("pausedMs = %v (%T), want %d", task["pausedMs"], task["pausedMs"], pausedMs)
	}

	stats, err := maintenance.ComputeMaintenanceStats(deps2.ShotsRepo, deps2.LibRepo, maint, 1)
	if err != nil {
		t.Fatalf("ComputeMaintenanceStats: %v", err)
	}
	if got, _ := stats["descaling"]["status"].(string); got != "paused" {
		t.Errorf("restored descaling status = %q, want paused", got)
	}
}

// TestRestore_LegacyBackup_HasNoPausedTasks: an old bundle carries neither
// pause key, so nothing restores as paused.
func TestRestore_LegacyBackup_HasNoPausedTasks(t *testing.T) {
	useImageDir(t)
	zipBytes, err := os.ReadFile(filepath.Join("testdata", "legacy-backup.zip"))
	if err != nil {
		t.Fatalf("reading fixture: %v", err)
	}
	h, deps, _ := newTestHandlersInDir(t)
	rr := doZip(t, newMux(h), "/api/restore", zipBytes, nil)
	if rr.Code != http.StatusOK {
		t.Fatalf("restore status = %d; body=%s", rr.Code, rr.Body.String())
	}

	maint, err := deps.MaintenanceRepo.GetMaintenance(1)
	if err != nil {
		t.Fatalf("GetMaintenance: %v", err)
	}
	stats, err := maintenance.ComputeMaintenanceStats(deps.ShotsRepo, deps.LibRepo, maint, 1)
	if err != nil {
		t.Fatalf("ComputeMaintenanceStats: %v", err)
	}
	for key, stat := range stats {
		if status, _ := stat["status"].(string); status == "paused" {
			t.Errorf("%s restored as paused, want no paused tasks", key)
		}
		if at, ok := stat["pausedAt"]; ok && at != nil {
			t.Errorf("%s carries pausedAt = %v, want none", key, at)
		}
	}
}

// numericValue reads a maintenance map's number however it decoded — int64 on
// a freshly saved row, float64 after a JSON round-trip.
func numericValue(v any) int64 {
	switch n := v.(type) {
	case int64:
		return n
	case float64:
		return int64(n)
	case int:
		return int64(n)
	}
	return 0
}
