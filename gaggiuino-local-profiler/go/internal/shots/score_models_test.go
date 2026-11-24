package shots

// #1922: the score model registry. The invariant this file pins is that the
// classic model is byte-for-byte today's scorer — same ScoreDetail, same
// score-cache fingerprint — so introducing the registry rescored nothing on
// upgrade, and that switching the active model actually changes every read
// path's scores (CLAUDE.md rule (a): a setting test must prove changing the
// setting changes behaviour).

import (
	stdjson "encoding/json"
	"math"
	"reflect"
	"strings"
	"testing"
)

// testConstantModel scores every shot 7 — distinct from any real score, so a
// path that did not follow the active model is obvious.
func testConstantModel() ScoreModel {
	return ScoreModel{ID: "test_const", Score: func(Shot, ScoreTargets) ScoreDetail {
		v := 7
		return ScoreDetail{Score: &v}
	}}
}

// registerScoreModelForTest appends m to the registry and restores the previous
// registry when t finishes. It lives here because the registry is unexported:
// only this package's tests register a second model. Not safe with
// t.Parallel().
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

func TestScoreModels_OnlyClassicRegistered(t *testing.T) {
	if got, want := ScoreModelIDs(), []string{"classic"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("registry ids = %v, want %v", got, want)
	}
}

