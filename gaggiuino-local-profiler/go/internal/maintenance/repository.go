package maintenance

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"sync/atomic"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/library"
)

// This file holds the maintenance/maintenance_log DB methods — kept in this
// package (not internal/library's) because the maintenance domain lives in
// its own package rather than alongside the library. See
// go/internal/library/doc.go for the matching note on the library side.

// globalMaintenanceMachineID is the sentinel machine_id waterfilter/grinder_*
// rows always live under (#338), since that equipment is shared across
// machines.
const globalMaintenanceMachineID = 1

// Repository wraps an already-open *sql.DB and the library Repository
// getMaintenance() needs to enumerate grinders (for the per-grinder
// maintenance rows getMaintenance() synthesizes).
type Repository struct {
	db      *sql.DB
	libRepo *library.Repository

	lastLogID atomic.Int64
}

// NewRepository wraps db and libRepo.
func NewRepository(db *sql.DB, libRepo *library.Repository) *Repository {
	return &Repository{db: db, libRepo: libRepo}
}

// GetMaintenance merges the maintenance defaults with whatever's actually
// stored for this machine (plus the shared global sentinel rows), then
// synthesizes one entry per currently-existing grinder.
func (r *Repository) GetMaintenance(machineID int64) (map[string]Task, error) {
	rows, err := r.db.Query(
		`SELECT key, data, machine_id FROM maintenance WHERE machine_id IN (?, ?)`,
		machineID, globalMaintenanceMachineID,
	)
	if err != nil {
		return nil, fmt.Errorf("maintenance: reading rows for machine %d: %w", machineID, err)
	}
	saved := map[string]Task{}
	func() {
		defer rows.Close()
		for rows.Next() {
			var key, data string
			var rowMachineID int64
			if err := rows.Scan(&key, &data, &rowMachineID); err != nil {
				continue
			}
			wantMachineID := machineID
			if isGlobalMaintenanceTask(key) {
				wantMachineID = globalMaintenanceMachineID
			}
			if rowMachineID != wantMachineID {
				continue
			}
			var t Task
			if err := json.Unmarshal([]byte(data), &t); err == nil {
				saved[key] = t
			}
		}
	}()
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("maintenance: scanning rows for machine %d: %w", machineID, err)
	}

	result := maintenanceDefaults()
	for key, defaults := range result {
		if s, ok := saved[key]; ok {
			merged := Task{}
			for k, v := range defaults {
				merged[k] = v
			}
			for k, v := range s {
				merged[k] = v
			}
			result[key] = merged
		}
	}

	lib, err := r.libRepo.GetLibrary()
	if err != nil {
		return nil, err
	}
	for _, g := range lib.Grinders {
		gid, ok := grinderIDOf(g)
		if !ok {
			continue
		}
		key := fmt.Sprintf("grinder_%d", gid)
		s := saved[key]
		thresholdShots := valueOrDefault(s, "threshold_shots", 200)
		if _, ok := s["threshold_shots"]; ok {
			thresholdShots = valueOrNil(s, "threshold_shots")
		}
		task := Task{
			"lastDate":        valueOrNil(s, "lastDate"),
			"threshold_shots": thresholdShots,
			"threshold_days":  valueOrDefault(s, "threshold_days", nil),
			"threshold_g":     valueOrDefault(s, "threshold_g", nil),
			"grinderName":     g["name"],
		}
		if d, ok := s["disabled"]; ok {
			task["disabled"] = d
		}
		result[key] = task
	}

	// Include any user-defined custom_* tasks stored in DB.
	for key, task := range saved {
		if isCustomTask(key) {
			result[key] = task
		}
	}
	return result, nil
}

// DeleteCustomTask removes a custom_* task row from the maintenance table.
func (r *Repository) DeleteCustomTask(machineID int64, key string) error {
	if _, err := r.db.Exec(
		`DELETE FROM maintenance WHERE machine_id = ? AND key = ?`, machineID, key,
	); err != nil {
		return fmt.Errorf("maintenance: deleting custom task %s: %w", key, err)
	}
	return nil
}

func valueOrNil(t Task, key string) any {
	if t == nil {
		return nil
	}
	if v, ok := t[key]; ok {
		return v
	}
	return nil
}

func valueOrDefault(t Task, key string, def any) any {
	if t == nil {
		return def
	}
	if v, ok := t[key]; ok {
		return v
	}
	return def
}

