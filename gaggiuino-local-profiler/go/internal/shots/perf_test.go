package shots

import (
	"database/sql"
	stdjson "encoding/json"
	"net/http"
	"strconv"
	"testing"
)

// perf_test.go covers the /shots.json + /api/shots/last throughput work
// from #951: the list endpoint must keep every shot's datapoints in the
// response (no contract break for the Vite bundle's charts/sparklines,
// which load them straight out of the bulk /shots.json), and /api/shots/last
// must land on the same shot Node's getAll()+last did without hydrating the
// whole history. BenchmarkListShots documents the marshalling cost against
// a realistic dataset.

// bigDatapoints builds a datapoints blob roughly the size of a real shot's
// (samples across the series the frontend charts).
func bigDatapoints(samples int) map[string]any {
	mk := func(fn func(i int) float64) []any {
		out := make([]any, samples)
		for i := range out {
			out[i] = fn(i)
		}
		return out
	}
	return map[string]any{
		"timeInShot":        mk(func(i int) float64 { return float64(i) }),
		"pressure":          mk(func(i int) float64 { return 90 - float64(i%7) }),
		"pumpFlow":          mk(func(i int) float64 { return 22 + float64(i%3) }),
		"weightFlow":        mk(func(i int) float64 { return float64(i % 20) }),
		"shotWeight":        mk(func(i int) float64 { return float64(i) * 0.3 }),
		"temperature":       mk(func(i int) float64 { return 930 + float64(i%4) }),
		"targetPressure":    mk(func(i int) float64 { return 90 }),
		"targetTemperature": mk(func(i int) float64 { return 930 }),
	}
}

