package db

import (
	"crypto/rand"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"time"

	_ "modernc.org/sqlite"
)

// DefaultPath is the on-disk location the Node app opens (lib/db.js's
// DB_PATH = path.join(DATA_DIR, 'glp.db')). Callers needing an isolated
// database (tests, primarily) pass their own path to Open instead.
const DefaultPath = "/data/glp.db"

// Open opens (creating if necessary) the SQLite database at path, brings it
// to the current schema, and runs the same additive migrations
// lib/db.js's getDb() runs on every start — everything except the legacy
// flat-JSON-to-SQLite migration (lib/db.js's migrate() against JSON_FILES),
// which is deliberately not ported: it only ever mattered for installs
// upgrading from a pre-SQLite version, and every install this Go binary can
// possibly run against is already on SQLite.
//
// modernc.org/sqlite is a database/sql driver, so unlike better-sqlite3
// (Node's single synchronous connection) database/sql pools multiple
// connections. The pragmas this database needs on every connection
// (journal_mode, foreign_keys, busy_timeout, synchronous) are therefore set
// through the connection URL — modernc.org/sqlite applies each `_pragma=`
// query parameter to every physical connection it opens, so a pooled
// connection can never end up with a stale pragma state.
//
// With WAL + per-connection busy_timeout that lets the pool run several
// concurrent readers: SQLite/WAL allows readers to proceed while another
// connection reads or writes, so a slow full-table scan on one connection
// (the periodic sync loop, achievements, a big list response) no longer
// head-of-line-blocks every other HTTP request behind the one shared
// handle (#956). Writes are still serialised by SQLite itself; a writer
// that meets a brief WAL lock retries internally for up to busy_timeout
// rather than erroring with SQLITE_BUSY.
//
// Schema creation and the additive migrations below run before the pool is
// opened up — on a single connection (SetMaxOpenConns(1)) — so a
// multi-statement ALTER never races a concurrent reader, matching
// lib/db.js's single better-sqlite3 handle exactly for the one phase where
// it matters.
func Open(path string) (*sql.DB, error) {
	if dir := filepath.Dir(path); dir != "." && dir != "/" {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, fmt.Errorf("db: creating data dir %s: %w", dir, err)
		}
	}

	// getDb(): _db.pragma('journal_mode = WAL') + initSchema()'s
	// `foreign_keys = ON`, plus busy_timeout/synchronous(NORMAL) WAL tuning
	// (#956). Applied per connection by the driver, so every pooled
	// connection is identical.
	dsn := "file:" + path +
		"?_pragma=busy_timeout(5000)" +
		"&_pragma=journal_mode(WAL)" +
		"&_pragma=foreign_keys(ON)" +
		"&_pragma=synchronous(NORMAL)"

	sqlDB, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("db: opening %s: %w", path, err)
	}

	// Serial phase: schema + migrations on one connection (see doc comment).
	sqlDB.SetMaxOpenConns(1)
	sqlDB.SetMaxIdleConns(1)

	if err := InitSchema(sqlDB); err != nil {
		sqlDB.Close()
		return nil, err
	}
	if err := FixSchema(sqlDB); err != nil {
		sqlDB.Close()
		return nil, err
	}
	// migrate() (flat JSON -> SQLite) intentionally not ported — see doc
	// comment above.
	if err := MigrateMachineColumns(sqlDB, path); err != nil {
		sqlDB.Close()
		return nil, err
	}
	if err := MigrateMachineTheme(sqlDB); err != nil {
		sqlDB.Close()
		return nil, err
	}
	if _, err := EnsureInstallID(sqlDB); err != nil {
		sqlDB.Close()
		return nil, err
	}

	// Migrations done — open the pool for concurrent reads.
	poolSize := runtime.NumCPU()
	if poolSize < 4 {
		poolSize = 4
	}
	sqlDB.SetMaxOpenConns(poolSize)
	sqlDB.SetMaxIdleConns(4)
	sqlDB.SetConnMaxIdleTime(5 * time.Minute)

	return sqlDB, nil
}

