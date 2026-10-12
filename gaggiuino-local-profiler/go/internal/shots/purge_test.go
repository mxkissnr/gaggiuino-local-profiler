package shots

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
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
// cache row; a 29-day-old entry and a live shot are untouched; the purged id
// is blocklisted while the fresh trash entry's id is not (#1159).
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
	if len(purged) != 1 || purged[0].ID != 1 {
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
		{"blocklist size", `SELECT COUNT(*) FROM blocklist`, 1},
	} {
		if got := countRows(t, sqlDB, q.query); got != q.want {
			t.Fatalf("%s count = %d, want %d", q.name, got, q.want)
		}
	}

	blocklist, err := repo.GetBlocklist()
	if err != nil {
		t.Fatalf("GetBlocklist: %v", err)
	}
	if len(blocklist) != 1 || blocklist[0] != "1" {
		t.Fatalf("GetBlocklist after purge = %v, want [1]", blocklist)
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

// TestPurgeExpiredTrash_RemovesPhotoAndThumbnail (#1525): a purged trashed
// shot's photo and thumbnail are deleted from the image dir.
func TestPurgeExpiredTrash_RemovesPhotoAndThumbnail(t *testing.T) {
	h, _, sqlDB := newTestHandlers(t)
	dir := t.TempDir()
	h.service.imageDir = dir
	insertShot(t, sqlDB, 1, 1000, nil, "Espresso", map[string]any{"image": "jpg"}, nil)
	if _, err := sqlDB.Exec(`INSERT INTO trash (shot_id, deleted_at) VALUES (?, ?)`, 1, time.Now().Add(-31*24*time.Hour).UnixMilli()); err != nil {
		t.Fatalf("trashing shot 1: %v", err)
	}
	for _, name := range []string{"shot-1.jpg", "shot-1.thumb.jpg"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte{0x01}, 0o644); err != nil {
			t.Fatal(err)
		}
	}

	if err := h.service.PurgeExpiredTrash(); err != nil {
		t.Fatalf("PurgeExpiredTrash: %v", err)
	}
	for _, name := range []string{"shot-1.jpg", "shot-1.thumb.jpg"} {
		if _, err := os.Stat(filepath.Join(dir, name)); !os.IsNotExist(err) {
			t.Errorf("%s should have been removed (err=%v)", name, err)
		}
	}
}

// TestDeleteAndBlocklist_RemovesRowsAndBlocklists covers #1609's delete path:
// the shot, its annotation and its trash entry are gone and its id is in the
// blocklist, all from the one Repository call the delete handler now makes.
func TestDeleteAndBlocklist_RemovesRowsAndBlocklists(t *testing.T) {
	_, repo, sqlDB := newTestHandlers(t)
	dur := int64(300)
	insertShot(t, sqlDB, 1, 1000, &dur, "V60",
		map[string]any{"datapoints": []any{}}, map[string]any{"dose": 18.0})
	if _, err := sqlDB.Exec(`INSERT INTO trash (shot_id, deleted_at) VALUES (?, ?)`, 1, time.Now().UnixMilli()); err != nil {
		t.Fatalf("trashing shot 1: %v", err)
	}

	if err := repo.DeleteAndBlocklist(1); err != nil {
		t.Fatalf("DeleteAndBlocklist: %v", err)
	}

	for _, q := range []struct {
		name  string
		query string
		want  int
	}{
		{"shot row", `SELECT COUNT(*) FROM shots WHERE id = 1`, 0},
		{"annotation", `SELECT COUNT(*) FROM annotations WHERE shot_id = 1`, 0},
		{"trash", `SELECT COUNT(*) FROM trash WHERE shot_id = 1`, 0},
		{"blocklist entry", `SELECT COUNT(*) FROM blocklist WHERE value = '1'`, 1},
	} {
		if got := countRows(t, sqlDB, q.query); got != q.want {
			t.Fatalf("%s count = %d, want %d", q.name, got, q.want)
		}
	}
}

