package db

import (
	"database/sql"
	"os"
	"path/filepath"
	"regexp"
	"testing"

	_ "modernc.org/sqlite"
)

func openRaw(t *testing.T, path string) *sql.DB {
	t.Helper()
	sqlDB, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatalf("sql.Open: %v", err)
	}
	sqlDB.SetMaxOpenConns(1)
	t.Cleanup(func() { sqlDB.Close() })
	return sqlDB
}

func TestOpen_CreatesDataDirAndIsIdempotent(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "nested", "glp.db")

	sqlDB, err := Open(dbPath)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	sqlDB.Close()

	// Re-opening an already-initialized DB must not error and must not
	// duplicate/alter anything (every step is IF NOT EXISTS / column-guarded).
	sqlDB2, err := Open(dbPath)
	if err != nil {
		t.Fatalf("second Open: %v", err)
	}
	defer sqlDB2.Close()

	var count int
	if err := sqlDB2.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='shots'`).Scan(&count); err != nil {
		t.Fatalf("querying shots table: %v", err)
	}
	if count != 1 {
		t.Fatalf("expected exactly one shots table, got %d", count)
	}
}

var uuidV4Pattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

func TestEnsureInstallID_StableAcrossCalls(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "glp.db")
	sqlDB, err := Open(dbPath)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer sqlDB.Close()

	id1, err := EnsureInstallID(sqlDB)
	if err != nil {
		t.Fatalf("EnsureInstallID (1st): %v", err)
	}
	if !uuidV4Pattern.MatchString(id1) {
		t.Fatalf("install id %q is not a v4 UUID", id1)
	}

	id2, err := EnsureInstallID(sqlDB)
	if err != nil {
		t.Fatalf("EnsureInstallID (2nd): %v", err)
	}
	if id1 != id2 {
		t.Fatalf("install id changed across calls: %q != %q", id1, id2)
	}
}

// TestEnsureInstallID_TolerantOfMalformedStoredValue pins #901: a
// syntactically valid but wrongly-shaped kv.value for install_id (e.g. "{}"
// or "123" instead of a JSON-encoded string, which is what a hand-edited or
// corrupted DB might contain) must not make Open() fail. lib/db.js's
// `JSON.parse(row.value)` never type-checks its result either -- it just
// returns whatever JSON.parse produced, so this pins the Go port to the same
// "never abort the server on this" behavior instead of propagating a
// json.UnmarshalTypeError up through Open().
func TestEnsureInstallID_TolerantOfMalformedStoredValue(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "glp.db")

	sqlDB, err := Open(dbPath)
	if err != nil {
		t.Fatalf("initial Open: %v", err)
	}
	for _, malformed := range []string{`{}`, `123`} {
		if _, err := sqlDB.Exec(
			`INSERT OR REPLACE INTO kv (key, value) VALUES ('install_id', ?)`, malformed,
		); err != nil {
			t.Fatalf("seeding malformed install_id %q: %v", malformed, err)
		}

		id, err := EnsureInstallID(sqlDB)
		if err != nil {
			t.Fatalf("EnsureInstallID with malformed value %q: %v", malformed, err)
		}
		if id != malformed {
			t.Errorf("EnsureInstallID(%q) = %q, want %q", malformed, id, malformed)
		}
	}
	sqlDB.Close()

	// Also confirm a full Open() (which calls EnsureInstallID internally)
	// against a DB file that already has a malformed stored value succeeds,
	// not just a direct EnsureInstallID call against an already-open handle.
	sqlDB2, err := Open(dbPath)
	if err != nil {
		t.Fatalf("re-Open with malformed install_id already on disk: %v", err)
	}
	sqlDB2.Close()
}

// TestMigrateMachineColumns_LegacySchema builds a pre-#317 database by hand
// (the shape lib/db.js's initSchema produced before machine_id existed) and
// checks MigrateMachineColumns brings it up to the current shape: additive
// machine_id columns on shots/orders/maintenance_log, the idx_shots_machine
// index, maintenance rebuilt onto a (machine_id, key) composite primary key
// with its one existing row preserved under machine_id=1, and a
// pre-migration backup file written next to the DB.
func TestMigrateMachineColumns_LegacySchema(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "glp.db")
	sqlDB := openRaw(t, dbPath)

	if _, err := sqlDB.Exec(`
		CREATE TABLE shots (id INTEGER PRIMARY KEY, timestamp INTEGER NOT NULL, duration INTEGER, profile_name TEXT, data TEXT NOT NULL DEFAULT '{}');
		CREATE TABLE orders (id TEXT PRIMARY KEY, data TEXT NOT NULL DEFAULT '{}');
		CREATE TABLE maintenance_log (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, date TEXT NOT NULL, task TEXT NOT NULL, machine TEXT DEFAULT '', shot_count INTEGER DEFAULT 0, notes TEXT DEFAULT '');
		CREATE TABLE maintenance (key TEXT PRIMARY KEY, data TEXT NOT NULL DEFAULT '{}');
		INSERT INTO maintenance (key, data) VALUES ('descaling', '{"lastDate":123}');
	`); err != nil {
		t.Fatalf("seeding legacy schema: %v", err)
	}
	// A real file must exist on disk for the backup step to trigger — write
	// something after the in-memory exec above by touching the file (Open
	// already created it via sql.Open, but force a flush/checkpoint isn't
	// needed: the backup step only checks os.Stat, and MigrateMachineColumns
	// itself is what we're testing here, driven directly, not through Open).
	if _, err := os.Stat(dbPath); err != nil {
		t.Fatalf("expected db file to exist before migration: %v", err)
	}

	if err := MigrateMachineColumns(sqlDB, dbPath); err != nil {
		t.Fatalf("MigrateMachineColumns: %v", err)
	}

	for _, table := range []string{"shots", "orders", "maintenance_log", "maintenance"} {
		ok, err := hasColumn(sqlDB, table, "machine_id")
		if err != nil {
			t.Fatalf("hasColumn(%s): %v", table, err)
		}
		if !ok {
			t.Errorf("expected %s.machine_id to exist after migration", table)
		}
	}

	var idxCount int
	if err := sqlDB.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_shots_machine'`).Scan(&idxCount); err != nil {
		t.Fatalf("checking idx_shots_machine: %v", err)
	}
	if idxCount != 1 {
		t.Errorf("expected idx_shots_machine to be created, got count %d", idxCount)
	}

	var data string
	var machineID int
	if err := sqlDB.QueryRow(`SELECT machine_id, data FROM maintenance WHERE key = 'descaling'`).Scan(&machineID, &data); err != nil {
		t.Fatalf("querying migrated maintenance row: %v", err)
	}
	if machineID != 1 {
		t.Errorf("expected preserved maintenance row to get machine_id=1, got %d", machineID)
	}
	if data != `{"lastDate":123}` {
		t.Errorf("expected maintenance row data preserved, got %q", data)
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("reading temp dir: %v", err)
	}
	foundBackup := false
	for _, e := range entries {
		if regexp.MustCompile(`^pre-v2-migration-\d+\.db$`).MatchString(e.Name()) {
			foundBackup = true
		}
	}
	if !foundBackup {
		t.Errorf("expected a pre-v2-migration-*.db backup file in %s, found: %v", dir, entries)
	}

	// Re-running must be a no-op (idempotent) — no second backup, no error.
	if err := MigrateMachineColumns(sqlDB, dbPath); err != nil {
		t.Fatalf("second MigrateMachineColumns: %v", err)
	}
	entriesAfter, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("reading temp dir after second run: %v", err)
	}
	if len(entriesAfter) != len(entries) {
		t.Errorf("expected no new backup on idempotent re-run: before=%v after=%v", entries, entriesAfter)
	}
}

