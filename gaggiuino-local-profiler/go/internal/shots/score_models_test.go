package shots

// #1922: the score model registry. The invariant this file pins is that the
// classic model is byte-for-byte today's scorer — same ScoreDetail, same
// score-cache fingerprint — so introducing the registry rescored nothing on
// upgrade, and that switching the active model actually changes every read
// path's scores (CLAUDE.md rule (a): a setting test must prove changing the
// setting changes behaviour).

import (
	"reflect"
	"strings"
	"testing"
)

// scoreModelIDs is the registry's ids in registry order.
func scoreModelIDs() []string {
	models := loadScoreModels()
	ids := make([]string, len(models))
	for i, m := range models {
		ids[i] = m.ID
	}
	return ids
}

// registerScoreModelForTest appends m to the registry and restores the
// previous registry on cleanup. Not safe with t.Parallel().
func registerScoreModelForTest(t testing.TB, m ScoreModel) {
	t.Helper()
	prev := loadScoreModels()
	next := make([]ScoreModel, 0, len(prev)+1)
	next = append(next, prev...)
	next = append(next, m)
	scoreModels.Store(&next)
	t.Cleanup(func() {
		restored := prev
		scoreModels.Store(&restored)
	})
}

// testConstantModel scores every shot 7 — distinct from any real score, so a
// path that did not follow the active model is obvious.
func testConstantModel() ScoreModel {
	return ScoreModel{ID: "test_const", Score: func(Shot, *Bean) ScoreDetail {
		v := 7
		return ScoreDetail{Score: &v}
	}}
}

func TestScoreModels_OnlyClassicRegistered(t *testing.T) {
	if got, want := scoreModelIDs(), []string{"classic"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("registry ids = %v, want %v", got, want)
	}
}

func TestActiveScoreModel_FallsBackToClassic(t *testing.T) {
	t.Cleanup(func() { SetScoreModelSource(nil) })

	if got := activeScoreModel().ID; got != ClassicScoreModel {
		t.Errorf("no source: active model = %q, want %q", got, ClassicScoreModel)
	}
	for _, id := range []string{"", "classic", "nope", "CLASSIC"} {
		SetScoreModelSource(func() string { return id })
		if got := activeScoreModel().ID; got != ClassicScoreModel {
			t.Errorf("source %q: active model = %q, want %q", id, got, ClassicScoreModel)
		}
	}
}

// TestDefaultModel_IdenticalToCalcShotScoreDetail is the Go half of the
// issue's invariant: with no model selected, the registry's scorer is exactly
// CalcShotScoreDetail. KnownDivergence is a Go/TS note, so no case is skipped.
func TestDefaultModel_IdenticalToCalcShotScoreDetail(t *testing.T) {
	t.Cleanup(func() {
		SetScoreModelSource(nil)
		SetBeanSource(nil)
	})
	_, repo, _ := newTestHandlers(t)
	svc := NewService(repo)
	SetBeanSource(nil)
	for _, c := range loadScoreParityCases(t) {
		t.Run(c.Name, func(t *testing.T) {
			SetScoreModelSource(nil)
			var bean *Bean
			if c.Bean != nil {
				bean = &Bean{BrewTempC: c.Bean.BrewTempC, BrewRatio: c.Bean.BrewRatio}
			}
			shot := Shot(c.Shot)
			want := CalcShotScoreDetail(shot, bean)

			if got := activeScoreModel().Score(shot, bean); !reflect.DeepEqual(got, want) {
				t.Errorf("no source: score detail = %+v, want %+v", got, want)
			}

			SetScoreModelSource(func() string { return ClassicScoreModel })
			if got := activeScoreModel().Score(shot, bean); !reflect.DeepEqual(got, want) {
				t.Errorf("source classic: score detail = %+v, want %+v", got, want)
			}
			if got := svc.DetailScorer()(shot); !reflect.DeepEqual(got, CalcShotScoreDetail(shot, nil)) {
				t.Errorf("DetailScorer: score detail = %+v, want %+v", got, CalcShotScoreDetail(shot, nil))
			}
		})
	}
}

// TestScoreCache_ClassicFingerprintUnchanged pins that the default model adds
// nothing to the fingerprint, so every cache row written before #1922 stays a
// hit and an upgrade rescores nothing.
func TestScoreCache_ClassicFingerprintUnchanged(t *testing.T) {
	t.Cleanup(func() { SetScoreModelSource(nil) })
	_, repo, _ := newTestHandlers(t)
	seedShots(t, repo, 3)

	if _, err := repo.FindPageExcludingTrash(Cursor{}, 60, 0); err != nil {
		t.Fatalf("FindPageExcludingTrash: %v", err)
	}
	fp, ok := cachedScoreRow(t, repo, 3)
	if !ok {
		t.Fatal("expected a cache row after the first read")
	}
	if want := "|" + beanTargetSignature(nil); len(fp) < len(want) || fp[len(fp)-len(want):] != want {
		t.Fatalf("fingerprint %q does not end with %q (empty bean signature)", fp, want)
	}
	if strings.Contains(fp, "|m=") {
		t.Fatalf("classic fingerprint %q carries a model suffix", fp)
	}

	// A pre-#1922 row (same fingerprint, sentinel score) must still be served
	// as-is: nothing is recomputed on upgrade. Real scores are 0..100.
	const sentinel = 1000
	if _, err := repo.db.Exec(`UPDATE shot_score_cache SET score = ? WHERE shot_id = 3`, sentinel); err != nil {
		t.Fatalf("writing sentinel score: %v", err)
	}
	page, err := repo.FindPageExcludingTrash(Cursor{}, 60, 0)
	if err != nil {
		t.Fatalf("FindPageExcludingTrash: %v", err)
	}
	for _, row := range page.Rows {
		if row.Shot["id"] != int64(3) {
			continue
		}
		if row.Score == nil || *row.Score != sentinel {
			t.Fatalf("cached sentinel score = %v, want %d (the row should still be a cache hit)", row.Score, sentinel)
		}
	}
}

