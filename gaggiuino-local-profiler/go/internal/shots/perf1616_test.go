package shots_test

import (
	"database/sql"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/library"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/perfseed"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// installBeanSource wires the library bean lookup the way cmd/server does,
// so scores resolve each shot's bean target.
func installBeanSource(tb testing.TB, libRepo *library.Repository) {
	tb.Helper()
	shots.SetBeanSource(func() (func(shots.Shot) *shots.Bean, error) {
		lib, err := libRepo.GetLibrary()
		if err != nil {
			return nil, err
		}
		beans := lib.Beans
		return func(s shots.Shot) *shots.Bean { return library.ScoreBean(s, beans) }, nil
	})
	tb.Cleanup(func() { shots.SetBeanSource(nil) })
}

type perfEnv struct {
	db   *sql.DB
	repo *shots.Repository
	svc  *shots.Service
	mux  *http.ServeMux
	info perfseed.Info
}

func newPerfEnv(tb testing.TB, opts perfseed.Options) perfEnv {
	tb.Helper()
	if opts == perfseed.Equivalence {
		perfseed.PinUTC(tb)
	}
	sqlDB, info := perfseed.OpenSeeded(tb, opts)
	installBeanSource(tb, library.NewRepository(sqlDB))
	repo := shots.NewRepository(sqlDB)
	mux := http.NewServeMux()
	shots.NewHandlers(repo).RegisterRoutes(mux)
	return perfEnv{db: sqlDB, repo: repo, svc: shots.NewService(repo), mux: mux, info: info}
}

func (e perfEnv) get(tb testing.TB, path string) *httptest.ResponseRecorder {
	tb.Helper()
	rec := httptest.NewRecorder()
	e.mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
	if rec.Code != http.StatusOK {
		tb.Fatalf("GET %s: status = %d: %s", path, rec.Code, rec.Body.String())
	}
	return rec
}

// BenchmarkShotsJSON measures GET /shots.json against the #1616 dataset
// (5,000 shots) — the Home Assistant integration polls it every 60 s — in
// steady state (one warm-up request first), for the full list and for the
// ?limit=10 the integration needs. Run:
//
//	go test ./internal/shots -run '^$' -bench BenchmarkShotsJSON -benchmem
func BenchmarkShotsJSON(b *testing.B) {
	env := newPerfEnv(b, perfseed.Default)
	for _, path := range []string{"/shots.json", "/shots.json?limit=10"} {
		b.Run(path, func(b *testing.B) {
			env.get(b, path)
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				env.get(b, path)
			}
		})
	}
}

// BenchmarkComparativeGrindAdvice measures the comparative grind advice for
// a shot with a long same-bean/same-grinder history (the MCP get_shot
// tool's call path). The score cache is warmed once, as a running install
// has it after the first GET /api/shots pages.
func BenchmarkComparativeGrindAdvice(b *testing.B) {
	env := newPerfEnv(b, perfseed.Default)
	shot, err := env.svc.GetByID(env.info.LatestAnnotatedID)
	if err != nil || shot == nil {
		b.Fatalf("GetByID(%d) = %v, %v", env.info.LatestAnnotatedID, shot, err)
	}
	warmScoreCache(b, env.svc)

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := env.svc.GetComparativeGrindAdvice(shot); err != nil {
			b.Fatal(err)
		}
	}
}

// warmScoreCache pages through the whole history once, which backfills
// shot_score_cache for every shot.
func warmScoreCache(tb testing.TB, svc *shots.Service) {
	tb.Helper()
	var cur shots.Cursor
	for {
		page, err := svc.GetPage(cur, shots.MaxPageLimit, 0)
		if err != nil {
			tb.Fatal(err)
		}
		if !page.HasMore {
			return
		}
		cur = page.NextCursor
	}
}
