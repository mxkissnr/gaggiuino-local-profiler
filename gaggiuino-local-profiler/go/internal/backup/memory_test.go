package backup

import (
	"archive/zip"
	"bytes"
	"database/sql"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// This file is the core evidence for #959: peak Go heap growth on every
// backup export/import path is bounded by a fixed ceiling that does NOT
// rise when the shot/image dataset is quadrupled.

// heapCeiling is the allowed peak HeapAlloc growth (over a post-GC
// baseline) for any single export or import, at ANY dataset size. Sized
// with generous slack over the real working set (~one shot batch + one
// image + the small sections + decoder/zip buffers + GC headroom, and the
// extra allocator overhead the -race build adds).
const heapCeiling = 48 << 20

// datasetGrowthSlack is how much more peak heap 4x the data is allowed to
// use than 1x. A streaming path stays flat; the old load-everything path
// grew roughly linearly (4x the shots => ~4x the resident datapoints).
const datasetGrowthSlack = 12 << 20

// discardRW is an http.ResponseWriter that counts the body but never
// retains it — so a streaming handler's memory profile isn't masked by
// httptest.ResponseRecorder buffering the whole response.
type discardRW struct {
	hdr  http.Header
	code int
	n    int64
}

func (d *discardRW) Header() http.Header {
	if d.hdr == nil {
		d.hdr = http.Header{}
	}
	return d.hdr
}
func (d *discardRW) WriteHeader(c int)           { d.code = c }
func (d *discardRW) Write(p []byte) (int, error) { d.n += int64(len(p)); return len(p), nil }

// measurePeakHeap runs fn while sampling runtime HeapAlloc, and returns the
// peak observed minus a pre-run post-GC baseline.
func measurePeakHeap(fn func()) uint64 {
	runtime.GC()
	var base runtime.MemStats
	runtime.ReadMemStats(&base)

	var peak uint64
	stop := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		var m runtime.MemStats
		for {
			select {
			case <-stop:
				return
			default:
			}
			runtime.ReadMemStats(&m)
			for {
				cur := atomic.LoadUint64(&peak)
				if m.HeapAlloc <= cur || atomic.CompareAndSwapUint64(&peak, cur, m.HeapAlloc) {
					break
				}
			}
			time.Sleep(2 * time.Millisecond)
		}
	}()

	fn()

	close(stop)
	wg.Wait()

	p := atomic.LoadUint64(&peak)
	if p < base.HeapAlloc {
		return 0
	}
	return p - base.HeapAlloc
}

// seedSyntheticShots inserts n shots each carrying a ~2 KB datapoints JSON
// array, straight through SQL for speed.
func seedSyntheticShots(t *testing.T, sqlDB *sql.DB, n int) {
	t.Helper()
	pts := make([]string, 0, 128)
	for i := 0; i < 128; i++ {
		pts = append(pts, fmt.Sprintf("%d.%d", i, i%10))
	}
	series := "[" + strings.Join(pts, ",") + "]"
	data := fmt.Sprintf(`{"datapoints":{"pressure":%s,"flow":%s,"temperature":%s,"weight":%s}}`, series, series, series, series)

	tx, err := sqlDB.Begin()
	if err != nil {
		t.Fatal(err)
	}
	stmt, err := tx.Prepare(`INSERT INTO shots (id, timestamp, duration, profile_name, data, machine_id) VALUES (?,?,?,?,?,1)`)
	if err != nil {
		t.Fatal(err)
	}
	for i := 1; i <= n; i++ {
		if _, err := stmt.Exec(i, int64(1_700_000_000+i), 30000, "Perf Profile", data, 1); err != nil {
			t.Fatal(err)
		}
	}
	stmt.Close()
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
}

