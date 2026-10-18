package maintenance

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/library"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/perfseed"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// BenchmarkGetMaintenance measures GET /api/maintenance (one machine) and
// GET /api/maintenance?machine=all against the #1616 dataset (5,000 shots).
// Run:
//
//	go test ./internal/maintenance -run '^$' -bench BenchmarkGetMaintenance -benchmem
func BenchmarkGetMaintenance(b *testing.B) {
	sqlDB, _ := perfseed.OpenSeeded(b, perfseed.Default)
	libRepo := library.NewRepository(sqlDB)
	h := NewHandlers(NewRepository(sqlDB, libRepo), shots.NewRepository(sqlDB), libRepo, machines.NewRegistry(sqlDB))
	mux := http.NewServeMux()
	h.RegisterRoutes(mux)

	for _, path := range []string{"/api/maintenance", "/api/maintenance?machine=all"} {
		b.Run(path, func(b *testing.B) {
			b.ReportAllocs()
			for i := 0; i < b.N; i++ {
				rec := httptest.NewRecorder()
				mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
				if rec.Code != http.StatusOK {
					b.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
				}
			}
		})
	}
}

// BenchmarkShotCountFor measures the maintenance-log shot counter for a
// machine-scoped and a shared-equipment task.
func BenchmarkShotCountFor(b *testing.B) {
	sqlDB, _ := perfseed.OpenSeeded(b, perfseed.Default)
	shotsRepo := shots.NewRepository(sqlDB)
	for _, task := range []string{"descaling", "waterfilter"} {
		b.Run(task, func(b *testing.B) {
			b.ReportAllocs()
			for i := 0; i < b.N; i++ {
				if ShotCountFor(shotsRepo, task, 1) == 0 {
					b.Fatal("zero shots counted")
				}
			}
		})
	}
}
