package shots

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"strconv"
	"sync"
	"time"
)

// Repository is the SQL DB access for shots, annotations and the related
// trash/blocklist tables. It grew with the domains that needed it: the
// machineId-scoped variants, FindAll, GetAnnotatedDoses, GetAnnotation,
// GetLatestID, GetTrashEntry, SetTrashEntry, WipeAll and Upsert serve the
// orders/maintenance/backup domains, and Count (#901) serves GET /api/status's
// shotCount. Deliberately still absent are the import/sync-path helpers (bulk
// upsert, max-id, all-annotations and machine-id reads) — no HTTP route
// reaches them yet; add them alongside the sync/import domain that calls
// them.
type Repository struct {
	db *sql.DB
}

// NewRepository wraps an already-open *sql.DB (see internal/db.Open).
func NewRepository(db *sql.DB) *Repository {
	return &Repository{db: db}
}

// FindByID returns the hydrated shot, or (nil, nil) — not an error — when no
// such shot exists.
func (r *Repository) FindByID(id int64) (Shot, error) {
	row := r.db.QueryRow(selectBase+` WHERE s.id = ?`, id)
	shot, err := hydrateRow(row)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("shots: finding shot %d: %w", id, err)
	}
	return shot, nil
}

// FindAllExcludingTrash returns every non-trashed shot (no machineId filter —
// see the type doc comment), ordered by timestamp ASC.
func (r *Repository) FindAllExcludingTrash() ([]Shot, error) {
	rows, err := r.db.Query(selectBase + ` WHERE s.id NOT IN (SELECT shot_id FROM trash) ORDER BY s.timestamp ASC`)
	if err != nil {
		return nil, fmt.Errorf("shots: listing shots: %w", err)
	}
	defer rows.Close()

	var out []Shot
	for rows.Next() {
		shot, err := hydrateRow(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, shot)
	}
	return out, rows.Err()
}

// FindLastExcludingTrash returns the single newest non-trashed shot. The
// list-based equivalent (findAllExcludingTrash, ORDER BY timestamp ASC) would
// keep the list's last element: greatest timestamp and, on a tie, the row
// SQLite returned last for that ASC scan (greatest id) — so the single-row
// query is ORDER BY s.timestamp DESC, s.id DESC LIMIT 1, the same ordering
// GetLatestID uses. Hydrating one row instead of all 213 to discard the rest
// (#951). Returns (nil, nil) when there are no shots.
func (r *Repository) FindLastExcludingTrash() (Shot, error) {
	row := r.db.QueryRow(selectBase + ` WHERE s.id NOT IN (SELECT shot_id FROM trash) ORDER BY s.timestamp DESC, s.id DESC LIMIT 1`)
	shot, err := hydrateRow(row)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("shots: finding last shot: %w", err)
	}
	return shot, nil
}

// FindAllExcludingTrashByMachine returns every non-trashed shot for one
// machine. Used by the maintenance domain (computeMaintenanceStats scopes
// descaling/backflush/grouphead/gaskets counts to one machine, see
// internal/maintenance/service.go).
func (r *Repository) FindAllExcludingTrashByMachine(machineID int64) ([]Shot, error) {
	rows, err := r.db.Query(
		selectBase+` WHERE s.machine_id = ? AND s.id NOT IN (SELECT shot_id FROM trash) ORDER BY s.timestamp ASC`,
		machineID,
	)
	if err != nil {
		return nil, fmt.Errorf("shots: listing shots for machine %d: %w", machineID, err)
	}
	defer rows.Close()

	var out []Shot
	for rows.Next() {
		shot, err := hydrateRow(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, shot)
	}
	return out, rows.Err()
}

// FindAll returns every shot including trashed ones (no machineId filter),
// ordered by timestamp ASC. Used by the backup domain's export, which needs
// the trashed shots' full payloads too — see internal/backup/doc.go.
func (r *Repository) FindAll() ([]Shot, error) {
	rows, err := r.db.Query(selectBase + ` ORDER BY s.timestamp ASC`)
	if err != nil {
		return nil, fmt.Errorf("shots: listing all shots: %w", err)
	}
	defer rows.Close()

	var out []Shot
	for rows.Next() {
		shot, err := hydrateRow(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, shot)
	}
	return out, rows.Err()
}

