package shots

import (
	"database/sql"
	"errors"
	"log"
	"sync"
	"sync/atomic"
)

// The bean age a shot's annotation stores is defined in internal/library
// (BeanAgeForAnnotation), but this package can't import it (library imports
// shots). cmd/server installs a loader here at startup via SetBeanAgeSource,
// the same shape as SetBeanSource, so PatchAnnotation derives the age once for
// every client of POST /api/shots/{id}/annotate: the browser, the MCP
// annotate_shot tool and Home Assistant's assistant all go through that merge
// (#2025).
//
// The rules the merge relies on:
//
//   - When the library resolves an age for the merged annotation, the stored
//     beanAgeDays becomes it, overriding whatever the client sent.
//   - When no age resolves (the bean left the library, its frozen portion is
//     gone), the merged value is left exactly as the merge produced it: the
//     stored age is the fallback the browser relies on (#1788), and a client
//     that clears the key still clears it.
//   - A failing library read never fails the save; it is logged once.
//
// The lookup is loaded before the annotation lock is taken, so updateAnnotation's
// merge stays pure and the documented lock order — annotationMu first, then the
// library's writeMu — is untouched.

// beanAgeSource is the loader cmd/server installs: it loads whatever the lookup
// needs (the library's beans) once and returns a per-annotation age function
// over that snapshot.
var beanAgeSource atomic.Pointer[func() (func(ann map[string]any, shotSec int64) (int, bool), error)]

// beanAgeSourceErrOnce logs a failing source only once — a DB read error would
// otherwise print on every annotation save without ever being actionable.
var beanAgeSourceErrOnce sync.Once

// SetBeanAgeSource installs the process-wide bean-age source. It is intended to
// be called once at startup; passing nil restores the no-source behaviour (no
// derived age is stored), which tests rely on.
func SetBeanAgeSource(fn func() (func(ann map[string]any, shotSec int64) (int, bool), error)) {
	if fn == nil {
		beanAgeSource.Store(nil)
		return
	}
	beanAgeSource.Store(&fn)
}

// shotTimestamp reads the shot's timestamp column: the moment the age is
// measured at. A missing shot row is (0, false, nil) — the patch then fails on
// its own, on the annotation read.
func (r *Repository) shotTimestamp(id int64) (int64, bool, error) {
	var ts int64
	err := r.db.QueryRow(`SELECT timestamp FROM shots WHERE id = ?`, id).Scan(&ts)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, err
	}
	return ts, true, nil
}

// loadBeanAge returns the age function PatchAnnotation applies to the merged
// annotation, or nil when no age can be derived. Every reason to give up is a
// nil result rather than an error: no source installed, a failing source (logged
// once), a shot with no row or no usable timestamp.
func (s *Service) loadBeanAge(shotID int64) func(ann map[string]any) (int, bool) {
	src := beanAgeSource.Load()
	if src == nil {
		return nil
	}
	lookup, err := (*src)()
	if err != nil {
		beanAgeSourceErrOnce.Do(func() {
			log.Printf("shots: bean age source unavailable, keeping the stored age: %v", err)
		})
		return nil
	}
	if lookup == nil {
		return nil
	}
	ts, ok, err := s.repo.shotTimestamp(shotID)
	if err != nil || !ok || ts <= 0 {
		return nil
	}
	return func(ann map[string]any) (int, bool) {
		return lookup(ann, ts)
	}
}
