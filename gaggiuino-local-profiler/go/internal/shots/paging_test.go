package shots

import (
	stdjson "encoding/json"
	"net/http"
	"testing"
)

// ── Cursor round-trip ──────────────────────────────────────────────────

func TestCursor_RoundTrips(t *testing.T) {
	in := Cursor{Timestamp: 1_700_000_123, ID: 42, Set: true}
	tok := EncodeCursor(in)
	if tok == "" {
		t.Fatal("EncodeCursor of a set cursor returned empty")
	}
	got, err := DecodeCursor(tok)
	if err != nil {
		t.Fatalf("DecodeCursor: %v", err)
	}
	if got != in {
		t.Fatalf("round trip: got %+v, want %+v", got, in)
	}

	if EncodeCursor(Cursor{}) != "" {
		t.Error("EncodeCursor of the zero cursor should be empty")
	}
	if z, err := DecodeCursor(""); err != nil || z.Set {
		t.Errorf("DecodeCursor(\"\") = %+v, %v; want zero cursor, nil", z, err)
	}
	if _, err := DecodeCursor("not-base64!!"); err == nil {
		t.Error("DecodeCursor of garbage should error")
	}
	if _, err := DecodeCursor(EncodeCursor(Cursor{Timestamp: 1, ID: 2, Set: true})[:3]); err == nil {
		t.Error("DecodeCursor of a truncated token should error")
	}
}

// ── FindPageExcludingTrash ─────────────────────────────────────────────

func seedShots(t testing.TB, r *Repository, n int) {
	t.Helper()
	dur := int64(300)
	for i := 1; i <= n; i++ {
		insertShot(t, r.db, int64(i), int64(i*1000), &dur, "V60",
			map[string]any{"datapoints": bigDatapoints(40)},
			map[string]any{"dose": 18.0})
	}
}

func TestFindPage_NewestFirstAndPaginatesToExhaustion(t *testing.T) {
	_, repo, _ := newTestHandlers(t)
	seedShots(t, repo, 25)

	var seen []int64
	cur := Cursor{}
	pages := 0
	for {
		page, err := repo.FindPageExcludingTrash(cur, 10, 0)
		if err != nil {
			t.Fatalf("FindPageExcludingTrash: %v", err)
		}
		pages++
		for _, row := range page.Rows {
			seen = append(seen, row.Shot.id())
		}
		if !page.HasMore {
			break
		}
		cur = page.NextCursor
		if pages > 10 {
			t.Fatal("paging did not terminate")
		}
	}
	if len(seen) != 25 {
		t.Fatalf("saw %d shots across pages, want 25", len(seen))
	}
	for i := 1; i < len(seen); i++ {
		if seen[i-1] <= seen[i] {
			t.Fatalf("not newest-first at %d: %v", i, seen)
		}
	}
	if seen[0] != 25 || seen[24] != 1 {
		t.Fatalf("boundaries wrong: first=%d last=%d", seen[0], seen[24])
	}
}

func TestFindPage_HasMoreLookahead(t *testing.T) {
	_, repo, _ := newTestHandlers(t)
	seedShots(t, repo, 6)

	page, err := repo.FindPageExcludingTrash(Cursor{}, 6, 0)
	if err != nil {
		t.Fatalf("FindPageExcludingTrash: %v", err)
	}
	if page.HasMore {
		t.Error("exactly limit rows should not report HasMore")
	}
	if len(page.Rows) != 6 {
		t.Fatalf("got %d rows, want 6", len(page.Rows))
	}

	page, _ = repo.FindPageExcludingTrash(Cursor{}, 5, 0)
	if !page.HasMore {
		t.Error("more rows than limit should report HasMore")
	}
	if len(page.Rows) != 5 {
		t.Fatalf("got %d rows, want limit 5", len(page.Rows))
	}
}