// TestScoreModelSwitch_EveryReadPathFollows proves switching the active model
// changes every server read path, and switching back restores classic.
func TestScoreModelSwitch_EveryReadPathFollows(t *testing.T) {
	t.Cleanup(func() {
		SetScoreModelSource(nil)
		SetBeanSource(nil)
	})
	_, repo, _ := newTestHandlers(t)
	seedShots(t, repo, 3)
	SetBeanSource(nil)
	svc := NewService(repo)

	classicPage, err := repo.FindPageExcludingTrash(Cursor{}, 60, 0)
	if err != nil {
		t.Fatalf("FindPageExcludingTrash: %v", err)
	}
	if len(classicPage.Rows) != 3 {
		t.Fatalf("seeded %d shots, read %d", 3, len(classicPage.Rows))
	}
	classicScores := map[int64]*int{}
	var shot Shot
	for _, row := range classicPage.Rows {
		classicScores[row.Shot["id"].(int64)] = row.Score
		if shot == nil {
			shot = row.Shot
		}
	}

	registerScoreModelForTest(t, testConstantModel())
	SetScoreModelSource(func() string { return "test_const" })

	assertAllScoresAre(t, repo, svc, shot, 7)

	fp, ok := cachedScoreRow(t, repo, 3)
	if !ok {
		t.Fatal("expected a cache row after the model switch")
	}
	if wantSuffix := "|m=test_const"; len(fp) < len(wantSuffix) || fp[len(fp)-len(wantSuffix):] != wantSuffix {
		t.Fatalf("fingerprint %q does not end with %q", fp, wantSuffix)
	}

	SetScoreModelSource(func() string { return ClassicScoreModel })
	page, err := repo.FindPageExcludingTrash(Cursor{}, 60, 0)
	if err != nil {
		t.Fatalf("FindPageExcludingTrash: %v", err)
	}
	for _, row := range page.Rows {
		want := classicScores[row.Shot["id"].(int64)]
		if !sameScore(row.Score, want) {
			t.Fatalf("shot %v: score after switching back = %v, want classic %v", row.Shot["id"], row.Score, want)
		}
	}
}

// assertAllScoresAre checks every read path yields score want for these
// seeded shots: the page read, /shots.json, the achievements stream, the
// comparative-advice candidates and Service.ComputeScore.
func assertAllScoresAre(t *testing.T, repo *Repository, svc *Service, shot Shot, want int) {
	t.Helper()

	page, err := repo.FindPageExcludingTrash(Cursor{}, 60, 0)
	if err != nil {
		t.Fatalf("FindPageExcludingTrash: %v", err)
	}
	if len(page.Rows) == 0 {
		t.Fatal("page read returned no rows")
	}
	for _, row := range page.Rows {
		if row.Score == nil || *row.Score != want {
			t.Errorf("page read: shot %v score = %v, want %d", row.Shot["id"], row.Score, want)
		}
	}

	scored, err := svc.GetAllScored(0)
	if err != nil {
		t.Fatalf("GetAllScored: %v", err)
	}
	if len(scored) == 0 {
		t.Fatal("GetAllScored returned no rows")
	}
	for _, row := range scored {
		if row.Score == nil || *row.Score != want {
			t.Errorf("GetAllScored: shot %v score = %v, want %d", row.Shot["id"], row.Score, want)
		}
	}

	n := 0
	if err := repo.EachScoredExcludingTrash(nil, func(s Shot, score *int) error {
		n++
		if score == nil || *score != want {
			t.Errorf("achievements stream: shot %v score = %v, want %d", s["id"], score, want)
		}
		return nil
	}); err != nil {
		t.Fatalf("EachScoredExcludingTrash: %v", err)
	}
	if n == 0 {
		t.Fatal("achievements stream yielded no shots")
	}

	candidates, err := repo.comparativeCandidates(1, func(Shot) bool { return true }, nil)
	if err != nil {
		t.Fatalf("comparativeCandidates: %v", err)
	}
	if len(candidates) == 0 {
		t.Fatal("comparativeCandidates returned nothing")
	}
	for _, c := range candidates {
		if c.score == nil || *c.score != want {
			t.Errorf("comparative advice: shot %v score = %v, want %d", c.light["id"], c.score, want)
		}
	}

	if got := svc.ComputeScore(shot); got == nil || *got != want {
		t.Errorf("ComputeScore = %v, want %d", got, want)
	}
}

func sameScore(a, b *int) bool {
	switch {
	case a == nil && b == nil:
		return true
	case a == nil || b == nil:
		return false
	default:
		return *a == *b
	}
}