// TestListShots_KeepsDatapointsInResponse pins that /shots.json still ships
// each shot's full datapoints object — the hydrateRow projection keeps the
// bytes raw for speed, it does not drop them (a frontend consumer reads
// shot.datapoints out of this bulk response, see public-src/views/shots).
func TestListShots_KeepsDatapointsInResponse(t *testing.T) {
	h, _, sqlDB := newTestHandlers(t)
	mux := newMux(h)

	dur := int64(280)
	insertShot(t, sqlDB, 1, 1000, &dur, "V60", map[string]any{
		"datapoints": bigDatapoints(50),
		"version":    "1.2.3",
	}, map[string]any{"dose": 18.0})

	rec := doJSON(t, mux, http.MethodGet, "/shots.json", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d; body=%s", rec.Code, rec.Body.String())
	}
	var list []map[string]any
	if err := stdjson.Unmarshal(rec.Body.Bytes(), &list); err != nil {
		t.Fatalf("decoding response: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("expected 1 shot, got %d", len(list))
	}
	dpOut, ok := list[0]["datapoints"].(map[string]any)
	if !ok {
		t.Fatalf("datapoints missing or not an object in /shots.json entry: %T", list[0]["datapoints"])
	}
	press, ok := dpOut["pressure"].([]any)
	if !ok || len(press) != 50 {
		t.Fatalf("datapoints.pressure = %T len %d, want a 50-element array", dpOut["pressure"], len(press))
	}
	if _, ok := list[0]["score"]; !ok {
		t.Error("expected additive 'score' field")
	}
	if list[0]["version"] != "1.2.3" {
		t.Errorf("non-datapoints data key mangled: version = %v", list[0]["version"])
	}
}

// TestListShots_ScoreMatchesRawAndMapDatapoints pins that a shot hydrated
// from the DB (datapoints kept as raw bytes, scored via scoreSeriesFromRaw)
// gets the same score as the identical shot built as a map[string]any and
// scored directly (scoreSeriesFromMap) — the two paths must not diverge.
func TestListShots_ScoreMatchesRawAndMapDatapoints(t *testing.T) {
	ann := map[string]any{"dose": 18.0, "tds": 9.0}

	cases := map[string]map[string]any{
		"clean series": bigDatapoints(400),
		// A stray null in a series: the map path (floatSlice) drops it, so
		// the raw path (decodeFloatArray) must too — decoding straight into
		// []float64 would turn it into a 0 and diverge (#951 review C).
		"null in temperature / timeInShot / pressure": func() map[string]any {
			dp := bigDatapoints(400)
			for _, key := range []string{"temperature", "timeInShot", "pressure", "shotWeight", "targetTemperature"} {
				s := dp[key].([]any)
				s[10], s[50], s[len(s)-1] = nil, nil, nil
			}
			return dp
		}(),
	}

	for name, dp := range cases {
		t.Run(name, func(t *testing.T) {
			h, _, sqlDB := newTestHandlers(t)
			mux := newMux(h)
			dur := int64(300)
			insertShot(t, sqlDB, 1, 1000, &dur, "V60", map[string]any{"datapoints": dp}, ann)

			rec := doJSON(t, mux, http.MethodGet, "/shots.json", nil)
			var list []map[string]any
			if err := stdjson.Unmarshal(rec.Body.Bytes(), &list); err != nil {
				t.Fatalf("decoding response: %v", err)
			}
			rawScore := list[0]["score"]

			mapShot := Shot{"datapoints": dp, "duration": int64(300), "annotation": ann}
			want := CalcShotScoreDetail(mapShot, nil).Score
			switch {
			case rawScore == nil && want == nil:
			case rawScore == nil || want == nil:
				t.Fatalf("score mismatch: raw-path = %v, map-path = %v", rawScore, want)
			case int(rawScore.(float64)) != *want:
				t.Fatalf("score mismatch: raw-path = %v, map-path = %d", rawScore, *want)
			}
			if want == nil {
				t.Fatal("test dataset should produce a score — check the fixture")
			}
		})
	}
}

// TestLastShot_TieBreaksOnHighestID pins that GET /api/shots/last resolves
// a timestamp tie the same way Node's getAll() (ORDER BY timestamp ASC)
// then `shots[shots.length-1]` did: the greatest id wins.
func TestLastShot_TieBreaksOnHighestID(t *testing.T) {
	h, _, sqlDB := newTestHandlers(t)
	mux := newMux(h)

	dur := int64(300)
	insertShot(t, sqlDB, 5, 9000, &dur, "V60", nil, nil)
	insertShot(t, sqlDB, 9, 9000, &dur, "V60", nil, nil) // same timestamp
	insertShot(t, sqlDB, 7, 9000, &dur, "V60", nil, nil) // same timestamp

	rec := doJSON(t, mux, http.MethodGet, "/api/shots/last", nil)
	body := decodeBody(t, rec.Body.Bytes())
	if int64(body["id"].(float64)) != 9 {
		t.Errorf("last shot id = %v, want 9 (highest id among the newest timestamp)", body["id"])
	}
}

// TestLastShot_IgnoresTrashed pins that a trashed newest shot is skipped,
// matching getAll() excluding trash.
func TestLastShot_IgnoresTrashed(t *testing.T) {
	h, s, sqlDB := newTestHandlers(t)
	mux := newMux(h)

	dur := int64(300)
	insertShot(t, sqlDB, 1, 1000, &dur, "V60", nil, nil)
	insertShot(t, sqlDB, 2, 2000, &dur, "V60", nil, nil)
	if err := s.MoveToTrash(2); err != nil {
		t.Fatalf("MoveToTrash: %v", err)
	}

	rec := doJSON(t, mux, http.MethodGet, "/api/shots/last", nil)
	body := decodeBody(t, rec.Body.Bytes())
	if int64(body["id"].(float64)) != 1 {
		t.Errorf("last shot id = %v, want 1 (shot 2 is trashed)", body["id"])
	}
}

// seedRealisticShots loads ~213 shots with ~150 samples/series — roughly
// the live dataset the #951 benchmark ran against (Go 213 shots / 1.93 MB).
func seedRealisticShots(b *testing.B, sqlDB *sql.DB) {
	b.Helper()
	dur := int64(280)
	for i := 1; i <= 213; i++ {
		data := map[string]any{"datapoints": bigDatapoints(150), "version": "1.5.0"}
		insertShot(b, sqlDB, int64(i), int64(1000+i), &dur, "V60", data, map[string]any{"dose": 18.0, "tds": 9.0})
	}
}

// seedManyShots bulk-inserts n shots with a realistic (~150-sample) curve
// blob each — the bulk seed for BenchmarkListShotsPage's 200-vs-5000
// comparison.
func seedManyShots(b *testing.B, sqlDB *sql.DB, n int) {
	b.Helper()
	dur := int64(280)
	blob, err := stdjson.Marshal(map[string]any{"datapoints": bigDatapoints(150), "version": "1.5.0"})
	if err != nil {
		b.Fatal(err)
	}
	ann, _ := stdjson.Marshal(map[string]any{"dose": 18.0, "tds": 9.0})
	tx, err := sqlDB.Begin()
	if err != nil {
		b.Fatal(err)
	}
	for i := 1; i <= n; i++ {
		if _, err := tx.Exec(
			`INSERT INTO shots (id, timestamp, duration, profile_name, data, machine_id) VALUES (?,?,?,?,?,1)`,
			i, 1000+i, dur, "V60", string(blob),
		); err != nil {
			b.Fatal(err)
		}
		if _, err := tx.Exec(`INSERT INTO annotations (shot_id, data) VALUES (?, ?)`, i, string(ann)); err != nil {
			b.Fatal(err)
		}
	}
	if err := tx.Commit(); err != nil {
		b.Fatal(err)
	}
}

// BenchmarkListShotsPage is #957's headline done-criterion: GET
// /api/shots?limit=60 wall time AND alloc bytes must stay flat (within
// ~10%) between a 200-shot and a 5000-shot DB — i.e. listing the history is
// O(page), not O(history). Run:
//
//	go test ./internal/shots -run '^$' -bench BenchmarkListShotsPage -benchmem
//
// The first request per size warms shot_score_cache; the measured loop is
// all cache hits, so the only per-request work is the keyset query (61
// rows) + hydrating/serialising one page of metadata.
func BenchmarkListShotsPage(b *testing.B) {
	for _, n := range []int{200, 5000} {
		b.Run("shots="+strconv.Itoa(n), func(b *testing.B) {
			h, _, sqlDB := newTestHandlers(b)
			mux := newMux(h)
			seedManyShots(b, sqlDB, n)
			doJSON(b, mux, http.MethodGet, "/api/shots?limit=60", nil) // warm cache

			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				rec := doJSON(b, mux, http.MethodGet, "/api/shots?limit=60", nil)
				if rec.Code != http.StatusOK {
					b.Fatalf("status = %d", rec.Code)
				}
			}
		})
	}
}

