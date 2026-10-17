package library

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/perfseed"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// BenchmarkGetLibrary measures GET /api/library against the #1616 dataset
// (5,000 shots): the grinder-wear enrichment is the part that scales with
// the shot history. Run:
//
//	go test ./internal/library -run '^$' -bench BenchmarkGetLibrary -benchmem
func BenchmarkGetLibrary(b *testing.B) {
	sqlDB, _ := perfseed.OpenSeeded(b, perfseed.Default)
	h := NewHandlers(NewRepository(sqlDB), shots.NewRepository(sqlDB))
	mux := http.NewServeMux()
	h.RegisterRoutes(mux)

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/library", nil))
		if rec.Code != http.StatusOK {
			b.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
		}
	}
}
