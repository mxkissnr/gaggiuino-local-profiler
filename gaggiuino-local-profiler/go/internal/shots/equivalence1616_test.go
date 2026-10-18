package shots_test

import (
	"testing"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/perfseed"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// shotsJSONSummary reduces a /shots.json body to a golden-sized summary:
// the id order, each shot's score fields, and a digest of the whole body.
// timestamp is left out of the digest — the newest shots are anchored to
// the seed day, so it is the one field that changes from day to day.
func shotsJSONSummary(tb testing.TB, body []byte) map[string]any {
	tb.Helper()
	list, _ := perfseed.DecodeJSON(tb, body).([]any)
	rows := make([][3]any, 0, len(list))
	for _, v := range list {
		s, _ := v.(map[string]any)
		rows = append(rows, [3]any{s["id"], s["score"], s["usedBeanTarget"]})
	}
	return map[string]any{
		"count":  len(list),
		"rows":   rows,
		"digest": perfseed.Digest(tb, perfseed.Strip(list, "timestamp")),
	}
}

// TestEquivalence1616_ShotsJSON pins GET /shots.json (active and trash) on
// the #1616 equivalence dataset, captured before the endpoint changed. The
// second request runs against a warm score cache and must match the first.
func TestEquivalence1616_ShotsJSON(t *testing.T) {
	env := newPerfEnv(t, perfseed.Equivalence)
	got := map[string]any{}
	for _, path := range []string{"/shots.json", "/shots.json?trash=1"} {
		cold := shotsJSONSummary(t, env.get(t, path).Body.Bytes())
		warmScoreCache(t, env.svc)
		warm := shotsJSONSummary(t, env.get(t, path).Body.Bytes())
		if perfseed.Digest(t, cold) != perfseed.Digest(t, warm) {
			t.Errorf("GET %s: response changed once the score cache was warm", path)
		}
		got[path] = cold
	}
	perfseed.AssertGolden(t, "shots_json", got)
}

// TestEquivalence1616_ShotPages pins every GET /api/shots page row's score
// fields, hasChartData and tempStabilityDev, on a cold and then a warm
// score cache.
func TestEquivalence1616_ShotPages(t *testing.T) {
	env := newPerfEnv(t, perfseed.Equivalence)
	collect := func() [][5]any {
		var rows [][5]any
		var cur shots.Cursor
		for {
			page, err := env.svc.GetPage(cur, 64, 0)
			if err != nil {
				t.Fatal(err)
			}
			for _, r := range page.Rows {
				rows = append(rows, [5]any{r.Shot["id"], r.Score, r.UsedBeanTarget, r.HasChartData, r.TempStabilityDev})
			}
			if !page.HasMore {
				return rows
			}
			cur = page.NextCursor
		}
	}
	cold := collect()
	warm := collect()
	if perfseed.Digest(t, cold) != perfseed.Digest(t, warm) {
		t.Error("GET /api/shots rows changed once the score cache was warm")
	}
	perfseed.AssertGolden(t, "shot_pages", cold)
}

// TestEquivalence1616_ComparativeAdvice pins the comparative grind advice
// for a spread of shots (annotated, unannotated, both machines) on a cold
// and then a warm score cache, captured before it started reading the
// cache.
func TestEquivalence1616_ComparativeAdvice(t *testing.T) {
	env := newPerfEnv(t, perfseed.Equivalence)
	advise := func() map[int64]any {
		out := map[int64]any{}
		for i, id := range env.info.ShotIDs {
			if i%3 != 0 && id != env.info.LatestAnnotatedID {
				continue
			}
			shot, err := env.svc.GetByID(id)
			if err != nil {
				t.Fatal(err)
			}
			advice, err := env.svc.GetComparativeGrindAdvice(shot, "en")
			if err != nil {
				t.Fatal(err)
			}
			out[id] = advice
		}
		return out
	}
	cold := advise()
	advised := 0
	for _, a := range cold {
		if a != (*shots.ComparativeGrindAdvice)(nil) {
			advised++
		}
	}
	if advised < 3 {
		t.Fatalf("only %d sampled shots have advice — check the seed", advised)
	}
	warmScoreCache(t, env.svc)
	warm := advise()
	if perfseed.Digest(t, cold) != perfseed.Digest(t, warm) {
		t.Error("comparative advice changed once the score cache was warm")
	}
	perfseed.AssertGolden(t, "comparative_advice", cold)
}
