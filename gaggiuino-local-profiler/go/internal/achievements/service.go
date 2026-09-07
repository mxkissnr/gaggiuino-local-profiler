package achievements

import (
	"fmt"
	"log"
	"math"
	"sync"
)

// This file ports lib/services/AchievementService.js: evaluate the registry
// against a fresh context snapshot and persist newly-crossed badges, plus
// shape the full catalogue + DB state for GET /api/achievements.
//
// # No event bus
//
// Node wires evaluateAll() to six bus events (shot saved, bean changed,
// maintenance acknowledged, order completed, profile saved, backup
// exported) AND runs one boot sweep. This Go port has no event bus, so
// GetState() reconstructs the same "evaluate on change, not on a schedule"
// signal from the data: it calls Repository.ChangeFingerprint() (a handful
// of cheap COUNT/MAX aggregates, no datapoints blobs) on every read and
// only runs the full evaluateAll(nil) pass — buildContext scans every
// shot's datapoints and re-scores it, ~200ms on a real history (#956) —
// when that digest, or the cached GitHub-version result, moved since the
// last pass. A fresh install after an update still pays one retroactive
// scoring sweep on its first GET /api/achievements, exactly what Node's
// boot sweep does; steady-state reads with no new shot/bean/order/
// maintenance activity pay only the fingerprint query.
//
// The four live-moment badges (first_profile/profile_edit/backup/restock)
// only ever unlock on their specific event and have no retroactive path in
// Node either — those stay permanently locked in this port until an event
// bus (or explicit EvaluateEvent call sites) exists. Documented, not a
// silent gap.

var supportedLangs = map[string]bool{
	"de": true, "en": true, "it": true, "fr": true, "es": true, "nl": true,
}

// Service ports the AchievementService singleton.
type Service struct {
	repo *Repository
	deps Deps

	// evalMu guards the fingerprint gate below and serialises the full
	// evaluateAll pass so a burst of GET /api/achievements right after a
	// data change triggers one scan, not one per request.
	evalMu      sync.Mutex
	lastFP      string
	fpEvaluated bool
}

// NewService wires the achievements Repository + the cross-domain Deps
// buildContext reads.
func NewService(repo *Repository, deps Deps) *Service {
	return &Service{repo: repo, deps: deps}
}

// EvaluateEvent ports evaluateAll({ type, payload }) for a live event — the
// call Node's bus listeners make. No call sites yet in this port (see the
// file header); kept exported so an event bus / explicit hooks can drive it
// without touching this package.
func (s *Service) EvaluateEvent(event *Event) ([]string, error) {
	out, err := s.evaluateAll(event)
	// Force the next GetState() to re-sync its fingerprint against the DB
	// this pass may have mutated.
	s.evalMu.Lock()
	s.fpEvaluated = false
	s.evalMu.Unlock()
	return out, err
}

// maybeEvaluate runs evaluateAll(nil) only when the DB change fingerprint
// (or the cached version-check result) has moved since the last pass, or no
// pass has run yet this process. See the file header.
func (s *Service) maybeEvaluate() error {
	fp, err := s.repo.ChangeFingerprint()
	if err != nil {
		return err
	}
	fp += " v=" + versionFingerprint(s.deps.VersionFn)

	s.evalMu.Lock()
	defer s.evalMu.Unlock()
	if s.fpEvaluated && fp == s.lastFP {
		return nil
	}
	if _, err := s.evaluateAll(nil); err != nil {
		return err
	}
	s.lastFP = fp
	s.fpEvaluated = true
	return nil
}

// versionFingerprint folds the in-memory GitHub-release check result into
// the change signal so the up_to_date badge still unlocks the read after a
// version check completes, without that check being a DB write.
func versionFingerprint(fn func() VersionCache) string {
	if fn == nil {
		return ""
	}
	vc := fn()
	latest := ""
	if vc.Latest != nil {
		latest = *vc.Latest
	}
	return fmt.Sprintf("%s/%t", latest, vc.UpdateAvailable)
}

