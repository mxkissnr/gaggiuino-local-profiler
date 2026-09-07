#!/usr/bin/env node
// Generates go/internal/db/testdata/node_schema.json, the reference fixture
// db_schema_test.go compares the Go schema against.
//
// Run from the repo root with the real lib/db.js (never re-implemented
// here) driving a real better-sqlite3 database, so the fixture reflects
// exactly what a fresh install running the Node app ends up with on disk —
// not a hand-transcribed guess at its schema. Only the flat-JSON migration
// (migrate() against JSON_FILES) is skipped, matching Go's Open(), which
// deliberately never ports it (see go/internal/db/db.go's doc comment).
//
// Usage: node go/internal/db/testdata/gen_node_schema.js
//   (regenerate after any lib/db.js schema change; go test ./... then
//   verifies the Go port still matches)
'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const Database = require('better-sqlite3');
const { initSchema, migrateMachineColumns, migrateMachineTheme, ensureInstallId } = require('../../../../lib/db');

const tmpPath = path.join(os.tmpdir(), `glp-fixture-${Date.now()}-${process.pid}.db`);
const db = new Database(tmpPath);
db.pragma('journal_mode = WAL');

// Same sequence as lib/db.js's getDb(), minus fixSchema() (no-op on a fresh
// DB — it only ever fires against a legacy INTEGER-PK orders table, which a
// fresh initSchema() never creates) and minus migrate() (see header above).
initSchema(db);
migrateMachineColumns(db, tmpPath);
migrateMachineTheme(db);
ensureInstallId(db);

const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
    .all();

const result = { tables: {}, indexes: [] };
for (const { name } of tables) {
    const cols = db.prepare(`PRAGMA table_info('${name}')`).all();
    result.tables[name] = cols.map((c) => ({
        name: c.name,
        type: c.type,
        notnull: c.notnull,
        dflt_value: c.dflt_value,
        pk: c.pk,
    }));
}

const indexes = db
    .prepare(`SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY name`)
    .all();
result.indexes = indexes.map((i) => ({ name: i.name, table: i.tbl_name }));

const outPath = path.join(__dirname, 'node_schema.json');
fs.writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n');

db.close();
fs.unlinkSync(tmpPath);
for (const suffix of ['-wal', '-shm']) {
    try { fs.unlinkSync(tmpPath + suffix); } catch { /* not present */ }
}

console.log(`Wrote ${outPath}`);
