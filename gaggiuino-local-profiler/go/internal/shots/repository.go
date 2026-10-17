package shots

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"maps"
	"strings"
	"sync"
)

// Repository is the SQL DB access for shots, annotations and the related
// trash/blocklist tables. It grew with the domains that needed it: the
// machineId-scoped variants, FindAll, GetAnnotatedDoses, GetAnnotation,
// GetLatestID and Upsert serve the orders/maintenance/backup domains, and
// Count (#901) serves GET /api/status's shotCount. Deliberately still absent
// are the import/sync-path helpers (bulk upsert, max-id, all-annotations and
// machine-id reads) — no HTTP route reaches them yet; add them alongside the
// sync/import domain that calls them.
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

// Light reads (#1616) select a hydrated shot's timestamp and annotation
// straight from SQL instead of hydrating it. Hydration spreads a data
// blob's own top-level keys over the fixed columns and falls back to the
// blob's "annotation" key when a shot has no annotations row, so the exact
// SQL counterparts are:
//
//   - timestamp (hydrateRow(...)["timestamp"].(int64)): the column, or NULL
//     (read as 0) when the blob carries its own "timestamp" key — the
//     decoded JSON value replaces the int64, so the int64 read yields 0;
//   - annotation: the annotations row, else the blob's "annotation" key.
//
// The instr() pre-checks keep the JSON parse off rows that cannot hold the
// key.
const (
	hydratedTimestampSQL = `CASE WHEN instr(s.data, '"timestamp"') > 0 AND s.data -> '$.timestamp' IS NOT NULL
	THEN NULL ELSE s.timestamp END`
	hydratedAnnotationSQL = `CASE WHEN a.shot_id IS NOT NULL THEN a.data
	WHEN instr(s.data, '"annotation"') > 0 THEN s.data -> '$.annotation' END`
)

// legacyBlobKeys memoises, per *sql.DB, which of those two keys any shot's
// data blob carries at the top level. No writer in this app ever adds
// either — Upsert and RestoreShots strip both (shotInsertArgs), writeData
// only round-trips a blob's existing keys, and the misfiled-shot move
// copies an existing blob — so once a database has been checked and found
// free of a key it stays that way, and every later read can skip parsing
// the curve blobs for it. Only rows from an older app version can carry
// one; then the memo says so and reads keep the exact per-row expression.
var legacyBlobKeys sync.Map // *sql.DB -> legacyKeys

type legacyKeys struct{ timestamp, annotation bool }

// lightColumnsSQL returns the SQL expressions (over aliases s and a) for a
// hydrated shot's int64 timestamp and its annotation JSON text.
func (r *Repository) lightColumnsSQL() (ts, ann string, err error) {
	v, ok := legacyBlobKeys.Load(r.db)
	if !ok {
		var k legacyKeys
		if err := r.db.QueryRow(`SELECT
			EXISTS (SELECT 1 FROM shots s WHERE instr(s.data, '"timestamp"') > 0 AND s.data -> '$.timestamp' IS NOT NULL),
			EXISTS (SELECT 1 FROM shots s WHERE instr(s.data, '"annotation"') > 0 AND s.data -> '$.annotation' IS NOT NULL)`,
		).Scan(&k.timestamp, &k.annotation); err != nil {
			return "", "", fmt.Errorf("shots: probing data blobs for legacy keys: %w", err)
		}
		legacyBlobKeys.Store(r.db, k)
		v = k
	}
	k := v.(legacyKeys)
	ts, ann = "s.timestamp", "a.data"
	if k.timestamp {
		ts = hydratedTimestampSQL
	}
	if k.annotation {
		ann = hydratedAnnotationSQL
	}
	return ts, ann, nil
}

// TimestampsExcludingTrash returns every non-trashed shot's hydrated
// timestamp (as an int64 read of a hydrated shot sees it, see
// lightColumnsSQL), in FindAllExcludingTrash's order — the light read for
// the maintenance stats, which only count shots newer than a task's last
// date (#1616).
func (r *Repository) TimestampsExcludingTrash() ([]int64, error) {
	return r.timestamps(``)
}

