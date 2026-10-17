package shots

import (
	"context"
	"errors"
	"fmt"
	"log"
	"sync/atomic"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/img"
)

// This file is the shot service: the DB-facing operations the HTTP handlers
// call. importShots/upsertShot (sync/import call sites) are deliberately not
// here — nothing in the current HTTP surface reaches them; add them alongside
// the sync/import domain that does. Trash purging (#1152) is: see
// PurgeExpiredTrash/StartTrashPurge below, wired into cmd/server's startup.

// ErrShotNotFound is the 404 returned when a shot does not exist. The trash
// handler has no existence check of its own, so this error comes from the
// service layer and is mapped to a 404 by the HTTP layer.
var ErrShotNotFound = errors.New("Shot not found")

// Service composes Repository with score.go's pure scoring functions.
type Service struct {
	repo *Repository
	// imageDir is where the entity photos live. It is only needed to remove a
	// purged shot's photo (#1525); it defaults to DefaultImageDir, and tests
	// point it elsewhere by setting the field directly.
	imageDir string
}

// NewService wraps repo.
func NewService(repo *Repository) *Service {
	return &Service{repo: repo, imageDir: DefaultImageDir}
}

// GetAll returns every non-trashed shot (no machineId filter — see
// Repository's type doc comment).
func (s *Service) GetAll() ([]Shot, error) {
	return s.repo.FindAllExcludingTrash()
}

// GetLastN returns the newest n non-trashed shots, oldest first — the tail
// of GetAll's list (#1616).
func (s *Service) GetLastN(n int) ([]Shot, error) {
	return s.repo.FindLastNExcludingTrash(n)
}

// CountToday counts the non-trashed shots (every machine) stamped on now's
// local calendar day, server time.
func (s *Service) CountToday(now time.Time) (int, error) {
	y, m, d := now.Date()
	start := time.Date(y, m, d, 0, 0, 0, 0, now.Location())
	return s.repo.CountExcludingTrashBetween(start.Unix(), start.AddDate(0, 0, 1).Unix())
}

// DefaultPageLimit / MaxPageLimit bound GET /api/shots's ?limit= (#957).
const (
	DefaultPageLimit = 60
	MaxPageLimit     = 200
)

// ClampPageLimit applies the DefaultPageLimit / MaxPageLimit policy: a
// non-positive or absent limit becomes the default, anything above the max
// is capped.
func ClampPageLimit(limit int) int {
	if limit <= 0 {
		return DefaultPageLimit
	}
	if limit > MaxPageLimit {
		return MaxPageLimit
	}
	return limit
}

// GrinderUses returns every non-trashed shot's grinder-wear input without
// hydrating the history — see Repository.GrinderUses.
func (s *Service) GrinderUses() ([]GrinderUse, error) {
	return s.repo.GrinderUses()
}

// GetPage serves the GET /api/shots list (#957): one keyset page of
// non-trashed shot metadata, newest first, each row carrying a
// cache-resolved score. machineID == 0 lists every machine. limit is
// clamped by ClampPageLimit.
func (s *Service) GetPage(cur Cursor, limit int, machineID int64) (Page, error) {
	return s.repo.findPage(cur, ClampPageLimit(limit), machineID, loadBeanLookup())
}

// GetTrashPage is GetPage against the trash list.
func (s *Service) GetTrashPage(cur Cursor, limit int, machineID int64) (Page, error) {
	return s.repo.findTrashedPage(cur, ClampPageLimit(limit), machineID, loadBeanLookup())
}

// GetByID returns one hydrated shot, or (nil, nil) when it does not exist.
func (s *Service) GetByID(id int64) (Shot, error) {
	return s.repo.FindByID(id)
}

// GetLast returns the newest non-trashed shot — GET /api/shots/last reads the
// full list and keeps the last element; this fetches only that shot (see
// Repository.FindLastExcludingTrash). Returns (nil, nil) for an empty shot
// history.
func (s *Service) GetLast() (Shot, error) {
	return s.repo.FindLastExcludingTrash()
}