// TestDeleteAndBlocklist_AtomicWhenBlocklistWriteFails proves the delete and
// the blocklist insert share one transaction (#1609): with the blocklist table
// missing the call errors and the shot row must survive, so a sync can never
// see the shot gone without the blocklist entry that is meant to hide it.
func TestDeleteAndBlocklist_AtomicWhenBlocklistWriteFails(t *testing.T) {
	_, repo, sqlDB := newTestHandlers(t)
	dur := int64(300)
	insertShot(t, sqlDB, 1, 1000, &dur, "V60", map[string]any{"datapoints": []any{}}, nil)
	if _, err := sqlDB.Exec(`DROP TABLE blocklist`); err != nil {
		t.Fatalf("dropping blocklist table: %v", err)
	}

	if err := repo.DeleteAndBlocklist(1); err == nil {
		t.Fatal("DeleteAndBlocklist succeeded without a blocklist table; want an error")
	}
	if got := countRows(t, sqlDB, `SELECT COUNT(*) FROM shots WHERE id = 1`); got != 1 {
		t.Fatalf("shot row count = %d, want 1 (the failed blocklist write must roll the delete back)", got)
	}
}

// TestPurgeExpiredTrash_SkipsRestoredShot covers #1609's purge race: of two
// expired trash entries, the one whose trash row was removed (RestoreFromTrash
// — exactly what the user's restore does) must be left alone while the other is
// purged and blocklisted.
func TestPurgeExpiredTrash_SkipsRestoredShot(t *testing.T) {
	_, repo, sqlDB := newTestHandlers(t)
	now := time.Now()

	for i := int64(1); i <= 2; i++ {
		insertShot(t, sqlDB, i, i*1000, nil, "Espresso",
			map[string]any{"datapoints": []any{}}, nil)
	}
	expired := now.Add(-31 * 24 * time.Hour).UnixMilli()
	for i := int64(1); i <= 2; i++ {
		if _, err := sqlDB.Exec(`INSERT INTO trash (shot_id, deleted_at) VALUES (?, ?)`, i, expired); err != nil {
			t.Fatalf("trashing shot %d: %v", i, err)
		}
	}
	// The user restores shot 2 after the purge would have read it as a candidate.
	if err := repo.RestoreFromTrash(2); err != nil {
		t.Fatalf("RestoreFromTrash: %v", err)
	}

	purged, err := repo.PurgeExpiredTrash(now)
	if err != nil {
		t.Fatalf("PurgeExpiredTrash: %v", err)
	}
	if len(purged) != 1 || purged[0].ID != 1 {
		t.Fatalf("PurgeExpiredTrash = %v, want [1]", purged)
	}
	if got := countRows(t, sqlDB, `SELECT COUNT(*) FROM shots WHERE id = 2`); got != 1 {
		t.Fatalf("restored shot 2 row count = %d, want 1", got)
	}
	blocklist, err := repo.GetBlocklist()
	if err != nil {
		t.Fatalf("GetBlocklist: %v", err)
	}
	if len(blocklist) != 1 || blocklist[0] != "1" {
		t.Fatalf("blocklist = %v, want [1] (the restored shot must not be blocklisted)", blocklist)
	}
}

// TestUpsert_InvalidatesScoreCacheOnResync covers #1609's stale-score case: a
// re-synced shot keeps the same id, timestamp and data length while its
// duration changes, so Upsert must drop the cached score instead of letting the
// page query's fingerprint keep matching and serve the old one.
func TestUpsert_InvalidatesScoreCacheOnResync(t *testing.T) {
	_, repo, sqlDB := newTestHandlers(t)
	dur := int64(300)
	insertShot(t, sqlDB, 1, 1000, &dur, "V60",
		map[string]any{"datapoints": bigDatapoints(40)},
		map[string]any{"dose": 18.0})

	// First read backfills shot_score_cache for shot 1.
	if _, err := repo.FindPageExcludingTrash(Cursor{}, 60, 0); err != nil {
		t.Fatalf("FindPageExcludingTrash: %v", err)
	}
	if got := countRows(t, sqlDB, `SELECT COUNT(*) FROM shot_score_cache WHERE shot_id = 1`); got != 1 {
		t.Fatalf("cache rows after the first page read = %d, want 1", got)
	}

	// Re-sync: same id/timestamp/data length, changed duration.
	if err := repo.Upsert(Shot{
		"id":         int64(1),
		"timestamp":  int64(1000),
		"duration":   int64(999),
		"datapoints": bigDatapoints(40),
	}); err != nil {
		t.Fatalf("Upsert: %v", err)
	}

	if got := countRows(t, sqlDB, `SELECT COUNT(*) FROM shot_score_cache WHERE shot_id = 1`); got != 0 {
		t.Fatalf("cache rows right after Upsert = %d, want 0 (Upsert must invalidate the stale score)", got)
	}
}