// TimestampsExcludingTrashByMachine is TimestampsExcludingTrash scoped to
// one machine, matching FindAllExcludingTrashByMachine's filter.
func (r *Repository) TimestampsExcludingTrashByMachine(machineID int64) ([]int64, error) {
	return r.timestamps(` AND s.machine_id = ?`, machineID)
}

func (r *Repository) timestamps(filter string, args ...any) ([]int64, error) {
	tsSQL, _, err := r.lightColumnsSQL()
	if err != nil {
		return nil, err
	}
	rows, err := r.db.Query(`SELECT `+tsSQL+` FROM shots s WHERE s.id NOT IN (SELECT shot_id FROM trash)`+
		filter+` ORDER BY s.timestamp ASC`, args...)
	if err != nil {
		return nil, fmt.Errorf("shots: listing shot timestamps: %w", err)
	}
	defer rows.Close()
	var out []int64
	for rows.Next() {
		var ts sql.NullInt64
		if err := rows.Scan(&ts); err != nil {
			return nil, fmt.Errorf("shots: scanning shot timestamp: %w", err)
		}
		out = append(out, ts.Int64)
	}
	return out, rows.Err()
}

// CountByMachine counts every shot of one machine, trashed ones included —
// Count's machine-scoped counterpart.
func (r *Repository) CountByMachine(machineID int64) (int, error) {
	var n int
	if err := r.db.QueryRow(`SELECT COUNT(*) FROM shots WHERE machine_id = ?`, machineID).Scan(&n); err != nil {
		return 0, fmt.Errorf("shots: counting machine %d: %w", machineID, err)
	}
	return n, nil
}

// GrinderUse is one non-trashed shot's grinder-wear input, read without
// hydrating the shot (#1616): exactly the three values the library's
// burr-wear computation reads off a hydrated shot.
type GrinderUse struct {
	// Timestamp is the hydrated shot's timestamp as an int64 read sees it
	// — 0 when the data blob overrides it, see lightColumnsSQL.
	Timestamp int64
	// Grinder is the annotation's "grinder" when that is a JSON string,
	// else "".
	Grinder string
	// Dose is the annotation's "dose" as decoded JSON (nil when absent).
	Dose any
}