func seedFakeImages(t *testing.T, dir string, m int) {
	t.Helper()
	body := append(fakePNG(), bytes.Repeat([]byte{0x7f}, 48*1024)...)
	for i := 0; i < m; i++ {
		if err := os.WriteFile(filepath.Join(dir, fmt.Sprintf("bench-%d.png", i)), body, 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

// exportPeak measures the peak heap growth of one POST /api/backup for a DB
// seeded with n shots and m images, and returns (peak, zip entry count).
func exportPeak(t *testing.T, n, m int) (uint64, int) {
	t.Helper()
	imgDir := useImageDir(t)
	seedFakeImages(t, imgDir, m)

	h, _, sqlDB := newTestHandlers(t)
	seedSyntheticShots(t, sqlDB, n)
	mux := newMux(h)

	var zipBytes []byte
	peak := measurePeakHeap(func() {
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/backup", nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("export status = %d", rec.Code)
		}
		zipBytes = rec.Body.Bytes()
	})

	zr, err := zipReaderFromBytes(zipBytes)
	if err != nil {
		t.Fatalf("export produced an invalid zip: %v", err)
	}
	return peak, len(zr)
}

func TestBackupExport_PeakHeapBoundedAndDatasetIndependent(t *testing.T) {
	const n, m = 800, 40

	peak1, entries1 := exportPeak(t, n, m)
	if entries1 != m+1 {
		t.Errorf("export zip has %d entries, want %d (backup.json + %d images)", entries1, m+1, m)
	}
	if peak1 > heapCeiling {
		t.Errorf("export peak heap growth %s exceeds ceiling %s at N=%d", human(peak1), human(heapCeiling), n)
	}

	peak4, entries4 := exportPeak(t, 4*n, 4*m)
	if entries4 != 4*m+1 {
		t.Errorf("4x export zip has %d entries, want %d", entries4, 4*m+1)
	}
	if peak4 > heapCeiling {
		t.Errorf("4x export peak heap growth %s exceeds ceiling %s", human(peak4), human(heapCeiling))
	}
	if peak4 > peak1+datasetGrowthSlack {
		t.Errorf("export peak heap grew with the dataset: N=%s, 4N=%s (slack %s) — not O(1) in dataset size",
			human(peak1), human(peak4), human(datasetGrowthSlack))
	}
	t.Logf("export peak heap: N=%d -> %s ; 4N=%d -> %s", n, human(peak1), 4*n, human(peak4))
}

// importPeak measures the peak heap growth of one POST /api/restore of a
// backup zip produced from n shots / m images, into a fresh install.
func importPeak(t *testing.T, n, m int) (uint64, map[string]int) {
	t.Helper()
	imgDir := useImageDir(t)
	seedFakeImages(t, imgDir, m)

	hSrc, _, srcDB := newTestHandlers(t)
	seedSyntheticShots(t, srcDB, n)
	recExp := httptest.NewRecorder()
	newMux(hSrc).ServeHTTP(recExp, httptest.NewRequest(http.MethodPost, "/api/backup", nil))
	if recExp.Code != http.StatusOK {
		t.Fatalf("seed export status = %d", recExp.Code)
	}
	zipBytes := append([]byte(nil), recExp.Body.Bytes()...)

	hDst, depsDst, _ := newTestHandlersInDir(t)
	mux := newMux(hDst)

	peak := measurePeakHeap(func() {
		dw := &discardRW{}
		r := httptest.NewRequest(http.MethodPost, "/api/restore", bytes.NewReader(zipBytes))
		r.Header.Set("Content-Type", "application/zip")
		mux.ServeHTTP(dw, r)
		if dw.code != http.StatusOK {
			t.Fatalf("restore status = %d", dw.code)
		}
	})

	counts := map[string]int{}
	if c, err := depsDst.ShotsRepo.Count(); err == nil {
		counts["shots"] = c
	}
	return peak, counts
}

func TestBackupImport_PeakHeapBoundedAndDatasetIndependent(t *testing.T) {
	const n, m = 800, 40

	peak1, counts1 := importPeak(t, n, m)
	if counts1["shots"] != n {
		t.Errorf("restored %d shots, want %d", counts1["shots"], n)
	}
	if peak1 > heapCeiling {
		t.Errorf("import peak heap growth %s exceeds ceiling %s at N=%d", human(peak1), human(heapCeiling), n)
	}

	peak4, counts4 := importPeak(t, 4*n, 4*m)
	if counts4["shots"] != 4*n {
		t.Errorf("4x restore restored %d shots, want %d", counts4["shots"], 4*n)
	}
	if peak4 > heapCeiling {
		t.Errorf("4x import peak heap growth %s exceeds ceiling %s", human(peak4), human(heapCeiling))
	}
	if peak4 > peak1+datasetGrowthSlack {
		t.Errorf("import peak heap grew with the dataset: N=%s, 4N=%s (slack %s) — not O(1) in dataset size",
			human(peak1), human(peak4), human(datasetGrowthSlack))
	}
	t.Logf("import peak heap: N=%d -> %s ; 4N=%d -> %s", n, human(peak1), 4*n, human(peak4))
}

func human(b uint64) string {
	const u = 1 << 20
	return fmt.Sprintf("%.1f MiB", float64(b)/float64(u))
}

// zipReaderFromBytes returns the entry names of a zip held in b.
func zipReaderFromBytes(b []byte) ([]string, error) {
	zr, err := zip.NewReader(bytes.NewReader(b), int64(len(b)))
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(zr.File))
	for _, f := range zr.File {
		names = append(names, f.Name)
	}
	return names, nil
}
