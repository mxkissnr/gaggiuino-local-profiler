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

// BenchmarkListShotsSince measures a list_shots-style scan bounded below
// by since (2025-06-01, the newest part of the #1616 dataset) with a limit
// the window cannot fill, so the scan has to decide when to stop.
func BenchmarkListShotsSince(b *testing.B) {
	sqlDB, _ := perfseed.OpenSeeded(b, perfseed.Default)
	svc := shots.NewService(shots.NewRepository(sqlDB))
	filters := shotFilters{Lo: 1748736000}
	if _, err := scanShots(svc, filters, 5000, func(shots.PageRow) {}); err != nil { // warm the score cache
		b.Fatal(err)
	}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		n := 0
		if _, err := scanShots(svc, filters, 5000, func(shots.PageRow) { n++ }); err != nil {
			b.Fatal(err)
		}
		if n == 0 {
			b.Fatal("no shots in the window")
		}
	}
}
