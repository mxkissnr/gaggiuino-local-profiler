package shots

import (
	"database/sql"
	"encoding/base64"
	"fmt"
	"slices"
	"strconv"
	"strings"
	"time"

	json "github.com/goccy/go-json"
)

// This file backs GET /api/shots (#957): a keyset-paginated, newest-first
// list of shot METADATA — every field a hydrated shot has except the
// `datapoints` curve blob, plus the score. It exists so listing the shot
// history costs O(page), not O(history): no request path here decodes more
// than `limit` shots' datapoints, and the response never carries the
// full-history curve payload the old GET /shots.json does.
//
// The score still needs each row's curve series, so scoring a page decodes
// `limit` datapoints blobs. shot_score_cache (internal/db/db.go) turns that
// into a one-time cost per shot: a cheap SQL-recomputable fingerprint of
// the scoring inputs is stored next to the score, so an unchanged shot is
// served from the cache without re-decoding its blob. The frontend walks
// every page in the background to fill S.allShots, so this matters — the
// first walk after a sync burst pays the decode once, every later one is
// cache hits.

// Cursor is the keyset position for a GET /api/shots page: the
// (timestamp, id) of the last row already returned. The zero value
// (Set == false) means "first page".
type Cursor struct {
	Timestamp int64
	ID        int64
	Set       bool
}

// EncodeCursor renders a Cursor as the opaque `?cursor=` token clients pass
// back verbatim — base64url of "<timestamp>.<id>". An unset cursor encodes
// to "" (first page).
func EncodeCursor(c Cursor) string {
	if !c.Set {
		return ""
	}
	return base64.RawURLEncoding.EncodeToString([]byte(strconv.FormatInt(c.Timestamp, 10) + "." + strconv.FormatInt(c.ID, 10)))
}

