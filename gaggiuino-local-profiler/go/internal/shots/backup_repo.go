package shots

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"strconv"
)

// This file holds the three ShotRepository methods the backup domain's
// streaming export/import (#959) needs: a batched, keyset-scanned iterator
// that never materialises the whole shots table, a lightweight trash
// id->timestamp map, and RestoreShots — the single-transaction structured
// shots restore (wipe + upserts + annotations + trash + blocklist +
// library) that replaces backup.applyRestore's WipeAll + per-shot Upsert
// loop.

// backupShotBatch is ForEachShotForBackup's default page size — how many
// hydrated shots the keyset scan pulls per round trip. Small enough that a
// page's worth of hydrated shots is a bounded allocation regardless of
// history size, large enough that the per-query overhead stays negligible.
const backupShotBatch = 200

// ForEachShotForBackup streams every shot (trashed ones included, matching
// FindAll's scope) to fn one hydrated Shot at a time, in the same
// timestamp-ASC, id-ASC order FindAll returns — so the exported file's shot
// order is unchanged. It keyset-paginates (WHERE (timestamp > ?) OR
// (timestamp = ? AND id > ?) LIMIT batch) instead of one unbounded query,
// so peak retention is one page, not the whole table with every
// datapoints blob resident (#959). idx_shots_ts_id serves the scan.
func (r *Repository) ForEachShotForBackup(batch int, fn func(Shot) error) error {
	if batch <= 0 {
		batch = backupShotBatch
	}
	var lastTS, lastID int64
	first := true
	for {
		var (
			rows *sql.Rows
			err  error
		)
		if first {
			rows, err = r.db.Query(selectBase+` ORDER BY s.timestamp ASC, s.id ASC LIMIT ?`, batch)
		} else {
			rows, err = r.db.Query(
				selectBase+` WHERE (s.timestamp > ?) OR (s.timestamp = ? AND s.id > ?) ORDER BY s.timestamp ASC, s.id ASC LIMIT ?`,
				lastTS, lastTS, lastID, batch,
			)
		}
		if err != nil {
			return fmt.Errorf("shots: paging shots for backup: %w", err)
		}

		n := 0
		for rows.Next() {
			shot, err := hydrateRow(rows)
			if err != nil {
				rows.Close()
				return err
			}
			lastTS, _ = shot["timestamp"].(int64)
			lastID = shot.id()
			n++
			if err := fn(shot); err != nil {
				rows.Close()
				return err
			}
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return err
		}
		rows.Close()

		first = false
		if n < batch {
			return nil
		}
	}
}

// TrashMap ports the export path's trash id->deleted_at collection without
// FindTrashed's full per-row hydration: SELECT ... FROM trash JOIN shots
// keeps FindTrashed's "only entries whose shot row still exists" semantics
// while reading two integer columns instead of every trashed shot's blob.
// Keys are the decimal shot id (the backup bundle's `trash` object keys).
func (r *Repository) TrashMap() (map[string]int64, error) {
	rows, err := r.db.Query(`SELECT t.shot_id, t.deleted_at FROM trash t JOIN shots s ON s.id = t.shot_id`)
	if err != nil {
		return nil, fmt.Errorf("shots: reading trash map: %w", err)
	}
	defer rows.Close()

	out := map[string]int64{}
	for rows.Next() {
		var id, deletedAt int64
		if err := rows.Scan(&id, &deletedAt); err != nil {
			return nil, fmt.Errorf("shots: scanning trash map row: %w", err)
		}
		out[strconv.FormatInt(id, 10)] = deletedAt
	}
	return out, rows.Err()
}

// RestoreInput is everything RestoreShots writes in one transaction. Every
// field is pre-validated/pre-resolved by the caller (internal/backup):
// Annotations holds already-schema-checked annotation objects keyed by
// decimal shot id; Trash holds resolved deleted_at millis keyed the same
// way (filtered here to ids that were actually restored); LibraryJSON is
// the marshalled library.Library blob (nil = do not touch the library).
type RestoreInput struct {
	Shots       func(yield func(Shot) error) error
	Annotations map[string]map[string]any
	Trash       map[string]int64
	Blocklist   []string
	LibraryJSON []byte
}