// GetTrash returns every trashed shot, hydrated, skipping any id whose shot
// row is somehow already gone. See Repository.FindTrashed's doc comment for
// why this is one joined query instead of a per-id FindByID loop.
func (s *Service) GetTrash() ([]Shot, error) {
	return s.repo.FindTrashed()
}

// GetPreviousByProfile returns the machine's previous shot with the same
// profile (#402).
func (s *Service) GetPreviousByProfile(shot Shot) (Shot, error) {
	if shot == nil {
		return nil, nil
	}
	profileName := shot.profileName()
	if profileName == "" {
		return nil, nil
	}
	return s.repo.FindPreviousByProfile(shot.id(), profileName, shot.machineID())
}

// GetComparativeGrindAdvice is the history-aware call path for the comparative
// grind advice (#901, design pass 4 follow-up — see comparative.go's own doc
// comment for why this needs the full shot history): compares shot against
// every other shot on its own machine. Returns nil, nil (not an error)
// whenever ComputeComparativeGrindAdvice itself would — no comparable
// shots, no coffee/grinder set; nil is a legitimate, common answer.
//
// It returns exactly ComputeComparativeGrindAdvice(shot, <the machine's
// history>), but hydrates only the comparable shots and takes their scores
// from the score cache (#1616) instead of hydrating and rescoring the whole
// history: a cached score is CalcShotScore against the same bean target,
// guarded by the same fingerprint GET /api/shots trusts.
func (s *Service) GetComparativeGrindAdvice(shot Shot) (*ComparativeGrindAdvice, error) {
	if shot == nil {
		return nil, nil
	}
	m := newComparativeMatch(shot)
	if m == nil {
		return nil, nil
	}
	keep := func(c Shot) bool {
		_, ok := m.grindOf(c)
		return ok
	}
	rows, err := s.repo.scoredMachineShotsMatching(shot.machineID(), keep, loadBeanLookup())
	if err != nil {
		return nil, err
	}
	var comparable []comparableSibling
	for _, row := range rows {
		g, ok := m.grindOf(row.Shot)
		if !ok || row.Score == nil {
			continue
		}
		comparable = append(comparable, comparableSibling{grind: g, score: *row.Score})
	}
	return m.advice(comparable), nil
}

// AnnotationValidationError reports that a merged annotation failed
// ValidateAnnotation. The merged result was never written; handlers.go's
// annotate turns it back into the same 400 shape the pre-merge body check
// produces.
type AnnotationValidationError struct {
	Issues []ValidationIssue
}

func (e *AnnotationValidationError) Error() string {
	return fmt.Sprintf("annotation validation failed: %d issue(s)", len(e.Issues))
}

// serverOwnedAnnotationKeys are annotation keys clients may send but never
// change. They are dropped from a patch before it is merged, so a client
// payload that happens to carry one cannot overwrite the server-written
// value (see orders' CompleteOrder, which owns orderedBy).
var serverOwnedAnnotationKeys = map[string]bool{"orderedBy": true}

// annotationStockHook books the library side effects of a PatchAnnotation
// (milk stock, frozen-portion counts, #1411). It is installed by cmd/server
// because this package cannot import internal/library. It only runs for
// PatchAnnotation: never for UpdateAnnotation (orders' orderedBy) or
// SaveAnnotation (restore and sync).
var annotationStockHook atomic.Pointer[func(prev, next map[string]any) error]

// SetAnnotationStockHook installs the process-wide annotation stock hook.
// Passing nil removes it, restoring the no-bookkeeping behaviour tests and
// tools rely on.
func SetAnnotationStockHook(fn func(prev, next map[string]any) error) {
	if fn == nil {
		annotationStockHook.Store(nil)
		return
	}
	annotationStockHook.Store(&fn)
}

