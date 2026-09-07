package achievements

import (
	"database/sql"
	"fmt"
)

// This file ports lib/repositories/AchievementRepository.js: deliberately
// thin persistence for the `achievements` table (created by
// internal/db/db.go — no schema work here). The badge conditions live in
// registry.go; this only reads/writes the (id, unlocked_at, progress) rows
// the evaluator decides on.

// Repository wraps the shared *sql.DB (internal/db.Open).
type Repository struct {
	db *sql.DB
}

// NewRepository wraps an already-open *sql.DB.
func NewRepository(db *sql.DB) *Repository {
	return &Repository{db: db}
}

// Row mirrors AchievementRepository.getAll()'s per-id value: {id,
// unlockedAt, progress}. UnlockedAt/Progress are pointers so "column is
// NULL" is distinct from 0.
type Row struct {
	ID         string
	UnlockedAt *int64
	Progress   *int64
}

// GetAll ports getAll(): id -> Row for every row ever written. An id with
// no row is simply absent from the map (callers treat that as locked/0).
func (r *Repository) GetAll() (map[string]Row, error) {
	rows, err := r.db.Query(`SELECT id, unlocked_at, progress FROM achievements`)
	if err != nil {
		return nil, fmt.Errorf("achievements: listing rows: %w", err)
	}
	defer rows.Close()

	out := map[string]Row{}
	for rows.Next() {
		var id string
		var unlockedAt, progress sql.NullInt64
		if err := rows.Scan(&id, &unlockedAt, &progress); err != nil {
			return nil, fmt.Errorf("achievements: scanning row: %w", err)
		}
		row := Row{ID: id}
		if unlockedAt.Valid {
			v := unlockedAt.Int64
			row.UnlockedAt = &v
		}
		if progress.Valid {
			v := progress.Int64
			row.Progress = &v
		}
		out[id] = row
	}
	return out, rows.Err()
}

// ChangeFingerprint is a cheap digest of the tables buildContext's context
// snapshot reads (shots/annotations/trash/orders/library/kv/maintenance/
// machines). It is built only from COUNT / MAX / SUM(LENGTH) aggregates, so
// it never reads a shot's datapoints blob — the whole point is that
// Service.GetState can call this on every GET /api/achievements and only
// pay the ~200ms full-context scan (evaluateAll -> buildContext ->
// FindAllExcludingTrash over every datapoints blob + per-shot scoring) when
// the digest actually changed since the last pass. lib/db.js's Node
// counterpart gets "evaluate on change, not on every read" for free from
// its event bus; this port has none (see doc.go), so it derives the same
// signal from the data. #956.
func (r *Repository) ChangeFingerprint() (string, error) {
	var (
		shotCount, shotMaxID, shotMaxTS int64
		trashCount                      int64
		annCount, annBytes              int64
		orderCount, orderBytes          int64
		libBytes, kvBytes               int64
		maintLogCount, maintBytes       int64
		machineCount, machineBytes      int64
	)
	err := r.db.QueryRow(`
		SELECT
			(SELECT COUNT(*) FROM shots),
			(SELECT COALESCE(MAX(id), 0) FROM shots),
			(SELECT COALESCE(MAX(timestamp), 0) FROM shots),
			(SELECT COUNT(*) FROM trash),
			(SELECT COUNT(*) FROM annotations),
			(SELECT COALESCE(SUM(LENGTH(data)), 0) FROM annotations),
			(SELECT COUNT(*) FROM orders),
			(SELECT COALESCE(SUM(LENGTH(data)), 0) FROM orders),
			(SELECT COALESCE(SUM(LENGTH(data)), 0) FROM library),
			(SELECT COALESCE(SUM(LENGTH(value)), 0) FROM kv),
			(SELECT COUNT(*) FROM maintenance_log),
			(SELECT COALESCE(SUM(LENGTH(data)), 0) FROM maintenance),
			(SELECT COUNT(*) FROM machines),
			(SELECT COALESCE(SUM(LENGTH(COALESCE(theme, ''))), 0) FROM machines)
	`).Scan(
		&shotCount, &shotMaxID, &shotMaxTS,
		&trashCount,
		&annCount, &annBytes,
		&orderCount, &orderBytes,
		&libBytes, &kvBytes,
		&maintLogCount, &maintBytes,
		&machineCount, &machineBytes,
	)
	if err != nil {
		return "", fmt.Errorf("achievements: building change fingerprint: %w", err)
	}
	return fmt.Sprintf("s%d.%d.%d t%d a%d.%d o%d.%d l%d k%d m%d.%d M%d.%d",
		shotCount, shotMaxID, shotMaxTS,
		trashCount,
		annCount, annBytes,
		orderCount, orderBytes,
		libBytes, kvBytes,
		maintLogCount, maintBytes,
		machineCount, machineBytes,
	), nil
}

// Unlock ports unlock(id, unlockedAt, progress): idempotent via INSERT OR
// IGNORE — a badge already unlocked keeps its original unlocked_at forever,
// even if evaluateAll runs again.
func (r *Repository) Unlock(id string, unlockedAt int64, progress *int64) error {
	var prog any
	if progress != nil {
		prog = *progress
	}
	_, err := r.db.Exec(
		`INSERT OR IGNORE INTO achievements (id, unlocked_at, progress) VALUES (?, ?, ?)`,
		id, unlockedAt, prog,
	)
	if err != nil {
		return fmt.Errorf("achievements: unlocking %q: %w", id, err)
	}
	return nil
}

// SetProgress ports setProgress(id, progress): updates progress on a
// still-locked badge, never touching unlocked_at (the WHERE clause makes an
// already-unlocked row a no-op).
func (r *Repository) SetProgress(id string, progress int64) error {
	_, err := r.db.Exec(
		`INSERT INTO achievements (id, unlocked_at, progress) VALUES (?, NULL, ?)
		 ON CONFLICT(id) DO UPDATE SET progress = excluded.progress
		 WHERE achievements.unlocked_at IS NULL`,
		id, progress,
	)
	if err != nil {
		return fmt.Errorf("achievements: setting progress for %q: %w", id, err)
	}
	return nil
}
