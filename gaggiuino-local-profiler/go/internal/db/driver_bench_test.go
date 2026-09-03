//go:build driverbench

// Spike #958: head-to-head micro-benchmark of the two cgo-free SQLite
// drivers under consideration for the Go build —
//
//	modernc.org/sqlite        (in use today; C transpiled to Go)
//	github.com/ncruces/go-sqlite3 (real SQLite compiled to WASM, run on wazero)
//
// Build-tagged so it never compiles into the normal `go test ./...` gate
// and ncruces stays an unused (but recorded) module until a real switch is
// decided. Run it explicitly:
//
//	go test -tags driverbench -run '^$' -bench . -benchmem ./internal/db/
//
// The dataset (SPIKE_SHOTS shots, each with a realistic ~5-15 KB datapoints
// JSON blob) mirrors Repository.FindAllExcludingTrash / FindByID from
// internal/shots — the paths #957/#958 care about.
package db

import (
	"context"
	"database/sql"
	"encoding/json"
	"math"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	_ "github.com/ncruces/go-sqlite3/driver"
	_ "modernc.org/sqlite"
)

const spikeShots = 5000

// driverCase is one of the two drivers under test, plus the per-connection
// DSN that gives it the same pragma state internal/db.Open sets today
// (busy_timeout, WAL, foreign_keys, synchronous=NORMAL).
type driverCase struct {
	name       string
	driverName string
	dsn        func(path string) string
}

func moderncDSN(path string) string {
	return "file:" + path +
		"?_pragma=busy_timeout(5000)" +
		"&_pragma=journal_mode(WAL)" +
		"&_pragma=foreign_keys(ON)" +
		"&_pragma=synchronous(NORMAL)"
}

func ncrucesDSN(path string) string {
	// ncruces parses the same `_pragma=` query params. `_txlock=immediate`
	// is ncruces' documented recommendation for a database/sql pool that
	// writes (upgrades the BEGIN so a write txn can't deadlock a second
	// connection mid-statement); modernc has no equivalent knob.
	return "file:" + path +
		"?_txlock=immediate" +
		"&_pragma=busy_timeout(5000)" +
		"&_pragma=journal_mode(WAL)" +
		"&_pragma=foreign_keys(ON)" +
		"&_pragma=synchronous(NORMAL)"
}

var driverCases = []driverCase{
	{"modernc", "sqlite", moderncDSN},
	{"ncruces", "sqlite3", ncrucesDSN},
}

// realisticDatapoints builds a datapoints object shaped like a real shot's
// (the 8 series internal/shots/perf_test.go's bigDatapoints uses), sized to
// land in the 5-15 KB JSON range by varying the sample count per shot.
func realisticDatapoints(samples int) map[string]any {
	mk := func(fn func(i int) float64) []float64 {
		out := make([]float64, samples)
		for i := range out {
			out[i] = math.Round(fn(i)*100) / 100
		}
		return out
	}
	return map[string]any{
		"timeInShot":        mk(func(i int) float64 { return float64(i) * 0.1 }),
		"pressure":          mk(func(i int) float64 { return 9 - float64(i%7)*0.13 }),
		"pumpFlow":          mk(func(i int) float64 { return 2.2 + float64(i%3)*0.4 }),
		"weightFlow":        mk(func(i int) float64 { return float64(i%20) * 0.11 }),
		"shotWeight":        mk(func(i int) float64 { return float64(i) * 0.31 }),
		"temperature":       mk(func(i int) float64 { return 93 + float64(i%4)*0.2 }),
		"targetPressure":    mk(func(i int) float64 { return 9 }),
		"targetTemperature": mk(func(i int) float64 { return 93 }),
	}
}

// seedShotData returns the JSON blob for one shot; samples is chosen so the
// blob size sweeps 5-15 KB across the dataset.
func seedShotData(i int) (string, int64) {
	samples := 90 + (i%23)*10 // 90..310 samples -> ~5-15 KB
	blob := map[string]any{
		"datapoints": realisticDatapoints(samples),
		"version":    "1.5.2",
		"profile":    map[string]any{"name": "Turbo Bloom", "id": i%12 + 1},
	}
	b, err := json.Marshal(blob)
	if err != nil {
		panic(err)
	}
	return string(b), int64(len(b))
}

