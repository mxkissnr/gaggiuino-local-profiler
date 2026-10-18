package mcp

import (
	"testing"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/library"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/perfseed"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// TestEquivalence1616_GetLibraryTool pins the MCP get_library tool's output
// (full and grinders-only) on the #1616 equivalence dataset, captured before
// the grinder wear stopped hydrating every shot.
func TestEquivalence1616_GetLibraryTool(t *testing.T) {
	sqlDB, _ := perfseed.OpenEquivalence(t)
	shotsRepo := shots.NewRepository(sqlDB)
	deps := Deps{Shots: shots.NewService(shotsRepo), ShotsRepo: shotsRepo, Library: library.NewRepository(sqlDB)}

	full, err := getLibrary(deps, getLibraryInput{})
	if err != nil {
		t.Fatal(err)
	}
	grinders, err := getLibrary(deps, getLibraryInput{Section: "grinders"})
	if err != nil {
		t.Fatal(err)
	}
	perfseed.AssertGolden(t, "get_library", map[string]any{"full": full, "grinders": grinders})
}

// TestEquivalence1616_ListShotsSince pins list_shots with a since/until
// window on the #1616 equivalence dataset, captured before the scan learned
// to stop at the window's lower bound.
func TestEquivalence1616_ListShotsSince(t *testing.T) {
	sqlDB, _ := perfseed.OpenEquivalence(t)
	svc := shots.NewService(shots.NewRepository(sqlDB))

	// 2023-01-01 .. 2023-07-01 UTC sits in the fixed-date part of the seed.
	const since, until = int64(1672531200), int64(1688169600)
	var got [][]any
	for _, f := range []shotFilters{
		{Lo: since, Hi: until},
		{Lo: since},
		{Lo: since, Hi: until, MinRating: 3},
		{Lo: since, Hi: until, Bean: "kenya"},
		{Lo: since, Hi: until, MachineID: 2},
	} {
		for _, limit := range []int{5, 1000} {
			var ids []int64
			next, err := scanShots(svc, f, limit, func(row shots.PageRow) {
				id, _ := row.Shot["id"].(int64)
				ids = append(ids, id)
			})
			if err != nil {
				t.Fatal(err)
			}
			// The cursor's timestamp may fall in the seed-day-relative tail, so
			// only its id is pinned.
			got = append(got, []any{f.Lo, f.Hi, f.MinRating, f.Bean, f.MachineID, limit, ids, next.Set, next.ID})
		}
	}
	perfseed.AssertGolden(t, "scan_shots_since", got)
}