// GrinderUses returns every non-trashed shot's GrinderUse — the
// SQL-aggregate replacement for hydrating the whole history just to fold
// each grinder's wear (GET /api/library, the MCP get_library tool). Rows
// come in FindAllExcludingTrash's order: the wear sums doses as float64,
// and a different summation order can change the rounded gram total.
func (r *Repository) GrinderUses() ([]GrinderUse, error) {
	tsSQL, annSQL, err := r.lightColumnsSQL()
	if err != nil {
		return nil, err
	}
	rows, err := r.db.Query(`
		SELECT ts, ann -> '$.grinder', ann -> '$.dose' FROM (
			SELECT s.timestamp AS ord, ` + tsSQL + ` AS ts, ` + annSQL + ` AS ann
			FROM shots s LEFT JOIN annotations a ON a.shot_id = s.id
			WHERE s.id NOT IN (SELECT shot_id FROM trash)
		) ORDER BY ord ASC`)
	if err != nil {
		return nil, fmt.Errorf("shots: listing grinder uses: %w", err)
	}
	defer rows.Close()

	var out []GrinderUse
	for rows.Next() {
		var ts sql.NullInt64
		var grinder, dose sql.NullString
		if err := rows.Scan(&ts, &grinder, &dose); err != nil {
			return nil, fmt.Errorf("shots: scanning grinder use: %w", err)
		}
		u := GrinderUse{Timestamp: ts.Int64}
		if v, ok := decodeJSONValue(grinder).(string); ok {
			u.Grinder = v
		}
		u.Dose = decodeJSONValue(dose)
		out = append(out, u)
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
	// Only literal SQL fragments (never caller input) are concatenated; the
	// machineID/sinceSec values ride along as bound args.
	var conds []string
	var args []any
	if machineID != 0 {
		conds = append(conds, "machine_id = ?")
		args = append(args, machineID)
	}
	if sinceSec > 0 {
		conds = append(conds, "timestamp >= ?")
		args = append(args, sinceSec)
	}
	conds = append(conds, "id NOT IN (SELECT shot_id FROM trash)")
	query := "SELECT id FROM shots WHERE " + strings.Join(conds, " AND ") +
		" ORDER BY timestamp DESC, id DESC LIMIT 1"
	row := r.db.QueryRow(query, args...)
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
// FindAllExcludingTrash). GET /api/status's shotCount field (#901) and the
// maintenance log's shared-equipment shot count use it.
func (r *Repository) Count() (int, error) {
	var n int
	if err := r.db.QueryRow(`SELECT COUNT(*) FROM shots`).Scan(&n); err != nil {
		return 0, fmt.Errorf("shots: counting: %w", err)
	}
	return n, nil
}

// Upsert writes the shots row (and, if the shot object carries an `annotation`
// key, the annotations row too) straight from a sync-pulled or
// restored/imported shot object. Its statement must never go back to INSERT OR
// REPLACE (#1150) — see the inline comment on the Exec below.
// ownerMachineID gives a shot with no explicit machineId machine 1 by default.
// The ownerOfShotId inference (#719) isn't implemented (it needs
// internal/machines' MACHINE_ID_OFFSET arithmetic, out of scope here); that
// fallback is not expected to be reached in practice, because every backup the
// restore path handles was itself exported by an app version that always wrote
// machineId.
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
	// A re-synced shot can keep the same data length and timestamp while its
	// values (or duration) change — the SQL fingerprint the page query
	// recomputes would then still match, so drop the cached score outright
	// rather than let it serve the old one (#1609). Same reason saveAnnotation
	// invalidates on an annotation write.
	r.InvalidateScoreCache(row.id)
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
// (#402). "Earlier" orders by (timestamp, id): a shot is previous when its
// timestamp is older, or when it shares the reference shot's timestamp but has
// a lower id, so two shots taken in the same second are still ordered
// deterministically.
func (r *Repository) FindPreviousByProfile(shotID int64, profileName string, machineID int64) (Shot, error) {
	var refTimestamp int64
	if err := r.db.QueryRow(`SELECT timestamp FROM shots WHERE id = ?`, shotID).Scan(&refTimestamp); err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, fmt.Errorf("shots: reading timestamp of shot %d: %w", shotID, err)
	}
	row := r.db.QueryRow(selectBase+`
		WHERE s.machine_id = ?
		  AND s.profile_name = ?
		  AND (s.timestamp < ? OR (s.timestamp = ? AND s.id < ?))
		  AND s.id NOT IN (SELECT shot_id FROM trash)
		ORDER BY s.timestamp DESC, s.id DESC
		LIMIT 1
	`, machineID, profileName, refTimestamp, refTimestamp, shotID)
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
	return r.updateAnnotation(shotID, fn, nil)
}

// updateAnnotation is the locked read-modify-write behind UpdateAnnotation
// and PatchAnnotation. When after is non-nil it runs once the merged
// annotation is saved, still under annotationMu, so the annotation and
// after's side effects land together or not at all (#1411). Lock order is
// annotationMu first, then internal/library's writeMu; nothing may take them
// in the reverse order.
func (r *Repository) updateAnnotation(shotID int64, fn func(ann map[string]any) error, after func(prev, next map[string]any) error) (map[string]any, error) {
	annotationMu.Lock()
	defer annotationMu.Unlock()

	ann, err := r.GetAnnotation(shotID)
	if err != nil {
		return nil, err
	}
	prev := maps.Clone(ann)
	if err := fn(ann); err != nil {
		return nil, err
	}
	if err := r.saveAnnotation(shotID, ann); err != nil {
		return nil, err
	}
	if after != nil {
		if err := after(prev, ann); err != nil {
			if rerr := r.saveAnnotation(shotID, prev); rerr != nil {
				return nil, fmt.Errorf("%w (restoring annotation for shot %d: %v)", err, shotID, rerr)
			}
			return nil, fmt.Errorf("%w", err)
		}
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