func TestMigrateMachineTheme_AddsColumn(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "glp.db")
	sqlDB := openRaw(t, dbPath)

	if _, err := sqlDB.Exec(`
		CREATE TABLE machines (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, type TEXT NOT NULL, host TEXT NOT NULL, switch_entity TEXT, is_default INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
	`); err != nil {
		t.Fatalf("seeding legacy machines table: %v", err)
	}

	if err := MigrateMachineTheme(sqlDB); err != nil {
		t.Fatalf("MigrateMachineTheme: %v", err)
	}
	ok, err := hasColumn(sqlDB, "machines", "theme")
	if err != nil {
		t.Fatalf("hasColumn: %v", err)
	}
	if !ok {
		t.Fatal("expected machines.theme to exist after migration")
	}

	// Idempotent re-run.
	if err := MigrateMachineTheme(sqlDB); err != nil {
		t.Fatalf("second MigrateMachineTheme: %v", err)
	}
}

func TestFixSchema_RecreatesIntegerOrdersTable(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "glp.db")
	sqlDB := openRaw(t, dbPath)

	if _, err := sqlDB.Exec(`CREATE TABLE orders (id INTEGER PRIMARY KEY, data TEXT NOT NULL DEFAULT '{}')`); err != nil {
		t.Fatalf("seeding legacy INTEGER-pk orders table: %v", err)
	}

	if err := FixSchema(sqlDB); err != nil {
		t.Fatalf("FixSchema: %v", err)
	}

	var colType string
	if err := sqlDB.QueryRow(`SELECT type FROM pragma_table_info('orders') WHERE name = 'id'`).Scan(&colType); err != nil {
		t.Fatalf("inspecting orders.id: %v", err)
	}
	if colType != "TEXT" {
		t.Fatalf("expected orders.id to become TEXT, got %s", colType)
	}

	// A TEXT-pk orders table must be left untouched.
	if err := FixSchema(sqlDB); err != nil {
		t.Fatalf("second FixSchema: %v", err)
	}
	if _, err := sqlDB.Exec(`INSERT INTO orders (id, data) VALUES ('abc', '{}')`); err != nil {
		t.Fatalf("inserting into fixed orders table: %v", err)
	}
	if err := FixSchema(sqlDB); err != nil {
		t.Fatalf("third FixSchema (with data present): %v", err)
	}
	var n int
	if err := sqlDB.QueryRow(`SELECT COUNT(*) FROM orders`).Scan(&n); err != nil {
		t.Fatalf("counting orders: %v", err)
	}
	if n != 1 {
		t.Fatalf("expected FixSchema to leave a TEXT-pk orders table's data alone, got %d rows", n)
	}
}