// PatchAnnotation merges patch into the shot's stored annotation (#1273):
// every remaining top-level key of patch whose value is neither JSON null nor
// "" is set on the stored annotation, a key present as JSON null or "" is
// deleted, and keys absent from patch are kept. Server-owned keys are ignored.
// Only the keys the patch actually sets are validated, so an older stored
// value the current rules no longer accept (an over-long notes, an
// out-of-range rating) cannot block an unrelated edit. The patched keys are
// validated before the write; an invalid patch returns
// *AnnotationValidationError and leaves the stored annotation untouched.
// Returns the saved annotation. The installed annotation stock hook (see
// SetAnnotationStockHook) runs once the merge is saved, in the same locked
// save.
func (s *Service) PatchAnnotation(shotID int64, patch map[string]any) (map[string]any, error) {
	var after func(prev, next map[string]any) error
	if h := annotationStockHook.Load(); h != nil {
		after = *h
	}
	return s.repo.updateAnnotation(shotID, func(ann map[string]any) error {
		applied := make(map[string]any, len(patch))
		for k, v := range patch {
			if serverOwnedAnnotationKeys[k] {
				continue
			}
			if v == nil || v == "" {
				delete(ann, k)
				continue
			}
			ann[k] = v
			applied[k] = v
		}
		if issues := ValidateAnnotation(applied); len(issues) > 0 {
			return &AnnotationValidationError{Issues: issues}
		}
		return nil
	}, after)
}

// SetImage sets the shot's image extension and returns the updated shot.
func (s *Service) SetImage(id int64, ext string) (Shot, error) {
	return s.repo.SetImage(id, ext)
}

// ClearImage removes the shot's image and returns the updated shot.
func (s *Service) ClearImage(id int64) (Shot, error) {
	return s.repo.ClearImage(id)
}

// TrashShot moves the shot to trash, or returns ErrShotNotFound when it does
// not exist.
func (s *Service) TrashShot(id int64) error {
	shot, err := s.repo.FindByID(id)
	if err != nil {
		return err
	}
	if shot == nil {
		return ErrShotNotFound
	}
	return s.repo.MoveToTrash(id)
}

// RestoreShot restores the shot from trash — no existence check.
func (s *Service) RestoreShot(id int64) error {
	return s.repo.RestoreFromTrash(id)
}

// PermanentDelete deletes the shot and its annotation permanently, adding its
// id to the blocklist in the same transaction (Repository.DeleteAndBlocklist)
// so a sync racing the delete can never re-import the shot in the window where
// the row is gone but the blocklist entry is not yet written (#1609).
func (s *Service) PermanentDelete(id int64) error {
	return s.repo.DeleteAndBlocklist(id)
}

// PurgeExpiredTrash permanently deletes every shot whose trash entry is older
// than 30 days (#1152), logging `Auto-purged N shot(s) from trash (>30 days)`
// — only when N > 0. Each purged shot's photo and thumbnail are removed from
// imageDir as well (#1525): the repository drops the rows, and without this
// the files would linger until the next restart's orphan sweep.
func (s *Service) PurgeExpiredTrash() error {
	purged, err := s.repo.PurgeExpiredTrash(time.Now())
	if err != nil {
		return err
	}
	for _, p := range purged {
		if p.Ext != "" {
			img.Delete(s.imageDir, p.ID, p.Ext, "shot-")
		}
	}
	if len(purged) > 0 {
		log.Printf("shots: auto-purged %d shot(s) from trash (>30 days)", len(purged))
	}
	return nil
}

// StartTrashPurge runs one purge immediately, then one per interval on a
// background goroutine until ctx is cancelled. A purge failure is logged,
// never fatal.
func StartTrashPurge(ctx context.Context, svc *Service, interval time.Duration) {
	if err := svc.PurgeExpiredTrash(); err != nil {
		log.Printf("shots: trash purge failed: %v", err)
	}
	ticker := time.NewTicker(interval)
	go func() {
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if err := svc.PurgeExpiredTrash(); err != nil {
					log.Printf("shots: trash purge failed: %v", err)
				}
			}
		}
	}()
}

// ComputeScoreDetail scores shot against its own library bean's
// brewTempC/brewRatio target when one is installed (see SetBeanSource),
// falling back to the generic fixed bands when no bean resolves or no source
// is set (#457).
func (s *Service) ComputeScoreDetail(shot Shot) ScoreDetail {
	return s.DetailScorer()(shot)
}

// ComputeScore is the score-only counterpart of ComputeScoreDetail.
func (s *Service) ComputeScore(shot Shot) *int {
	return s.Scorer()(shot)
}
