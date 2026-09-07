package shots

import (
	"database/sql"
	"encoding/base64"
	"fmt"
	"strconv"
	"strings"
	"time"
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
// scans them.
const pageColumns = `s.id, s.timestamp, s.duration, s.profile_name, s.data, s.machine_id, a.data AS ann_data,
	c.score, c.used_bean_target, c.fingerprint,
	(length(s.data) || ':' || s.timestamp || ':' || IFNULL(length(a.data), 0)) AS fp`

// FindPageExcludingTrash returns one keyset page of non-trashed shots,
// newest first (timestamp DESC, id DESC), resolving each row's score
// through shot_score_cache (backfilling misses). machineID == 0 means "all
// machines". limit is the page size; the method fetches limit+1 rows to
// report HasMore without a second COUNT query.
func (r *Repository) FindPageExcludingTrash(cur Cursor, limit int, machineID int64) (Page, error) {
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

	return r.runPageQuery(sb.String(), args, limit)
}

// FindTrashedPage mirrors FindPageExcludingTrash but drives the join FROM
// trash (like FindTrashed), so it lists only trashed shots, newest first.
func (r *Repository) FindTrashedPage(cur Cursor, limit int, machineID int64) (Page, error) {
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

	return r.runPageQuery(sb.String(), args, limit)
}

func (r *Repository) runPageQuery(query string, args []any, limit int) (Page, error) {
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
		row, bf, err := r.scanPageRow(rows)
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
// backfill.
func (r *Repository) scanPageRow(sc rowScanner) (PageRow, *scoreCacheRow, error) {
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

	row := PageRow{Shot: shot}
	// hasChartData / tempStabilityDev are derived from the raw datapoints
	// bytes on every row (cache hit or miss) — one shallow tokenize each,
	// bounded by page size, never the full score-series decode.
	row.HasChartData = hasChartSeries(shot["datapoints"])
	row.TempStabilityDev = tempStabilityDev(shot["datapoints"])

	if cachedFingerprint.Valid && cachedFingerprint.String == fingerprint {
		if cachedScore.Valid {
			v := int(cachedScore.Int64)
			row.Score = &v
		}
		row.UsedBeanTarget = cachedUBT.Bool
		return row, nil, nil
	}

	detail := CalcShotScoreDetail(shot, nil)
	row.Score = detail.Score
	row.UsedBeanTarget = detail.UsedBeanTarget
	return row, &scoreCacheRow{
		shotID:         id,
		score:          detail.Score,
		usedBeanTarget: detail.UsedBeanTarget,
		fingerprint:    fingerprint,
	}, nil
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
