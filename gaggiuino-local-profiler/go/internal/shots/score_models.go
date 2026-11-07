package shots

import "sync/atomic"

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
// Only classic is registered: a further model is added here, and the
// multi-model comparison API arrives with the slice that calls it, so no
// unreachable exported function sits on this package's public surface.
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

// ActiveScoreModelID is the id of the model this process scores with, after
// the fallback rules above. cmd/server logs it on a dev build at startup.
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