// TestScoreModels_SecondModelListedAfterClassic covers the multi-model registry
// contract: a second registered model comes after classic in ScoreModelIDs and
// AllModelsScorer scores the same shot with both, in registry order. It is here
// rather than in another package's tests because the registry is unexported.
func TestScoreModels_SecondModelListedAfterClassic(t *testing.T) {
	t.Cleanup(func() {
		SetScoreModelSource(nil)
		SetBeanSource(nil)
	})
	registerScoreModelForTest(t, testConstantModel())

	if got, want := ScoreModelIDs(), []string{ClassicScoreModel, "test_const"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("registry ids = %v, want %v", got, want)
	}

	_, repo, _ := newTestHandlers(t)
	seedShots(t, repo, 3)
	SetBeanSource(nil)
	svc := NewService(repo)

	page, err := repo.FindPageExcludingTrash(Cursor{}, 60, 0)
	if err != nil {
		t.Fatalf("FindPageExcludingTrash: %v", err)
	}
	if len(page.Rows) == 0 {
		t.Fatal("page read returned no rows")
	}
	shot := page.Rows[0].Shot

	scores := svc.AllModelsScorer()(shot)
	if len(scores) != 2 {
		t.Fatalf("AllModelsScorer returned %d scores, want 2: %+v", len(scores), scores)
	}
	if scores[0].Model != ClassicScoreModel {
		t.Fatalf("scores[0].Model = %q, want %q", scores[0].Model, ClassicScoreModel)
	}
	if scores[1].Model != "test_const" {
		t.Fatalf("scores[1].Model = %q, want test_const", scores[1].Model)
	}
	if scores[1].Score == nil || *scores[1].Score != 7 {
		t.Fatalf("scores[1].Score = %v, want 7", scores[1].Score)
	}
	if want := CalcShotScoreDetail(shot, nil).Score; !sameScore(scores[0].Score, want) {
		t.Fatalf("classic model score = %v, want %v", scores[0].Score, want)
	}

	if got := ActiveScoreModelID(); got != ClassicScoreModel {
		t.Fatalf("ActiveScoreModelID = %q, want %q before the switch", got, ClassicScoreModel)
	}
	SetScoreModelSource(func() string { return "test_const" })
	if got := ActiveScoreModelID(); got != "test_const" {
		t.Fatalf("ActiveScoreModelID = %q, want test_const after the switch", got)
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

			if got := activeScoreModel().Score(shot, ScoreTargets{Bean: bean}); !reflect.DeepEqual(got, want) {
				t.Errorf("no source: score detail = %+v, want %+v", got, want)
			}

			SetScoreModelSource(func() string { return ClassicScoreModel })
			if got := activeScoreModel().Score(shot, ScoreTargets{Bean: bean}); !reflect.DeepEqual(got, want) {
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

// TestScoreCache_NoWindowFingerprintUnchanged pins that the time-window part
// of the fingerprint adds no bytes when no window is stored (#1504), so an
// upgrade rescores nothing.
func TestScoreCache_NoWindowFingerprintUnchanged(t *testing.T) {
	_, repo, _ := newTestHandlers(t)
	seedShots(t, repo, 3)

	if _, err := repo.FindPageExcludingTrash(Cursor{}, 60, 0); err != nil {
		t.Fatalf("FindPageExcludingTrash: %v", err)
	}
	fp, ok := cachedScoreRow(t, repo, 3)
	if !ok {
		t.Fatal("expected a cache row after the first read")
	}
	if strings.Contains(fp, "|w=") {
		t.Fatalf("fingerprint %q carries a time window with none stored", fp)
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
// comparative-advice candidates, Service.ComputeScore and the trash list.
// It moves shot 1 to the trash for the last check, so call it once per test.
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

	// The trash list is the one read that scores each shot through
	// Service.DetailScorer instead of the score cache, so it needs its own check.
	if err := repo.MoveToTrash(1); err != nil {
		t.Fatalf("MoveToTrash: %v", err)
	}
	trashed, err := svc.GetTrash()
	if err != nil {
		t.Fatalf("GetTrash: %v", err)
	}
	if len(trashed) == 0 {
		t.Fatal("trash list returned no shots")
	}
	detail := svc.DetailScorer()
	for _, s := range trashed {
		if got := detail(s).Score; got == nil || *got != want {
			t.Errorf("trash list: shot %v score = %v, want %d", s["id"], got, want)
		}
	}
	if err := repo.RestoreFromTrash(1); err != nil {
		t.Fatalf("RestoreFromTrash: %v", err)
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

// #2186: the experimental dev-channel model "adherence". Its part ports the
// #1505 harness's adherencePressureMae literally, so these tests pin the
// harness's rules: the 1.5 s settle window after phase 0, FLOW phases never
// count, and the series stay index-aligned (a null sample is not dropped).

// adherenceShot builds a one-phase PRESSURE shot from pressure/target samples
// taken at 0, 1, 2, 3 and 4 s.
func adherenceShot(pressure, target []any) Shot {
	return Shot{
		"profile": map[string]any{"phases": []any{map[string]any{"type": "PRESSURE"}}},
		"datapoints": map[string]any{
			"pressure":       pressure,
			"targetPressure": target,
			"timeInShot":     []any{0.0, 10.0, 20.0, 30.0, 40.0},
			"phaseIndex":     []any{0.0, 0.0, 0.0, 0.0, 0.0},
		},
	}
}

// weightedAverage recomputes a ScoreDetail's total from its own components, so
// the expectation follows classic's weights instead of duplicating them.
func weightedAverage(components []ScoreComponent) int {
	total, weighted := 0, 0.0
	for _, c := range components {
		total += c.Weight
		weighted += float64(c.Score * c.Weight)
	}
	return jsRound(weighted / float64(total))
}

func TestAdherence_PerfectAdherenceScores100(t *testing.T) {
	shot := adherenceShot(
		[]any{90.0, 90.0, 90.0, 90.0, 90.0},
		[]any{90.0, 90.0, 90.0, 90.0, 90.0},
	)
	detail := adherenceModel().Score(shot, ScoreTargets{})
	if detail.Score == nil {
		t.Fatal("adherence model did not score a fully scoreable shot")
	}
	part := componentByName(t, detail.Components, PressureAdherenceComponent)
	if part.Score != 100 {
		t.Errorf("%s score = %d, want 100 (perfect adherence)", PressureAdherenceComponent, part.Score)
	}
	if part.Weight != adherenceWeight {
		t.Errorf("%s weight = %d, want %d", PressureAdherenceComponent, part.Weight, adherenceWeight)
	}
	if part.Target != "profile" {
		t.Errorf("%s target = %q, want profile", PressureAdherenceComponent, part.Target)
	}
	if got := part.Inputs["pressure_mae_bar"]; got != 0 {
		t.Errorf("pressure_mae_bar = %v, want 0", got)
	}
	if got := part.Inputs["samples"]; got != 5 {
		t.Errorf("samples = %v, want 5", got)
	}
	if want := weightedAverage(detail.Components); *detail.Score != want {
		t.Errorf("total score = %d, want the weighted component average %d", *detail.Score, want)
	}
}

func TestAdherence_KnownMAEScoresHalf(t *testing.T) {
	shot := adherenceShot(
		[]any{90.0, 90.0, 90.0, 90.0, 90.0},
		[]any{75.0, 75.0, 75.0, 75.0, 75.0},
	)
	detail := adherenceModel().Score(shot, ScoreTargets{})
	if detail.Score == nil {
		t.Fatal("adherence model did not score a fully scoreable shot")
	}
	part := componentByName(t, detail.Components, PressureAdherenceComponent)
	if got := part.Inputs["pressure_mae_bar"]; math.Abs(got-1.5) > 1e-9 {
		t.Errorf("pressure_mae_bar = %v, want 1.5", got)
	}
	if got := part.Inputs["samples"]; got != 5 {
		t.Errorf("samples = %v, want 5", got)
	}
	if part.Score != 50 {
		t.Errorf("%s score = %d, want 50 for a 1.5 bar mean deviation", PressureAdherenceComponent, part.Score)
	}

	classic := classicModel().Score(shot, ScoreTargets{})
	if classic.Score == nil {
		t.Fatal("classic did not score the shot, so the adherence total has no baseline")
	}
	total, weighted := adherenceWeight, float64(part.Score*adherenceWeight)
	for _, c := range classic.Components {
		total += c.Weight
		weighted += float64(c.Score * c.Weight)
	}
	if want := jsRound(weighted / float64(total)); *detail.Score != want {
		t.Errorf("total score = %d, want %d", *detail.Score, want)
	}

	for _, tc := range []struct {
		mae  float64
		want int
	}{
		{0, 100},
		{3, 0},
		{4.2, 0},
	} {
		if got := adherencePartScore(tc.mae); got != tc.want {
			t.Errorf("adherencePartScore(%v) = %d, want %d", tc.mae, got, tc.want)
		}
	}
}

func TestAdherence_SettleWindowAndFlowPhasesExcluded(t *testing.T) {
	shot := Shot{
		"profile": map[string]any{"phases": []any{
			map[string]any{"type": "PRESSURE"},
			map[string]any{"type": "PRESSURE"},
			map[string]any{"type": "FLOW"},
		}},
		"datapoints": map[string]any{
			"timeInShot":     []any{0.0, 10.0, 20.0, 25.0, 30.0, 35.0, 40.0, 50.0, 60.0},
			"phaseIndex":     []any{0.0, 0.0, 1.0, 1.0, 1.0, 1.0, 1.0, 2.0, 2.0},
			"pressure":       []any{90.0, 90.0, 90.0, 90.0, 90.0, 90.0, 90.0, 90.0, 90.0},
			"targetPressure": []any{90.0, 90.0, 60.0, 60.0, 60.0, 90.0, 90.0, 0.0, 0.0},
		},
	}
	mae, samples, ok := adherencePressureMAE(shot)
	if !ok {
		t.Fatal("adherencePressureMAE reported no data for a shot with target pressure")
	}
	if samples != 4 {
		t.Errorf("samples = %d, want 4 (phase 1's first 1.5 s and the FLOW phase are skipped)", samples)
	}
	if mae != 0 {
		t.Errorf("mae = %v, want 0", mae)
	}
}

func TestAdherence_RawDatapointsKeepNullsAligned(t *testing.T) {
	raw := stdjson.RawMessage(`{"pressure":[90,null,90,90,90],"targetPressure":[90,60,60,90,90],"timeInShot":[0,10,20,30,40],"phaseIndex":[0,0,0,0,0]}`)
	profile := map[string]any{"phases": []any{map[string]any{"type": "PRESSURE"}}}
	rawShot := Shot{"profile": profile, "datapoints": raw}

	mae, samples, ok := adherencePressureMAE(rawShot)
	if !ok {
		t.Fatal("adherencePressureMAE reported no data for an aligned raw shot")
	}
	if samples != 4 {
		t.Errorf("raw samples = %d, want 4 (the null pressure sample is kept, not dropped)", samples)
	}
	if math.Abs(mae-0.75) > 1e-9 {
		t.Errorf("raw mae = %v, want 0.75 (a shifted series would give 1.5)", mae)
	}

	mapShot := Shot{"profile": profile, "datapoints": map[string]any{
		"pressure":       []any{90.0, nil, 90.0, 90.0, 90.0},
		"targetPressure": []any{90.0, 60.0, 60.0, 90.0, 90.0},
		"timeInShot":     []any{0.0, 10.0, 20.0, 30.0, 40.0},
		"phaseIndex":     []any{0.0, 0.0, 0.0, 0.0, 0.0},
	}}
	if got, want := adherenceModel().Score(mapShot, ScoreTargets{}), adherenceModel().Score(rawShot, ScoreTargets{}); !reflect.DeepEqual(got, want) {
		t.Fatalf("map detail = %+v, want the raw detail %+v", got, want)
	}
}

func TestAdherence_NoTargetDataEqualsClassic(t *testing.T) {
	flowProfile := map[string]any{"phases": []any{map[string]any{"type": "FLOW"}}}
	pressureProfile := map[string]any{"phases": []any{map[string]any{"type": "PRESSURE"}}}
	fullSeries := func() map[string]any {
		return map[string]any{
			"pressure":       []any{90.0, 90.0, 90.0, 90.0, 90.0},
			"targetPressure": []any{75.0, 75.0, 75.0, 75.0, 75.0},
			"timeInShot":     []any{0.0, 10.0, 20.0, 30.0, 40.0},
			"phaseIndex":     []any{0.0, 0.0, 0.0, 0.0, 0.0},
		}
	}

	noPhaseIndex := fullSeries()
	delete(noPhaseIndex, "phaseIndex")

	for _, tc := range []struct {
		name string
		shot Shot
	}{
		{"no profile", Shot{"datapoints": fullSeries()}},
		{"no phaseIndex series", Shot{"profile": pressureProfile, "datapoints": noPhaseIndex}},
		{"flow-only profile", Shot{"profile": flowProfile, "datapoints": fullSeries()}},
	} {
		got := adherenceModel().Score(tc.shot, ScoreTargets{})
		want := classicModel().Score(tc.shot, ScoreTargets{})
		if !reflect.DeepEqual(got, want) {
			t.Errorf("%s: adherence detail = %+v, want classic's %+v", tc.name, got, want)
		}
	}

	for _, c := range loadScoreParityCases(t) {
		shot := Shot(c.Shot)
		if _, _, ok := adherencePressureMAE(shot); ok {
			continue
		}
		targets := ScoreTargets{}
		if c.Bean != nil {
			targets.Bean = &Bean{BrewTempC: c.Bean.BrewTempC, BrewRatio: c.Bean.BrewRatio}
		}
		if c.TimeTarget != nil {
			targets.Time = &TimeTarget{MinS: c.TimeTarget.MinS, MaxS: c.TimeTarget.MaxS}
		}
		got := adherenceModel().Score(shot, targets)
		want := classicModel().Score(shot, targets)
		if !reflect.DeepEqual(got, want) {
			t.Errorf("parity case %q: adherence detail = %+v, want classic's %+v", c.Name, got, want)
		}
	}

	thin := Shot{
		"profile": pressureProfile,
		"datapoints": map[string]any{
			"pressure":   []any{90.0, 90.0, 90.0},
			"timeInShot": []any{0.0, 10.0, 20.0},
			"phaseIndex": []any{0.0, 0.0, 0.0},
		},
	}
	if got := adherenceModel().Score(thin, ScoreTargets{}).Score; got != nil {
		t.Errorf("thin shot adherence score = %v, want nil like classic", *got)
	}
	if got := classicModel().Score(thin, ScoreTargets{}).Score; got != nil {
		t.Errorf("thin shot classic score = %v, want nil", *got)
	}
}

func TestAdherence_WeightSum(t *testing.T) {
	shot := adherenceShot(
		[]any{90.0, 90.0, 90.0, 90.0, 90.0},
		[]any{75.0, 75.0, 75.0, 75.0, 75.0},
	)
	classic := classicModel().Score(shot, ScoreTargets{})
	before := make([]ScoreComponent, len(classic.Components))
	copy(before, classic.Components)

	detail := adherenceModel().Score(shot, ScoreTargets{})
	if len(detail.Components) != len(before)+1 {
		t.Fatalf("adherence components = %d, want classic's %d plus one", len(detail.Components), len(before))
	}
	classicWeight := 0
	for i, c := range before {
		if !reflect.DeepEqual(detail.Components[i], c) {
			t.Errorf("component %d = %+v, want classic's %+v in the same order", i, detail.Components[i], c)
		}
		classicWeight += c.Weight
	}
	part := detail.Components[len(detail.Components)-1]
	if part.Name != PressureAdherenceComponent || part.Weight != adherenceWeight {
		t.Fatalf("last component = %+v, want a %s part of weight %d", part, PressureAdherenceComponent, adherenceWeight)
	}
	total := 0
	for _, c := range detail.Components {
		total += c.Weight
	}
	if want := classicWeight + adherenceWeight; total != want {
		t.Errorf("weight sum = %d, want classic's %d plus %d", total, classicWeight, adherenceWeight)
	}
	if !reflect.DeepEqual(classic.Components, before) {
		t.Errorf("classic detail components were mutated in place: %+v, want %+v", classic.Components, before)
	}
}

func TestRegisterDevScoreModels_AddsAdherenceAfterClassic(t *testing.T) {
	restore := RegisterDevScoreModels()
	t.Cleanup(restore)

	if got, want := ScoreModelIDs(), []string{ClassicScoreModel, AdherenceScoreModel}; !reflect.DeepEqual(got, want) {
		t.Fatalf("registry ids = %v, want %v", got, want)
	}

	again := RegisterDevScoreModels()
	t.Cleanup(again)
	if got, want := ScoreModelIDs(), []string{ClassicScoreModel, AdherenceScoreModel}; !reflect.DeepEqual(got, want) {
		t.Fatalf("second registration: ids = %v, want %v", got, want)
	}

	if got, want := scoreModelByID(AdherenceScoreModel).fingerprintSuffix(), "|m="+AdherenceScoreModel; got != want {
		t.Errorf("adherence fingerprint suffix = %q, want %q", got, want)
	}

	restore()
	if got, want := ScoreModelIDs(), []string{ClassicScoreModel}; !reflect.DeepEqual(got, want) {
		t.Fatalf("after restore: ids = %v, want %v", got, want)
	}
}

func TestRegisterDevScoreModels_ClassicSelectedUnchanged(t *testing.T) {
	t.Cleanup(func() { SetScoreModelSource(nil) })
	t.Cleanup(RegisterDevScoreModels())

	for _, c := range loadScoreParityCases(t) {
		targets := ScoreTargets{}
		if c.Bean != nil {
			targets.Bean = &Bean{BrewTempC: c.Bean.BrewTempC, BrewRatio: c.Bean.BrewRatio}
		}
		if c.TimeTarget != nil {
			targets.Time = &TimeTarget{MinS: c.TimeTarget.MinS, MaxS: c.TimeTarget.MaxS}
		}
		shot := Shot(c.Shot)

		SetScoreModelSource(nil)
		if got, want := activeScoreModel().Score(shot, targets), CalcShotScoreTargets(shot, targets); !reflect.DeepEqual(got, want) {
			t.Errorf("%s: no source with dev models registered: detail = %+v, want classic's %+v", c.Name, got, want)
		}

		SetScoreModelSource(func() string { return ClassicScoreModel })
		if got, want := activeScoreModel().Score(shot, targets), CalcShotScoreTargets(shot, targets); !reflect.DeepEqual(got, want) {
			t.Errorf("%s: classic selected with dev models registered: detail = %+v, want %+v", c.Name, got, want)
		}
	}

	SetScoreModelSource(func() string { return AdherenceScoreModel })
	if got := ActiveScoreModelID(); got != AdherenceScoreModel {
		t.Errorf("ActiveScoreModelID = %q, want %q", got, AdherenceScoreModel)
	}
}