// DecodeCursor parses a `?cursor=` token. An empty string is the first page
// (zero Cursor, nil error). A malformed token is an error — the handler
// turns that into a 400 rather than silently serving page 1, so a client
// paging with a stale/corrupt cursor finds out instead of looping over the
// first page forever.
func DecodeCursor(token string) (Cursor, error) {
	if token == "" {
		return Cursor{}, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil {
		return Cursor{}, fmt.Errorf("shots: bad cursor encoding: %w", err)
	}
	ts, id, ok := strings.Cut(string(raw), ".")
	if !ok {
		return Cursor{}, fmt.Errorf("shots: bad cursor payload %q", raw)
	}
	tsN, err := strconv.ParseInt(ts, 10, 64)
	if err != nil {
		return Cursor{}, fmt.Errorf("shots: bad cursor timestamp: %w", err)
	}
	idN, err := strconv.ParseInt(id, 10, 64)
	if err != nil {
		return Cursor{}, fmt.Errorf("shots: bad cursor id: %w", err)
	}
	return Cursor{Timestamp: tsN, ID: idN, Set: true}, nil
}

// PageRow is one entry of a GET /api/shots response: the hydrated shot with
// its `datapoints` key removed (handler-side, see json envelope), plus the
// resolved score fields and hasChartData. Score is nil for a shot with too
// little data to score at all (matching CalcShotScoreDetail).
type PageRow struct {
	// id is the row's id column (the hydrated Shot's "id" can differ for a
	// legacy blob carrying its own "id" key).
	id               int64
	Shot             Shot
	Score            *int
	UsedBeanTarget   bool
	HasChartData     bool
	TempStabilityDev *float64
}

// Page is a slice of PageRows plus the keyset state to fetch the next one.
type Page struct {
	Rows       []PageRow
	NextCursor Cursor
	HasMore    bool
}

// pageColumns is selectBase's column list plus the three shot_score_cache
// columns and the SQL-recomputed fingerprint, in the order scanPageRow
// scans them. The scoreVersion prefix (score.go) is the score-version tag: it
// is not derived from the shot at all, so bumping it invalidates every cached
// row at once.
// #1538 changed what counts as scoreable (a sub-5-bar shot now scores), so
// every pre-#1538 cached score is stale and must be recomputed — a plain
// rescan of the same row would otherwise keep serving the old nil score.
// v3 folds the shot's duration into the fingerprint (IFNULL'd because the
// column is nullable): duration is part of the score input, so a re-sync that
// only changes it must miss the cache instead of serving the old score (#1609).
const pageColumns = `s.id, s.timestamp, s.duration, s.profile_name, s.data, s.machine_id, a.data AS ann_data,
	c.score, c.used_bean_target, c.fingerprint,
	('` + scoreVersion + `:' || length(s.data) || ':' || s.timestamp || ':' || IFNULL(s.duration, 0) || ':' || IFNULL(length(a.data), 0)) AS fp`

// FindPageExcludingTrash returns one keyset page of non-trashed shots,
// newest first (timestamp DESC, id DESC), resolving each row's score
// through shot_score_cache (backfilling misses). machineID == 0 means "all
// machines". limit is the page size; the method fetches limit+1 rows to
// report HasMore without a second COUNT query.
//
// It scores against the generic bands (lookup nil) and is now only a test
// helper — production callers go through Service.GetPage, which uses
// findPage with a loadBeanLookup source so the cache key includes the
// resolved bean target.
func (r *Repository) FindPageExcludingTrash(cur Cursor, limit int, machineID int64) (Page, error) {
	return r.findPage(cur, limit, machineID, nil)
}

func (r *Repository) findPage(cur Cursor, limit int, machineID int64, lookup beanLookup) (Page, error) {
	var sb strings.Builder
	sb.WriteString(`SELECT `)
	sb.WriteString(pageColumns)
	sb.WriteString(`
		FROM shots s
		LEFT JOIN annotations a ON a.shot_id = s.id
		LEFT JOIN shot_score_cache c ON c.shot_id = s.id
		WHERE s.id NOT IN (SELECT shot_id FROM trash)`)

	var args []any
	if machineID != 0 {
		sb.WriteString(" AND s.machine_id = ?")
		args = append(args, machineID)
	}
	if cur.Set {
		sb.WriteString(" AND (s.timestamp < ? OR (s.timestamp = ? AND s.id < ?))")
		args = append(args, cur.Timestamp, cur.Timestamp, cur.ID)
	}
	sb.WriteString(" ORDER BY s.timestamp DESC, s.id DESC LIMIT ?")
	args = append(args, limit+1)

	return r.runPageQuery(sb.String(), args, limit, lookup)
}

// FindTrashedPage mirrors FindPageExcludingTrash but drives the join FROM
// trash (like FindTrashed), so it lists only trashed shots, newest first.
// Like FindPageExcludingTrash it scores against the generic bands and is
// only a test helper; production callers use Service.GetTrashPage →
// findTrashedPage with a bean lookup.
func (r *Repository) FindTrashedPage(cur Cursor, limit int, machineID int64) (Page, error) {
	return r.findTrashedPage(cur, limit, machineID, nil)
}

func (r *Repository) findTrashedPage(cur Cursor, limit int, machineID int64, lookup beanLookup) (Page, error) {
	var sb strings.Builder
	sb.WriteString(`SELECT `)
	sb.WriteString(pageColumns)
	sb.WriteString(`
		FROM trash t
		JOIN shots s ON s.id = t.shot_id
		LEFT JOIN annotations a ON a.shot_id = s.id
		LEFT JOIN shot_score_cache c ON c.shot_id = s.id
		WHERE 1 = 1`)

	var args []any
	if machineID != 0 {
		sb.WriteString(" AND s.machine_id = ?")
		args = append(args, machineID)
	}
	if cur.Set {
		sb.WriteString(" AND (s.timestamp < ? OR (s.timestamp = ? AND s.id < ?))")
		args = append(args, cur.Timestamp, cur.Timestamp, cur.ID)
	}
	sb.WriteString(" ORDER BY s.timestamp DESC, s.id DESC LIMIT ?")
	args = append(args, limit+1)

	return r.runPageQuery(sb.String(), args, limit, lookup)
}

func (r *Repository) runPageQuery(query string, args []any, limit int, lookup beanLookup) (Page, error) {
	rows, err := r.db.Query(query, args...)
	if err != nil {
		return Page{}, fmt.Errorf("shots: listing shot page: %w", err)
	}
	defer rows.Close()

	var (
		page     Page
		backfill []scoreCacheRow
	)
	for rows.Next() {
		row, bf, err := r.scanPageRow(rows, lookup, true)
		if err != nil {
			return Page{}, err
		}
		if bf != nil {
			backfill = append(backfill, *bf)
		}
		page.Rows = append(page.Rows, row)
	}
	if err := rows.Err(); err != nil {
		return Page{}, err
	}

	if len(page.Rows) > limit {
		page.Rows = page.Rows[:limit]
		page.HasMore = true
		// Any cache row we would have backfilled for the dropped look-ahead
		// entry is harmless to write, but trim it so a backfill batch never
		// depends on rows the caller never sees.
		if len(backfill) > 0 && len(backfill) > limit {
			backfill = backfill[:limit]
		}
	}
	if n := len(page.Rows); n > 0 {
		last := page.Rows[n-1].Shot
		page.NextCursor = Cursor{Timestamp: last["timestamp"].(int64), ID: last.id(), Set: true}
	}

	if len(backfill) > 0 {
		r.backfillScoreCache(backfill)
	}
	return page, nil
}

// scoredFrom is the join every score-cache-backed read selects
// pageColumns from.
const scoredFrom = `
		FROM shots s
		LEFT JOIN annotations a ON a.shot_id = s.id
		LEFT JOIN shot_score_cache c ON c.shot_id = s.id`

// scoredShots runs a pageColumns query and resolves each row's score
// through shot_score_cache exactly like a GET /api/shots page (a miss is
// computed and backfilled), without the page-only chart stats.
func (r *Repository) scoredShots(query string, args []any, lookup beanLookup) ([]PageRow, error) {
	rows, err := r.db.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("shots: listing scored shots: %w", err)
	}
	defer rows.Close()

	var (
		out      []PageRow
		backfill []scoreCacheRow
	)
	for rows.Next() {
		row, bf, err := r.scanPageRow(rows, lookup, false)
		if err != nil {
			return nil, err
		}
		if bf != nil {
			backfill = append(backfill, *bf)
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(backfill) > 0 {
		r.backfillScoreCache(backfill)
	}
	return out, nil
}

// FindAllScoredExcludingTrash is FindAllExcludingTrash (same shots, same
// order: the timestamp index breaks a tie on the id) with each shot's score
// resolved through the score cache instead of recomputed — GET /shots.json
// (#1616). limit > 0 keeps only the newest limit shots, still oldest first.
func (r *Repository) FindAllScoredExcludingTrash(limit int, lookup beanLookup) ([]PageRow, error) {
	q := `SELECT ` + pageColumns + scoredFrom + ` WHERE s.id NOT IN (SELECT shot_id FROM trash)`
	if limit <= 0 {
		return r.scoredShots(q+` ORDER BY s.timestamp ASC, s.id ASC`, nil, lookup)
	}
	rows, err := r.scoredShots(q+` ORDER BY s.timestamp DESC, s.id DESC LIMIT ?`, []any{limit}, lookup)
	if err != nil {
		return nil, err
	}
	slices.Reverse(rows)
	return rows, nil
}

// EachScoredExcludingTrash streams FindAllScoredExcludingTrash's shots (same
// shots, same order) to fn one at a time, each with its score resolved
// through the score cache — the achievements evaluation (#1721), which keeps
// a few values per shot instead of the hydrated history. The shot passed to
// fn is only valid for that call, and fn must not query the database (the
// scan's rows are still open). Cache misses are backfilled after the scan; a
// non-nil error from fn stops it.
func (r *Repository) EachScoredExcludingTrash(lookup func(Shot) *Bean, fn func(shot Shot, score *int) error) error {
	rows, err := r.db.Query(`SELECT ` + pageColumns + scoredFrom +
		` WHERE s.id NOT IN (SELECT shot_id FROM trash) ORDER BY s.timestamp ASC, s.id ASC`)
	if err != nil {
		return fmt.Errorf("shots: streaming scored shots: %w", err)
	}
	var backfill []scoreCacheRow
	err = func() error {
		defer rows.Close()
		for rows.Next() {
			row, bf, err := r.scanPageRow(rows, lookup, false)
			if err != nil {
				return err
			}
			if bf != nil {
				backfill = append(backfill, *bf)
			}
			if err := fn(row.Shot, row.Score); err != nil {
				return err
			}
		}
		return rows.Err()
	}()
	if err != nil {
		return err
	}
	if len(backfill) > 0 {
		r.backfillScoreCache(backfill)
	}
	return nil
}

// scoredIDsChunk bounds the bound-parameter list of one scoredShotsByIDs
// query, well under SQLite's variable limit.
const scoredIDsChunk = 500

// scoredShotsByIDs hydrates and scores (through the cache) the shots with
// the given ids, in chunks.
func (r *Repository) scoredShotsByIDs(ids []int64, lookup beanLookup) ([]PageRow, error) {
	var out []PageRow
	for start := 0; start < len(ids); start += scoredIDsChunk {
		chunk := ids[start:min(start+scoredIDsChunk, len(ids))]
		args := make([]any, len(chunk))
		for i, id := range chunk {
			args[i] = id
		}
		rows, err := r.scoredShots(`SELECT `+pageColumns+scoredFrom+
			` WHERE s.id IN (?`+strings.Repeat(`,?`, len(chunk)-1)+`)`, args, lookup)
		if err != nil {
			return nil, err
		}
		out = append(out, rows...)
	}
	return out, nil
}

// scoredCandidate is one comparative-advice candidate: the light shot it
// was matched on and its score.
type scoredCandidate struct {
	light Shot
	score *int
}

// comparativeCandidates returns the non-trashed shots of machineID that
// keep accepts, each with its score resolved through the score cache — the
// comparative-advice read (#1616), which used to hydrate and rescore the
// machine's whole history to keep a handful of shots.
//
// keep sees a light shot: "id" and "profileName" from their columns and
// the annotation from SQL (no curve blobs). Only the kept shots are then
// hydrated, and only for their score; the match itself stays on the light
// values.
func (r *Repository) comparativeCandidates(machineID int64, keep func(Shot) bool, lookup beanLookup) ([]scoredCandidate, error) {
	rows, err := r.db.Query(`SELECT s.id, s.profile_name, a.shot_id IS NOT NULL, `+hydratedAnnotationSQL+`
		FROM shots s LEFT JOIN annotations a ON a.shot_id = s.id
		WHERE s.machine_id = ? AND s.id NOT IN (SELECT shot_id FROM trash)`, machineID)
	if err != nil {
		return nil, fmt.Errorf("shots: listing comparative candidates: %w", err)
	}
	var (
		ids  []int64
		kept = map[int64]Shot{}
	)
	err = func() error {
		defer rows.Close()
		for rows.Next() {
			var (
				id     int64
				pn     sql.NullString
				hasRow bool
				ann    sql.NullString
			)
			if err := rows.Scan(&id, &pn, &hasRow, &ann); err != nil {
				return fmt.Errorf("shots: scanning comparative candidate: %w", err)
			}
			light, err := lightShot(id, pn, hasRow, ann)
			if err != nil {
				return err
			}
			if keep(light) {
				ids = append(ids, id)
				kept[id] = light
			}
		}
		return rows.Err()
	}()
	if err != nil {
		return nil, err
	}
	scored, err := r.scoredShotsByIDs(ids, lookup)
	if err != nil {
		return nil, err
	}
	out := make([]scoredCandidate, 0, len(scored))
	for _, row := range scored {
		if light, ok := kept[row.id]; ok {
			out = append(out, scoredCandidate{light: light, score: row.Score})
		}
	}
	return out, nil
}

// lightShot builds the "id"/"profileName"/"annotation" part of a hydrated
// shot from SQL values, with hydrateFields' rules and decoder: an annotations row must
// decode as an object (an error otherwise, as hydration fails), a legacy
// blob annotation is any decoded value, and no annotation at all is {}.
func lightShot(id int64, profileName sql.NullString, hasAnnotationRow bool, ann sql.NullString) (Shot, error) {
	var pn any
	if profileName.Valid {
		pn = profileName.String
	}
	shot := Shot{"id": id, "profileName": pn}
	switch {
	case hasAnnotationRow:
		var m map[string]any
		if err := json.Unmarshal([]byte(ann.String), &m); err != nil {
			return nil, fmt.Errorf("shots: decoding annotation for shot %d: %w", id, err)
		}
		shot["annotation"] = m
	case ann.Valid:
		shot["annotation"] = decodeJSONValue(ann)
	default:
		shot["annotation"] = map[string]any{}
	}
	return shot, nil
}

type scoreCacheRow struct {
	shotID         int64
	score          *int
	usedBeanTarget bool
	fingerprint    string
}

// scanPageRow scans one joined shots+annotations+shot_score_cache row,
// hydrates the shot, and resolves its score: a fingerprint hit uses the
// cached score, a miss (or an absent cache row) computes it via
// CalcShotScoreDetail and returns a *scoreCacheRow for the caller to
// backfill. lookup (nil = generic bands) resolves each shot's bean target;
// that target is folded into the fingerprint, so editing a bean's
// brewTempC/brewRatio misses the cache and recomputes instead of serving the
// old score forever. withChart fills HasChartData/TempStabilityDev; callers
// that only need the score (comparative advice, /shots.json) skip them.
func (r *Repository) scanPageRow(sc rowScanner, lookup beanLookup, withChart bool) (PageRow, *scoreCacheRow, error) {
	var (
		id, timestamp, machineID int64
		duration                 sql.NullInt64
		profileName              sql.NullString
		data                     string
		annData                  sql.NullString
		cachedScore              sql.NullInt64
		cachedUBT                sql.NullBool
		cachedFingerprint        sql.NullString
		fingerprint              string
	)
	if err := sc.Scan(&id, &timestamp, &duration, &profileName, &data, &machineID,
		&annData, &cachedScore, &cachedUBT, &cachedFingerprint, &fingerprint); err != nil {
		return PageRow{}, nil, err
	}

	shot, err := hydrateFields(id, timestamp, machineID, duration, profileName, data, annData)
	if err != nil {
		return PageRow{}, nil, err
	}

	var bean *Bean
	if lookup != nil {
		bean = lookup(shot)
	}
	fp := fingerprint + "|" + beanTargetSignature(bean)

	row := PageRow{id: id, Shot: shot}
	// hasChartData / tempStabilityDev are derived from the raw datapoints
	// bytes on every row (cache hit or miss) — one shared split of the blob
	// (#1616: it used to be split once per value), bounded by page size.
	if withChart {
		row.HasChartData, row.TempStabilityDev = chartStats(shot["datapoints"])
	}

	if cachedFingerprint.Valid && cachedFingerprint.String == fp {
		if cachedScore.Valid {
			v := int(cachedScore.Int64)
			row.Score = &v
		}
		row.UsedBeanTarget = cachedUBT.Bool
		return row, nil, nil
	}

	detail := CalcShotScoreDetail(shot, bean)
	row.Score = detail.Score
	row.UsedBeanTarget = detail.UsedBeanTarget
	return row, &scoreCacheRow{
		shotID:         id,
		score:          detail.Score,
		usedBeanTarget: detail.UsedBeanTarget,
		fingerprint:    fp,
	}, nil
}

// beanTargetSignature renders a resolved *Bean into a stable string appended
// to the shot fingerprint, so a changed bean target invalidates the cached
// score. Empty for a nil bean (no bean resolved → generic bands).
func beanTargetSignature(bean *Bean) string {
	if bean == nil {
		return ""
	}
	temp := ""
	if bean.BrewTempC != nil {
		temp = strconv.FormatFloat(*bean.BrewTempC, 'g', -1, 64)
	}
	return "t=" + temp + ";r=" + bean.BrewRatio
}

// backfillScoreCache writes recomputed score rows in one transaction. A
// failure here is logged-and-swallowed by design: the cache is a pure
// optimisation, and a GET /api/shots must still succeed (with a correct,
// freshly computed score) on a read-only DB or a write contention blip.
func (r *Repository) backfillScoreCache(rows []scoreCacheRow) {
	tx, err := r.db.Begin()
	if err != nil {
		return
	}
	stmt, err := tx.Prepare(`INSERT OR REPLACE INTO shot_score_cache
		(shot_id, score, used_bean_target, fingerprint, computed_at) VALUES (?, ?, ?, ?, ?)`)
	if err != nil {
		tx.Rollback()
		return
	}
	now := time.Now().UnixMilli()
	for _, row := range rows {
		var score any
		if row.score != nil {
			score = *row.score
		}
		if _, err := stmt.Exec(row.shotID, score, boolToInt(row.usedBeanTarget), row.fingerprint, now); err != nil {
			stmt.Close()
			tx.Rollback()
			return
		}
	}
	stmt.Close()
	_ = tx.Commit()
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

// InvalidateScoreCache drops a shot's cached score — called when its
// annotation changes (dose/tds feed the score) or the shot is deleted.
func (r *Repository) InvalidateScoreCache(shotID int64) {
	_, _ = r.db.Exec(`DELETE FROM shot_score_cache WHERE shot_id = ?`, shotID)
}

// stripDatapoints removes the curve blob from a hydrated shot in place —
// the metadata-only projection GET /api/shots rows carry. hydrateRow keeps
// datapoints as a json.RawMessage, so this is a map delete, not a
// re-marshal.
func stripDatapoints(shot Shot) {
	delete(shot, "datapoints")
}
