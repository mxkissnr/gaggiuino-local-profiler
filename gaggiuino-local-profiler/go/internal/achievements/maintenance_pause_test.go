package achievements

import (
	"testing"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/maintenance"
)

const pauseTestDayMS int64 = 86_400_000
const pauseTestNow int64 = 1_800_000_000_000

// streakContext is a maintenance-only context: one machine, the descaling
// task, two log entries at now-130d and now-90d, and a 60-day threshold.
func streakContext(task maintenance.Task) *Context {
	return &Context{
		Now:                        pauseTestNow,
		Machines:                   []machines.Machine{{ID: 1}},
		StaticMaintenanceTasks:     map[string]bool{"descaling": true},
		MaintenanceLogs:            []maintenance.LogEntry{
			{Task: "descaling", MachineID: 1, TS: (pauseTestNow - 130*pauseTestDayMS) / 1000},
			{Task: "descaling", MachineID: 1, TS: (pauseTestNow - 90*pauseTestDayMS) / 1000},
		},
		MaintenanceConfigByMachine: map[int64]map[string]maintenance.Task{
			1: {"descaling": task},
		},
	}
}

func TestMaintenanceCleanStreak_UnpausedOverdueGapResets(t *testing.T) {
	ctx := streakContext(maintenance.Task{"threshold_days": int64(60)})
	if got := maintenanceCleanStreakDays(ctx); got != 0 {
		t.Fatalf("streak = %d, want 0 (the 90-day gap is over the 60-day threshold)", got)
	}
}

func TestMaintenanceCleanStreak_PausedTimeIsExcluded(t *testing.T) {
	ctx := streakContext(maintenance.Task{
		"threshold_days": int64(60),
		"pausedAt":       pauseTestNow - 50*pauseTestDayMS,
	})
	if got := maintenanceCleanStreakDays(ctx); got != 130 {
		t.Fatalf("streak = %d, want 130 (only 40 of the 90 days count)", got)
	}
}

func TestMaintenanceCleanStreak_ShortPauseDoesNotMatter(t *testing.T) {
	ctx := streakContext(maintenance.Task{
		"threshold_days": int64(60),
		"pausedAt":       pauseTestNow - pauseTestDayMS,
	})
	if got := maintenanceCleanStreakDays(ctx); got != 0 {
		t.Fatalf("streak = %d, want 0 (one paused day leaves 89, still over threshold)", got)
	}
}
