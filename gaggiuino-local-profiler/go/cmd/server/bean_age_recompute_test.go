package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/db"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/library"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// newBeanAgeRecomputeApp opens a throwaway DB and seeds the library the #2100
// tests resolve ages against: one bean with one bag, opened 2026-03-01, and a
// frozen portion frozen on 2026-03-15. No buildApp, so no background goroutines
// touch the file.
func newBeanAgeRecomputeApp(t *testing.T) (*sql.DB, *library.Repository) {
	t.Helper()
	sqlDB, err := db.Open(filepath.Join(t.TempDir(), "glp.db"))
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { sqlDB.Close() })

	libRepo := library.NewRepository(sqlDB)
	lib, err := libRepo.GetLibrary()
	if err != nil {
		t.Fatalf("GetLibrary: %v", err)
	}
	portion := map[string]any{
		"id":       float64(7),
		"frozenAt": time.Date(2026, 3, 15, 12, 0, 0, 0, time.UTC).UnixMilli(),
	}
	bag := map[string]any{
		"id":             float64(10),
		"roastDate":      "2026-03-01",
		"openedAt":       time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC).UnixMilli(),
		"frozenPortions": []any{portion},
	}
	lib.Beans = []library.Entity{{
		"id":        float64(1),
		"name":      "Alpha",
		"roastDate": "2026-03-01",
		"bags":      []any{bag},
	}}
	if err := libRepo.SaveLibrary(lib); err != nil {
		t.Fatalf("SaveLibrary: %v", err)
	}
	return sqlDB, libRepo
}

// seedShot inserts a shot at 2026-06-24 12:00 UTC plus its annotation.
func seedShot(t *testing.T, sqlDB *sql.DB, id int64, ann map[string]any) {
	t.Helper()
	ts := time.Date(2026, 6, 24, 12, 0, 0, 0, time.UTC).Unix()
	if _, err := sqlDB.Exec(`INSERT INTO shots (id, timestamp, data, machine_id) VALUES (?, ?, '{}', 1)`, id, ts); err != nil {
		t.Fatalf("inserting shot %d: %v", id, err)
	}
	raw, err := json.Marshal(ann)
	if err != nil {
		t.Fatalf("marshaling annotation %d: %v", id, err)
	}
	if _, err := sqlDB.Exec(`INSERT INTO annotations (shot_id, data) VALUES (?, ?)`, id, string(raw)); err != nil {
		t.Fatalf("inserting annotation %d: %v", id, err)
	}
}

// storedAge reads the beanAgeDays a shot's annotation holds.
func storedAge(t *testing.T, sqlDB *sql.DB, shotID int64) (float64, bool) {
	t.Helper()
	var raw string
	if err := sqlDB.QueryRow(`SELECT data FROM annotations WHERE shot_id = ?`, shotID).Scan(&raw); err != nil {
		t.Fatalf("reading annotation %d: %v", shotID, err)
	}
	var ann map[string]any
	if err := json.Unmarshal([]byte(raw), &ann); err != nil {
		t.Fatalf("decoding annotation %d: %v", shotID, err)
	}
	days, ok := ann["beanAgeDays"].(float64)
	return days, ok
}

