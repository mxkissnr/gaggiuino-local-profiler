package shots

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"path/filepath"
	"testing"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/db"
)

// newTestHandlers opens a throwaway on-disk SQLite DB via internal/db.Open
// (same fixture pattern as internal/db's own tests — see db_test.go) and
// wires it into a fresh Handlers/Repository pair.
func newTestHandlers(t testing.TB) (*Handlers, *Repository, *sql.DB) {
	t.Helper()
	dbPath := filepath.Join(t.TempDir(), "glp.db")
	sqlDB, err := db.Open(dbPath)
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { sqlDB.Close() })
	repo := NewRepository(sqlDB)
	h := NewHandlers(repo)
	// DefaultImageDir ("/data/bean-images") isn't writable by a test
	// process — point image uploads at a throwaway dir instead.
	h.imageDir = t.TempDir()
	return h, repo, sqlDB
}

// newMux routes h's endpoints through a real *http.ServeMux — required for
// r.PathValue("id") to be populated at all; calling a handler method
// directly with a hand-built *http.Request (no mux involved) leaves every
// path parameter empty.
func newMux(h *Handlers) *http.ServeMux {
	mux := http.NewServeMux()
	h.RegisterRoutes(mux)
	return mux
}

// insertShot writes a shots row directly (bypassing Repository, which
// deliberately doesn't port ShotRepository.js's upsert()/upsertMany() in
// this phase — see repository.go's doc comment) plus an optional
// annotation row.
func insertShot(t testing.TB, sqlDB *sql.DB, id, timestamp int64, duration *int64, profileName string, data map[string]any, annotation map[string]any) {
	t.Helper()
	if data == nil {
		data = map[string]any{}
	}
	b, err := json.Marshal(data)
	if err != nil {
		t.Fatalf("marshaling shot data: %v", err)
	}
	var durVal any
	if duration != nil {
		durVal = *duration
	}
	var pn any
	if profileName != "" {
		pn = profileName
	}
	if _, err := sqlDB.Exec(
		`INSERT INTO shots (id, timestamp, duration, profile_name, data, machine_id) VALUES (?,?,?,?,?,1)`,
		id, timestamp, durVal, pn, string(b),
	); err != nil {
		t.Fatalf("inserting shot %d: %v", id, err)
	}
	if annotation != nil {
		ab, err := json.Marshal(annotation)
		if err != nil {
			t.Fatalf("marshaling annotation: %v", err)
		}
		if _, err := sqlDB.Exec(`INSERT INTO annotations (shot_id, data) VALUES (?, ?)`, id, string(ab)); err != nil {
			t.Fatalf("inserting annotation for shot %d: %v", id, err)
		}
	}
}

func decodeBody(t testing.TB, body []byte) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(body, &m); err != nil {
		t.Fatalf("decoding response body %q: %v", body, err)
	}
	return m
}
