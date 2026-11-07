package shots

import (
	"sync/atomic"
	"testing"
)

// Score models (#1922): the scorer behind a shot's score is a registry entry
// instead of a bare function call, so a dev build can switch models without
// touching a call site. Groundwork for #1505, which wants to compare candidate
// scorers on real history.
//
// "classic" is today's scorer, CalcShotScoreDetail, unchanged — it is always
// registered, always first, and the only model a stable build ever scores
// with. Any other model is dev-channel only: production registers nothing
// else, and cmd/server only honours the ui-pref that selects one when
// GLP_DEV_BUILD is set (see scoreModelPref).

// ClassicScoreModel is the id of the production scorer, CalcShotScoreDetail.
const ClassicScoreModel = "classic"

// ScoreModel is one registered scorer: an id (stable, part of the score-cache
// fingerprint) and the function that scores a shot against its resolved bean
// target (nil = generic bands, exactly like CalcShotScoreDetail).
type ScoreModel struct {
	ID    string
	Score func(Shot, *Bean) ScoreDetail
}

// scoreModels holds the registry. It is an atomic pointer so a test can swap
// the whole slice without a lock on the read path, which runs per shot.
var scoreModels atomic.Pointer[[]ScoreModel]

func init() {
	models := []ScoreModel{classicModel()}
	scoreModels.Store(&models)
}

// classicModel is the production scorer: today's CalcShotScoreDetail.
func classicModel() ScoreModel {
	return ScoreModel{ID: ClassicScoreModel, Score: CalcShotScoreDetail}
}

// loadScoreModels returns the registered models. The slice is shared and must
// not be mutated; callers that swap it store a fresh copy.
func loadScoreModels() []ScoreModel {
	if p := scoreModels.Load(); p != nil {
		return *p
	}
	return []ScoreModel{classicModel()}
}

// ScoreModelIDs returns the registered model ids in registry order, as a
// fresh slice.
func ScoreModelIDs() []string {
	models := loadScoreModels()
	ids := make([]string, len(models))
	for i, m := range models {
		ids[i] = m.ID
	}
	return ids
}

// scoreModelByID resolves an id against the registry. Anything that is not an
// exact registered id (empty, unknown, different case) falls back to classic,
// so a stale or malformed preference can never leave the score undefined.
func scoreModelByID(id string) ScoreModel {
	for _, m := range loadScoreModels() {
		if m.ID == id {
			return m
		}
	}
	return classicModel()
}

// scoreModelSource is the process-wide active-model source, installed by
// cmd/server (same shape as beanSource): internal/shots cannot read ui-prefs
// itself, and the dev-build gate lives in cmd/server.
var scoreModelSource atomic.Pointer[func() string]

// SetScoreModelSource installs the source of the active model id. It is
// intended to be called once at startup; passing nil restores the default
// (always classic), which tests rely on.
func SetScoreModelSource(fn func() string) {
	if fn == nil {
		scoreModelSource.Store(nil)
		return
	}
	scoreModelSource.Store(&fn)
}

// activeScoreModel resolves the model to score with. No source means classic;
// otherwise the source's id goes through the registry, so an unknown id still
// resolves to classic.
func activeScoreModel() ScoreModel {
	src := scoreModelSource.Load()
	if src == nil {
		return classicModel()
	}
	return scoreModelByID((*src)())
}

// ActiveScoreModelID is the id of the model scoring this process, after the
// fallback rules above (slice b reports it over MCP).
func ActiveScoreModelID() string { return activeScoreModel().ID }

// fingerprintSuffix is appended to the score-cache fingerprint so switching
// models misses the cache and rescores on the next read. Classic returns the
// empty string on purpose: that keeps the exact pre-#1922 fingerprint, so an
// upgrade rescores nothing and every cached row stays valid. Only registered
// ids reach the fingerprint — never the raw preference string.
func (m ScoreModel) fingerprintSuffix() string {
	if m.ID == ClassicScoreModel {
		return ""
	}
	return "|m=" + m.ID
}

// ModelScore is one model's score for a shot, as AllModelsScorer reports it.
type ModelScore struct {
	Model string
	Score *int
}

// AllModelsScorer returns a per-shot function yielding every registered
// model's score in registry order, from one bean-source load (used by the
// dev-channel comparison slice b adds).
func (s *Service) AllModelsScorer() func(Shot) []ModelScore {
	lookup := loadBeanLookup()
	models := loadScoreModels()
	return func(shot Shot) []ModelScore {
		bean := lookup(shot)
		out := make([]ModelScore, len(models))
		for i, m := range models {
			out[i] = ModelScore{Model: m.ID, Score: m.Score(shot, bean).Score}
		}
		return out
	}
}

// RegisterScoreModelForTest appends m to the registry for the duration of the
// test, restoring the previous registry on cleanup. Tests only: it is not
// safe to use with t.Parallel(), and it must not be called from production
// code. (Importing testing here has precedent: internal/system/version.go
// uses testing.Testing().)
func RegisterScoreModelForTest(t testing.TB, m ScoreModel) {
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