// buildSpikeDB creates a fresh DB at path with the real app schema and
// spikeShots rows, using the modernc driver for the load regardless of
// which driver will read it back (the on-disk format is identical). Returns
// the mean blob size actually written.
func buildSpikeDB(tb testing.TB, path string) int64 {
	tb.Helper()
	loader, err := sql.Open("sqlite", moderncDSN(path))
	if err != nil {
		tb.Fatalf("seed open: %v", err)
	}
	defer loader.Close()
	loader.SetMaxOpenConns(1)

	if err := InitSchema(loader); err != nil {
		tb.Fatalf("seed schema: %v", err)
	}

	tx, err := loader.Begin()
	if err != nil {
		tb.Fatalf("seed tx: %v", err)
	}
	stmt, err := tx.Prepare(`INSERT INTO shots (id, timestamp, duration, profile_name, data, machine_id) VALUES (?,?,?,?,?,1)`)
	if err != nil {
		tb.Fatalf("seed prepare: %v", err)
	}
	annStmt, err := tx.Prepare(`INSERT INTO annotations (shot_id, data) VALUES (?, ?)`)
	if err != nil {
		tb.Fatalf("seed prepare ann: %v", err)
	}
	var total int64
	for i := 1; i <= spikeShots; i++ {
		data, n := seedShotData(i)
		total += n
		if _, err := stmt.Exec(i, 1_700_000_000+i*37, 25+i%15, "Turbo Bloom", data); err != nil {
			tb.Fatalf("seed insert %d: %v", i, err)
		}
		if i%5 == 0 {
			if _, err := annStmt.Exec(i, `{"dose":18.0,"tds":9.1,"notes":"spike"}`); err != nil {
				tb.Fatalf("seed ann %d: %v", i, err)
			}
		}
	}
	if err := tx.Commit(); err != nil {
		tb.Fatalf("seed commit: %v", err)
	}
	// Fold the WAL back into the main file so the read benchmarks start
	// from the same clean state for both drivers.
	if _, err := loader.Exec(`PRAGMA wal_checkpoint(TRUNCATE)`); err != nil {
		tb.Fatalf("seed checkpoint: %v", err)
	}
	return total / spikeShots
}

const selectScan = `
	SELECT s.id, s.timestamp, s.duration, s.profile_name, s.data, s.machine_id, a.data
	FROM shots s LEFT JOIN annotations a ON a.shot_id = s.id
`

// scanShotRow mimics hydrateRow's actual work: pull every column, decode
// the JSON blob's top level (datapoints kept raw, like the real projection).
func scanShotRow(rows *sql.Rows) error {
	var id, ts, machineID int64
	var dur sql.NullInt64
	var pn, data, ann sql.NullString
	if err := rows.Scan(&id, &ts, &dur, &pn, &data, &machineID, &ann); err != nil {
		return err
	}
	if data.String != "" {
		var raw map[string]json.RawMessage
		if err := json.Unmarshal([]byte(data.String), &raw); err != nil {
			return err
		}
		_ = raw["datapoints"]
	}
	return nil
}

func openPool(tb testing.TB, dc driverCase, path string, maxOpen int) *sql.DB {
	tb.Helper()
	sqlDB, err := sql.Open(dc.driverName, dc.dsn(path))
	if err != nil {
		tb.Fatalf("%s open: %v", dc.name, err)
	}
	sqlDB.SetMaxOpenConns(maxOpen)
	sqlDB.SetMaxIdleConns(maxOpen)
	// Warm one connection so the wazero module instantiation (ncruces) is
	// not attributed to the first benchmarked query.
	if err := sqlDB.Ping(); err != nil {
		tb.Fatalf("%s ping: %v", dc.name, err)
	}
	return sqlDB
}

// BenchmarkFullScan is Repository.FindAllExcludingTrash: scan every shot,
// read the blob, decode its top level.
func BenchmarkFullScan(b *testing.B) {
	dir := b.TempDir()
	path := filepath.Join(dir, "spike.db")
	meanBlob := buildSpikeDB(b, path)

	for _, dc := range driverCases {
		b.Run(dc.name, func(b *testing.B) {
			sqlDB := openPool(b, dc, path, 4)
			defer sqlDB.Close()
			b.ReportMetric(float64(meanBlob), "blobBytes/op")
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				rows, err := sqlDB.Query(selectScan + ` WHERE s.id NOT IN (SELECT shot_id FROM trash) ORDER BY s.timestamp ASC`)
				if err != nil {
					b.Fatal(err)
				}
				n := 0
				for rows.Next() {
					if err := scanShotRow(rows); err != nil {
						rows.Close()
						b.Fatal(err)
					}
					n++
				}
				rows.Close()
				if err := rows.Err(); err != nil {
					b.Fatal(err)
				}
				if n != spikeShots {
					b.Fatalf("scanned %d rows, want %d", n, spikeShots)
				}
			}
		})
	}
}