// RestoreShots is the Option B-lite transactional structured restore
// (#959): wipe + every shot upsert + annotations + trash + blocklist +
// library-save all commit as ONE *sql.Tx, so a failure part-way through
// the shots section rolls the whole section back and leaves the
// pre-restore shots intact — the "thousands of un-transacted single-row
// INSERTs" and "half-applied shots table" problems backup.applyRestore
// had. Orders/maintenance/machines/kv restore stay their own txs (each
// already atomic on its own); cross-section atomicity is still not
// Node-identical — see internal/backup/restore.go's header.
func (r *Repository) RestoreShots(in RestoreInput) error {
	tx, err := r.db.Begin()
	if err != nil {
		return fmt.Errorf("shots: starting restore tx: %w", err)
	}
	defer func() {
		if tx != nil {
			tx.Rollback()
		}
	}()

	for _, stmt := range []string{
		`DELETE FROM annotations`, `DELETE FROM trash`,
		`DELETE FROM shot_score_cache`, `DELETE FROM shots`,
	} {
		if _, err := tx.Exec(stmt); err != nil {
			return fmt.Errorf("shots: restore wipe (%s): %w", stmt, err)
		}
	}

	shotStmt, err := tx.Prepare(
		`INSERT OR REPLACE INTO shots (id, timestamp, duration, profile_name, data, machine_id) VALUES (?,?,?,?,?,?)`,
	)
	if err != nil {
		return fmt.Errorf("shots: preparing restore insert: %w", err)
	}
	defer shotStmt.Close()
	annStmt, err := tx.Prepare(`INSERT OR REPLACE INTO annotations (shot_id, data) VALUES (?, ?)`)
	if err != nil {
		return fmt.Errorf("shots: preparing restore annotation insert: %w", err)
	}
	defer annStmt.Close()

	restored := map[int64]bool{}
	if in.Shots != nil {
		err = in.Shots(func(s Shot) error {
			row, err := shotInsertArgs(s)
			if err != nil {
				return err
			}
			if _, err := shotStmt.Exec(row.id, row.timestamp, row.duration, row.profileName, row.data, row.machineID); err != nil {
				return fmt.Errorf("shots: restoring shot %d: %w", row.id, err)
			}
			restored[row.id] = true
			if ann, ok := s["annotation"]; ok {
				annMap, _ := ann.(map[string]any)
				if annMap == nil {
					annMap = map[string]any{}
				}
				b, err := json.Marshal(annMap)
				if err != nil {
					return fmt.Errorf("shots: encoding restored annotation for shot %d: %w", row.id, err)
				}
				if _, err := annStmt.Exec(row.id, string(b)); err != nil {
					return fmt.Errorf("shots: restoring annotation for shot %d: %w", row.id, err)
				}
			}
			return nil
		})
		if err != nil {
			return err
		}
	}

	for idStr, m := range in.Annotations {
		id, err := strconv.ParseInt(idStr, 10, 64)
		if err != nil {
			continue
		}
		b, err := json.Marshal(m)
		if err != nil {
			return fmt.Errorf("shots: encoding restored annotation %s: %w", idStr, err)
		}
		if _, err := annStmt.Exec(id, string(b)); err != nil {
			return fmt.Errorf("shots: restoring annotation %s: %w", idStr, err)
		}
	}

	trashStmt, err := tx.Prepare(`INSERT OR REPLACE INTO trash (shot_id, deleted_at) VALUES (?, ?)`)
	if err != nil {
		return fmt.Errorf("shots: preparing restore trash insert: %w", err)
	}
	defer trashStmt.Close()
	for idStr, deletedAt := range in.Trash {
		id, err := strconv.ParseInt(idStr, 10, 64)
		if err != nil || !restored[id] {
			continue
		}
		if _, err := trashStmt.Exec(id, deletedAt); err != nil {
			return fmt.Errorf("shots: restoring trash entry %s: %w", idStr, err)
		}
	}

	if in.Blocklist != nil {
		if _, err := tx.Exec(`DELETE FROM blocklist`); err != nil {
			return fmt.Errorf("shots: clearing blocklist: %w", err)
		}
		blkStmt, err := tx.Prepare(`INSERT INTO blocklist (value) VALUES (?)`)
		if err != nil {
			return fmt.Errorf("shots: preparing blocklist insert: %w", err)
		}
		defer blkStmt.Close()
		for _, v := range in.Blocklist {
			if _, err := blkStmt.Exec(v); err != nil {
				return fmt.Errorf("shots: restoring blocklist entry %q: %w", v, err)
			}
		}
	}

	if in.LibraryJSON != nil {
		if _, err := tx.Exec(
			`INSERT OR REPLACE INTO library (key, data) VALUES ('main', ?)`, string(in.LibraryJSON),
		); err != nil {
			return fmt.Errorf("shots: restoring library: %w", err)
		}
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("shots: committing restore: %w", err)
	}
	tx = nil
	return nil
}