func TestFindPage_TimestampTieBreaksOnID(t *testing.T) {
	_, repo, _ := newTestHandlers(t)
	dur := int64(300)
	for _, id := range []int64{3, 7, 5} {
		insertShot(t, repo.db, id, 9000, &dur, "V60", nil, nil)
	}

	// Page size 2 so the page boundary lands mid-tie.
	p1, _ := repo.FindPageExcludingTrash(Cursor{}, 2, 0)
	if p1.Rows[0].Shot.id() != 7 || p1.Rows[1].Shot.id() != 5 {
		t.Fatalf("page 1 = [%d,%d], want [7,5]", p1.Rows[0].Shot.id(), p1.Rows[1].Shot.id())
	}
	if !p1.HasMore {
		t.Fatal("expected HasMore after 2 of 3 tied rows")
	}
	p2, _ := repo.FindPageExcludingTrash(p1.NextCursor, 2, 0)
	if len(p2.Rows) != 1 || p2.Rows[0].Shot.id() != 3 {
		t.Fatalf("page 2 = %v, want [3]", p2.Rows)
	}
}

func TestFindPage_MachineFilterAndTrash(t *testing.T) {
	_, repo, sqlDB := newTestHandlers(t)
	dur := int64(300)
	insertShot(t, sqlDB, 1, 1000, &dur, "V60", nil, nil)
	insertShot(t, sqlDB, 2, 2000, &dur, "V60", nil, nil)
	if _, err := sqlDB.Exec(`UPDATE shots SET machine_id = 2 WHERE id = 2`); err != nil {
		t.Fatal(err)
	}
	insertShot(t, sqlDB, 3, 3000, &dur, "V60", nil, nil)
	if err := repo.MoveToTrash(3); err != nil {
		t.Fatal(err)
	}

	all, _ := repo.FindPageExcludingTrash(Cursor{}, 60, 0)
	if len(all.Rows) != 2 {
		t.Fatalf("all-machine live page = %d rows, want 2 (3 is trashed)", len(all.Rows))
	}
	m2, _ := repo.FindPageExcludingTrash(Cursor{}, 60, 2)
	if len(m2.Rows) != 1 || m2.Rows[0].Shot.id() != 2 {
		t.Fatalf("machine-2 page = %v, want [2]", m2.Rows)
	}
	trash, _ := repo.FindTrashedPage(Cursor{}, 60, 0)
	if len(trash.Rows) != 1 || trash.Rows[0].Shot.id() != 3 {
		t.Fatalf("trash page = %v, want [3]", trash.Rows)
	}
}

func TestFindPage_EmptyDB(t *testing.T) {
	_, repo, _ := newTestHandlers(t)
	page, err := repo.FindPageExcludingTrash(Cursor{}, 60, 0)
	if err != nil {
		t.Fatalf("FindPageExcludingTrash on empty DB: %v", err)
	}
	if len(page.Rows) != 0 || page.HasMore || page.NextCursor.Set {
		t.Fatalf("empty DB page = %+v", page)
	}
}

// ── shot_score_cache read-through ──────────────────────────────────────

func cachedScoreRow(t testing.TB, r *Repository, shotID int64) (fp string, ok bool) {
	t.Helper()
	var fpv string
	err := r.db.QueryRow(`SELECT fingerprint FROM shot_score_cache WHERE shot_id = ?`, shotID).Scan(&fpv)
	if err != nil {
		return "", false
	}
	return fpv, true
}

func TestScoreCache_BackfilledOnReadThenReused(t *testing.T) {
	_, repo, _ := newTestHandlers(t)
	seedShots(t, repo, 3)

	if _, ok := cachedScoreRow(t, repo, 2); ok {
		t.Fatal("cache should be empty before the first list read")
	}

	p1, _ := repo.FindPageExcludingTrash(Cursor{}, 60, 0)
	want := p1.Rows[0].Score

	fp1, ok := cachedScoreRow(t, repo, 3)
	if !ok {
		t.Fatal("expected a cache row after the first read")
	}

	// Second read: same fingerprint -> served from cache, identical score.
	p2, _ := repo.FindPageExcludingTrash(Cursor{}, 60, 0)
	got := p2.Rows[0].Score
	switch {
	case want == nil && got == nil:
	case want == nil || got == nil || *want != *got:
		t.Fatalf("cached score diverged: first=%v second=%v", want, got)
	}
	if fp2, _ := cachedScoreRow(t, repo, 3); fp2 != fp1 {
		t.Fatalf("fingerprint changed across identical reads: %q -> %q", fp1, fp2)
	}
}

