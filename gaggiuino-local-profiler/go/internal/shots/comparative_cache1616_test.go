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
// and a warm score cache, and on a database where legacy data blobs
// override the id/profileName columns (the full-hydrate fallback).
func TestComparativeAdvice_MatchesFullHistoryComputation(t *testing.T) {
	for _, legacyIdentity := range []bool{false, true} {
		env := newPerfEnv(t, perfseed.Equivalence)
		if legacyIdentity {
			// A blob profileName overrides the column on hydration.
			if _, err := env.db.Exec(`UPDATE shots SET data = json_set(data, '$.profileName', 'Blob Profile') WHERE id % 17 = 0`); err != nil {
				t.Fatal(err)
			}
		}
		check := func(phase string) {
			t.Helper()
			n := 0
			for i, id := range env.info.ShotIDs {
				if i%23 != 0 {
					continue
				}
				shot, err := env.svc.GetByID(id)
				if err != nil {
					t.Fatal(err)
				}
				if shot == nil {
					continue
				}
				got, err := env.svc.GetComparativeGrindAdvice(shot)
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
					t.Errorf("legacy=%v %s shot %d: advice = %+v, full-history computation %+v", legacyIdentity, phase, id, got, want)
				}
				if want != nil {
					n++
				}
			}
			if n == 0 {
				t.Fatalf("legacy=%v %s: no shot had advice — check the seed", legacyIdentity, phase)
			}
		}
		check("cold")
		warmScoreCache(t, env.svc)
		check("warm")
	}
}