// SaveTask writes exactly one (machine_id, key) row, leaving every other row
// untouched, so it cannot clobber a concurrent edit to a *different* task.
// t carries only the keys this change sets and the stored row is the merge
// base (read for this one task, not the defaults-merged map), so
// GetMaintenance's defaults are never frozen into the DB as if the user had
// set them. Global tasks (waterfilter/grinder_*) route to the shared sentinel
// machine_id; the table's unique key is (machine_id, key), so the upsert
// targets it directly.
func (r *Repository) SaveTask(machineID int64, key string, t Task) error {
	target := machineID
	if isGlobalMaintenanceTask(key) {
		target = globalMaintenanceMachineID
	}
	base := Task{}
	var data string
	err := r.db.QueryRow(
		`SELECT data FROM maintenance WHERE machine_id = ? AND key = ?`, target, key,
	).Scan(&data)
	switch {
	case err == nil:
		_ = json.Unmarshal([]byte(data), &base)
	case errors.Is(err, sql.ErrNoRows):
		// No stored row yet: the change is the whole row.
	default:
		return fmt.Errorf("maintenance: reading stored task %s: %w", key, err)
	}
	for k, v := range t {
		base[k] = v
	}
	b, err := json.Marshal(base)
	if err != nil {
		return fmt.Errorf("maintenance: encoding task %s: %w", key, err)
	}
	if _, err := r.db.Exec(
		`INSERT INTO maintenance (machine_id, key, data) VALUES (?,?,?)
		 ON CONFLICT(machine_id, key) DO UPDATE SET data = excluded.data`,
		target, key, string(b),
	); err != nil {
		return fmt.Errorf("maintenance: saving task %s: %w", key, err)
	}
	return nil
}

// LogEntry mirrors one maintenance_log row, shaped for the JSON the
// maintenance log returns.
type LogEntry struct {
	ID              int64  `json:"id"`
	TS              int64  `json:"ts"`
	Date            string `json:"date"`
	Task            string `json:"task"`
	Machine         string `json:"machine"`
	MachineID       int64  `json:"machineId"`
	ShotCountAtTime int64  `json:"shotCountAtTime"`
	Notes           string `json:"notes"`
	GrinderName     string `json:"grinderName,omitempty"`
	Label           string `json:"label,omitempty"`
}

