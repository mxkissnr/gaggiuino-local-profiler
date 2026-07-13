const Database = require('better-sqlite3');
const fs       = require('fs');
const path     = require('path');
const { DATA_DIR } = require('./constants');
const { log }      = require('./helpers');

const DB_PATH = path.join(DATA_DIR, 'glp.db');

let _db = null;

// Extracted so tests can stand up an isolated (e.g. in-memory) database with
// the same schema instead of duplicating this SQL.
function initSchema(db) {
    db.pragma('foreign_keys = ON');
    db.exec(`
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
        -- (backward compat — existing URLs/images/annotations keep working
        -- untouched), additional machines get a synthetic id
        -- (machineId * MACHINE_ID_OFFSET + nativeId, see lib/machines/index.js)
        -- so no PRIMARY KEY rebuild is needed anywhere.
        CREATE TABLE IF NOT EXISTS machines (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            name          TEXT NOT NULL,
            type          TEXT NOT NULL CHECK(type IN ('gaggiuino','gaggimate')),
            host          TEXT NOT NULL,
            switch_entity TEXT,
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
    `);
}

function getDb() {
    if (_db) return _db;

    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');
    initSchema(_db);

    fixSchema(_db);
    migrate(_db);
    migrateMachineColumns(_db);

    return _db;
}