func TestScoreCache_InvalidatedByAnnotation(t *testing.T) {
	_, repo, _ := newTestHandlers(t)
	seedShots(t, repo, 1)

	repo.FindPageExcludingTrash(Cursor{}, 60, 0) // backfill
	if _, ok := cachedScoreRow(t, repo, 1); !ok {
		t.Fatal("expected cache row after read")
	}

	if err := repo.SaveAnnotation(1, map[string]any{"dose": 20.0}); err != nil {
		t.Fatalf("SaveAnnotation: %v", err)
	}
	if _, ok := cachedScoreRow(t, repo, 1); ok {
		t.Fatal("SaveAnnotation must drop the cached score row")
	}
}

func TestTempStabilityDev_MeanAbsDeviationOverTen(t *testing.T) {
	// temp - target: |950-940|,|960-940|,|930-940| = 10,20,10 -> mean 13.33
	// /10 -> 1.333 (analytics.js _tempStability convention).
	dp := map[string]any{
		"temperature":       []any{950.0, 960.0, 930.0},
		"targetTemperature": []any{940.0, 940.0, 940.0},
		"pressure":          []any{90.0, 90.0, 90.0},
		"timeInShot":        []any{0.0, 10.0, 20.0},
	}
	got := tempStabilityDev(map[string]any(dp))
	if got == nil || *got < 1.33 || *got > 1.34 {
		t.Fatalf("tempStabilityDev = %v, want ~1.333", got)
	}
	// A zero target sample is skipped, not counted as a huge deviation.
	if d := tempStabilityDev(map[string]any{"temperature": []any{950.0}, "targetTemperature": []any{0.0}}); d != nil {
		t.Fatalf("all-zero-target series should yield nil, got %v", *d)
	}
	// raw-bytes path matches the map path.
	raw := stdjson.RawMessage(`{"temperature":[950,960,930],"targetTemperature":[940,940,940]}`)
	if d := tempStabilityDev(raw); d == nil || *d < 1.33 || *d > 1.34 {
		t.Fatalf("raw path tempStabilityDev = %v, want ~1.333", d)
	}
}

// ── GET /api/shots handler ────────────────────────────────────────────

func TestListShotsPage_EnvelopeAndSlimRows(t *testing.T) {
	h, repo, _ := newTestHandlers(t)
	mux := newMux(h)
	seedShots(t, repo, 3)

	rec := doJSON(t, mux, http.MethodGet, "/api/shots?limit=2", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d; body=%s", rec.Code, rec.Body.String())
	}
	var env struct {
		Shots      []map[string]any `json:"shots"`
		NextCursor *string          `json:"nextCursor"`
		HasMore    bool             `json:"hasMore"`
	}
	if err := stdjson.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(env.Shots) != 2 || !env.HasMore || env.NextCursor == nil {
		t.Fatalf("envelope = %+v", env)
	}
	for _, row := range env.Shots {
		if _, ok := row["datapoints"]; ok {
			t.Errorf("row %v still carries datapoints", row["id"])
		}
		for _, k := range []string{"score", "usedBeanTarget", "hasChartData", "tempStabilityDev"} {
			if _, ok := row[k]; !ok {
				t.Errorf("row %v missing %q", row["id"], k)
			}
		}
		if row["hasChartData"] != true {
			t.Errorf("row %v hasChartData = %v, want true (seeded with a pressure series)", row["id"], row["hasChartData"])
		}
	}
	if int64(env.Shots[0]["id"].(float64)) != 3 {
		t.Errorf("first row id = %v, want newest (3)", env.Shots[0]["id"])
	}

	// Follow the cursor to exhaustion.
	rec = doJSON(t, mux, http.MethodGet, "/api/shots?limit=2&cursor="+*env.NextCursor, nil)
	stdjson.Unmarshal(rec.Body.Bytes(), &env)
	if len(env.Shots) != 1 || env.HasMore {
		t.Fatalf("last page = %+v", env)
	}
}