func BenchmarkListShots(b *testing.B) {
	h, _, sqlDB := newTestHandlers(b)
	mux := newMux(h)
	seedRealisticShots(b, sqlDB)

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		rec := doJSON(b, mux, http.MethodGet, "/shots.json", nil)
		if rec.Code != http.StatusOK {
			b.Fatalf("status = %d", rec.Code)
		}
	}
}

// BenchmarkListShots_LegacyHydrate reproduces the pre-#951 cost: hydrate
// every shot fully into map[string]any (datapoints number arrays boxed into
// []any) with encoding/json, then re-marshal the whole list with
// encoding/json. Run alongside BenchmarkListShots to quantify the
// projection + goccy win without a live instance.
func BenchmarkListShots_LegacyHydrate(b *testing.B) {
	h, repo, sqlDB := newTestHandlers(b)
	_ = h
	seedRealisticShots(b, sqlDB)
	svc := NewService(repo)

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		rows, err := sqlDB.Query(selectBase + ` WHERE s.id NOT IN (SELECT shot_id FROM trash) ORDER BY s.timestamp ASC`)
		if err != nil {
			b.Fatal(err)
		}
		var out []Shot
		for rows.Next() {
			shot, err := legacyHydrateRow(rows)
			if err != nil {
				rows.Close()
				b.Fatal(err)
			}
			out = append(out, withScore(shot, svc.ComputeScoreDetail(shot)))
		}
		rows.Close()
		if _, err := stdjson.Marshal(out); err != nil {
			b.Fatal(err)
		}
	}
}

// legacyHydrateRow is the pre-#951 hydrateRow: datapoints (and every other
// data key) boxed into map[string]any via encoding/json.
func legacyHydrateRow(sc rowScanner) (Shot, error) {
	var id, timestamp, machineID int64
	var duration sql.NullInt64
	var profileName sql.NullString
	var data string
	var annData sql.NullString
	if err := sc.Scan(&id, &timestamp, &duration, &profileName, &data, &machineID, &annData); err != nil {
		return nil, err
	}
	var rest map[string]any
	if data != "" {
		if err := stdjson.Unmarshal([]byte(data), &rest); err != nil {
			return nil, err
		}
	}
	if rest == nil {
		rest = map[string]any{}
	}
	shot := Shot{"id": id, "timestamp": timestamp}
	if duration.Valid {
		shot["duration"] = duration.Int64
	}
	for k, v := range rest {
		shot[k] = v
	}
	shot["machineId"] = machineID
	if annData.Valid {
		var ann map[string]any
		_ = stdjson.Unmarshal([]byte(annData.String), &ann)
		shot["annotation"] = ann
	}
	return shot, nil
}
