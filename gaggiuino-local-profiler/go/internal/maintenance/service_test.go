package maintenance

import (
	"testing"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// TestJsFloorDivDays_NegativeDelta_FloorsNotTruncates (#901 code review):
// Go's integer division truncates toward zero, but this helper must round
// toward -infinity. 1.5 days in the future (lastTs > now, e.g. clock
// skew or a hand-edited/restored backup) must floor to -2, not truncate
// to -1.
func TestJsFloorDivDays_NegativeDelta_FloorsNotTruncates(t *testing.T) {
	const dayMs = 86400000
	cases := []struct {
		name    string
		deltaMs int64
		want    int64
	}{
		{"1.5 days in the future", -(dayMs + dayMs/2), -2},
		{"exactly 2 days in the future (no remainder)", -2 * dayMs, -2},
		{"1.5 days in the past", dayMs + dayMs/2, 1},
		{"exactly 1 day in the past", dayMs, 1},
		{"zero delta", 0, 0},
	}
	for _, c := range cases {
		if got := jsFloorDivDays(c.deltaMs); got != c.want {
			t.Errorf("%s: jsFloorDivDays(%d) = %d, want %d", c.name, c.deltaMs, got, c.want)
		}
	}
}

// TestComputeMaintenanceStats_FutureLastDate_DaysSinceIsMinusTwo exercises
// the same fix through the real call path: a task's lastDate 1.5 days in
// the future must produce daysSince = -2 in the computed stat.
func TestComputeMaintenanceStats_FutureLastDate_DaysSinceIsMinusTwo(t *testing.T) {
	_, _, _, sqlDB := newTestHandlers(t)
	shotsRepo := shots.NewRepository(sqlDB)

	future := time.Now().Add(36 * time.Hour) // 1.5 days from now
	maint := map[string]Task{
		"descaling": {
			"lastDate":        future.UTC().Format("2006-01-02T15:04:05.000Z"),
			"threshold_shots": float64(200), "threshold_days": float64(60),
		},
	}

	stats, err := ComputeMaintenanceStats(shotsRepo, maint, 1)
	if err != nil {
		t.Fatalf("ComputeMaintenanceStats: %v", err)
	}
	daysSince, ok := stats["descaling"]["daysSince"].(int64)
	if !ok {
		t.Fatalf("daysSince = %#v (%T), want an int64", stats["descaling"]["daysSince"], stats["descaling"]["daysSince"])
	}
	if daysSince != -2 {
		t.Errorf("daysSince = %d, want -2 (Math.floor(-1.5), not Go's truncating -1)", daysSince)
	}
}

// TestSaveTask_ConcurrentDifferentTasksBothSurvive (#1608): two writers share
// one stale snapshot; one changes backflush's threshold, then another marks
// descaling done. Per-task writes must leave both changes intact — the old
// whole-map SaveMaintenance would have rewritten backflush from the second
// caller's stale copy, dropping the threshold change.
func TestSaveTask_ConcurrentDifferentTasksBothSurvive(t *testing.T) {
	_, repo, libRepo, sqlDB := newTestHandlers(t)
	shotsRepo := shots.NewRepository(sqlDB)
	registry := machines.NewRegistry(sqlDB)

	before, err := repo.GetMaintenance(1)
	if err != nil {
		t.Fatalf("GetMaintenance: %v", err)
	}
	if v, _ := jsPositiveInt(before["backflush"]["threshold_shots"]); v != 20 {
		t.Fatalf("precondition: backflush default threshold_shots = %v; want 20", before["backflush"]["threshold_shots"])
	}

	if err := repo.SaveTask(1, "backflush", Task{"threshold_shots": int64(99)}); err != nil {
		t.Fatalf("SaveTask(backflush): %v", err)
	}
	if _, err := MarkTaskDone(repo, shotsRepo, libRepo, registry, "descaling", "", 1); err != nil {
		t.Fatalf("MarkTaskDone(descaling): %v", err)
	}

	got, err := repo.GetMaintenance(1)
	if err != nil {
		t.Fatalf("GetMaintenance after writes: %v", err)
	}
	if v, _ := jsPositiveInt(got["backflush"]["threshold_shots"]); v != 99 {
		t.Errorf("backflush threshold_shots = %v; want 99 (survived the descaling write)", got["backflush"]["threshold_shots"])
	}
	if got["descaling"]["lastDate"] == nil {
		t.Errorf("descaling lastDate = nil; want a date set by MarkTaskDone")
	}
}

// TestMarkTaskDone_DoesNotFreezeOtherTasksDefaults (#1608): marking one task
// done must write only that task's row — GetMaintenance's defaults for the
// other tasks must not be persisted as if the user had set them.
func TestMarkTaskDone_DoesNotFreezeOtherTasksDefaults(t *testing.T) {
	_, repo, libRepo, sqlDB := newTestHandlers(t)
	shotsRepo := shots.NewRepository(sqlDB)
	registry := machines.NewRegistry(sqlDB)

	if _, err := MarkTaskDone(repo, shotsRepo, libRepo, registry, "backflush", "", 1); err != nil {
		t.Fatalf("MarkTaskDone(backflush): %v", err)
	}

	rows, err := repo.GetAllMaintenanceRaw()
	if err != nil {
		t.Fatalf("GetAllMaintenanceRaw: %v", err)
	}
	for _, row := range rows {
		if row.Key == "descaling" {
			t.Fatalf("MarkTaskDone(backflush) wrote a descaling row: %s", row.Data)
		}
	}
}