// schemaSQL is lib/db.js's initSchema() template literal, ported verbatim
// (including its comments) so the two stay diffable against each other.
// Table/column/index definitions must stay byte-for-byte equivalent to the
// Node schema — see db_schema_test.go, which pins the exact
// `sqlite_master.sql` text this produces.
const schemaSQL = `
	CREATE TABLE IF NOT EXISTS shots (
		id          INTEGER PRIMARY KEY,
		timestamp   INTEGER NOT NULL,
		duration    INTEGER,
		profile_name TEXT,
		data        TEXT NOT NULL DEFAULT '{}',
		machine_id  INTEGER NOT NULL DEFAULT 1
	);
	CREATE INDEX IF NOT EXISTS idx_shots_timestamp ON shots(timestamp);

	-- Multi-machine registry (#317). shots.id stays a single global integer:
	-- the default machine (id 1) keeps its native machine shot ids unchanged
	-- (backward compat -- existing URLs/images/annotations keep working
	-- untouched), additional machines get a synthetic id
	-- (machineId * MACHINE_ID_OFFSET + nativeId, see lib/machines/index.js)
	-- so no PRIMARY KEY rebuild is needed anywhere.
	-- theme (#594): nullable JSON string, one of
	--   {"preset":"<key>"}        -- one of the 8 approved preset keys (see
	--                                lib/machines/theme-presets.js)
	--   {"a":"#rrggbb","b":"#rrggbb"} -- custom colour; b === a for a flat
	--                                colour, b !== a for a two-stop gradient
	-- NULL = no theme set, current default appearance. This is the
	-- cross-repo contract the Lovelace cards consume in a later round --
	-- see DOCS.md "Machine themes".
	CREATE TABLE IF NOT EXISTS machines (
		id            INTEGER PRIMARY KEY AUTOINCREMENT,
		name          TEXT NOT NULL,
		type          TEXT NOT NULL CHECK(type IN ('gaggiuino','gaggimate')),
		host          TEXT NOT NULL,
		switch_entity TEXT,
		theme         TEXT,
		is_default    INTEGER NOT NULL DEFAULT 0,
		enabled       INTEGER NOT NULL DEFAULT 1,
		created_at    INTEGER NOT NULL
	);

	CREATE TABLE IF NOT EXISTS annotations (
		shot_id     INTEGER PRIMARY KEY REFERENCES shots(id) ON DELETE CASCADE,
		data        TEXT NOT NULL DEFAULT '{}'
	);

	CREATE TABLE IF NOT EXISTS trash (
		shot_id     INTEGER PRIMARY KEY,
		deleted_at  INTEGER NOT NULL
	);

	CREATE TABLE IF NOT EXISTS blocklist (
		id          INTEGER PRIMARY KEY AUTOINCREMENT,
		value       TEXT NOT NULL UNIQUE
	);

	CREATE TABLE IF NOT EXISTS library (
		key         TEXT PRIMARY KEY,
		data        TEXT NOT NULL DEFAULT '{}'
	);

	CREATE TABLE IF NOT EXISTS maintenance (
		machine_id  INTEGER NOT NULL DEFAULT 1,
		key         TEXT NOT NULL,
		data        TEXT NOT NULL DEFAULT '{}',
		PRIMARY KEY (machine_id, key)
	);

	CREATE TABLE IF NOT EXISTS maintenance_log (
		id          INTEGER PRIMARY KEY,
		ts          INTEGER NOT NULL,
		date        TEXT NOT NULL,
		task        TEXT NOT NULL,
		machine     TEXT DEFAULT '',
		shot_count  INTEGER DEFAULT 0,
		notes       TEXT DEFAULT '',
		machine_id  INTEGER NOT NULL DEFAULT 1
	);
	CREATE INDEX IF NOT EXISTS idx_maint_log_ts ON maintenance_log(ts DESC);

	CREATE TABLE IF NOT EXISTS orders (
		id          TEXT PRIMARY KEY,
		data        TEXT NOT NULL DEFAULT '{}',
		machine_id  INTEGER NOT NULL DEFAULT 1
	);

	CREATE TABLE IF NOT EXISTS kv (
		key         TEXT PRIMARY KEY,
		value       TEXT NOT NULL DEFAULT '{}'
	);

	-- #812: achievements stamp card. One row per badge id (see
	-- lib/achievements/registry.js), written once on unlock and never
	-- updated again except progress (e.g. "7 of 10") while still locked.
	-- No machine_id column, deliberately: the collection is per-install,
	-- shared across every machine registered in this app -- see the
	-- registry file's header comment for why that's the right scope.
	-- unlocked_at is Unix SECONDS (NULL while locked), matching
	-- shots.timestamp's convention elsewhere in this file.
	CREATE TABLE IF NOT EXISTS achievements (
		id          TEXT PRIMARY KEY,
		unlocked_at INTEGER,
		progress    INTEGER
	);
`

