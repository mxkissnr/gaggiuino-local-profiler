package shots

import (
	"context"
	"errors"
	"fmt"
	"log"
	"time"
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
}

// NewService wraps repo.
func NewService(repo *Repository) *Service {
	return &Service{repo: repo}
}

// GetAll returns every non-trashed shot (no machineId filter — see
// Repository's type doc comment).
func (s *Service) GetAll() ([]Shot, error) {
	return s.repo.FindAllExcludingTrash()
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
// comment for why this needs the full shot history): loads every other shot on
// shot's own machine, then runs the pure comparison. Returns nil, nil (not an
// error) whenever ComputeComparativeGrindAdvice itself would — no comparable
// shots, no coffee/grinder set; nil is a legitimate, common answer.
func (s *Service) GetComparativeGrindAdvice(shot Shot) (*ComparativeGrindAdvice, error) {
	if shot == nil {
		return nil, nil
	}
	all, err := s.repo.FindAllExcludingTrashByMachine(shot.machineID())
	if err != nil {
		return nil, err
	}
	return ComputeComparativeGrindAdvice(shot, all), nil
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

// PatchAnnotation merges patch into the shot's stored annotation (#1273):
// every remaining top-level key of patch overwrites the stored value, a key
// present as JSON null or "" clears the field, and keys absent from patch
// are kept. Server-owned keys are ignored. The merged result is validated
// before it is written; an invalid merge returns *AnnotationValidationError
// and leaves the stored annotation untouched. Returns the saved annotation.
func (s *Service) PatchAnnotation(shotID int64, patch map[string]any) (map[string]any, error) {
	return s.repo.UpdateAnnotation(shotID, func(ann map[string]any) error {
		for k, v := range patch {
			if serverOwnedAnnotationKeys[k] {
				continue
			}
			ann[k] = v
		}
		if issues := ValidateAnnotation(ann); len(issues) > 0 {
			return &AnnotationValidationError{Issues: issues}
		}
		return nil
	})
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

// PermanentDelete deletes the shot and its annotation permanently.
func (s *Service) PermanentDelete(id int64) error {
	return s.repo.DeleteByID(id)
}

// PurgeExpiredTrash permanently deletes every shot whose trash entry is older
// than 30 days (#1152), logging `Auto-purged N shot(s) from trash (>30 days)`
// — only when N > 0.
func (s *Service) PurgeExpiredTrash() error {
	purged, err := s.repo.PurgeExpiredTrash(time.Now())
	if err != nil {
		return err
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

// GetBlocklist returns the blocklist entries.
func (s *Service) GetBlocklist() ([]string, error) {
	return s.repo.GetBlocklist()
}

// SaveBlocklist replaces the blocklist with list.
func (s *Service) SaveBlocklist(list []string) error {
	return s.repo.SaveBlocklist(list)
}

// AppendToBlocklist atomically adds a single value to the blocklist — see
// Repository.AppendToBlocklist's doc comment for why the delete handler
// uses this instead of a GetBlocklist+SaveBlocklist read-modify-write.
func (s *Service) AppendToBlocklist(value string) error {
	return s.repo.AppendToBlocklist(value)
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
