package shots

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"time"
)

// Repository ports lib/repositories/ShotRepository.js's DB access. Phase
// 1c originally scoped this to only what routes/shots.js's endpoints
// needed; Phase 1f (orders/maintenance/backup) added the machineId-scoped
// variants, FindAll, GetAnnotatedDoses, GetAnnotation, GetLatestID,
// GetTrashEntry, SetTrashEntry, WipeAll and Upsert those later domains
// actually call; Phase 3b (#901) added Count for GET /api/status's
// shotCount. Still deliberately not ported: upsertMany, getMaxId,
// getAllAnnotations, getMachineId — those are import/sync-path only (no
// HTTP route reaches them yet in any phase so far); add them alongside
// whichever later domain (sync/import) actually calls them.
type Repository struct {
	db *sql.DB
}

// NewRepository wraps an already-open *sql.DB (see internal/db.Open).
func NewRepository(db *sql.DB) *Repository {
	return &Repository{db: db}
}

// FindByID ports ShotRepository.js's findById. Returns (nil, nil) — not an
// error — when no such shot exists, matching _hydrate(undefined) => null.
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

// FindAllExcludingTrash ports ShotRepository.js's findAllExcludingTrash()
// (no machineId — see the type doc comment), ordered by timestamp ASC.
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

// FindLastExcludingTrash returns the single newest non-trashed shot — the
// one routes/shots.js's GET /api/shots/last keeps as `shots[shots.length -
// 1]` after shotService.getAll() (findAllExcludingTrash, ORDER BY timestamp
// ASC). "Newest" there means greatest timestamp and, on a tie, the row
// SQLite returned last for that ASC scan (greatest id) — so the equivalent
// single-row query is ORDER BY s.timestamp DESC, s.id DESC LIMIT 1, the
// same ordering getLatestId already uses. Hydrating one row instead of all
// 213 to discard the rest (#951). Returns (nil, nil) when there are no
// shots, matching the Node `shots.length ? … : null` / `if (!last)` branch.
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

// FindAllExcludingTrashByMachine ports ShotRepository.js's
// findAllExcludingTrash(machineId) with machineId actually supplied — the
// machineId-scoped variant the type doc comment above flagged as
// deliberately unported in Phase 1c. Needed by Phase 1f's maintenance
// domain (computeMaintenanceStats scopes descaling/backflush/grouphead/
// gaskets counts to one machine, see internal/maintenance/service.go).
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

// FindAll ports ShotRepository.js's findAll() with no machineId — every
// shot including trashed ones, ordered by timestamp ASC. Needed by the
// backup domain's export (routes/backup.js reads shotRepo.findAll(), not
// the trash-excluding getAll(), so a trashed shot's full payload is still
// part of every export — see internal/backup/doc.go).
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

// AnnotatedDose is one row of ShotRepository.js's getAnnotatedDoses():
// lightweight (coffee, beanId, dose, timestamp) tuples for bean-consumption
// math, avoiding hydrating full shot payloads just to sum annotated doses.
type AnnotatedDose struct {
	Coffee    string
	BeanID    *int64
	Dose      *float64
	Timestamp int64
}

// GetAnnotatedDoses ports ShotRepository.js's getAnnotatedDoses() — used by
// the library/orders domains' bean-stock math (computeBeanRemaining,
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

// GetAnnotation ports ShotRepository.js's getAnnotation(shotId): the raw
// stored annotation object, or {} if none exists — used by
// OrderService.completeOrder's read-modify-write of the orderedBy field
// (see internal/orders/service.go), which must merge onto whatever
// annotation already exists rather than overwrite it wholesale.
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