// evaluateAll ports AchievementService.evaluateAll(event).
func (s *Service) evaluateAll(event *Event) ([]string, error) {
	existing, err := s.repo.GetAll()
	if err != nil {
		return nil, err
	}

	all := badges()
	var stillLocked []badge
	for _, b := range all {
		if isRetired(b) {
			continue
		}
		if row, ok := existing[b.ID]; ok && row.UnlockedAt != nil {
			continue
		}
		stillLocked = append(stillLocked, b)
	}
	if len(stillLocked) == 0 {
		return nil, nil
	}

	ctx, err := buildContext(s.deps, event)
	if err != nil {
		return nil, err
	}
	nowSec := int64(math.Floor(float64(ctx.Now) / 1000))

	var newlyUnlocked []string
	for _, b := range stillLocked {
		unlocked := safeCheck(b, ctx)
		if unlocked {
			var progress *int64
			if b.ProgressTarget > 0 {
				v := int64(b.ProgressTarget)
				progress = &v
			}
			if err := s.repo.Unlock(b.ID, nowSec, progress); err != nil {
				return nil, err
			}
			newlyUnlocked = append(newlyUnlocked, b.ID)
			continue
		}
		if b.Progress != nil {
			p := safeProgress(b, ctx)
			if err := s.repo.SetProgress(b.ID, int64(p)); err != nil {
				log.Printf("achievements: progress persist failed for %q: %v", b.ID, err)
			}
		}
	}
	if len(newlyUnlocked) > 0 {
		log.Printf("achievements unlocked: %v", newlyUnlocked)
	}
	return newlyUnlocked, nil
}

// safeCheck ports the `try { unlocked = !!badge.check(ctx) } catch { log;
// continue }` guard — a Go check can't throw, but a nil-map/index access
// could panic on unexpected data, so recover and treat as "not unlocked".
func safeCheck(b badge, ctx *Context) (result bool) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("achievements: check failed for %q: %v", b.ID, r)
			result = false
		}
	}()
	return b.Check(ctx)
}

func safeProgress(b badge, ctx *Context) (result int) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("achievements: progress failed for %q: %v", b.ID, r)
			result = 0
		}
	}()
	return b.Progress(ctx)
}

// GetState ports getState(lang): the full catalogue + DB state. Runs a
// fresh evaluateAll(nil) pass first when the change fingerprint moved (see
// the file header for why — no event bus). lang is assumed already
// validated by the handler.
func (s *Service) GetState(lang string) ([]map[string]any, error) {
	if err := s.maybeEvaluate(); err != nil {
		return nil, err
	}
	existing, err := s.repo.GetAll()
	if err != nil {
		return nil, err
	}

	var out []map[string]any
	for _, b := range badges() {
		if isRetired(b) {
			continue
		}
		row, hasRow := existing[b.ID]
		unlocked := hasRow && row.UnlockedAt != nil

		base := map[string]any{
			"id":       b.ID,
			"card":     b.Card,
			"secret":   b.Secret,
			"unlocked": unlocked,
		}
		if unlocked {
			base["unlockedAt"] = *row.UnlockedAt
		} else {
			base["unlockedAt"] = nil
		}

		if b.ProgressTarget > 0 && !unlocked {
			var current int64
			if hasRow && row.Progress != nil {
				current = *row.Progress
			}
			base["progress"] = map[string]any{"current": current, "target": b.ProgressTarget}
		}

		if !b.Secret {
			base["stamp"] = b.Stamp
		} else if unlocked {
			if sc, ok := getSecretCopy(b.ID, lang); ok {
				base["stamp"] = sc.Stamp
				base["name"] = sc.Name
				base["description"] = sc.Description
			}
		}
		out = append(out, base)
	}
	return out, nil
}

// cards ports routes/achievements.js's CARD_KEYS constant returned as the
// response's `cards` field.
func cards() []string { return cardKeys }