// InitSchema creates every table/index used by the app if it doesn't already
// exist and turns on foreign-key enforcement — the Go port of lib/db.js's
// initSchema(db). Extracted, like the Node original, so tests can stand up
// an isolated database with the same schema instead of duplicating this SQL.
//
// Open() also sets foreign_keys via the connection DSN (per pooled
// connection); the Exec here is kept so callers that open a raw *sql.DB
// without that DSN (a custom driver in tests, an in-memory probe) still get
// enforcement. It runs during Open()'s single-connection migration phase,
// so it is not the "pragma on one random pooled connection" anti-pattern.
func InitSchema(sqlDB *sql.DB) error {
	if _, err := sqlDB.Exec(`PRAGMA foreign_keys = ON`); err != nil {
		return fmt.Errorf("db: enabling foreign_keys: %w", err)
	}
	if _, err := sqlDB.Exec(schemaSQL); err != nil {
		return fmt.Errorf("db: creating schema: %w", err)
	}
	return nil
}

// FixSchema ports lib/db.js's fixSchema(): early installs created `orders`
// with an INTEGER PRIMARY KEY id before order ids were known to be strings.
// Safe to drop and recreate because the (never-ported) JSON migration only
// ever set kv.migrated after succeeding, so a still-INTEGER orders table is
// always empty when this runs.
func FixSchema(sqlDB *sql.DB) error {
	var colType string
	err := sqlDB.QueryRow(
		`SELECT type FROM pragma_table_info('orders') WHERE name = 'id'`,
	).Scan(&colType)
	if err == sql.ErrNoRows {
		return nil
	}
	if err != nil {
		return fmt.Errorf("db: inspecting orders.id: %w", err)
	}
	if colType != "INTEGER" {
		return nil
	}
	if _, err := sqlDB.Exec(`DROP TABLE IF EXISTS orders`); err != nil {
		return fmt.Errorf("db: dropping legacy orders table: %w", err)
	}
	if _, err := sqlDB.Exec(
		`CREATE TABLE orders (id TEXT PRIMARY KEY, data TEXT NOT NULL DEFAULT '{}')`,
	); err != nil {
		return fmt.Errorf("db: recreating orders table: %w", err)
	}
	return nil
}

// hasColumn ports the hasColumn(table, col) closure repeated in lib/db.js's
// migrateMachineColumns/migrateMachineTheme. table/col are always internal
// literals (never user input), so building the pragma_table_info() query
// directly (that table-valued function can't take a bound parameter for its
// own name) is safe.
func hasColumn(sqlDB *sql.DB, table, col string) (bool, error) {
	var one int
	err := sqlDB.QueryRow(
		fmt.Sprintf(`SELECT 1 FROM pragma_table_info('%s') WHERE name = ?`, table),
		col,
	).Scan(&one)
	if err == sql.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("db: checking column %s.%s: %w", table, col, err)
	}
	return true, nil
}