// GetLatestID ports ShotRepository.js's getLatestId(machineId). machineID
// == 0 mirrors the Node original's `machineId` falsy branch (global
// latest, across every machine); a positive machineID scopes to that one
// machine. ok is false when there is no matching shot (Node's `row?.id ??
// null`).
func (r *Repository) GetLatestID(machineID int64) (id int64, ok bool, err error) {
	var row *sql.Row
	if machineID != 0 {
		row = r.db.QueryRow(
			`SELECT id FROM shots WHERE machine_id = ? AND id NOT IN (SELECT shot_id FROM trash) ORDER BY timestamp DESC, id DESC LIMIT 1`,
			machineID,
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

// MaxNativeShotID ports lib/sync.js's maxDefaultMachineShotId(): the
// highest shot id filed under the given machine that is still a real
// native id. #341: scoped to one machine so another machine's synthetic
// ids (10,000,000+) can't inflate it. #719: also excludes any id at or
// above machineIDOffset even if it's (wrongly) filed under this machine —
// a corrupt/pre-existing row must never poison the max the sync loop
// catches up from. Trash is excluded, matching the Node original's
// `shotService.getAll(1)` == findAllExcludingTrash(1). Returns 0 when the
// machine has no qualifying shots yet, matching the Node reduce() seed.
func (r *Repository) MaxNativeShotID(machineID int64) (int64, error) {
	var maxID sql.NullInt64
	err := r.db.QueryRow(
		`SELECT MAX(id) FROM shots WHERE machine_id = ? AND id < ? AND id NOT IN (SELECT shot_id FROM trash)`,
		machineID, machineIDOffset,
	).Scan(&maxID)
	if err != nil {
		return 0, fmt.Errorf("shots: getting max native id: %w", err)
	}
	if !maxID.Valid {
		return 0, nil
	}
	return maxID.Int64, nil
}

// Count ports ShotRepository.js's count(): a plain `SELECT COUNT(*) FROM
// shots`, deliberately including trashed rows (no `NOT IN (SELECT shot_id
// FROM trash)` filter — mirrors the Node original exactly, not
// FindAllExcludingTrash's convention). GET /api/status's shotCount field
// (#901 Phase 3b) is its only caller.
func (r *Repository) Count() (int, error) {
	var n int
	if err := r.db.QueryRow(`SELECT COUNT(*) FROM shots`).Scan(&n); err != nil {
		return 0, fmt.Errorf("shots: counting: %w", err)
	}
	return n, nil
}

// GetTrashEntry ports ShotRepository.js's getTrashEntry(shotId): a single
// trash row's deleted_at, or (0, false) if the shot isn't trashed. Used by
// the backup export, which needs a per-shot timestamp rather than
// FindTrashed's full hydrated rows.
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

// SetTrashEntry ports ShotRepository.js's setTrashEntry(shotId, deletedAt)
// — restore-only counterpart to MoveToTrash: takes the deletedAt timestamp
// from the backup instead of always stamping time.Now(), so a restored
// trash entry keeps its original deletion time rather than resetting the
// 30-day TTL clock.
func (r *Repository) SetTrashEntry(shotID, deletedAt int64) error {
	if _, err := r.db.Exec(`INSERT OR REPLACE INTO trash (shot_id, deleted_at) VALUES (?, ?)`, shotID, deletedAt); err != nil {
		return fmt.Errorf("shots: setting trash entry for shot %d: %w", shotID, err)
	}
	return nil
}

// WipeAll ports ShotRepository.js's wipeAll() — deletes every shot,
// annotation and trash row, used only by the backup domain's restore path
// (a restore replaces the whole shots table, matching Node's
// db.transaction(() => { shotRepo.wipeAll(); ... }) sequence).
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

// Upsert ports ShotRepository.js's upsert(shot): writes the shots row (and,
// if the shot object carries an `annotation` key, the annotations row too)
// straight from a restored/imported shot object. Only used by the backup
// domain's restore path in this phase — see internal/backup/doc.go.
// ownerMachineID mirrors upsert()'s `shot.machineId ?? ownerOfShotId(id)`
// fallback; #719's ownerOfShotId inference isn't ported (that needs
// internal/machines' MACHINE_ID_OFFSET arithmetic, out of scope here), so a
// shot with no explicit machineId defaults to machine 1 — every backup this
// phase's restore handles was itself exported by an app version that always
// wrote machineId, so this fallback is not expected to be reached in
// practice.
func (r *Repository) Upsert(shot Shot) error {
	row, err := shotInsertArgs(shot)
	if err != nil {
		return err
	}
	if _, err := r.db.Exec(
		`INSERT OR REPLACE INTO shots (id, timestamp, duration, profile_name, data, machine_id) VALUES (?,?,?,?,?,?)`,
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

// FindTrashed ports ShotRepository.js's getTrash() paired with
// ShotService.getTrash()'s per-id findById hydration — but as one joined
// query instead of a TrashIDs()-then-FindByID(id)-per-id round trip: the
// naive port issued 1+N queries (one to list trash ids, one more per id,
// each re-running selectBase's shots<->annotations join), which scales
// linearly with trash size. Driving the join FROM trash instead of shots
// keeps the same "only rows with a live shots record" semantics
// ShotService.getTrash()'s `.filter(Boolean)` had (an INNER JOIN silently
// drops a trash entry whose shot row is somehow already gone, same as a nil
// FindByID result did), and ordering by t.shot_id makes the result
// deterministic (trash's shot_id is its INTEGER PRIMARY KEY, so this matches
// the rowid-order SQLite returned for the old unordered `SELECT shot_id FROM
// trash` in practice).
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

// FindPreviousByProfile ports ShotRepository.js's findPreviousByProfile
// (#402): the most recent earlier shot before shotID with the same
// profileName on the same machine, excluding trashed shots.
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

// SetImage ports ShotRepository.js's setImage: merges the `image` key into
// the shot's JSON blob without disturbing the rest of the payload. Returns
// (nil, nil) if the shot doesn't exist.
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

// ClearImage ports ShotRepository.js's clearImage.
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

// SaveAnnotation ports ShotRepository.js's saveAnnotation — an upsert with
// no existence check against `shots` in the query itself, matching the
// Node original. In practice this still fails for a shot id that was never
// synced: annotations.shot_id REFERENCES shots(id) and foreign_keys=ON in
// both InitSchema and lib/db.js, so the INSERT hits a foreign-key
// constraint violation, surfaced as a generic error (500) by the caller —
// see handlers.go's annotate doc comment.
func (r *Repository) SaveAnnotation(shotID int64, annotation map[string]any) error {
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

// MoveToTrash ports ShotRepository.js's moveToTrash.
func (r *Repository) MoveToTrash(shotID int64) error {
	if _, err := r.db.Exec(`INSERT OR REPLACE INTO trash (shot_id, deleted_at) VALUES (?, ?)`, shotID, time.Now().UnixMilli()); err != nil {
		return fmt.Errorf("shots: trashing shot %d: %w", shotID, err)
	}
	return nil
}

// RestoreFromTrash ports ShotRepository.js's restoreFromTrash — no
// existence check, matching the Node original.
func (r *Repository) RestoreFromTrash(shotID int64) error {
	if _, err := r.db.Exec(`DELETE FROM trash WHERE shot_id = ?`, shotID); err != nil {
		return fmt.Errorf("shots: restoring shot %d: %w", shotID, err)
	}
	return nil
}

// DeleteByID ports ShotRepository.js's deleteById: annotations, then
// trash, then the shot row itself, inside one transaction.
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

// GetBlocklist ports ShotRepository.js's getBlocklist.
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

// SaveBlocklist ports ShotRepository.js's saveBlocklist: replaces the
// entire table contents inside one transaction.
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
// the read-then-replace round trip SaveBlocklist requires for a
// single-id add. Node's saveBlocklist(list) has no concurrency issue
// (single-threaded event loop, so a route handler's read-modify-write
// always runs to completion before the next request starts), but Go's
// handlers run concurrently: two overlapping DELETE /api/shots/{id}/delete
// requests can each read the same blocklist snapshot via GetBlocklist,
// append their own id, and then SaveBlocklist — whose DELETE+re-INSERT
// replaces the whole table — so the second write silently drops the first
// request's id (#901). blocklist.value has a UNIQUE constraint (see
// internal/db/db.go), so INSERT OR IGNORE is a single atomic statement with
// no read step and therefore no lost-update window.
func (r *Repository) AppendToBlocklist(value string) error {
	if _, err := r.db.Exec(`INSERT OR IGNORE INTO blocklist (value) VALUES (?)`, value); err != nil {
		return fmt.Errorf("shots: appending blocklist entry %q: %w", value, err)
	}
	return nil
}
