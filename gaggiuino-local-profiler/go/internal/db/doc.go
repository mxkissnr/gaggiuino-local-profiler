// Package db is the SQLite data-access layer, built on modernc.org/sqlite
// (pure Go, no CGo). Open brings a database at a given path (DefaultPath for
// the real /data/glp.db) to the current schema and runs the additive
// migrations needed on every start: InitSchema, FixSchema,
// MigrateMachineColumns, MigrateMachineTheme, EnsureInstallID. The legacy
// flat-JSON-to-SQLite migration is deliberately NOT implemented — every
// install this binary can run against is already on SQLite.
//
// database/sql pools connections, which would make SQLite pragmas
// (journal_mode, foreign_keys, busy_timeout, synchronous) apply
// inconsistently depending on which connection later runs a query; Open
// sets them through the connection DSN instead (modernc.org/sqlite's
// `_pragma=` query parameters, applied to every physical connection it
// opens). The pool then runs concurrent WAL readers so a slow full scan on
// one connection no longer head-of-line-blocks every other HTTP request
// (#956); schema creation and migrations still run on a single connection
// before the pool opens up.
//
// Schema fidelity is enforced by db_schema_test.go, which compares this
// package's schema (column names, types, NOT NULL, defaults, primary-key
// position, and named indexes) against testdata/node_schema.json — a fixture
// frozen from the pre-port baseline (archived at tag
// archive/node-backend-final), captured by running the original
// initSchema()/migrateMachineColumns()/migrateMachineTheme()/ensureInstallID()
// against a live better-sqlite3 database. That schema code is gone, so the
// fixture is now the canonical reference; a deliberate schema change here
// that diverges from it is applied by editing the fixture to match.
package db
