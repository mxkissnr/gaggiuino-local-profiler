package shots_test

import (
	"reflect"
	"testing"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/perfseed"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// TestComparativeAdvice_MatchesFullHistoryComputation (#1616) pins that the
// cached, candidates-only Service path returns exactly what the pure
// function returns over the machine's fully hydrated history, on a cold
// and a warm score cache.
func TestComparativeAdvice_MatchesFullHistoryComputation(t *testing.T) {
	env := newPerfEnv(t, perfseed.Equivalence)
	check := func(phase string) {
		t.Helper()
		n := 0
		for i, id := range env.info.ShotIDs {
			if i%3 != 0 {
				continue
			}
			shot, err := env.svc.GetByID(id)
			if err != nil {
				t.Fatal(err)
			}
			if shot == nil {
				continue
			}
			got, err := env.svc.GetComparativeGrindAdvice(shot, "en")
			if err != nil {
				t.Fatal(err)
			}
			mid, _ := shot["machineId"].(int64)
			history, err := env.repo.FindAllExcludingTrashByMachine(mid)
			if err != nil {
				t.Fatal(err)
			}
			want := shots.ComputeComparativeGrindAdvice(shot, history)
			if !reflect.DeepEqual(got, want) {
				t.Errorf("%s shot %d: advice = %+v, full-history computation %+v", phase, id, got, want)
			}
			if want != nil {
				n++
			}
		}
		if n == 0 {
			t.Fatalf("%s: no shot had advice — check the seed", phase)
		}
	}
	check("cold")
	warmScoreCache(t, env.svc)
	check("warm")
}
