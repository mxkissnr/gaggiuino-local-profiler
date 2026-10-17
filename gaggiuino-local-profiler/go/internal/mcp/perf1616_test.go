package mcp

import (
	"testing"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/library"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/perfseed"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// BenchmarkGetLibraryTool measures the MCP get_library tool against the
// #1616 dataset (5,000 shots); like GET /api/library it computes every
// grinder's wear from the shot history. Run:
//
//	go test ./internal/mcp -run '^$' -bench BenchmarkGetLibraryTool -benchmem
func BenchmarkGetLibraryTool(b *testing.B) {
	sqlDB, _ := perfseed.OpenSeeded(b, perfseed.Default)
	shotsRepo := shots.NewRepository(sqlDB)
	deps := Deps{Shots: shots.NewService(shotsRepo), ShotsRepo: shotsRepo, Library: library.NewRepository(sqlDB)}

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		out, err := getLibrary(deps, getLibraryInput{})
		if err != nil {
			b.Fatal(err)
		}
		if len(out.Grinders) == 0 {
			b.Fatal("no grinders in the seeded library")
		}
	}
}