func TestListShotsPage_LimitClampingAndBadCursor(t *testing.T) {
	h, repo, _ := newTestHandlers(t)
	mux := newMux(h)
	seedShots(t, repo, 5)

	// limit above the max clamps rather than erroring.
	rec := doJSON(t, mux, http.MethodGet, "/api/shots?limit=99999", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("clamp: status = %d", rec.Code)
	}
	// limit=0 -> default.
	rec = doJSON(t, mux, http.MethodGet, "/api/shots?limit=0", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("limit=0: status = %d", rec.Code)
	}
	// Bad cursor -> 400. "Z2FyYmFnZQ" is valid base64url but decodes to
	// "garbage", which has no "<ts>.<id>" shape.
	rec = doJSON(t, mux, http.MethodGet, "/api/shots?cursor=Z2FyYmFnZQ", nil)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("bad cursor: status = %d, want 400", rec.Code)
	}
	// Not even base64 -> 400.
	rec = doJSON(t, mux, http.MethodGet, "/api/shots?cursor=abc.def.ghi", nil)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("non-base64 cursor: status = %d, want 400", rec.Code)
	}
}

func TestListShotsPage_TrashAndMachineParams(t *testing.T) {
	h, _, sqlDB := newTestHandlers(t)
	mux := newMux(h)
	dur := int64(300)
	insertShot(t, sqlDB, 1, 1000, &dur, "V60", nil, nil)
	insertShot(t, sqlDB, 2, 2000, &dur, "V60", nil, nil)
	sqlDB.Exec(`UPDATE shots SET machine_id = 2 WHERE id = 2`)
	insertShot(t, sqlDB, 3, 3000, &dur, "V60", nil, nil)
	if err := NewRepository(sqlDB).MoveToTrash(3); err != nil {
		t.Fatal(err)
	}

	get := func(q string) []map[string]any {
		rec := doJSON(t, mux, http.MethodGet, "/api/shots"+q, nil)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: status %d", q, rec.Code)
		}
		var env struct {
			Shots []map[string]any `json:"shots"`
		}
		stdjson.Unmarshal(rec.Body.Bytes(), &env)
		return env.Shots
	}

	if rows := get("?machine=2"); len(rows) != 1 || int64(rows[0]["id"].(float64)) != 2 {
		t.Errorf("?machine=2 = %v", rows)
	}
	if rows := get("?machine=all"); len(rows) != 2 {
		t.Errorf("?machine=all = %d rows, want 2", len(rows))
	}
	if rows := get("?trash=1"); len(rows) != 1 || int64(rows[0]["id"].(float64)) != 3 {
		t.Errorf("?trash=1 = %v", rows)
	}
}

// TestListShotsPage_DoesNotShadowSiblingRoutes pins that registering
// "GET /api/shots" leaves "/api/shots/{id}", "/last" and "/defaults"
// reachable (Go's ServeMux prefers the more specific pattern, but assert it).
func TestListShotsPage_DoesNotShadowSiblingRoutes(t *testing.T) {
	h, _, sqlDB := newTestHandlers(t)
	mux := newMux(h)
	dur := int64(300)
	insertShot(t, sqlDB, 1, 1000, &dur, "V60", map[string]any{"datapoints": bigDatapoints(40)}, map[string]any{"dose": 18.0})

	for _, tc := range []struct{ path, wantKey string }{
		{"/api/shots/1", "previousShotId"},
		{"/api/shots/last", "id"},
		{"/api/shots/defaults", "grinder"},
	} {
		rec := doJSON(t, mux, http.MethodGet, tc.path, nil)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: status %d", tc.path, rec.Code)
		}
		body := decodeBody(t, rec.Body.Bytes())
		if _, ok := body[tc.wantKey]; !ok {
			t.Errorf("%s: response missing %q -> route shadowed? body=%s", tc.path, tc.wantKey, rec.Body.String())
		}
	}
}
