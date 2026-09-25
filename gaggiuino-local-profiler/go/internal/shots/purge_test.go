package shots

import (
	"context"
	"database/sql"
	"testing"
	"time"
)

func countRows(t *testing.T, sqlDB *sql.DB, query string, args ...any) int {
	t.Helper()
	var n int
	if err := sqlDB.QueryRow(query, args...).Scan(&n); err != nil {
		t.Fatalf("counting %q: %v", query, err)
	}
	return n
}

// TestPurgeExpiredTrash is the #1152 port test: a trash entry older than 30
// days is dropped together with its shot, annotation and (Go-only) score
// cache row; a 29-day-old entry and a live shot are untouched; the blocklist
// stays empty (Node parity).
func TestPurgeExpiredTrash(t *testing.T) {
	_, repo, sqlDB := newTestHandlers(t)
	now := time.Now()

	for i := int64(1); i <= 3; i++ {
		insertShot(t, sqlDB, i, i*1000, nil, "Espresso",
			map[string]any{"datapoints": []any{}},
			map[string]any{"coffee": "Beans"})
	}
	trashAt := func(id int64, at time.Time) {
		t.Helper()
		if _, err := sqlDB.Exec(`INSERT INTO trash (shot_id, deleted_at) VALUES (?, ?)`, id, at.UnixMilli()); err != nil {
			t.Fatalf("trashing shot %d: %v", id, err)
		}
	}
	trashAt(1, now.Add(-31*24*time.Hour)) // expired
	trashAt(2, now.Add(-29*24*time.Hour)) // still inside the window
	if _, err := sqlDB.Exec(
		`INSERT INTO shot_score_cache (shot_id, score, used_bean_target, fingerprint, computed_at) VALUES (?,?,?,?,?)`,
		1, 80, 0, "fp", now.UnixMilli(),
	); err != nil {
		t.Fatalf("seeding score cache: %v", err)
	}

	purged, err := repo.PurgeExpiredTrash(now)
	if err != nil {
		t.Fatalf("PurgeExpiredTrash: %v", err)
	}
	if len(purged) != 1 || purged[0] != 1 {
		t.Fatalf("PurgeExpiredTrash = %v, want [1]", purged)
	}

	for _, q := range []struct {
		name  string
		query string
		want  int
	}{
		{"shot 1 row", `SELECT COUNT(*) FROM shots WHERE id = 1`, 0},
		{"shot 1 annotation", `SELECT COUNT(*) FROM annotations WHERE shot_id = 1`, 0},
		{"shot 1 trash", `SELECT COUNT(*) FROM trash WHERE shot_id = 1`, 0},
		{"shot 1 score cache", `SELECT COUNT(*) FROM shot_score_cache WHERE shot_id = 1`, 0},
		{"shot 2 row", `SELECT COUNT(*) FROM shots WHERE id = 2`, 1},
		{"shot 2 annotation", `SELECT COUNT(*) FROM annotations WHERE shot_id = 2`, 1},
		{"shot 2 trash", `SELECT COUNT(*) FROM trash WHERE shot_id = 2`, 1},
		{"shot 3 row", `SELECT COUNT(*) FROM shots WHERE id = 3`, 1},
		{"shot 3 annotation", `SELECT COUNT(*) FROM annotations WHERE shot_id = 3`, 1},
		{"shot 3 trash", `SELECT COUNT(*) FROM trash WHERE shot_id = 3`, 0},
		{"blocklist", `SELECT COUNT(*) FROM blocklist`, 0},
	} {
		if got := countRows(t, sqlDB, q.query); got != q.want {
			t.Fatalf("%s count = %d, want %d", q.name, got, q.want)
		}
	}

	again, err := repo.PurgeExpiredTrash(now)
	if err != nil {
		t.Fatalf("second PurgeExpiredTrash: %v", err)
	}
	if len(again) != 0 {
		t.Fatalf("second PurgeExpiredTrash = %v, want none", again)
	}
}

// TestStartTrashPurge_PurgesOnStartup checks that the startup purge runs
// before any tick: with a long interval and an already-cancelled context,
// only the immediate pass can have executed.
func TestStartTrashPurge_PurgesOnStartup(t *testing.T) {
	_, repo, sqlDB := newTestHandlers(t)
	insertShot(t, sqlDB, 1, 1000, nil, "Espresso", map[string]any{"datapoints": []any{}}, nil)
	if _, err := sqlDB.Exec(`INSERT INTO trash (shot_id, deleted_at) VALUES (?, ?)`, 1, time.Now().Add(-31*24*time.Hour).UnixMilli()); err != nil {
		t.Fatalf("trashing shot 1: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	StartTrashPurge(ctx, NewService(repo), 24*time.Hour)

	if got := countRows(t, sqlDB, `SELECT COUNT(*) FROM shots WHERE id = 1`); got != 0 {
		t.Fatalf("shot 1 still present after startup purge (count=%d)", got)
	}
}