// BenchmarkFindByID is Repository.FindByID: one indexed single-row lookup.
func BenchmarkFindByID(b *testing.B) {
	dir := b.TempDir()
	path := filepath.Join(dir, "spike.db")
	buildSpikeDB(b, path)

	for _, dc := range driverCases {
		b.Run(dc.name, func(b *testing.B) {
			sqlDB := openPool(b, dc, path, 4)
			defer sqlDB.Close()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				id := (i % spikeShots) + 1
				rows, err := sqlDB.Query(selectScan+` WHERE s.id = ?`, id)
				if err != nil {
					b.Fatal(err)
				}
				if !rows.Next() {
					rows.Close()
					b.Fatalf("id %d not found", id)
				}
				if err := scanShotRow(rows); err != nil {
					rows.Close()
					b.Fatal(err)
				}
				rows.Close()
			}
		})
	}
}

// BenchmarkParallelReadersOneWriter runs 8 concurrent readers doing
// single-row lookups while 1 writer streams INSERTs, for a fixed wall-clock
// window. Reports read throughput and counts any SQLITE_BUSY the writer or
// readers hit (with WAL + busy_timeout there should be none).
func BenchmarkParallelReadersOneWriter(b *testing.B) {
	for _, dc := range driverCases {
		b.Run(dc.name, func(b *testing.B) {
			dir := b.TempDir()
			path := filepath.Join(dir, "spike.db")
			buildSpikeDB(b, path)

			sqlDB := openPool(b, dc, path, 12)
			defer sqlDB.Close()

			b.ResetTimer()
			for iter := 0; iter < b.N; iter++ {
				var reads, busy int64
				stop := make(chan struct{})
				var wg sync.WaitGroup

				for r := 0; r < 8; r++ {
					wg.Add(1)
					go func(seed int) {
						defer wg.Done()
						id := seed
						for {
							select {
							case <-stop:
								return
							default:
							}
							id = id%spikeShots + 1
							row := sqlDB.QueryRow(`SELECT data FROM shots WHERE id = ?`, id)
							var data string
							if err := row.Scan(&data); err != nil {
								if isBusy(err) {
									atomic.AddInt64(&busy, 1)
									continue
								}
								b.Error(err)
								return
							}
							atomic.AddInt64(&reads, 1)
						}
					}(r*911 + 1)
				}

				wg.Add(1)
				go func() {
					defer wg.Done()
					id := spikeShots + 1 + iter*1_000_000
					for {
						select {
						case <-stop:
							return
						default:
						}
						data, _ := seedShotData(id)
						_, err := sqlDB.Exec(
							`INSERT INTO shots (id, timestamp, duration, profile_name, data, machine_id) VALUES (?,?,?,?,?,1)`,
							id, 1_800_000_000+id, 30, "Writer", data)
						if err != nil {
							if isBusy(err) {
								atomic.AddInt64(&busy, 1)
								continue
							}
							b.Error(err)
							return
						}
						id++
						time.Sleep(2 * time.Millisecond)
					}
				}()

				time.Sleep(2 * time.Second)
				close(stop)
				wg.Wait()

				b.ReportMetric(float64(reads)/2.0, "reads/sec")
				b.ReportMetric(float64(busy), "SQLITE_BUSY/op")
			}
		})
	}
}

// BenchmarkColdStart is sql.Open + first real query on a fresh process
// state — the cost a container restart pays. For ncruces this includes the
// one-time wazero module compile/instantiate.
func BenchmarkColdStart(b *testing.B) {
	dir := b.TempDir()
	path := filepath.Join(dir, "spike.db")
	buildSpikeDB(b, path)

	for _, dc := range driverCases {
		b.Run(dc.name, func(b *testing.B) {
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				sqlDB, err := sql.Open(dc.driverName, dc.dsn(path))
				if err != nil {
					b.Fatal(err)
				}
				sqlDB.SetMaxOpenConns(1)
				var n int
				if err := sqlDB.QueryRow(`SELECT COUNT(*) FROM shots`).Scan(&n); err != nil {
					b.Fatal(err)
				}
				if n != spikeShots {
					b.Fatalf("count = %d", n)
				}
				sqlDB.Close()
			}
		})
	}
}