// MigrateMachineColumns ports lib/db.js's migrateMachineColumns(): adds the
// machine_id scoping column (#317) to shots/orders/maintenance_log, and
// rebuilds maintenance onto a composite (machine_id, key) primary key —
// without ever rebuilding shots'/orders'/maintenance_log's PRIMARY KEY, same
// as the Node original. dbPath is the on-disk file backing sqlDB; it is only
// used to snapshot the file before a migration that touches real shot/order
// history actually runs (never on a fresh install with no file yet, never
// again once machine_id already exists everywhere) — passed explicitly, like
// the Node version's injectable dbPath default, so tests can point it at a
// throwaway file instead of the real DefaultPath.
func MigrateMachineColumns(sqlDB *sql.DB, dbPath string) error {
	needsMigration := false
	for _, t := range []string{"shots", "orders", "maintenance_log"} {
		ok, err := hasColumn(sqlDB, t, "machine_id")
		if err != nil {
			return err
		}
		if !ok {
			needsMigration = true
		}
	}
	if !needsMigration {
		ok, err := hasColumn(sqlDB, "maintenance", "machine_id")
		if err != nil {
			return err
		}
		needsMigration = !ok
	}

	if needsMigration {
		if _, err := os.Stat(dbPath); err == nil {
			backupPath := filepath.Join(filepath.Dir(dbPath),
				fmt.Sprintf("pre-v2-migration-%d.db", time.Now().UnixMilli()))
			if err := copyFile(dbPath, backupPath); err != nil {
				return fmt.Errorf("db: writing pre-migration backup: %w", err)
			}
		}
	}

	for _, table := range []string{"shots", "orders", "maintenance_log"} {
		ok, err := hasColumn(sqlDB, table, "machine_id")
		if err != nil {
			return err
		}
		if !ok {
			stmt := fmt.Sprintf(`ALTER TABLE %s ADD COLUMN machine_id INTEGER NOT NULL DEFAULT 1`, table)
			if _, err := sqlDB.Exec(stmt); err != nil {
				return fmt.Errorf("db: adding machine_id to %s: %w", table, err)
			}
		}
	}
	if _, err := sqlDB.Exec(`CREATE INDEX IF NOT EXISTS idx_shots_machine ON shots(machine_id)`); err != nil {
		return fmt.Errorf("db: creating idx_shots_machine: %w", err)
	}

	// shot_score_cache (#957): a Go-only read-through cache for the shot
	// score, so GET /api/shots's keyset-paginated list — and the frontend's
	// background walk of every page to build S.allShots — don't re-parse each
	// shot's datapoints blob to re-score it on every request. Deliberately
	// NOT in schemaSQL: that constant is pinned byte-for-byte to Node's
	// lib/db.js by db_schema_test.go, and Node has no equivalent table. An
	// additive CREATE TABLE IF NOT EXISTS Exec here (same pattern as
	// idx_shots_machine just above) keeps the Node-parity schema intact while
	// still giving every Go install the table. fingerprint is a cheap
	// SQL-recomputable digest of the inputs to CalcShotScoreDetail
	// (length(data) || timestamp || length(annotation)); a mismatch on read
	// means the row is stale and gets recomputed + rewritten. See
	// internal/shots/repository.go's FindPageExcludingTrash.
	if _, err := sqlDB.Exec(`CREATE TABLE IF NOT EXISTS shot_score_cache (
		shot_id          INTEGER PRIMARY KEY,
		score            INTEGER,
		used_bean_target INTEGER NOT NULL DEFAULT 0,
		fingerprint      TEXT NOT NULL,
		computed_at      INTEGER NOT NULL
	)`); err != nil {
		return fmt.Errorf("db: creating shot_score_cache: %w", err)
	}

	// idx_shots_ts_id (#957): the keyset order GET /api/shots pages by
	// (timestamp DESC, id DESC). idx_shots_timestamp covers only the
	// timestamp column, so the id-tiebreak sort and the "one page from the
	// tail" scan aren't fully index-served; this composite makes each page a
	// bounded covered range scan regardless of history size. Go-only,
	// additive, same rationale as shot_score_cache above.
	if _, err := sqlDB.Exec(`CREATE INDEX IF NOT EXISTS idx_shots_ts_id ON shots(timestamp DESC, id DESC)`); err != nil {
		return fmt.Errorf("db: creating idx_shots_ts_id: %w", err)
	}

	ok, err := hasColumn(sqlDB, "maintenance", "machine_id")
	if err != nil {
		return err
	}
	if !ok {
		tx, err := sqlDB.Begin()
		if err != nil {
			return fmt.Errorf("db: starting maintenance migration tx: %w", err)
		}
		_, err = tx.Exec(`
			CREATE TABLE maintenance_new (
				machine_id  INTEGER NOT NULL DEFAULT 1,
				key         TEXT NOT NULL,
				data        TEXT NOT NULL DEFAULT '{}',
				PRIMARY KEY (machine_id, key)
			);
			INSERT INTO maintenance_new (machine_id, key, data)
				SELECT 1, key, data FROM maintenance;
			DROP TABLE maintenance;
			ALTER TABLE maintenance_new RENAME TO maintenance;
		`)
		if err != nil {
			tx.Rollback()
			return fmt.Errorf("db: migrating maintenance table: %w", err)
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("db: committing maintenance migration: %w", err)
		}
	}

	return nil
}

// MigrateMachineTheme ports lib/db.js's migrateMachineTheme(): adds the
// machines.theme column (#594) for installs that created the machines table
// before this column existed. NULL theme means "no theme set" — nothing
// changes visually for existing machines.
func MigrateMachineTheme(sqlDB *sql.DB) error {
	ok, err := hasColumn(sqlDB, "machines", "theme")
	if err != nil {
		return err
	}
	if ok {
		return nil
	}
	if _, err := sqlDB.Exec(`ALTER TABLE machines ADD COLUMN theme TEXT`); err != nil {
		return fmt.Errorf("db: adding theme column to machines: %w", err)
	}
	return nil
}

