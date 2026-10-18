package achievements

import (
	"testing"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/library"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/maintenance"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/orders"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/perfseed"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// perfDeps wires Deps over a perfseed database the way cmd/server does.
func perfDeps(b testing.TB, opts perfseed.Options) Deps {
	sqlDB, _ := perfseed.OpenSeeded(b, opts)
	libRepo := library.NewRepository(sqlDB)
	return Deps{
		Shots:       shots.NewRepository(sqlDB),
		Library:     libRepo,
		Orders:      orders.NewRepository(sqlDB),
		Maintenance: maintenance.NewRepository(sqlDB, libRepo),
		Registry:    machines.NewRegistry(sqlDB),
	}
}

// evaluateEveryBadge is one full evaluation pass over every live badge —
// what evaluateAll does on a fresh install, minus the DB writes — so the
// benchmark measures the same work on every iteration instead of shrinking
// as badges unlock.
func evaluateEveryBadge(deps Deps) (unlocked int, err error) {
	ctx, err := buildContext(deps, nil)
	if err != nil {
		return 0, err
	}
	for _, b := range badges() {
		if isRetired(b) {
			continue
		}
		if safeCheck(b, ctx) {
			unlocked++
		} else if b.Progress != nil {
			safeProgress(b, ctx)
		}
	}
	return unlocked, nil
}

// BenchmarkEvaluateAchievements measures one achievements evaluation pass
// (context build + every badge check) against the #1616 dataset (5,000
// shots). Run:
//
//	go test ./internal/achievements -run '^$' -bench BenchmarkEvaluateAchievements -benchmem
func BenchmarkEvaluateAchievements(b *testing.B) {
	deps := perfDeps(b, perfseed.Default)
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		n, err := evaluateEveryBadge(deps)
		if err != nil {
			b.Fatal(err)
		}
		if n == 0 {
			b.Fatal("no badge unlocked on the seeded dataset")
		}
	}
}