// TestSpikeColdStartModernc / ...Ncruces measure the true one-off process
// cost of the first sql.Open + first query for each driver — the number
// BenchmarkColdStart cannot see, because after the first iteration ncruces'
// wazero module is already compiled and cached process-wide. Run each in
// its own `go test` process so only that driver initialises:
//
//	go test -tags driverbench -run TestSpikeColdStartModernc -v ./internal/db/
//	go test -tags driverbench -run TestSpikeColdStartNcruces  -v ./internal/db/
func TestSpikeColdStartModernc(t *testing.T) { spikeColdStart(t, driverCases[0]) }
func TestSpikeColdStartNcruces(t *testing.T) { spikeColdStart(t, driverCases[1]) }

func spikeColdStart(t *testing.T, dc driverCase) {
	dir := t.TempDir()
	path := filepath.Join(dir, "spike.db")
	buildSpikeDB(t, path)

	start := time.Now()
	sqlDB, err := sql.Open(dc.driverName, dc.dsn(path))
	if err != nil {
		t.Fatal(err)
	}
	defer sqlDB.Close()
	sqlDB.SetMaxOpenConns(1)
	var n int
	if err := sqlDB.QueryRow(`SELECT COUNT(*) FROM shots`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	t.Logf("%s: first Open + first query = %v (rows=%d)", dc.name, time.Since(start), n)
}

func isBusy(err error) bool {
	if err == nil {
		return false
	}
	s := err.Error()
	return contains(s, "SQLITE_BUSY") || contains(s, "database is locked") || contains(s, "database table is locked")
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}

// TestSpikeDrivers_SameResults is a correctness guard the benchmark leans
// on: both drivers must read the seeded dataset identically (row count,
// a spot-checked blob, pool pragmas) before any timing number means
// anything. Runs under `-tags driverbench` only.
func TestSpikeDrivers_SameResults(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "spike.db")
	buildSpikeDB(t, path)

	type snap struct {
		count      int
		blob4711   string
		journal    string
		foreignKey int
		busy       int
	}
	snaps := map[string]snap{}
	for _, dc := range driverCases {
		sqlDB := openPool(t, dc, path, 4)
		var s snap
		if err := sqlDB.QueryRow(`SELECT COUNT(*) FROM shots`).Scan(&s.count); err != nil {
			t.Fatalf("%s count: %v", dc.name, err)
		}
		if err := sqlDB.QueryRow(`SELECT data FROM shots WHERE id = 4711`).Scan(&s.blob4711); err != nil {
			t.Fatalf("%s blob: %v", dc.name, err)
		}
		conn, err := sqlDB.Conn(context.Background())
		if err != nil {
			t.Fatalf("%s conn: %v", dc.name, err)
		}
		_ = conn.QueryRowContext(context.Background(), `PRAGMA journal_mode`).Scan(&s.journal)
		_ = conn.QueryRowContext(context.Background(), `PRAGMA foreign_keys`).Scan(&s.foreignKey)
		_ = conn.QueryRowContext(context.Background(), `PRAGMA busy_timeout`).Scan(&s.busy)
		conn.Close()
		sqlDB.Close()
		snaps[dc.name] = s
		t.Logf("%s: %+v", dc.name, s)
	}
	m, n := snaps["modernc"], snaps["ncruces"]
	if m.count != n.count || m.count != spikeShots {
		t.Errorf("row count mismatch: modernc=%d ncruces=%d", m.count, n.count)
	}
	if m.blob4711 != n.blob4711 {
		t.Errorf("blob mismatch for shot 4711")
	}
	if m.journal != "wal" || n.journal != "wal" {
		t.Errorf("journal_mode: modernc=%q ncruces=%q", m.journal, n.journal)
	}
	if m.foreignKey != 1 || n.foreignKey != 1 {
		t.Errorf("foreign_keys: modernc=%d ncruces=%d", m.foreignKey, n.foreignKey)
	}
	if m.busy != 5000 || n.busy != 5000 {
		t.Errorf("busy_timeout: modernc=%d ncruces=%d", m.busy, n.busy)
	}
}