// GetMaintenanceLog returns the maintenance log: machineID == 0 means
// "every machine" (the optional-param convention), a positive value scopes
// to that one machine.
func (r *Repository) GetMaintenanceLog(machineID int64) ([]LogEntry, error) {
	// Resolve grinder names BEFORE opening the maintenance_log cursor
	// below, and keep it that way: a second query issued while an earlier
	// *sql.Rows is still open borrows a second pooled connection, and under
	// the pre-#956 single-connection pool that deadlocked outright (caught
	// live by handlers_test.go's TestTaskDone_MarksLastDateAndLogs
	// hanging). The pool is wider now, but nesting an unrelated query
	// inside an open cursor is still a connection-lifetime footgun worth
	// not reintroducing.
	lib, err := r.libRepo.GetLibrary()
	if err != nil {
		return nil, err
	}
	grinderNames := map[string]string{}
	for _, g := range lib.Grinders {
		if gid, ok := grinderIDOf(g); ok {
			if name, _ := g["name"].(string); name != "" {
				grinderNames[fmt.Sprintf("grinder_%d", gid)] = name
			}
		}
	}

	// Custom task labels — unlike grinder names (global equipment, keyed by
	// task alone), a custom_ task is defined per machine (customCreate saves
	// it under activeMachineID(r)), so two different machines' tasks can
	// share the same slugified key with different labels — the lookup key
	// must include machineID.
	customLabels := map[string]string{}
	rawTasks, err := r.GetAllMaintenanceRaw()
	if err != nil {
		return nil, err
	}
	for _, row := range rawTasks {
		if !isCustomTask(row.Key) {
			continue
		}
		var t Task
		if err := json.Unmarshal(row.Data, &t); err != nil {
			continue
		}
		if label, _ := t["label"].(string); label != "" {
			customLabels[fmt.Sprintf("%d:%s", row.MachineID, row.Key)] = label
		}
	}

	var rows *sql.Rows
	if machineID != 0 {
		rows, err = r.db.Query(
			`SELECT id, ts, date, task, machine, shot_count, notes, machine_id FROM maintenance_log WHERE machine_id = ? ORDER BY ts DESC`,
			machineID,
		)
	} else {
		rows, err = r.db.Query(
			`SELECT id, ts, date, task, machine, shot_count, notes, machine_id FROM maintenance_log ORDER BY ts DESC`,
		)
	}
	if err != nil {
		return nil, fmt.Errorf("maintenance: listing log: %w", err)
	}
	defer rows.Close()

	out := []LogEntry{}
	for rows.Next() {
		var e LogEntry
		var machine, notes sql.NullString
		if err := rows.Scan(&e.ID, &e.TS, &e.Date, &e.Task, &machine, &e.ShotCountAtTime, &notes, &e.MachineID); err != nil {
			return nil, fmt.Errorf("maintenance: scanning log row: %w", err)
		}
		e.Machine = machine.String
		e.Notes = notes.String
		if name, ok := grinderNames[e.Task]; ok {
			e.GrinderName = name
		}
		if label, ok := customLabels[fmt.Sprintf("%d:%s", e.MachineID, e.Task)]; ok {
			e.Label = label
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// AddMaintenanceLogEntry appends a log entry dated at `at` (ts/date come from
// it; callers logging "now" pass time.Now()). lastLogID is a monotonic-id
// guard (#578): the current millisecond alone collides when this is called
// more than once in the same millisecond. The id stays a now-based monotonic
// value regardless of `at`, so back-dating an entry never reorders the log.
func (r *Repository) AddMaintenanceLogEntry(task, notes, machine string, shotCount, machineID int64, at time.Time) (LogEntry, error) {
	now := time.Now()
	id := now.UnixMilli()
	for {
		prev := r.lastLogID.Load()
		if id <= prev {
			id = prev + 1
		}
		if r.lastLogID.CompareAndSwap(prev, id) {
			break
		}
	}
	entry := LogEntry{
		ID: id, TS: at.Unix(), Date: at.UTC().Format("2006-01-02"),
		Task: task, Machine: machine, ShotCountAtTime: shotCount, Notes: notes, MachineID: machineID,
	}
	if _, err := r.db.Exec(
		`INSERT INTO maintenance_log (id, ts, date, task, machine, shot_count, notes, machine_id) VALUES (?,?,?,?,?,?,?,?)`,
		entry.ID, entry.TS, entry.Date, entry.Task, entry.Machine, entry.ShotCountAtTime, entry.Notes, entry.MachineID,
	); err != nil {
		return LogEntry{}, fmt.Errorf("maintenance: inserting log entry: %w", err)
	}
	if _, err := r.db.Exec(
		`DELETE FROM maintenance_log WHERE id NOT IN (SELECT id FROM maintenance_log ORDER BY ts DESC LIMIT 500)`,
	); err != nil {
		return LogEntry{}, fmt.Errorf("maintenance: pruning log: %w", err)
	}
	return entry, nil
}

// DeleteMaintenanceLog removes a log entry by id and reports how many rows it
// deleted, so a caller can 404 on an unknown id without loading the whole log
// just to check existence.
func (r *Repository) DeleteMaintenanceLog(id int64) (int64, error) {
	res, err := r.db.Exec(`DELETE FROM maintenance_log WHERE id = ?`, id)
	if err != nil {
		return 0, fmt.Errorf("maintenance: deleting log entry %d: %w", id, err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("maintenance: deleting log entry %d: %w", id, err)
	}
	return n, nil
}

// DeleteGrinderTask removes a grinder's `grinder_{id}` row from the
// `maintenance` table — the cross-call internal/library's deleteGrinder
// handler makes via a callback (see handlers.go's WireLibraryGrinderDelete
// and go/internal/library's doc.go for why this is a callback, not a
// direct import: library -> maintenance would close an import cycle around
// maintenance's own existing dependency on library for grinder lookups).
func (r *Repository) DeleteGrinderTask(grinderID int64) error {
	key := fmt.Sprintf("grinder_%d", grinderID)
	if _, err := r.db.Exec(
		`DELETE FROM maintenance WHERE machine_id = ? AND key = ?`, globalMaintenanceMachineID, key,
	); err != nil {
		return fmt.Errorf("maintenance: deleting %s: %w", key, err)
	}
	return nil
}

// RawRow is the unfiltered maintenance-table row shape (no defaults merge),
// what a full backup export needs. Used by the backup domain (see
// go/internal/backup/doc.go); not called by this package's own handlers.
type RawRow struct {
	MachineID int64           `json:"machineId"`
	Key       string          `json:"key"`
	Data      json.RawMessage `json:"data"`
}

// GetAllMaintenanceRaw returns the unfiltered maintenance rows for backup.
func (r *Repository) GetAllMaintenanceRaw() ([]RawRow, error) {
	rows, err := r.db.Query(`SELECT machine_id, key, data FROM maintenance`)
	if err != nil {
		return nil, fmt.Errorf("maintenance: reading raw rows: %w", err)
	}
	defer rows.Close()
	out := []RawRow{}
	for rows.Next() {
		var row RawRow
		var data string
		if err := rows.Scan(&row.MachineID, &row.Key, &data); err != nil {
			return nil, fmt.Errorf("maintenance: scanning raw row: %w", err)
		}
		row.Data = json.RawMessage(data)
		out = append(out, row)
	}
	return out, rows.Err()
}

// RestoreMaintenanceRaw wipes and re-inserts the whole maintenance table.
func (r *Repository) RestoreMaintenanceRaw(rows []RawRow) error {
	tx, err := r.db.Begin()
	if err != nil {
		return fmt.Errorf("maintenance: starting restore tx: %w", err)
	}
	if _, err := tx.Exec(`DELETE FROM maintenance`); err != nil {
		tx.Rollback()
		return fmt.Errorf("maintenance: clearing table: %w", err)
	}
	stmt, err := tx.Prepare(`INSERT OR REPLACE INTO maintenance (machine_id, key, data) VALUES (?,?,?)`)
	if err != nil {
		tx.Rollback()
		return fmt.Errorf("maintenance: preparing restore: %w", err)
	}
	defer stmt.Close()
	for _, row := range rows {
		if _, err := stmt.Exec(row.MachineID, row.Key, string(row.Data)); err != nil {
			tx.Rollback()
			return fmt.Errorf("maintenance: restoring %s: %w", row.Key, err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("maintenance: committing restore: %w", err)
	}
	return nil
}

// RawLogRow is the unfiltered maintenance_log row shape — a true round-trip
// (preserves id/ts exactly), unlike AddMaintenanceLogEntry's live-logging
// path which mints new ones.
type RawLogRow struct {
	ID        int64  `json:"id"`
	TS        int64  `json:"ts"`
	Date      string `json:"date"`
	Task      string `json:"task"`
	Machine   string `json:"machine"`
	ShotCount int64  `json:"shotCount"`
	Notes     string `json:"notes"`
	MachineID int64  `json:"machineId"`
}

// GetAllMaintenanceLogRaw returns the unfiltered maintenance-log rows for backup.
func (r *Repository) GetAllMaintenanceLogRaw() ([]RawLogRow, error) {
	rows, err := r.db.Query(`SELECT id, ts, date, task, machine, shot_count, notes, machine_id FROM maintenance_log`)
	if err != nil {
		return nil, fmt.Errorf("maintenance: reading raw log rows: %w", err)
	}
	defer rows.Close()
	out := []RawLogRow{}
	for rows.Next() {
		var row RawLogRow
		var machine, notes sql.NullString
		if err := rows.Scan(&row.ID, &row.TS, &row.Date, &row.Task, &machine, &row.ShotCount, &notes, &row.MachineID); err != nil {
			return nil, fmt.Errorf("maintenance: scanning raw log row: %w", err)
		}
		row.Machine = machine.String
		row.Notes = notes.String
		out = append(out, row)
	}
	return out, rows.Err()
}

// RestoreMaintenanceLogRaw wipes and re-inserts the log, preserving id/ts.
func (r *Repository) RestoreMaintenanceLogRaw(rows []RawLogRow) error {
	tx, err := r.db.Begin()
	if err != nil {
		return fmt.Errorf("maintenance: starting log restore tx: %w", err)
	}
	if _, err := tx.Exec(`DELETE FROM maintenance_log`); err != nil {
		tx.Rollback()
		return fmt.Errorf("maintenance: clearing log table: %w", err)
	}
	stmt, err := tx.Prepare(
		`INSERT OR REPLACE INTO maintenance_log (id, ts, date, task, machine, shot_count, notes, machine_id) VALUES (?,?,?,?,?,?,?,?)`,
	)
	if err != nil {
		tx.Rollback()
		return fmt.Errorf("maintenance: preparing log restore: %w", err)
	}
	defer stmt.Close()
	for _, row := range rows {
		if _, err := stmt.Exec(row.ID, row.TS, row.Date, row.Task, row.Machine, row.ShotCount, row.Notes, row.MachineID); err != nil {
			tx.Rollback()
			return fmt.Errorf("maintenance: restoring log entry %d: %w", row.ID, err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("maintenance: committing log restore: %w", err)
	}
	return nil
}
