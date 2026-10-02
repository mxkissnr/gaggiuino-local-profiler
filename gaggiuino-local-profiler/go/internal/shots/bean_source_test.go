package shots

import (
	"errors"
	"testing"
)

// withFakeBeanSource installs a bean source for the duration of the test and
// restores the no-source (generic bands) default afterwards.
func withFakeBeanSource(t *testing.T, fn func() (func(Shot) *Bean, error)) {
	t.Helper()
	SetBeanSource(fn)
	t.Cleanup(func() { SetBeanSource(nil) })
}

func TestComputeScoreDetail_UsesBeanTargetWhenSourceSet(t *testing.T) {
	shot := fullScoreShot(300)

	withoutSource := NewService(nil).ComputeScoreDetail(shot)
	if withoutSource.Score == nil || *withoutSource.Score != 100 {
		t.Fatalf("baseline score = %v, want 100 (generic bands)", withoutSource.Score)
	}

	withFakeBeanSource(t, func() (func(Shot) *Bean, error) {
		temp := 80.0 // outside the shot's 90C average, so accuracy drops
		bean := &Bean{BrewTempC: &temp}
		return func(Shot) *Bean { return bean }, nil
	})

	detail := NewService(nil).ComputeScoreDetail(shot)
	if !detail.UsedBeanTarget {
		t.Fatal("expected UsedBeanTarget = true once a bean source is installed")
	}
	if detail.Score == nil {
		t.Fatal("expected a non-nil score")
	}
	if *detail.Score == 100 {
		t.Errorf("score = %d, want it to differ from the generic-band 100", *detail.Score)
	}
}

func TestComputeScoreDetail_FallsBackOnSourceError(t *testing.T) {
	shot := fullScoreShot(300)
	want := NewService(nil).ComputeScoreDetail(shot)

	withFakeBeanSource(t, func() (func(Shot) *Bean, error) {
		return nil, errors.New("library unavailable")
	})

	got := NewService(nil).ComputeScoreDetail(shot)
	if got.UsedBeanTarget {
		t.Error("expected UsedBeanTarget = false when the bean source errors")
	}
	if got.Score == nil || want.Score == nil || *got.Score != *want.Score {
		t.Errorf("score = %v, want %v (generic bands) on a source error", got.Score, want.Score)
	}
}

func TestScorer_LoadsBeanSourceOncePerRequest(t *testing.T) {
	loads := 0
	withFakeBeanSource(t, func() (func(Shot) *Bean, error) {
		loads++
		return func(Shot) *Bean { return nil }, nil
	})

	svc := NewService(nil)
	scorer := svc.Scorer()
	for i := 0; i < 5; i++ {
		scorer(fullScoreShot(300))
	}
	if loads != 1 {
		t.Errorf("bean source loaded %d times, want 1 for one Scorer()", loads)
	}
}

func TestComputeScore_MatchesDetailScore(t *testing.T) {
	temp := 93.0
	withFakeBeanSource(t, func() (func(Shot) *Bean, error) {
		bean := &Bean{BrewTempC: &temp}
		return func(Shot) *Bean { return bean }, nil
	})

	svc := NewService(nil)
	shot := fullScoreShot(300)
	detail := svc.ComputeScoreDetail(shot)
	score := svc.ComputeScore(shot)
	if detail.Score == nil || score == nil || *detail.Score != *score {
		t.Errorf("ComputeScore = %v, ComputeScoreDetail.Score = %v, want equal", score, detail.Score)
	}
}
