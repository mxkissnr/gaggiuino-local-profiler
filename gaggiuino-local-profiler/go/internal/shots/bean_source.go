package shots

import (
	"log"
	"sync"
	"sync/atomic"
)

// The bean target a shot was brewed against lives in internal/library, but
// this package can't import it (library imports shots). cmd/server installs a
// loader here at startup via SetBeanSource; everything else falls back to the
// generic fixed bands when no source is set, exactly as before.

// beanLookup resolves one shot to its library bean's target fields, or nil.
type beanLookup func(Shot) *Bean

// beanSourceFn loads whatever a lookup needs (the bean list) once and returns
// a per-shot lookup over that snapshot.
type beanSourceFn func() (beanLookup, error)

var beanSource atomic.Pointer[beanSourceFn]

// beanSourceErrOnce logs a failing source only once — a DB read error would
// otherwise print on every request without ever being actionable.
var beanSourceErrOnce sync.Once

// SetBeanSource installs the process-wide bean source. It is intended to be
// called once at startup; passing nil restores the no-source behaviour
// (generic bands), which tests and tools rely on.
func SetBeanSource(fn func() (func(Shot) *Bean, error)) {
	if fn == nil {
		beanSource.Store(nil)
		return
	}
	src := beanSourceFn(fn)
	beanSource.Store(&src)
}

// loadBeanLookup calls the installed source once, returning a per-shot
// lookup. No source, a nil lookup, or an error all yield a lookup that
// returns nil — the shot is scored against the generic bands and the request
// never fails over a bean-lookup problem.
func loadBeanLookup() beanLookup {
	src := beanSource.Load()
	if src == nil {
		return func(Shot) *Bean { return nil }
	}
	lookup, err := (*src)()
	if err != nil {
		beanSourceErrOnce.Do(func() {
			log.Printf("shots: bean source unavailable, scoring against generic bands: %v", err)
		})
		return func(Shot) *Bean { return nil }
	}
	if lookup == nil {
		return func(Shot) *Bean { return nil }
	}
	return lookup
}

// DetailScorer returns a per-shot ScoreDetail function that resolves each
// shot's bean through one load of the bean source. Callers scoring many shots
// in one request should call this once and reuse the result, instead of
// ComputeScoreDetail per shot (which reloads the bean list each time).
func (s *Service) DetailScorer() func(Shot) ScoreDetail {
	lookup := loadBeanLookup()
	return func(shot Shot) ScoreDetail {
		return CalcShotScoreDetail(shot, lookup(shot))
	}
}

// Scorer returns the score-only counterpart of DetailScorer — the same one
// bean load, reduced to the ScoreDetail's Score.
func (s *Service) Scorer() func(Shot) *int {
	detail := s.DetailScorer()
	return func(shot Shot) *int {
		return detail(shot).Score
	}
}
