package achievements

import (
	"testing"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/perfseed"
)

// TestEquivalence1616_Achievements pins one full evaluation pass on the
// #1616 equivalence dataset — every badge's check result and progress, and
// the score buildContext injects into each shot — captured before the pass
// stopped decoding each shot's curve once per badge.
func TestEquivalence1616_Achievements(t *testing.T) {
	perfseed.PinUTC(t)
	deps := perfDeps(t, perfseed.Equivalence)
	ctx, err := buildContext(deps, nil)
	if err != nil {
		t.Fatal(err)
	}
	type result struct {
		ID       string `json:"id"`
		Unlocked bool   `json:"unlocked"`
		Progress *int   `json:"progress,omitempty"`
	}
	var badgesOut []result
	for _, b := range badges() {
		if isRetired(b) {
			continue
		}
		r := result{ID: b.ID, Unlocked: safeCheck(b, ctx)}
		if b.Progress != nil {
			p := safeProgress(b, ctx)
			r.Progress = &p
		}
		badgesOut = append(badgesOut, r)
	}
	scores := make([][2]any, 0, len(ctx.Shots))
	for _, s := range ctx.Shots {
		scores = append(scores, [2]any{s["id"], shotScore(s)})
	}
	perfseed.AssertGolden(t, "achievements", map[string]any{
		"badges":     badgesOut,
		"shotScores": scores,
		"totalYield": totalYieldG(ctx),
	})
}