// TestRecomputeStoredBeanAgesOnce_FrozenPortion is #2100 case 34: the shot
// brewed from a frozen portion stored the plain bag age (115) while the shared
// rule resolves the portion's effective age.
func TestRecomputeStoredBeanAgesOnce_FrozenPortion(t *testing.T) {
	sqlDB, libRepo := newBeanAgeRecomputeApp(t)
	seedShot(t, sqlDB, 1, map[string]any{"beanId": 1, "coffee": "Alpha", "frozenPortionId": 7, "beanAgeDays": float64(115)})
	seedShot(t, sqlDB, 2, map[string]any{"beanId": 99, "coffee": "Gone", "beanAgeDays": float64(40)})
	seedShot(t, sqlDB, 3, map[string]any{"beanId": 1, "coffee": "Alpha", "frozenPortionId": 8, "beanAgeDays": float64(115)})

	lib, err := libRepo.GetLibrary()
	if err != nil {
		t.Fatalf("GetLibrary: %v", err)
	}
	// The expectation comes from the shared rule itself, on the annotation in
	// the shape a stored row decodes to (JSON numbers are float64).
	shotSec := time.Date(2026, 6, 24, 12, 0, 0, 0, time.UTC).Unix()
	wantAnn := map[string]any{"beanId": float64(1), "coffee": "Alpha", "frozenPortionId": float64(7)}
	want, ok := library.BeanAgeForAnnotation(lib.Beans, wantAnn, shotSec)
	if !ok {
		t.Fatal("the frozen portion's age does not resolve; the fixture is wrong")
	}
	if want == 115 || want >= 30 {
		t.Fatalf("expected age = %d, want the frozen portion's effective age below 30", want)
	}

	recomputeStoredBeanAgesOnce(sqlDB, shots.NewRepository(sqlDB), beanAgeLoader(libRepo))

	if got, ok := storedAge(t, sqlDB, 1); !ok || got != float64(want) {
		t.Fatalf("shot 1 stores %v, want %d", got, want)
	}
	if got, _ := storedAge(t, sqlDB, 2); got != 40 {
		t.Fatalf("shot 2 stores %v, want the unchanged 40", got)
	}
	if got, _ := storedAge(t, sqlDB, 3); got != 115 {
		t.Fatalf("shot 3 stores %v, want the unchanged 115", got)
	}
	flagged, err := db.GetKVBool(sqlDB, beanAgesRecomputedKey)
	if err != nil {
		t.Fatalf("GetKVBool: %v", err)
	}
	if !flagged {
		t.Fatal("the recompute flag is not set after a successful pass")
	}

	fn, err := beanAgeLoader(libRepo)()
	if err != nil {
		t.Fatalf("beanAgeLoader: %v", err)
	}
	changed, err := shots.NewRepository(sqlDB).RecomputeStoredBeanAges(fn)
	if err != nil {
		t.Fatalf("second pass: %v", err)
	}
	if changed != 0 {
		t.Fatalf("second pass changed = %d, want 0", changed)
	}
}

// TestRecomputeStoredBeanAgesOnce_RunsOnlyOnce: once the kv flag is set the
// pass does not run again, and nothing loads the library for it.
func TestRecomputeStoredBeanAgesOnce_RunsOnlyOnce(t *testing.T) {
	sqlDB, libRepo := newBeanAgeRecomputeApp(t)
	seedShot(t, sqlDB, 1, map[string]any{"beanId": 1, "coffee": "Alpha", "frozenPortionId": 7, "beanAgeDays": float64(115)})

	recomputeStoredBeanAgesOnce(sqlDB, shots.NewRepository(sqlDB), beanAgeLoader(libRepo))

	if _, err := sqlDB.Exec(`UPDATE annotations SET data = json_set(data, '$.beanAgeDays', 115) WHERE shot_id = 1`); err != nil {
		t.Fatalf("writing 115 back: %v", err)
	}

	failing := func() (func(map[string]any, int64) (int, bool), error) {
		t.Fatal("the loader was called although the kv flag is set")
		return nil, nil
	}
	recomputeStoredBeanAgesOnce(sqlDB, shots.NewRepository(sqlDB), failing)

	if got, _ := storedAge(t, sqlDB, 1); got != 115 {
		t.Fatalf("shot 1 stores %v, want the untouched 115", got)
	}
}

// TestRecomputeStoredBeanAgesOnce_FailedLoadRetries: a failing library load
// leaves the values alone and the flag unset, so the next start retries.
func TestRecomputeStoredBeanAgesOnce_FailedLoadRetries(t *testing.T) {
	sqlDB, _ := newBeanAgeRecomputeApp(t)
	seedShot(t, sqlDB, 1, map[string]any{"beanId": 1, "coffee": "Alpha", "frozenPortionId": 7, "beanAgeDays": float64(115)})

	failing := func() (func(map[string]any, int64) (int, bool), error) {
		return nil, errors.New("library unavailable")
	}
	recomputeStoredBeanAgesOnce(sqlDB, shots.NewRepository(sqlDB), failing)

	if got, _ := storedAge(t, sqlDB, 1); got != 115 {
		t.Fatalf("shot 1 stores %v, want the untouched 115", got)
	}
	flagged, err := db.GetKVBool(sqlDB, beanAgesRecomputedKey)
	if err != nil {
		t.Fatalf("GetKVBool: %v", err)
	}
	if flagged {
		t.Fatal("the recompute flag is set although the load failed")
	}
}
