package maintenance

import (
	"database/sql"
	"encoding/json"
	"testing"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/library"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// insertGrinderShot writes one shot (with an optional annotation row) straight
// into the test DB, the same way TestShotCountFor_ScopesToMachine seeds shots.
func insertGrinderShot(t *testing.T, sqlDB *sql.DB, shotsRepo *shots.Repository,
	id int64, at time.Time, machineID int64, ann map[string]any) {
	t.Helper()
	shot := shots.Shot{"id": id, "timestamp": at.Unix(), "machineId": machineID}
	if err := shotsRepo.Upsert(shot); err != nil {
		t.Fatalf("Upsert shot %d: %v", id, err)
	}
	if ann == nil {
		return
	}
	payload, err := json.Marshal(ann)
	if err != nil {
		t.Fatalf("marshal annotation for shot %d: %v", id, err)
	}
	if _, err := sqlDB.Exec(`INSERT INTO annotations (shot_id, data) VALUES (?, ?)`, id, payload); err != nil {
		t.Fatalf("insert annotation for shot %d: %v", id, err)
	}
}

// trashGrinderShot marks shot id deleted without removing its row.
func trashGrinderShot(t *testing.T, sqlDB *sql.DB, id int64) {
	t.Helper()
	if _, err := sqlDB.Exec(`INSERT INTO trash (shot_id, deleted_at) VALUES (?, ?)`, id, 1); err != nil {
		t.Fatalf("insert trash for shot %d: %v", id, err)
	}
}

// taskStat recomputes machine 1's maintenance stats and returns one task.
func taskStat(t *testing.T, repo *Repository, shotsRepo *shots.Repository, key string) Stat {
	t.Helper()
	maint, err := repo.GetMaintenance(1)
	if err != nil {
		t.Fatalf("GetMaintenance: %v", err)
	}
	stats, err := ComputeMaintenanceStats(shotsRepo, maint, 1)
	if err != nil {
		t.Fatalf("ComputeMaintenanceStats: %v", err)
	}
	stat, ok := stats[key]
	if !ok {
		t.Fatalf("stats are missing %q: %+v", key, stats)
	}
	return stat
}

func wantShotsSince(t *testing.T, stat Stat, key string, want int) {
	t.Helper()
	if got, _ := stat["shotsSince"].(int); got != want {
		t.Errorf("%s shotsSince = %v, want %d", key, stat["shotsSince"], want)
	}
}

func wantGramsSince(t *testing.T, stat Stat, key string, want int64) {
	t.Helper()
	if got, _ := stat["gramsSince"].(int64); got != want {
		t.Errorf("%s gramsSince = %v, want %d", key, stat["gramsSince"], want)
	}
}

func wantPct(t *testing.T, stat Stat, key string, want float64) {
	t.Helper()
	if got, _ := stat["pct"].(float64); got != want {
		t.Errorf("%s pct = %v, want %v", key, stat["pct"], want)
	}
}

// TestGrinderTasks_CountOnlyOwnShotsAndGrams is #1955's core fix: with two
// grinders in the library, each grinder_* task counts only the shots whose
// annotation names it, and sums only those shots' doses.
func TestGrinderTasks_CountOnlyOwnShotsAndGrams(t *testing.T) {
	_, repo, libRepo, sqlDB := newTestHandlers(t)
	shotsRepo := shots.NewRepository(sqlDB)

	if err := libRepo.SaveLibrary(library.Library{
		Grinders: []library.Entity{
			{"id": int64(1), "name": "Niche Zero"},
			{"id": int64(2), "name": "DF64"},
		},
	}); err != nil {
		t.Fatalf("SaveLibrary: %v", err)
	}
	for _, key := range []string{"grinder_1", "grinder_2"} {
		if err := repo.SaveTask(1, key, Task{"lastDate": "2026-01-01"}); err != nil {
			t.Fatalf("SaveTask %s: %v", key, err)
		}
	}

	day := func(d, h int) time.Time { return time.Date(2026, 1, d, h, 0, 0, 0, time.UTC) }
	for i := 0; i < 3; i++ {
		insertGrinderShot(t, sqlDB, shotsRepo, int64(10+i), day(2, 8+i), 1,
			map[string]any{"grinder": "niche zero", "dose": 18.0})
	}
	insertGrinderShot(t, sqlDB, shotsRepo, 20, day(3, 8), 1,
		map[string]any{"grinder": "DF64", "dose": 20.0})
	insertGrinderShot(t, sqlDB, shotsRepo, 30, day(4, 8), 1, nil)
	insertGrinderShot(t, sqlDB, shotsRepo, 31, day(5, 8), 1,
		map[string]any{"coffee": "Ethiopia Guji"})

	niche := taskStat(t, repo, shotsRepo, "grinder_1")
	wantShotsSince(t, niche, "grinder_1", 3)
	wantGramsSince(t, niche, "grinder_1", 54)

	df64 := taskStat(t, repo, shotsRepo, "grinder_2")
	wantShotsSince(t, df64, "grinder_2", 1)
	wantGramsSince(t, df64, "grinder_2", 20)
}

// TestGrinderTasks_ShotOnANeverAdvancesB: a shot on grinder A must not move
// grinder B's counter, pct or grams.
func TestGrinderTasks_ShotOnANeverAdvancesB(t *testing.T) {
	_, repo, libRepo, sqlDB := newTestHandlers(t)
	shotsRepo := shots.NewRepository(sqlDB)

	if err := libRepo.SaveLibrary(library.Library{
		Grinders: []library.Entity{
			{"id": int64(1), "name": "Niche Zero"},
			{"id": int64(2), "name": "DF64"},
		},
	}); err != nil {
		t.Fatalf("SaveLibrary: %v", err)
	}
	for _, key := range []string{"grinder_1", "grinder_2"} {
		if err := repo.SaveTask(1, key, Task{"lastDate": "2026-01-01"}); err != nil {
			t.Fatalf("SaveTask %s: %v", key, err)
		}
	}
	insertGrinderShot(t, sqlDB, shotsRepo, 1, time.Date(2026, 1, 2, 8, 0, 0, 0, time.UTC), 1,
		map[string]any{"grinder": "DF64", "dose": 20.0})

	before := taskStat(t, repo, shotsRepo, "grinder_2")
	wantShotsSince(t, before, "grinder_2", 1)

	insertGrinderShot(t, sqlDB, shotsRepo, 2, time.Date(2026, 1, 3, 8, 0, 0, 0, time.UTC), 1,
		map[string]any{"grinder": "Niche Zero", "dose": 18.0})

	after := taskStat(t, repo, shotsRepo, "grinder_2")
	wantShotsSince(t, after, "grinder_2", 1)
	wantGramsSince(t, after, "grinder_2", 20)
	wantPct(t, after, "grinder_2", before["pct"].(float64))

	niche := taskStat(t, repo, shotsRepo, "grinder_1")
	wantShotsSince(t, niche, "grinder_1", 1)
}

// TestGrinderTasks_SingleGrinderKeepsCountingEveryShot pins the attribution
// rule that keeps existing single-grinder installs unchanged: with exactly one
// grinder in the library every shot is that grinder's, annotated or not.
func TestGrinderTasks_SingleGrinderKeepsCountingEveryShot(t *testing.T) {
	_, repo, libRepo, sqlDB := newTestHandlers(t)
	shotsRepo := shots.NewRepository(sqlDB)

	if err := libRepo.SaveLibrary(library.Library{
		Grinders: []library.Entity{{"id": int64(1), "name": "Niche Zero"}},
	}); err != nil {
		t.Fatalf("SaveLibrary: %v", err)
	}
	if err := repo.SaveTask(1, "grinder_1", Task{"lastDate": "2026-01-01"}); err != nil {
		t.Fatalf("SaveTask: %v", err)
	}

	insertGrinderShot(t, sqlDB, shotsRepo, 1, time.Date(2026, 1, 2, 8, 0, 0, 0, time.UTC), 1,
		map[string]any{"grinder": "Niche Zero", "dose": 18.0})
	insertGrinderShot(t, sqlDB, shotsRepo, 2, time.Date(2026, 1, 3, 8, 0, 0, 0, time.UTC), 1,
		map[string]any{"grinder": "DF64", "dose": 18.0})
	insertGrinderShot(t, sqlDB, shotsRepo, 3, time.Date(2026, 1, 4, 8, 0, 0, 0, time.UTC), 1,
		map[string]any{"coffee": "Ethiopia Guji", "dose": 18.0})
	insertGrinderShot(t, sqlDB, shotsRepo, 4, time.Date(2026, 1, 5, 8, 0, 0, 0, time.UTC), 1, nil)

	stat := taskStat(t, repo, shotsRepo, "grinder_1")
	wantShotsSince(t, stat, "grinder_1", 4)
	wantGramsSince(t, stat, "grinder_1", 54)
}

// TestGrinderTasks_UnknownGrinderCountsForNone: with several grinders a shot
// naming a grinder that isn't in the library belongs to no task.
func TestGrinderTasks_UnknownGrinderCountsForNone(t *testing.T) {
	_, repo, libRepo, sqlDB := newTestHandlers(t)
	shotsRepo := shots.NewRepository(sqlDB)

	if err := libRepo.SaveLibrary(library.Library{
		Grinders: []library.Entity{
			{"id": int64(1), "name": "Niche Zero"},
			{"id": int64(2), "name": "DF64"},
		},
	}); err != nil {
		t.Fatalf("SaveLibrary: %v", err)
	}
	for _, key := range []string{"grinder_1", "grinder_2"} {
		if err := repo.SaveTask(1, key, Task{"lastDate": "2026-01-01"}); err != nil {
			t.Fatalf("SaveTask %s: %v", key, err)
		}
	}

	insertGrinderShot(t, sqlDB, shotsRepo, 1, time.Date(2026, 1, 2, 8, 0, 0, 0, time.UTC), 1,
		map[string]any{"grinder": "Other", "dose": 18.0})

	for _, key := range []string{"grinder_1", "grinder_2"} {
		stat := taskStat(t, repo, shotsRepo, key)
		wantShotsSince(t, stat, key, 0)
		wantGramsSince(t, stat, key, 0)
	}
}

// TestGrinderTasks_RespectsLastDateTrashAndAllMachines: the grinder fold keeps
// the old since-date and trash rules, and still counts every machine because a
// grinder is shared equipment.
func TestGrinderTasks_RespectsLastDateTrashAndAllMachines(t *testing.T) {
	_, repo, libRepo, sqlDB := newTestHandlers(t)
	shotsRepo := shots.NewRepository(sqlDB)

	if err := libRepo.SaveLibrary(library.Library{
		Grinders: []library.Entity{
			{"id": int64(1), "name": "Niche Zero"},
			{"id": int64(2), "name": "DF64"},
		},
	}); err != nil {
		t.Fatalf("SaveLibrary: %v", err)
	}
	if err := repo.SaveTask(1, "grinder_1", Task{"lastDate": "2026-02-01"}); err != nil {
		t.Fatalf("SaveTask: %v", err)
	}

	insertGrinderShot(t, sqlDB, shotsRepo, 1, time.Date(2026, 2, 2, 8, 0, 0, 0, time.UTC), 1,
		map[string]any{"grinder": "Niche Zero", "dose": 18.0})
	insertGrinderShot(t, sqlDB, shotsRepo, 2, time.Date(2026, 1, 15, 8, 0, 0, 0, time.UTC), 1,
		map[string]any{"grinder": "Niche Zero", "dose": 18.0})
	insertGrinderShot(t, sqlDB, shotsRepo, 3, time.Date(2026, 2, 3, 8, 0, 0, 0, time.UTC), 1,
		map[string]any{"grinder": "Niche Zero", "dose": 18.0})
	trashGrinderShot(t, sqlDB, 3)
	insertGrinderShot(t, sqlDB, shotsRepo, 4, time.Date(2026, 2, 4, 8, 0, 0, 0, time.UTC), 2,
		map[string]any{"grinder": "Niche Zero", "dose": 18.0})

	stat := taskStat(t, repo, shotsRepo, "grinder_1")
	wantShotsSince(t, stat, "grinder_1", 2)
	wantGramsSince(t, stat, "grinder_1", 36)
}

// TestNonGrinderTask_StillCountsAllShots: the grinder attribution applies only
// to grinder_* tasks; waterfilter still counts every shot on every machine.
func TestNonGrinderTask_StillCountsAllShots(t *testing.T) {
	_, repo, libRepo, sqlDB := newTestHandlers(t)
	shotsRepo := shots.NewRepository(sqlDB)

	if err := libRepo.SaveLibrary(library.Library{
		Grinders: []library.Entity{
			{"id": int64(1), "name": "Niche Zero"},
			{"id": int64(2), "name": "DF64"},
		},
	}); err != nil {
		t.Fatalf("SaveLibrary: %v", err)
	}
	if err := repo.SaveTask(1, "waterfilter", Task{"lastDate": "2026-01-01"}); err != nil {
		t.Fatalf("SaveTask: %v", err)
	}

	insertGrinderShot(t, sqlDB, shotsRepo, 1, time.Date(2026, 1, 2, 8, 0, 0, 0, time.UTC), 1,
		map[string]any{"grinder": "Niche Zero", "dose": 18.0})
	insertGrinderShot(t, sqlDB, shotsRepo, 2, time.Date(2026, 1, 3, 8, 0, 0, 0, time.UTC), 1,
		map[string]any{"grinder": "DF64", "dose": 20.0})
	insertGrinderShot(t, sqlDB, shotsRepo, 3, time.Date(2026, 1, 4, 8, 0, 0, 0, time.UTC), 2,
		map[string]any{"coffee": "Ethiopia Guji"})
	insertGrinderShot(t, sqlDB, shotsRepo, 4, time.Date(2026, 1, 5, 8, 0, 0, 0, time.UTC), 2, nil)

	stat := taskStat(t, repo, shotsRepo, "waterfilter")
	wantShotsSince(t, stat, "waterfilter", 4)
}
