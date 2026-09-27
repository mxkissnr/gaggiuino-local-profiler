package shots_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/db"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/library"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// This is the end-to-end wiring test for #1198: it reproduces cmd/server's
// SetBeanSource install against a real library repository and checks that a
// bean target actually changes what the paged list and the detail endpoint
// serve. It lives in shots_test (not shots) because wiring in
// internal/library would otherwise form an import cycle.

const integrationBeanID = 42

// seedBean writes a single-target bean into the library table via the real
// repository, exactly like the library handlers do.
func seedBean(t *testing.T, libRepo *library.Repository, brewTempC float64) {
	t.Helper()
	lib, err := libRepo.GetLibrary()
	if err != nil {
		t.Fatalf("GetLibrary: %v", err)
	}
	lib.Beans = []library.Entity{{
		"id":        float64(integrationBeanID),
		"name":      "Integration Bean",
		"brewTempC": brewTempC,
	}}
	if err := libRepo.SaveLibrary(lib); err != nil {
		t.Fatalf("SaveLibrary: %v", err)
	}
}

// scoreShotData is fullScoreShot's datapoint shape (temperature 90.0C,
// pressure 8.0 bar, 30s, 45g out, dose 18g) so the generic-band score is a
// clean 100 and a bean target of 90.0 keeps it there while 80.0 does not.
func scoreShotData(t *testing.T) string {
	t.Helper()
	pressure := make([]float64, 20)
	temperature := make([]float64, 10)
	timeInShot := make([]float64, 20)
	for i := range pressure {
		pressure[i] = 80.0
		timeInShot[i] = float64(i) * 10
	}
	for i := range temperature {
		temperature[i] = 900.0
	}
	b, err := json.Marshal(map[string]any{
		"datapoints": map[string]any{
			"pressure":    pressure,
			"temperature": temperature,
			"timeInShot":  timeInShot,
			"weight":      []float64{0, 450},
		},
	})
	if err != nil {
		t.Fatalf("marshaling shot data: %v", err)
	}
	return string(b)
}

func TestBeanSourceWiring_ServedScoresUseBeanTarget(t *testing.T) {
	sqlDB, err := db.Open(filepath.Join(t.TempDir(), "glp.db"))
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { sqlDB.Close() })

	libRepo := library.NewRepository(sqlDB)
	// Exact cmd/server wiring: one library read per request, shared lookup.
	shots.SetBeanSource(func() (func(shots.Shot) *shots.Bean, error) {
		lib, err := libRepo.GetLibrary()
		if err != nil {
			return nil, err
		}
		beans := lib.Beans
		return func(s shots.Shot) *shots.Bean { return library.ScoreBean(s, beans) }, nil
	})
	t.Cleanup(func() { shots.SetBeanSource(nil) })

	// A bean whose target matches the shot's 90.0C.
	seedBean(t, libRepo, 90.0)

	if _, err := sqlDB.Exec(
		`INSERT INTO shots (id, timestamp, duration, profile_name, data, machine_id) VALUES (?,?,?,?,?,1)`,
		int64(1), int64(1000), int64(300), "V60", scoreShotData(t),
	); err != nil {
		t.Fatalf("inserting shot: %v", err)
	}
	ann, _ := json.Marshal(map[string]any{
		"dose":   18.0,
		"coffee": "Integration Bean",
		"beanId": float64(integrationBeanID),
	})
	if _, err := sqlDB.Exec(`INSERT INTO annotations (shot_id, data) VALUES (?, ?)`, int64(1), string(ann)); err != nil {
		t.Fatalf("inserting annotation: %v", err)
	}

	repo := shots.NewRepository(sqlDB)
	h := shots.NewHandlers(repo)
	mux := http.NewServeMux()
	h.RegisterRoutes(mux)

	getJSON := func(path string) map[string]any {
		t.Helper()
		req := httptest.NewRequest(http.MethodGet, path, nil)
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("GET %s: status %d, body %s", path, rec.Code, rec.Body.String())
		}
		var out map[string]any
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
			t.Fatalf("GET %s: decoding body: %v", path, err)
		}
		return out
	}

	// /api/shots — the paged list (#957), whose score goes through the cache.
	firstList := getJSON("/api/shots")
	firstRow := firstList["shots"].([]any)[0].(map[string]any)
	if firstRow["usedBeanTarget"] != true {
		t.Fatalf("/api/shots usedBeanTarget = %v, want true (wired bean target)", firstRow["usedBeanTarget"])
	}
	firstScore, _ := firstRow["score"].(float64)

	// The detail endpoint resolves independently of the cache.
	detail := getJSON("/api/shots/1")
	if detail["usedBeanTarget"] != true {
		t.Errorf("/api/shots/1 usedBeanTarget = %v, want true", detail["usedBeanTarget"])
	}

	// Change the bean target. The cache fingerprint now includes the target,
	// so /api/shots must recompute rather than serve the stale score.
	seedBean(t, libRepo, 80.0)
	changed := getJSON("/api/shots")
	changedRow := changed["shots"].([]any)[0].(map[string]any)
	if changedRow["usedBeanTarget"] != true {
		t.Fatalf("/api/shots usedBeanTarget = %v after target change, want true", changedRow["usedBeanTarget"])
	}
	changedScore, _ := changedRow["score"].(float64)

	if changedScore == firstScore {
		t.Errorf("score = %v unchanged after the bean target moved 90.0 -> 80.0; the cache fingerprint must include the bean target", changedScore)
	}

	// And the cache accepted the recomputed row: a second read is stable.
	again := getJSON("/api/shots")
	againScore, _ := again["shots"].([]any)[0].(map[string]any)["score"].(float64)
	if againScore != changedScore {
		t.Errorf("score flipped from %v to %v across two identical reads", changedScore, againScore)
	}
}