// Adds machine_id scoping columns (#317) without ever rebuilding shots'/
// orders'/maintenance_log's PRIMARY KEY — see the shots table comment above.
// Idempotent: pragma-checks each column/table before touching it, same
// pattern as fixSchema().
function migrateMachineColumns(db) {
    const hasColumn = (table, col) =>
        !!db.prepare(`SELECT 1 FROM pragma_table_info(?) WHERE name = ?`).get(table, col);

    for (const table of ['shots', 'orders', 'maintenance_log']) {
        if (!hasColumn(table, 'machine_id')) {
            db.exec(`ALTER TABLE ${table} ADD COLUMN machine_id INTEGER NOT NULL DEFAULT 1`);
            log(`DB: added machine_id column to ${table}`);
        }
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_shots_machine ON shots(machine_id)');

    // maintenance is keyed by task name only (e.g. 'descaling') — needs a
    // composite (machine_id, key) primary key so each machine can track its
    // own schedule. Table is tiny (a handful of rows), so a full rebuild is
    // low-risk, unlike the shots table.
    if (!hasColumn('maintenance', 'machine_id')) {
        db.transaction(() => {
            db.exec(`
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
            `);
        })();
        log('DB: migrated maintenance table to (machine_id, key) composite key');
    }
}

// Fix orders table created with INTEGER PRIMARY KEY before order IDs were known to be strings.
// Safe to drop because migration never sets the 'migrated' flag when it fails, so the table
// is always empty when this runs.
function fixSchema(db) {
    const col = db.prepare("SELECT type FROM pragma_table_info('orders') WHERE name='id'").get();
    if (col && col.type === 'INTEGER') {
        db.exec("DROP TABLE IF EXISTS orders");
        db.exec("CREATE TABLE orders (id TEXT PRIMARY KEY, data TEXT NOT NULL DEFAULT '{}')");
        log('DB: fixed orders table schema (id: INTEGER → TEXT)');
    }
}

// ── Migration from flat JSON files ────────────────────────────────────────

const JSON_FILES = {
    shots:          path.join(DATA_DIR, 'shots.json'),
    annotations:    path.join(DATA_DIR, 'annotations.json'),
    trash:          path.join(DATA_DIR, 'trash.json'),
    blocklist:      path.join(DATA_DIR, 'blocklist.json'),
    library:        path.join(DATA_DIR, 'coffee_library.json'),
    maintenance:    path.join(DATA_DIR, 'maintenance.json'),
    maintenanceLog: path.join(DATA_DIR, 'maintenance_log.json'),
    orders:         path.join(DATA_DIR, 'orders.json'),
    menu:           path.join(DATA_DIR, 'menu.json'),
    ordersSettings: path.join(DATA_DIR, 'orders_settings.json'),
    notifyMapping:  path.join(DATA_DIR, 'notify_mapping.json'),
};

function readJson(file, fallback) {
    try {
        if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {}
    return fallback;
}

function migrate(db) {
    const migrated = db.prepare("SELECT value FROM kv WHERE key='migrated'").get();
    if (migrated) return;

    log('DB: migrating JSON files to SQLite...');

    const insertShot = db.prepare(
        'INSERT OR IGNORE INTO shots (id, timestamp, duration, profile_name, data) VALUES (?,?,?,?,?)'
    );
    const insertAnnotation = db.prepare(
        'INSERT OR IGNORE INTO annotations (shot_id, data) VALUES (?,?)'
    );
    const insertTrash = db.prepare(
        'INSERT OR IGNORE INTO trash (shot_id, deleted_at) VALUES (?,?)'
    );

    const shots       = readJson(JSON_FILES.shots, []);
    const annotations = readJson(JSON_FILES.annotations, {});
    const trash       = readJson(JSON_FILES.trash, {});

    const migrateAll = db.transaction(() => {
        for (const shot of shots) {
            const { id, timestamp, duration, profile_name, profileName, ...rest } = shot;
            insertShot.run(id, timestamp ?? null, duration ?? null, profile_name ?? profileName ?? null, JSON.stringify(rest));
            const ann = annotations[String(id)];
            if (ann) insertAnnotation.run(id, JSON.stringify(ann));
        }
        for (const [id, ts] of Object.entries(trash)) {
            insertTrash.run(parseInt(id), typeof ts === 'number' ? ts : Date.now());
        }

        const blocklist = readJson(JSON_FILES.blocklist, []);
        const insBlock  = db.prepare('INSERT OR IGNORE INTO blocklist (value) VALUES (?)');
        for (const v of blocklist) insBlock.run(String(v));

        const library = readJson(JSON_FILES.library, { beans: [], grinders: [], recipes: [], milks: [] });
        db.prepare("INSERT OR REPLACE INTO library (key, data) VALUES ('main', ?)").run(JSON.stringify(library));

        const maintenance = readJson(JSON_FILES.maintenance, {});
        for (const [key, val] of Object.entries(maintenance)) {
            db.prepare('INSERT OR REPLACE INTO maintenance (key, data) VALUES (?,?)').run(key, JSON.stringify(val));
        }

        const maintenanceLog = readJson(JSON_FILES.maintenanceLog, []);
        const insLog = db.prepare(
            'INSERT OR IGNORE INTO maintenance_log (id, ts, date, task, machine, shot_count, notes) VALUES (?,?,?,?,?,?,?)'
        );
        for (const e of maintenanceLog) {
            insLog.run(e.id, e.ts, e.date, e.task, e.machine ?? '', e.shotCountAtTime ?? 0, e.notes ?? '');
        }

        const orders = readJson(JSON_FILES.orders, []);
        const insOrder = db.prepare('INSERT OR REPLACE INTO orders (id, data) VALUES (?,?)');
        for (const o of orders) insOrder.run(o.id, JSON.stringify(o));

        const menu           = readJson(JSON_FILES.menu, null);
        const ordersSettings = readJson(JSON_FILES.ordersSettings, null);
        const notifyMapping  = readJson(JSON_FILES.notifyMapping, null);
        if (menu)           db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES ('menu', ?)").run(JSON.stringify(menu));
        if (ordersSettings) db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES ('orders_settings', ?)").run(JSON.stringify(ordersSettings));
        if (notifyMapping)  db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES ('notify_mapping', ?)").run(JSON.stringify(notifyMapping));

        db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES ('migrated', '\"1\"')").run();
    });

    try {
        migrateAll();
    } catch (e) {
        log(`Init error: ${e.message} — migration rolled back, will retry on next start`, true);
        return;
    }

    const shotCount = db.prepare('SELECT COUNT(*) AS n FROM shots').get().n;
    log(`DB: migration complete — ${shotCount} shots, ${Object.keys(annotations).length} annotations`);
}

module.exports = { getDb, initSchema };
