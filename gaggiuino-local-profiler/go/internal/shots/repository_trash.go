package shots

import (
	"database/sql"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// MoveToTrash inserts a trash entry stamped with the current time.
func (r *Repository) MoveToTrash(shotID int64) error {
	if _, err := r.db.Exec(`INSERT OR REPLACE INTO trash (shot_id, deleted_at) VALUES (?, ?)`, shotID, time.Now().UnixMilli()); err != nil {
		return fmt.Errorf("shots: trashing shot %d: %w", shotID, err)
	}
	return nil
}

// RestoreFromTrash deletes the shot's trash entry — no existence check.
func (r *Repository) RestoreFromTrash(shotID int64) error {
	if _, err := r.db.Exec(`DELETE FROM trash WHERE shot_id = ?`, shotID); err != nil {
		return fmt.Errorf("shots: restoring shot %d: %w", shotID, err)
	}
	return nil
}

// DeleteByID deletes annotations, then trash, then the shot row itself, inside
// one transaction. It deliberately leaves the blocklist alone — the demo
// cleanup in internal/system/demo.go relies on that; the user-facing delete
// path uses DeleteAndBlocklist instead.
func (r *Repository) DeleteByID(shotID int64) error {
	tx, err := r.db.Begin()
	if err != nil {
		return fmt.Errorf("shots: starting delete tx for shot %d: %w", shotID, err)
	}
	if err := deleteShotTx(tx, shotID); err != nil {
		tx.Rollback()
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("shots: committing delete of shot %d: %w", shotID, err)
	}
	return nil
}

// deleteShotTx drops a shot's annotation, trash entry, shot row and score
// cache in the statement order DeleteByID has always used. It runs inside the
// caller's transaction so a plain delete and a delete-and-blocklist share one
// code path; the caller owns the commit/rollback.
func deleteShotTx(tx *sql.Tx, shotID int64) error {
	if _, err := tx.Exec(`DELETE FROM annotations WHERE shot_id = ?`, shotID); err != nil {
		return fmt.Errorf("shots: deleting annotation for shot %d: %w", shotID, err)
	}
	if _, err := tx.Exec(`DELETE FROM trash WHERE shot_id = ?`, shotID); err != nil {
		return fmt.Errorf("shots: deleting trash entry for shot %d: %w", shotID, err)
	}
	if _, err := tx.Exec(`DELETE FROM shots WHERE id = ?`, shotID); err != nil {
		return fmt.Errorf("shots: deleting shot %d: %w", shotID, err)
	}
	if _, err := tx.Exec(`DELETE FROM shot_score_cache WHERE shot_id = ?`, shotID); err != nil {
		return fmt.Errorf("shots: deleting score cache for shot %d: %w", shotID, err)
	}
	return nil
}

// DeleteAndBlocklist permanently deletes the shot (annotation, trash entry,
// score cache and row) and adds its id to the blocklist in ONE transaction, so
// a machine sync running against the same DB can never observe the in-between
// state — shot gone, blocklist not yet written — and re-import it from the
// machine, and a failed blocklist write never reports success for a half-done
// delete (#1609). DeleteByID stays blocklist-free on purpose (demo cleanup).
func (r *Repository) DeleteAndBlocklist(shotID int64) error {
	tx, err := r.db.Begin()
	if err != nil {
		return fmt.Errorf("shots: starting delete tx for shot %d: %w", shotID, err)
	}
	if err := deleteShotTx(tx, shotID); err != nil {
		tx.Rollback()
		return err
	}
	if _, err := tx.Exec(`INSERT OR IGNORE INTO blocklist (value) VALUES (?)`, strconv.FormatInt(shotID, 10)); err != nil {
		tx.Rollback()
		return fmt.Errorf("shots: blocklisting deleted shot %d: %w", shotID, err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("shots: committing delete of shot %d: %w", shotID, err)
	}
	return nil
}

// MoveMisfiledShot (#1162) re-keys a shot the old default-machine sync
// filed under machine 1 with its native id to toMachineID's global id.
// Before #1162 the default path ran backfillShots(1, ...) and kept each
// shot's reported native id as shot["id"], so a Gaggiuino set as the
// default machine whose id is not 1 had its whole history stored as machine
// 1's shots, mixing the two machines' histories and letting their ids
// collide. syncDefaultMachineShots now scopes to the default machine's own
// id range; when it re-imports a shot whose native id still exists locally
// as a machine-1 row with the same timestamp, that row is the misfiled copy
// and this method moves it to its correct global id instead of leaving a
// duplicate behind.
//
// nativeID and timestamp identify the misfiled row: a machine-1 row with
// id == nativeID but a different timestamp is one of machine 1's own shots
// and is deliberately left untouched. The move runs in one transaction and
// must insert the copy before re-keying the children: annotations.shot_id
// REFERENCES shots(id) ON DELETE CASCADE with foreign_keys=ON, so updating
// the annotation's shot_id while the copy exists satisfies the FK, and
// deleting the old row afterwards cascades to nothing.
//
// Deliberately out of scope for #1162: other stores that reference shot ids
// inside JSON blobs (orders, achievements) are NOT re-keyed here. The shot's
// photo files (shot-<id>.<ext> plus its thumbnail) are handled separately by
// the caller: the moved row still carries its image key, and the sync path
// reads it back with ImageExtFor and renames the files with MoveShotImageFiles.
func (r *Repository) MoveMisfiledShot(nativeID, timestamp, toMachineID int64) (moved bool, err error) {
	if toMachineID == 1 {
		return false, nil
	}
	newID := ToGlobalShotID(toMachineID, nativeID)

	tx, err := r.db.Begin()
	if err != nil {
		return false, fmt.Errorf("shots: starting move tx for shot %d -> %d: %w", nativeID, newID, err)
	}

	var taken int
	switch err := tx.QueryRow(`SELECT 1 FROM shots WHERE id = ?`, newID).Scan(&taken); err {
	case nil:
		// Target id already taken — never clobber it.
		tx.Rollback()
		return false, nil
	case sql.ErrNoRows:
		// Free to move onto it.
	default:
		tx.Rollback()
		return false, fmt.Errorf("shots: checking target id %d: %w", newID, err)
	}

	res, err := tx.Exec(
		`INSERT INTO shots (id, timestamp, duration, profile_name, data, machine_id) `+
			`SELECT ?, timestamp, duration, profile_name, data, ? FROM shots WHERE id = ? AND machine_id = 1 AND timestamp = ?`,
		newID, toMachineID, nativeID, timestamp,
	)
	if err != nil {
		tx.Rollback()
		return false, fmt.Errorf("shots: copying misfiled shot %d to %d: %w", nativeID, newID, err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		tx.Rollback()
		return false, fmt.Errorf("shots: copying misfiled shot %d to %d: %w", nativeID, newID, err)
	}
	if n == 0 {
		// No misfiled copy: the row is gone or its timestamp differs (one of
		// machine 1's own shots), so there is nothing to move.
		tx.Rollback()
		return false, nil
	}

	if _, err := tx.Exec(`UPDATE annotations SET shot_id = ? WHERE shot_id = ?`, newID, nativeID); err != nil {
		tx.Rollback()
		return false, fmt.Errorf("shots: re-keying annotation for shot %d -> %d: %w", nativeID, newID, err)
	}
	if _, err := tx.Exec(`UPDATE trash SET shot_id = ? WHERE shot_id = ?`, newID, nativeID); err != nil {
		tx.Rollback()
		return false, fmt.Errorf("shots: re-keying trash entry for shot %d -> %d: %w", nativeID, newID, err)
	}
	if _, err := tx.Exec(`DELETE FROM shot_score_cache WHERE shot_id = ?`, nativeID); err != nil {
		tx.Rollback()
		return false, fmt.Errorf("shots: clearing score cache for shot %d: %w", nativeID, err)
	}
	if _, err := tx.Exec(`DELETE FROM shots WHERE id = ? AND machine_id = 1`, nativeID); err != nil {
		tx.Rollback()
		return false, fmt.Errorf("shots: deleting misfiled shot %d: %w", nativeID, err)
	}
	if err := tx.Commit(); err != nil {
		return false, fmt.Errorf("shots: committing move of shot %d -> %d: %w", nativeID, newID, err)
	}
	return true, nil
}

// trashTTL is the 30-day trash retention period (the purge cutoff is
// `deleted_at < now - 30d`). A named constant so the cutoff arithmetic and its
// tests share one source of truth.
const trashTTL = 30 * 24 * time.Hour

// PurgedShot is one shot permanently removed by PurgeExpiredTrash: its id and
// the `image` extension its JSON blob stored ("" when it had no photo), so the
// caller can remove the photo file alongside the row (#1525).
type PurgedShot struct {
	ID  int64
	Ext string
}

// PurgeExpiredTrash permanently drops every trash entry older than trashTTL,
// together with its shot row and annotation, in one transaction (#1152).
// deleted_at is in milliseconds (MoveToTrash stamps time.Now().UnixMilli), so
// the cutoff is a strict `<` against now's epoch-millis minus trashTTL.
//
// The candidate SELECT runs inside that same transaction and each row's trash
// entry is then deleted conditionally, in the same transaction, before its
// shot is purged (#1609): a shot the user restored (RestoreFromTrash removed
// its trash row) after the SELECT no longer matches the conditional DELETE, so
// it affects 0 rows and the shot is skipped instead of being purged and
// blocklisted out from under the restore.
//
// Each purged id is deliberately blocklisted (#1159) so the next sync does not
// resume below it and re-import the shot from the machine. Image files are not
// deleted here — the caller (internal/shots' Service.PurgeExpiredTrash) uses
// the returned extension to delete each photo and its thumbnail, since this
// package has no image directory. shot_score_cache is likewise cleared
// (deleteShotTx does this, and a purge would otherwise leave orphaned cache
// rows behind).
func (r *Repository) PurgeExpiredTrash(now time.Time) ([]PurgedShot, error) {
	cutoff := now.UnixMilli() - trashTTL.Milliseconds()

	tx, err := r.db.Begin()
	if err != nil {
		return nil, fmt.Errorf("shots: starting trash purge tx: %w", err)
	}
	// LEFT JOIN so a trash entry whose shot row already vanished is still
	// purged (and blocklisted) exactly as before; its image extension is then
	// simply absent. Read every candidate into a slice and close rows before
	// the deletes below: the cursor and the writes share one connection, so
	// running them while it is open would deadlock SQLite.
	rows, err := tx.Query(
		`SELECT t.shot_id, json_extract(s.data, '$.image') FROM trash t LEFT JOIN shots s ON s.id = t.shot_id WHERE t.deleted_at < ?`,
		cutoff,
	)
	if err != nil {
		tx.Rollback()
		return nil, fmt.Errorf("shots: listing expired trash: %w", err)
	}
	var candidates []PurgedShot
	for rows.Next() {
		var (
			p   PurgedShot
			ext sql.NullString
		)
		if err := rows.Scan(&p.ID, &ext); err != nil {
			rows.Close()
			tx.Rollback()
			return nil, fmt.Errorf("shots: scanning expired trash row: %w", err)
		}
		if ext.Valid {
			p.Ext = ext.String
		}
		candidates = append(candidates, p)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		tx.Rollback()
		return nil, fmt.Errorf("shots: listing expired trash: %w", err)
	}

	var purged []PurgedShot
	for _, p := range candidates {
		// Conditional delete first: a shot restored after the SELECT above has
		// no trash row left, so this affects 0 rows and the purge skips it.
		res, err := tx.Exec(`DELETE FROM trash WHERE shot_id = ? AND deleted_at < ?`, p.ID, cutoff)
		if err != nil {
			tx.Rollback()
			return nil, fmt.Errorf("shots: purging trash entry for shot %d: %w", p.ID, err)
		}
		n, err := res.RowsAffected()
		if err != nil {
			tx.Rollback()
			return nil, fmt.Errorf("shots: purging trash entry for shot %d: %w", p.ID, err)
		}
		if n == 0 {
			continue
		}
		if err := deleteShotTx(tx, p.ID); err != nil {
			tx.Rollback()
			return nil, fmt.Errorf("shots: purging shot %d: %w", p.ID, err)
		}
		// Blocklist the id so a later sync does not resume below it and
		// re-import the shot (same statement as AppendToBlocklist;
		// blocklist.value is UNIQUE).
		if _, err := tx.Exec(`INSERT OR IGNORE INTO blocklist (value) VALUES (?)`, strconv.FormatInt(p.ID, 10)); err != nil {
			tx.Rollback()
			return nil, fmt.Errorf("shots: blocklisting purged shot %d: %w", p.ID, err)
		}
		purged = append(purged, p)
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("shots: committing trash purge: %w", err)
	}
	return purged, nil
}

// GetBlocklist returns the blocklist entries.
func (r *Repository) GetBlocklist() ([]string, error) {
	rows, err := r.db.Query(`SELECT value FROM blocklist`)
	if err != nil {
		return nil, fmt.Errorf("shots: listing blocklist: %w", err)
	}
	defer rows.Close()

	var out []string
	for rows.Next() {
		var v string
		if err := rows.Scan(&v); err != nil {
			return nil, fmt.Errorf("shots: scanning blocklist entry: %w", err)
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// AppendToBlocklist atomically adds a single value to the blocklist. Its
// callers run concurrently (today the sync path, internal/system/sync.go):
// a read-then-replace round trip (GetBlocklist, append locally, write the
// whole list back) lets two overlapping callers each write a snapshot taken
// before the other's insert, so the second write silently drops the first
// caller's id (#901). blocklist.value has a UNIQUE constraint (see
// internal/db/db.go), so INSERT OR IGNORE is a single atomic statement with no
// read step and therefore no lost-update window. The user-facing delete
// handler no longer needs this: it blocklists inside the same transaction that
// deletes the shot (#1609, Repository.DeleteAndBlocklist).
func (r *Repository) AppendToBlocklist(value string) error {
	if _, err := r.db.Exec(`INSERT OR IGNORE INTO blocklist (value) VALUES (?)`, value); err != nil {
		return fmt.Errorf("shots: appending blocklist entry %q: %w", value, err)
	}
	return nil
}

// RemoveFromBlocklist atomically removes the given values from the blocklist.
// Its caller is the sync's counter-reset detection (internal/system/sync.go,
// #1824): when a machine re-issues ids it had already blocklisted, every entry
// in that machine's native range belongs to the previous shot counter and
// would otherwise wedge the cursor below every new shot for good. Values not
// present are ignored, so a concurrent removal is not an error, and an empty
// input is a no-op with no statement run at all.
func (r *Repository) RemoveFromBlocklist(values []string) error {
	if len(values) == 0 {
		return nil
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(values)), ",")
	args := make([]any, len(values))
	for i, v := range values {
		args[i] = v
	}
	if _, err := r.db.Exec(`DELETE FROM blocklist WHERE value IN (`+placeholders+`)`, args...); err != nil {
		return fmt.Errorf("shots: removing %d blocklist entries: %w", len(values), err)
	}
	return nil
}
