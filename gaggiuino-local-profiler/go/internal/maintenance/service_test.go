package maintenance

import (
	"errors"
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
// descaling done. Per-task writes must leave both changes intact — a whole-map
// save would have rewritten backflush from the second caller's stale copy,
// dropping the threshold change.
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

// isoTS formats at the way MarkTaskDone and ApplyMachineServiceLog both stamp
// lastDate (millisecond-precision UTC).
func isoTS(at time.Time) string {
	return at.UTC().Format("2006-01-02T15:04:05.000Z")
}

// TestApplyMachineServiceLog_NewTimestampMarksDoneAndLogs (#1639): a first machine
// service stamp sets lastDate to the machine's own (back-dated) time and
// appends one log entry dated that day with the auto-sync note.
func TestApplyMachineServiceLog_NewTimestampMarksDoneAndLogs(t *testing.T) {
	_, repo, _, sqlDB := newTestHandlers(t)
	shotsRepo := shots.NewRepository(sqlDB)
	registry := machines.NewRegistry(sqlDB)

	at := time.Date(2026, 10, 1, 8, 30, 0, 0, time.UTC)
	marked, err := ApplyMachineServiceLog(repo, shotsRepo, registry, 1, "descaling", at)
	if err != nil {
		t.Fatalf("ApplyMachineServiceLog: %v", err)
	}
	if !marked {
		t.Fatalf("marked = false, want true for a first-ever machine timestamp")
	}

	got, err := repo.GetMaintenance(1)
	if err != nil {
		t.Fatalf("GetMaintenance: %v", err)
	}
	if lastDate, _ := got["descaling"]["lastDate"].(string); lastDate != isoTS(at) {
		t.Errorf("descaling lastDate = %q, want %q", lastDate, isoTS(at))
	}
	if ms, ok := jsPositiveInt(got["descaling"]["machineSyncedAt"]); !ok || ms != at.UnixMilli() {
		t.Errorf("descaling machineSyncedAt = %v, want %d", got["descaling"]["machineSyncedAt"], at.UnixMilli())
	}

	log, err := repo.GetMaintenanceLog(1)
	if err != nil {
		t.Fatalf("GetMaintenanceLog: %v", err)
	}
	if len(log) != 1 {
		t.Fatalf("log entries = %d, want 1: %+v", len(log), log)
	}
	if log[0].Task != "descaling" || log[0].Notes != "Auto-synced from machine" || log[0].Date != "2026-10-01" {
		t.Errorf("log entry = %+v, want task=descaling notes=\"Auto-synced from machine\" date=2026-10-01", log[0])
	}
}

// TestApplyMachineServiceLog_SameTimestampIsIdempotent (#1639): re-applying the
// machine's unchanged timestamp is a no-op — no second log entry, and the
// reported "marked" is false.
func TestApplyMachineServiceLog_SameTimestampIsIdempotent(t *testing.T) {
	_, repo, _, sqlDB := newTestHandlers(t)
	shotsRepo := shots.NewRepository(sqlDB)
	registry := machines.NewRegistry(sqlDB)

	at := time.Date(2026, 10, 1, 8, 30, 0, 0, time.UTC)
	if _, err := ApplyMachineServiceLog(repo, shotsRepo, registry, 1, "descaling", at); err != nil {
		t.Fatalf("first ApplyMachineServiceLog: %v", err)
	}
	marked, err := ApplyMachineServiceLog(repo, shotsRepo, registry, 1, "descaling", at)
	if err != nil {
		t.Fatalf("second ApplyMachineServiceLog: %v", err)
	}
	if marked {
		t.Errorf("second apply marked = true, want false")
	}
	log, err := repo.GetMaintenanceLog(1)
	if err != nil {
		t.Fatalf("GetMaintenanceLog: %v", err)
	}
	if len(log) != 1 {
		t.Errorf("log entries = %d, want 1 (no second entry)", len(log))
	}
}

// TestApplyMachineServiceLog_DoesNotMoveLaterLastDateBackwards (#1639): a machine
// stamp older than a later manual "done" still advances machineSyncedAt (so it
// is not re-applied) but must leave lastDate untouched and add no log entry.
func TestApplyMachineServiceLog_DoesNotMoveLaterLastDateBackwards(t *testing.T) {
	_, repo, _, sqlDB := newTestHandlers(t)
	shotsRepo := shots.NewRepository(sqlDB)
	registry := machines.NewRegistry(sqlDB)

	manual := time.Date(2026, 10, 5, 12, 0, 0, 0, time.UTC)
	if err := repo.SaveTask(1, "backflush", Task{"lastDate": isoTS(manual)}); err != nil {
		t.Fatalf("SaveTask: %v", err)
	}
	machine := time.Date(2026, 10, 1, 8, 30, 0, 0, time.UTC) // older than the manual done
	marked, err := ApplyMachineServiceLog(repo, shotsRepo, registry, 1, "backflush", machine)
	if err != nil {
		t.Fatalf("ApplyMachineServiceLog: %v", err)
	}
	if marked {
		t.Errorf("marked = true, want false (machine time precedes the manual done)")
	}

	got, err := repo.GetMaintenance(1)
	if err != nil {
		t.Fatalf("GetMaintenance: %v", err)
	}
	if lastDate, _ := got["backflush"]["lastDate"].(string); lastDate != isoTS(manual) {
		t.Errorf("backflush lastDate = %q, want the manual %q (never moved backwards)", lastDate, isoTS(manual))
	}
	if ms, ok := jsPositiveInt(got["backflush"]["machineSyncedAt"]); !ok || ms != machine.UnixMilli() {
		t.Errorf("backflush machineSyncedAt = %v, want %d", got["backflush"]["machineSyncedAt"], machine.UnixMilli())
	}
	log, err := repo.GetMaintenanceLog(1)
	if err != nil {
		t.Fatalf("GetMaintenanceLog: %v", err)
	}
	if len(log) != 0 {
		t.Errorf("log entries = %d, want 0 (lastDate was not advanced)", len(log))
	}
}

// TestApplyMachineServiceLog_ZeroTimeIsNoOp (#1639): a machine that has never
// recorded the service sends a zero time, which must change nothing.
func TestApplyMachineServiceLog_ZeroTimeIsNoOp(t *testing.T) {
	_, repo, _, sqlDB := newTestHandlers(t)
	shotsRepo := shots.NewRepository(sqlDB)
	registry := machines.NewRegistry(sqlDB)

	marked, err := ApplyMachineServiceLog(repo, shotsRepo, registry, 1, "descaling", time.Time{})
	if err != nil {
		t.Fatalf("ApplyMachineServiceLog: %v", err)
	}
	if marked {
		t.Errorf("marked = true, want false for a zero time")
	}
	got, err := repo.GetMaintenance(1)
	if err != nil {
		t.Fatalf("GetMaintenance: %v", err)
	}
	if got["descaling"]["lastDate"] != nil {
		t.Errorf("descaling lastDate = %v, want nil", got["descaling"]["lastDate"])
	}
	if _, ok := jsPositiveInt(got["descaling"]["machineSyncedAt"]); ok {
		t.Errorf("descaling machineSyncedAt = %v, want unset", got["descaling"]["machineSyncedAt"])
	}
	log, err := repo.GetMaintenanceLog(1)
	if err != nil {
		t.Fatalf("GetMaintenanceLog: %v", err)
	}
	if len(log) != 0 {
		t.Errorf("log entries = %d, want 0", len(log))
	}
}

// TestApplyMachineServiceLog_RejectsTasksWithNoMachineCounterpart (#1639): only
// descaling/backflush exist in the firmware's service log; anything else (here
// grouphead) is an unknown task.
func TestApplyMachineServiceLog_RejectsTasksWithNoMachineCounterpart(t *testing.T) {
	_, repo, _, sqlDB := newTestHandlers(t)
	shotsRepo := shots.NewRepository(sqlDB)
	registry := machines.NewRegistry(sqlDB)

	if _, err := ApplyMachineServiceLog(repo, shotsRepo, registry, 1, "grouphead", time.Now()); !errors.Is(err, ErrUnknownTask) {
		t.Errorf("err = %v, want ErrUnknownTask", err)
	}
}