// AnnotatedDose is one lightweight (coffee, beanId, dose, timestamp) tuple for
// bean-consumption math, avoiding hydrating full shot payloads just to sum
// annotated doses.
type AnnotatedDose struct {
	Coffee    string
	BeanID    *int64
	Dose      *float64
	Timestamp int64
}

// GetAnnotatedDoses returns the annotated-dose tuples used by the
// library/orders domains' bean-stock math (computeBeanRemaining,
// getActiveBeans).
func (r *Repository) GetAnnotatedDoses() ([]AnnotatedDose, error) {
	rows, err := r.db.Query(`
		SELECT json_extract(a.data, '$.coffee') AS coffee,
		       json_extract(a.data, '$.beanId') AS beanId,
		       json_extract(a.data, '$.dose')   AS dose,
		       s.timestamp                      AS timestamp
		FROM annotations a JOIN shots s ON s.id = a.shot_id
		WHERE json_extract(a.data, '$.coffee') IS NOT NULL
		  AND s.id NOT IN (SELECT shot_id FROM trash)
	`)
	if err != nil {
		return nil, fmt.Errorf("shots: listing annotated doses: %w", err)
	}
	defer rows.Close()

	var out []AnnotatedDose
	for rows.Next() {
		var (
			coffee    sql.NullString
			beanID    sql.NullInt64
			dose      sql.NullFloat64
			timestamp int64
		)
		if err := rows.Scan(&coffee, &beanID, &dose, &timestamp); err != nil {
			return nil, fmt.Errorf("shots: scanning annotated dose: %w", err)
		}
		d := AnnotatedDose{Coffee: coffee.String, Timestamp: timestamp}
		if beanID.Valid {
			v := beanID.Int64
			d.BeanID = &v
		}
		if dose.Valid {
			v := dose.Float64
			d.Dose = &v
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// GetAnnotation returns the raw stored annotation object, or {} if none
// exists — the read half of UpdateAnnotation's locked read-modify-write (see
// its doc comment), which merges onto whatever annotation already exists
// rather than overwriting it wholesale.
func (r *Repository) GetAnnotation(shotID int64) (map[string]any, error) {
	var raw string
	err := r.db.QueryRow(`SELECT data FROM annotations WHERE shot_id = ?`, shotID).Scan(&raw)
	if err == sql.ErrNoRows {
		return map[string]any{}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("shots: reading annotation for shot %d: %w", shotID, err)
	}
	var ann map[string]any
	if err := json.Unmarshal([]byte(raw), &ann); err != nil {
		return nil, fmt.Errorf("shots: decoding annotation for shot %d: %w", shotID, err)
	}
	if ann == nil {
		ann = map[string]any{}
	}
	return ann, nil
}

// GetLatestID returns the newest shot id, extended with a sinceSec lower bound
// (#1197). machineID == 0 means global latest, across every machine; a
// positive machineID scopes to that one machine. When sinceSec > 0 only shots
// whose Unix-seconds timestamp is at or after it are considered — order
// fulfillment uses this so a completed order is not matched to an unrelated
// older shot. sinceSec == 0 means no time filter. ok is false when there is no
// matching shot.
func (r *Repository) GetLatestID(machineID, sinceSec int64) (id int64, ok bool, err error) {
	var row *sql.Row
	if machineID != 0 {
		if sinceSec > 0 {
			row = r.db.QueryRow(
				`SELECT id FROM shots WHERE machine_id = ? AND timestamp >= ? AND id NOT IN (SELECT shot_id FROM trash) ORDER BY timestamp DESC, id DESC LIMIT 1`,
				machineID, sinceSec,
			)
		} else {
			row = r.db.QueryRow(
				`SELECT id FROM shots WHERE machine_id = ? AND id NOT IN (SELECT shot_id FROM trash) ORDER BY timestamp DESC, id DESC LIMIT 1`,
				machineID,
			)
		}
	} else if sinceSec > 0 {
		row = r.db.QueryRow(
			`SELECT id FROM shots WHERE timestamp >= ? AND id NOT IN (SELECT shot_id FROM trash) ORDER BY timestamp DESC, id DESC LIMIT 1`,
			sinceSec,
		)
	} else {
		row = r.db.QueryRow(
			`SELECT id FROM shots WHERE id NOT IN (SELECT shot_id FROM trash) ORDER BY timestamp DESC, id DESC LIMIT 1`,
		)
	}
	if err := row.Scan(&id); err == sql.ErrNoRows {
		return 0, false, nil
	} else if err != nil {
		return 0, false, fmt.Errorf("shots: getting latest id: %w", err)
	}
	return id, true, nil
}

// MaxNativeShotID returns the highest shot id filed under the given machine
// that is still a real native id. #341: scoped to one machine so another
// machine's synthetic ids (10,000,000+) can't inflate it. #719: also excludes
// any id outside that machine's own window even if it's (wrongly) filed under
// this machine — a corrupt/pre-existing row must never poison the max the sync
// loop catches up from. Machine 1's native ids are 0..MachineIDOffset; every
// other machine's are stored globally as machineID*MachineIDOffset+nativeID, so
// its max is read from (base, base+MachineIDOffset) and returned as the native
// id by subtracting the base (#1147).
//
// Trashed rows are deliberately INCLUDED here (#1150). A trashed id already
// exists locally, so it must never count as "missing" and be re-fetched on
// every sync; excluding trashed rows would leave the starting point one too low
// whenever the newest shot was in the trash. Returns 0 when the machine has no
// qualifying shots yet.
func (r *Repository) MaxNativeShotID(machineID int64) (int64, error) {
	var maxID sql.NullInt64
	if machineID == 1 {
		err := r.db.QueryRow(
			`SELECT MAX(id) FROM shots WHERE machine_id = ? AND id < ?`,
			machineID, MachineIDOffset,
		).Scan(&maxID)
		if err != nil {
			return 0, fmt.Errorf("shots: getting max native id: %w", err)
		}
		if !maxID.Valid {
			return 0, nil
		}
		return maxID.Int64, nil
	}
	base := machineID * MachineIDOffset
	err := r.db.QueryRow(
		`SELECT MAX(id) FROM shots WHERE machine_id = ? AND id > ? AND id < ?`,
		machineID, base, base+MachineIDOffset,
	).Scan(&maxID)
	if err != nil {
		return 0, fmt.Errorf("shots: getting max native id: %w", err)
	}
	if !maxID.Valid {
		return 0, nil
	}
	return maxID.Int64 - base, nil
}

// Count is a plain `SELECT COUNT(*) FROM shots`, deliberately including
// trashed rows (no `NOT IN (SELECT shot_id FROM trash)` filter, unlike
// FindAllExcludingTrash). GET /api/status's shotCount field (#901) is its
// only caller.
func (r *Repository) Count() (int, error) {
	var n int
	if err := r.db.QueryRow(`SELECT COUNT(*) FROM shots`).Scan(&n); err != nil {
		return 0, fmt.Errorf("shots: counting: %w", err)
	}
	return n, nil
}

// GetTrashEntry returns a single trash row's deleted_at, or (0, false) if the
// shot isn't trashed. Used by the backup export, which needs a per-shot
// timestamp rather than FindTrashed's full hydrated rows.
func (r *Repository) GetTrashEntry(shotID int64) (deletedAt int64, ok bool, err error) {
	err = r.db.QueryRow(`SELECT deleted_at FROM trash WHERE shot_id = ?`, shotID).Scan(&deletedAt)
	if err == sql.ErrNoRows {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, fmt.Errorf("shots: reading trash entry for shot %d: %w", shotID, err)
	}
	return deletedAt, true, nil
}

// SetTrashEntry is the restore-only counterpart to MoveToTrash: it takes the
// deletedAt timestamp from the backup instead of always stamping time.Now(),
// so a restored trash entry keeps its original deletion time rather than
// resetting the 30-day TTL clock.
func (r *Repository) SetTrashEntry(shotID, deletedAt int64) error {
	if _, err := r.db.Exec(`INSERT OR REPLACE INTO trash (shot_id, deleted_at) VALUES (?, ?)`, shotID, deletedAt); err != nil {
		return fmt.Errorf("shots: setting trash entry for shot %d: %w", shotID, err)
	}
	return nil
}

// WipeAll deletes every shot, annotation and trash row. Used only by the
// backup domain's restore path, which replaces the whole shots table.
func (r *Repository) WipeAll() error {
	tx, err := r.db.Begin()
	if err != nil {
		return fmt.Errorf("shots: starting wipe tx: %w", err)
	}
	for _, stmt := range []string{`DELETE FROM annotations`, `DELETE FROM trash`, `DELETE FROM shot_score_cache`, `DELETE FROM shots`} {
		if _, err := tx.Exec(stmt); err != nil {
			tx.Rollback()
			return fmt.Errorf("shots: wiping (%s): %w", stmt, err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("shots: committing wipe: %w", err)
	}
	return nil
}

// Upsert writes the shots row (and, if the shot object carries an `annotation`
// key, the annotations row too) straight from a sync-pulled or
// restored/imported shot object. Its statement must never go back to INSERT OR
// REPLACE (#1150) — see the inline comment on the Exec below.
// ownerMachineID uses a `shot.machineId ?? ownerOfShotId(id)` fallback; the
// ownerOfShotId inference (#719) isn't implemented (it needs
// internal/machines' MACHINE_ID_OFFSET arithmetic, out of scope here), so a
// shot with no explicit machineId defaults to machine 1 — every backup this
// phase's restore handles was itself exported by an app version that always
// wrote machineId, so this fallback is not expected to be reached in practice.
func (r *Repository) Upsert(shot Shot) error {
	row, err := shotInsertArgs(shot)
	if err != nil {
		return err
	}
	// ON CONFLICT DO UPDATE, never INSERT OR REPLACE (#1150): a REPLACE
	// deletes the conflicting row first, and with foreign_keys=ON that
	// fires annotations' ON DELETE CASCADE, silently wiping the shot's
	// annotation even when the incoming payload carries none. The sync
	// loops re-upsert shots that may already be annotated, so REPLACE here
	// was real, repeating data loss.
	if _, err := r.db.Exec(
		`INSERT INTO shots (id, timestamp, duration, profile_name, data, machine_id) VALUES (?,?,?,?,?,?)`+
			` ON CONFLICT(id) DO UPDATE SET timestamp=excluded.timestamp, duration=excluded.duration,`+
			` profile_name=excluded.profile_name, data=excluded.data, machine_id=excluded.machine_id`,
		row.id, row.timestamp, row.duration, row.profileName, row.data, row.machineID,
	); err != nil {
		return fmt.Errorf("shots: upserting shot %d: %w", row.id, err)
	}
	if ann, ok := shot["annotation"]; ok {
		annMap, _ := ann.(map[string]any)
		if annMap == nil {
			annMap = map[string]any{}
		}
		if err := r.SaveAnnotation(row.id, annMap); err != nil {
			return err
		}
	}
	return nil
}

// shotInsertRow is the fixed-column shape shotInsertArgs extracts from a
// restored/imported Shot object for the shots-table INSERT.
type shotInsertRow struct {
	id          int64
	timestamp   int64
	duration    any
	profileName any
	data        string
	machineID   int64
}

// shotInsertArgs is Upsert's field-extraction logic, factored out so both
// Upsert and RestoreShots build the shots-row column values the same way.
// jsonInt tolerates BOTH shapes a caller can hand it: an int64 (a Shot
// built in-process, e.g. by hydrateRow) or a float64 (a Shot decoded
// straight from JSON by encoding/json, which never produces int64 for a
// bare `any` destination — the shape every restore/import caller has).
func shotInsertArgs(shot Shot) (shotInsertRow, error) {
	jsonInt := func(v any) (int64, bool) {
		switch t := v.(type) {
		case int64:
			return t, true
		case float64:
			return int64(t), true
		}
		return 0, false
	}
	var row shotInsertRow
	row.id, _ = jsonInt(shot["id"])
	row.timestamp, _ = jsonInt(shot["timestamp"])
	if d, ok := jsonInt(shot["duration"]); ok {
		row.duration = d
	}
	if pn, ok := shot["profileName"].(string); ok && pn != "" {
		row.profileName = pn
	} else if pn, ok := shot["profile_name"].(string); ok && pn != "" {
		row.profileName = pn
	}
	row.machineID = int64(1)
	if v, ok := jsonInt(shot["machineId"]); ok {
		row.machineID = v
	}

	rest := make(map[string]any, len(shot))
	for k, v := range shot {
		switch k {
		case "id", "timestamp", "duration", "profile_name", "profileName", "annotation", "machineId":
			continue
		default:
			rest[k] = v
		}
	}
	data, err := json.Marshal(rest)
	if err != nil {
		return shotInsertRow{}, fmt.Errorf("shots: encoding restored shot %d: %w", row.id, err)
	}
	row.data = string(data)
	return row, nil
}

// FindTrashed returns the trashed shots as one joined query instead of a
// TrashIDs()-then-FindByID(id)-per-id round trip: the naive version issued 1+N
// queries (one to list trash ids, one more per id, each re-running
// selectBase's shots<->annotations join), which scales linearly with trash
// size. Driving the join FROM trash instead of shots keeps the same "only rows
// with a live shots record" semantics a per-id lookup had (an INNER JOIN
// silently drops a trash entry whose shot row is somehow already gone), and
// ordering by t.shot_id makes the result deterministic (trash's shot_id is its
// INTEGER PRIMARY KEY, so this matches the rowid-order SQLite returned for the
// old unordered `SELECT shot_id FROM trash` in practice).
func (r *Repository) FindTrashed() ([]Shot, error) {
	rows, err := r.db.Query(`
		SELECT s.id, s.timestamp, s.duration, s.profile_name, s.data, s.machine_id, a.data AS ann_data
		FROM trash t
		JOIN shots s ON s.id = t.shot_id
		LEFT JOIN annotations a ON a.shot_id = s.id
		ORDER BY t.shot_id ASC
	`)
	if err != nil {
		return nil, fmt.Errorf("shots: listing trash: %w", err)
	}
	defer rows.Close()

	var out []Shot
	for rows.Next() {
		shot, err := hydrateRow(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, shot)
	}
	return out, rows.Err()
}

// FindPreviousByProfile returns the most recent earlier shot before shotID
// with the same profileName on the same machine, excluding trashed shots
// (#402).
func (r *Repository) FindPreviousByProfile(shotID int64, profileName string, machineID int64) (Shot, error) {
	row := r.db.QueryRow(selectBase+`
		WHERE s.machine_id = ?
		  AND s.profile_name = ?
		  AND s.timestamp < (SELECT timestamp FROM shots WHERE id = ?)
		  AND s.id NOT IN (SELECT shot_id FROM trash)
		ORDER BY s.timestamp DESC
		LIMIT 1
	`, machineID, profileName, shotID)
	shot, err := hydrateRow(row)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("shots: finding previous shot for profile %q: %w", profileName, err)
	}
	return shot, nil
}

// SetImage merges the `image` key into the shot's JSON blob without
// disturbing the rest of the payload. Returns (nil, nil) if the shot doesn't
// exist.
func (r *Repository) SetImage(id int64, ext string) (Shot, error) {
	data, err := r.rawData(id)
	if err != nil {
		return nil, err
	}
	if data == nil {
		return nil, nil
	}
	data["image"] = ext
	if err := r.writeData(id, data); err != nil {
		return nil, err
	}
	return r.FindByID(id)
}

// ClearImage removes the `image` key from the shot's JSON blob.
func (r *Repository) ClearImage(id int64) (Shot, error) {
	data, err := r.rawData(id)
	if err != nil {
		return nil, err
	}
	if data == nil {
		return nil, nil
	}
	delete(data, "image")
	if err := r.writeData(id, data); err != nil {
		return nil, err
	}
	return r.FindByID(id)
}

// ImageExtFor returns id's stored photo extension (data["image"]), or "" when
// the shot has no photo or does not exist. #1162's sync reads the moved row's
// extension back through this so it can carry the photo files over to the new
// id with MoveShotImageFiles.
func (r *Repository) ImageExtFor(id int64) (string, error) {
	shot, err := r.FindByID(id)
	if err != nil || shot == nil {
		return "", err
	}
	return shot.imageExt(), nil
}

func (r *Repository) rawData(id int64) (map[string]any, error) {
	var raw string
	err := r.db.QueryRow(`SELECT data FROM shots WHERE id = ?`, id).Scan(&raw)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("shots: reading data for shot %d: %w", id, err)
	}
	var data map[string]any
	if err := json.Unmarshal([]byte(raw), &data); err != nil {
		return nil, fmt.Errorf("shots: decoding data for shot %d: %w", id, err)
	}
	if data == nil {
		data = map[string]any{}
	}
	return data, nil
}

func (r *Repository) writeData(id int64, data map[string]any) error {
	b, err := json.Marshal(data)
	if err != nil {
		return fmt.Errorf("shots: encoding data for shot %d: %w", id, err)
	}
	if _, err := r.db.Exec(`UPDATE shots SET data = ? WHERE id = ?`, string(b), id); err != nil {
		return fmt.Errorf("shots: writing data for shot %d: %w", id, err)
	}
	return nil
}

// annotationMu serialises every annotation write: SaveAnnotation and
// UpdateAnnotation both take it, so a restore/sync full replace cannot
// interleave with a patch's read-modify-write. Like the library blob's
// package-level writeMu (internal/library/repository.go's Update — the
// pattern this copies), it is package-level rather than a Repository field
// because callers in other packages (orders, mcp) hold their own
// *Repository over the same *sql.DB; a per-value mutex would not cover
// them. GetAnnotation stays unlocked so read-only callers never block.
// internal/library/repository.go is the pattern donor here and needs no
// change of its own.
var annotationMu sync.Mutex

// UpdateAnnotation applies fn to the shot's current annotation under
// annotationMu and, only when fn returns nil, writes the result back and
// returns it (#1273). The annotation starts as an empty map when none is
// stored, so fn always sees a writable map. fn must be pure: it runs while
// the lock is held and the lock is not re-entrant, so it must not call back
// into an annotation writer.
func (r *Repository) UpdateAnnotation(shotID int64, fn func(ann map[string]any) error) (map[string]any, error) {
	annotationMu.Lock()
	defer annotationMu.Unlock()

	ann, err := r.GetAnnotation(shotID)
	if err != nil {
		return nil, err
	}
	if err := fn(ann); err != nil {
		return nil, err
	}
	if err := r.saveAnnotation(shotID, ann); err != nil {
		return nil, err
	}
	return ann, nil
}

// SaveAnnotation is a full-replace upsert with no existence check against
// `shots` in the query itself. It stays the whole-object write for
// Repository.Upsert (restore/sync/import), where the shot object carries the
// complete annotation; callers that merge a patch use UpdateAnnotation. In
// practice this still fails for a shot id that was never synced:
// annotations.shot_id REFERENCES shots(id) with foreign_keys=ON (see
// InitSchema), so the INSERT hits a foreign-key constraint violation,
// surfaced as a generic error (500) by the caller — see handlers.go's
// annotate doc comment.
func (r *Repository) SaveAnnotation(shotID int64, annotation map[string]any) error {
	annotationMu.Lock()
	defer annotationMu.Unlock()
	return r.saveAnnotation(shotID, annotation)
}

// saveAnnotation is the shared full-replace write behind SaveAnnotation and
// UpdateAnnotation; the caller must hold annotationMu.
func (r *Repository) saveAnnotation(shotID int64, annotation map[string]any) error {
	b, err := json.Marshal(annotation)
	if err != nil {
		return fmt.Errorf("shots: encoding annotation for shot %d: %w", shotID, err)
	}
	if _, err := r.db.Exec(`INSERT OR REPLACE INTO annotations (shot_id, data) VALUES (?, ?)`, shotID, string(b)); err != nil {
		return fmt.Errorf("shots: saving annotation for shot %d: %w", shotID, err)
	}
	// #957: dose/tds feed CalcShotScoreDetail, and a same-length edit
	// (18.0 -> 19.0) leaves shot_score_cache's fingerprint unchanged, so
	// drop the row outright rather than trusting the fingerprint here.
	r.InvalidateScoreCache(shotID)
	return nil
}

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
// one transaction.
func (r *Repository) DeleteByID(shotID int64) error {
	tx, err := r.db.Begin()
	if err != nil {
		return fmt.Errorf("shots: starting delete tx for shot %d: %w", shotID, err)
	}
	if _, err := tx.Exec(`DELETE FROM annotations WHERE shot_id = ?`, shotID); err != nil {
		tx.Rollback()
		return fmt.Errorf("shots: deleting annotation for shot %d: %w", shotID, err)
	}
	if _, err := tx.Exec(`DELETE FROM trash WHERE shot_id = ?`, shotID); err != nil {
		tx.Rollback()
		return fmt.Errorf("shots: deleting trash entry for shot %d: %w", shotID, err)
	}
	if _, err := tx.Exec(`DELETE FROM shots WHERE id = ?`, shotID); err != nil {
		tx.Rollback()
		return fmt.Errorf("shots: deleting shot %d: %w", shotID, err)
	}
	if _, err := tx.Exec(`DELETE FROM shot_score_cache WHERE shot_id = ?`, shotID); err != nil {
		tx.Rollback()
		return fmt.Errorf("shots: deleting score cache for shot %d: %w", shotID, err)
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

// PurgeExpiredTrash permanently drops every trash entry older than trashTTL,
// together with its shot row and annotation, in one transaction (#1152).
// deleted_at is in milliseconds (MoveToTrash stamps time.Now().UnixMilli), so
// the cutoff is a strict `<` against now's epoch-millis minus trashTTL.
//
// Each purged id is deliberately blocklisted (#1159) so the next sync does not
// resume below it and re-import the shot from the machine. Image files are not
// deleted. shot_score_cache is likewise cleared (DeleteByID does this, and a
// purge would otherwise leave orphaned cache rows behind).
func (r *Repository) PurgeExpiredTrash(now time.Time) ([]int64, error) {
	cutoff := now.UnixMilli() - trashTTL.Milliseconds()
	rows, err := r.db.Query(`SELECT shot_id FROM trash WHERE deleted_at < ?`, cutoff)
	if err != nil {
		return nil, fmt.Errorf("shots: listing expired trash: %w", err)
	}
	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, fmt.Errorf("shots: scanning expired trash id: %w", err)
		}
		ids = append(ids, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("shots: listing expired trash: %w", err)
	}
	if len(ids) == 0 {
		return nil, nil
	}

	tx, err := r.db.Begin()
	if err != nil {
		return nil, fmt.Errorf("shots: starting trash purge tx: %w", err)
	}
	for _, id := range ids {
		// Same order as DeleteByID.
		for _, stmt := range []string{
			`DELETE FROM annotations WHERE shot_id = ?`,
			`DELETE FROM trash WHERE shot_id = ?`,
			`DELETE FROM shots WHERE id = ?`,
			`DELETE FROM shot_score_cache WHERE shot_id = ?`,
		} {
			if _, err := tx.Exec(stmt, id); err != nil {
				tx.Rollback()
				return nil, fmt.Errorf("shots: purging shot %d (%s): %w", id, stmt, err)
			}
		}
		// Blocklist the id so a later sync does not resume below it and
		// re-import the shot (same statement as AppendToBlocklist;
		// blocklist.value is UNIQUE).
		if _, err := tx.Exec(`INSERT OR IGNORE INTO blocklist (value) VALUES (?)`, strconv.FormatInt(id, 10)); err != nil {
			tx.Rollback()
			return nil, fmt.Errorf("shots: blocklisting purged shot %d: %w", id, err)
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("shots: committing trash purge: %w", err)
	}
	return ids, nil
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

// SaveBlocklist replaces the entire table contents inside one transaction.
func (r *Repository) SaveBlocklist(list []string) error {
	tx, err := r.db.Begin()
	if err != nil {
		return fmt.Errorf("shots: starting blocklist save tx: %w", err)
	}
	if _, err := tx.Exec(`DELETE FROM blocklist`); err != nil {
		tx.Rollback()
		return fmt.Errorf("shots: clearing blocklist: %w", err)
	}
	stmt, err := tx.Prepare(`INSERT INTO blocklist (value) VALUES (?)`)
	if err != nil {
		tx.Rollback()
		return fmt.Errorf("shots: preparing blocklist insert: %w", err)
	}
	defer stmt.Close()
	for _, v := range list {
		if _, err := stmt.Exec(v); err != nil {
			tx.Rollback()
			return fmt.Errorf("shots: inserting blocklist entry %q: %w", v, err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("shots: committing blocklist save: %w", err)
	}
	return nil
}

// AppendToBlocklist atomically adds a single value to the blocklist without
// the read-then-replace round trip SaveBlocklist requires for a single-id add.
// The handlers run concurrently: two overlapping
// DELETE /api/shots/{id}/delete requests can each read the same blocklist
// snapshot via GetBlocklist, append their own id, and then SaveBlocklist —
// whose DELETE+re-INSERT replaces the whole table — so the second write
// silently drops the first request's id (#901). blocklist.value has a UNIQUE
// constraint (see internal/db/db.go), so INSERT OR IGNORE is a single atomic
// statement with no read step and therefore no lost-update window.
func (r *Repository) AppendToBlocklist(value string) error {
	if _, err := r.db.Exec(`INSERT OR IGNORE INTO blocklist (value) VALUES (?)`, value); err != nil {
		return fmt.Errorf("shots: appending blocklist entry %q: %w", value, err)
	}
	return nil
}
