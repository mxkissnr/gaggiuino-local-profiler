package shots

import (
	"errors"
	"testing"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/perfseed"
)

// TestEachScoredExcludingTrash_MatchesFindAll (#1721) pins that the
// achievements' streamed read yields FindAllExcludingTrash's shots in its
// order, with FindAllScoredExcludingTrash's scores, on a cold and then a
// warm score cache.
func TestEachScoredExcludingTrash_MatchesFindAll(t *testing.T) {
	sqlDB, _ := perfseed.OpenSeeded(t, perfseed.Equivalence)
	r := NewRepository(sqlDB)
	all, err := r.FindAllExcludingTrash()
	if err != nil {
		t.Fatal(err)
	}
	for _, pass := range []string{"cold cache", "warm cache"} {
		var (
			ids    []any
			scores []*int
		)
		err := r.EachScoredExcludingTrash(nil, func(s Shot, score *int) error {
			ids = append(ids, s["id"])
			scores = append(scores, score)
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
		if len(ids) != len(all) {
			t.Fatalf("%s: %d shots, want %d", pass, len(ids), len(all))
		}
		for i, s := range all {
			if ids[i] != s["id"] {
				t.Fatalf("%s: shot %d is id %v, want %v", pass, i, ids[i], s["id"])
			}
			want := CalcShotScoreDetail(s, nil).Score
			if (scores[i] == nil) != (want == nil) || (want != nil && *scores[i] != *want) {
				t.Fatalf("%s: shot %v score = %v, want %v", pass, s["id"], scores[i], want)
			}
		}
		var cached int
		if err := sqlDB.QueryRow(`SELECT COUNT(*) FROM shot_score_cache`).Scan(&cached); err != nil {
			t.Fatal(err)
		}
		if cached < len(all) {
			t.Fatalf("%s: %d cached scores after the pass, want at least %d", pass, cached, len(all))
		}
	}

	stop := errors.New("stop")
	n := 0
	err = r.EachScoredExcludingTrash(nil, func(Shot, *int) error { n++; return stop })
	if !errors.Is(err, stop) || n != 1 {
		t.Fatalf("an error from fn must stop the scan: err=%v after %d shots", err, n)
	}
}
