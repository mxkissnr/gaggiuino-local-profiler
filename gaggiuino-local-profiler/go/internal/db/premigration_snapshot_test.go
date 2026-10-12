package db

import (
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"

	_ "modernc.org/sqlite"
)

// TestMigrateMachineColumns_SnapshotIncludesUncheckpointedWAL is the #1625
// regression: the pre-v2-migration snapshot must be a consistent copy of the
// database, including rows still sitting in the WAL and not yet checkpointed.
// The plain file copy this replaced read only the main database file, so a row
// written in WAL mode just before the migration would have been missing from
// the snapshot.
func TestMigrateMachineColumns_SnapshotIncludesUncheckpointedWAL(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "glp.db")

	// WAL mode, matching db.Open's DSN; the driver applies the pragma per
	// connection.
	dsn := "file:" + dbPath + "?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)"
	sqlDB, err := sql.Open("sqlite", dsn)
	if err != nil {
		t.Fatalf("sql.Open: %v", err)
	}
	sqlDB.SetMaxOpenConns(1)
	t.Cleanup(func() { sqlDB.Close() })

	if _, err := sqlDB.Exec(`
		CREATE TABLE shots (id INTEGER PRIMARY KEY, timestamp INTEGER NOT NULL, duration INTEGER, profile_name TEXT, data TEXT NOT NULL DEFAULT '{}');
		CREATE TABLE orders (id TEXT PRIMARY KEY, data TEXT NOT NULL DEFAULT '{}');
		CREATE TABLE maintenance_log (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, date TEXT NOT NULL, task TEXT NOT NULL, machine TEXT DEFAULT '', shot_count INTEGER DEFAULT 0, notes TEXT DEFAULT '');
		CREATE TABLE maintenance (key TEXT PRIMARY KEY, data TEXT NOT NULL DEFAULT '{}');
		INSERT INTO shots (id, timestamp, data) VALUES (42, 7777, '{"legacy":true}');
	`); err != nil {
		t.Fatalf("seeding legacy schema: %v", err)
	}

	if err := MigrateMachineColumns(sqlDB, dbPath); err != nil {
		t.Fatalf("MigrateMachineColumns: %v", err)
	}

	backupPath := findPremigrationSnapshot(t, dir)
	// Read the snapshot through its own connection: it is a self-contained file
	// with no WAL sidecar, so a row still in the source WAL at snapshot time is
	// visible here only if it was copied across.
	backup, err := sql.Open("sqlite", "file:"+backupPath+"?mode=ro")
	if err != nil {
		t.Fatalf("opening snapshot: %v", err)
	}
	defer backup.Close()

	var ts int64
	if err := backup.QueryRow(`SELECT timestamp FROM shots WHERE id = 42`).Scan(&ts); err != nil {
		t.Fatalf("reading uncheckpointed row from snapshot: %v", err)
	}
	if ts != 7777 {
		t.Fatalf("snapshot shot timestamp = %d, want 7777", ts)
	}

	// The snapshot is taken before the migration, so it still has the legacy
	// shape (no machine_id column).
	ok, err := hasColumn(backup, "shots", "machine_id")
	if err != nil {
		t.Fatalf("hasColumn on snapshot: %v", err)
	}
	if ok {
		t.Fatal("snapshot has machine_id: it was taken after the migration, not before")
	}
}

func findPremigrationSnapshot(t *testing.T, dir string) string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("reading temp dir: %v", err)
	}
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), "pre-v2-migration-") && strings.HasSuffix(e.Name(), ".db") {
			return filepath.Join(dir, e.Name())
		}
	}
	t.Fatalf("no pre-v2-migration snapshot in %s: %v", dir, entries)
	return ""
}