// EnsureInstallID ports lib/db.js's ensureInstallId()/getInstallId(): a
// random id, generated once per DB file and stored in kv, that lets the
// frontend tell "this is still the install I already onboarded" apart from
// "this DB was just (re-)created" (see lib/db.js's #751 comment for the
// HA-Supervisor-wipe scenario this exists for). The value is stored
// JSON-encoded (a quoted string) to match the Node original's
// JSON.stringify(id)/JSON.parse(row.value) round trip exactly, since other
// kv rows (e.g. 'migrated') follow the same convention and any future Go
// reader of this table must decode it the same way.
//
// A syntactically valid but wrongly-shaped stored value (e.g. kv.value is
// "{}" or "123" instead of a JSON-encoded string) must not prevent the
// server from starting: Node's `if (row) return JSON.parse(row.value);`
// never type-checks its result, it just returns whatever JSON.parse
// produced. This decodes into interface{} and tolerantly coerces via
// installIDString instead of failing the unmarshal on a type mismatch, so
// Open() always succeeds here regardless of what's actually stored.
func EnsureInstallID(sqlDB *sql.DB) (string, error) {
	var value string
	err := sqlDB.QueryRow(`SELECT value FROM kv WHERE key = 'install_id'`).Scan(&value)
	if err == nil {
		var raw interface{}
		if err := json.Unmarshal([]byte(value), &raw); err != nil {
			return "", fmt.Errorf("db: decoding install_id: %w", err)
		}
		return installIDString(raw), nil
	}
	if err != sql.ErrNoRows {
		return "", fmt.Errorf("db: reading install_id: %w", err)
	}

	id, err := newUUIDv4()
	if err != nil {
		return "", fmt.Errorf("db: generating install_id: %w", err)
	}
	encodedBytes, err := json.Marshal(id)
	if err != nil {
		return "", fmt.Errorf("db: encoding install_id: %w", err)
	}
	encoded := string(encodedBytes)
	if _, err := sqlDB.Exec(
		`INSERT OR REPLACE INTO kv (key, value) VALUES ('install_id', ?)`, encoded,
	); err != nil {
		return "", fmt.Errorf("db: storing install_id: %w", err)
	}
	return id, nil
}

// installIDString tolerantly coerces a decoded kv.value for install_id into
// a string, the same way lib/db.js implicitly does by just returning
// JSON.parse's result unchecked: the expected case (the JSON-decoded value
// is itself a string) is returned directly; anything else (a number, bool,
// object, array, null -- kv.value was malformed or written by something
// other than this code path) falls back to its JSON representation rather
// than erroring, so a broken stored value can never fail Open().
func installIDString(raw interface{}) string {
	if s, ok := raw.(string); ok {
		return s
	}
	if encoded, err := json.Marshal(raw); err == nil {
		return string(encoded)
	}
	return fmt.Sprintf("%v", raw)
}

// GetKVBool reads a boolean flag from the kv table, JSON-decoded like every
// other kv row. A missing key or a value that is not a JSON `true` reads as
// false — callers use this for "has one-time task X already run" gates
// where only an explicit true should skip the work.
func GetKVBool(sqlDB *sql.DB, key string) (bool, error) {
	var value string
	err := sqlDB.QueryRow(`SELECT value FROM kv WHERE key = ?`, key).Scan(&value)
	if err == sql.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	var b bool
	if json.Unmarshal([]byte(value), &b) != nil {
		return false, nil
	}
	return b, nil
}

// SetKVBool stores a boolean flag in the kv table, JSON-encoded to match
// the convention every other kv row follows (see EnsureInstallID).
func SetKVBool(sqlDB *sql.DB, key string, v bool) error {
	encoded, err := json.Marshal(v)
	if err != nil {
		return err
	}
	_, err = sqlDB.Exec(`INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)`, key, string(encoded))
	return err
}

// copyFile is a plain byte-for-byte copy (no fsync/atomic-rename dance —
// this is a best-effort pre-migration safety snapshot, same as
// fs.copyFileSync in the Node original, not a crash-safe write path).
func copyFile(src, dst string) error {
	data, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	return os.WriteFile(dst, data, 0o644)
}

// newUUIDv4 generates a random RFC 4122 version-4 UUID, matching Node's
// crypto.randomUUID() used by lib/db.js. Implemented directly against
// crypto/rand rather than pulling in a UUID library for one call site.
func newUUIDv4() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	b[6] = (b[6] & 0x0f) | 0x40 // version 4
	b[8] = (b[8] & 0x3f) | 0x80 // variant 10xx
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16]), nil
}
