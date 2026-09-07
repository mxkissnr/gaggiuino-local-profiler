package achievements

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/db"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/library"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/maintenance"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/orders"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

type testEnv struct {
	db      *sql.DB
	svc     *Service
	handler *Handlers
	version VersionCache
}

func newTestEnv(t *testing.T) *testEnv {
	t.Helper()
	dbPath := filepath.Join(t.TempDir(), "glp.db")
	sqlDB, err := db.Open(dbPath)
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { sqlDB.Close() })

	registry := machines.NewRegistry(sqlDB)
	if err := registry.EnsureDefaultMachine(); err != nil {
		t.Fatalf("EnsureDefaultMachine: %v", err)
	}
	libRepo := library.NewRepository(sqlDB)
	env := &testEnv{db: sqlDB}
	repo := NewRepository(sqlDB)
	env.svc = NewService(repo, Deps{
		Shots:       shots.NewRepository(sqlDB),
		Library:     libRepo,
		Orders:      orders.NewRepository(sqlDB),
		Maintenance: maintenance.NewRepository(sqlDB, libRepo),
		Registry:    registry,
		VersionFn:   func() VersionCache { return env.version },
	})
	env.handler = NewHandlers(env.svc)
	return env
}

func (e *testEnv) get(t *testing.T, lang string) map[string]any {
	t.Helper()
	mux := http.NewServeMux()
	e.handler.RegisterRoutes(mux)
	path := "/api/achievements"
	if lang != "" {
		path += "?lang=" + lang
	}
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET %s -> %d: %s", path, rec.Code, rec.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	return body
}

func (e *testEnv) insertShot(t *testing.T, id, timestampSec int64, data map[string]any, annotation map[string]any) {
	t.Helper()
	raw, _ := json.Marshal(data)
	if _, err := e.db.Exec(
		`INSERT INTO shots (id,timestamp,duration,profile_name,data,machine_id) VALUES (?,?,?,?,?,1)`,
		id, timestampSec, 30, "Default", string(raw),
	); err != nil {
		t.Fatalf("insert shot: %v", err)
	}
	if annotation != nil {
		annRaw, _ := json.Marshal(annotation)
		if _, err := e.db.Exec(`INSERT INTO annotations (shot_id,data) VALUES (?,?)`, id, string(annRaw)); err != nil {
			t.Fatalf("insert annotation: %v", err)
		}
	}
}

func loadFixture(t *testing.T, name string) map[string]any {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatalf("read fixture %s: %v", name, err)
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("decode fixture %s: %v", name, err)
	}
	return out
}

// badgeByID indexes a decoded response's badges array by id.
func badgeByID(body map[string]any) map[string]map[string]any {
	out := map[string]map[string]any{}
	arr, _ := body["badges"].([]any)
	for _, b := range arr {
		m, _ := b.(map[string]any)
		if id, _ := m["id"].(string); id != "" {
			out[id] = m
		}
	}
	return out
}
