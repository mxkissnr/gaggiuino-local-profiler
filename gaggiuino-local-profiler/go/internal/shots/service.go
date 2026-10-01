package shots

import (
	"context"
	"errors"
	"fmt"
	"log"
	"time"
)

// This file ports lib/services/ShotService.js — the subset routes/shots.js
// actually calls. importShots/upsertShot (sync/import call sites) aren't
// ported: nothing in this phase's HTTP surface reaches them; add them
// alongside the sync/import domain that does. purgeExpiredTrash *is*
// ported (#1152) — see PurgeExpiredTrash/StartTrashPurge below, wired into
// cmd/server's startup.

// ErrShotNotFound ports the `Object.assign(new Error('Shot not found'),
// {status:404})` ShotService.js's trashShot throws — routes/shots.js's
// POST /api/shots/:id/trash has no explicit existence check of its own, so
// this 404 comes from the service layer, same as in Node.
var ErrShotNotFound = errors.New("Shot not found")

// Service composes Repository with score.go's pure scoring functions —
// the Go port of ShotService.js.
type Service struct {
	repo *Repository
}

// NewService wraps repo.
func NewService(repo *Repository) *Service {
	return &Service{repo: repo}
}

// GetAll ports ShotService.js's getAll() (no machineId — see
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

// GetPage ports the new GET /api/shots list (#957): one keyset page of
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

// GetRecent returns the newest n non-trashed shots (metadata + curves,
// hydrated) — the templ no-JS views' bounded replacement for GetAll(),
// which scans the whole history (#957 decision 7). Order is newest first,
// so callers no longer reverse the slice.
func (s *Service) GetRecent(n int) ([]Shot, error) {
	page, err := s.repo.findPage(Cursor{}, n, 0, loadBeanLookup())
	if err != nil {
		return nil, err
	}
	out := make([]Shot, len(page.Rows))
	for i, row := range page.Rows {
		out[i] = row.Shot
	}
	return out, nil
}

// GetRecentTrash is GetRecent against the trash list.
func (s *Service) GetRecentTrash(n int) ([]Shot, error) {
	page, err := s.repo.findTrashedPage(Cursor{}, n, 0, loadBeanLookup())
	if err != nil {
		return nil, err
	}
	out := make([]Shot, len(page.Rows))
	for i, row := range page.Rows {
		out[i] = row.Shot
	}
	return out, nil
}

// GetByID ports ShotService.js's getById.
func (s *Service) GetByID(id int64) (Shot, error) {
	return s.repo.FindByID(id)
}

// GetLast returns the newest non-trashed shot — routes/shots.js's GET
// /api/shots/last reads shotService.getAll() then keeps the last element;
// this fetches only that shot (see Repository.FindLastExcludingTrash).
// Returns (nil, nil) for an empty shot history.
func (s *Service) GetLast() (Shot, error) {
	return s.repo.FindLastExcludingTrash()
}

// GetTrash ports ShotService.js's getTrash(): every trashed shot, hydrated,
// skipping any id whose shot row is somehow already gone. See
// Repository.FindTrashed's doc comment for why this is one joined query
// instead of a per-id FindByID loop.
func (s *Service) GetTrash() ([]Shot, error) {
	return s.repo.FindTrashed()
}

// GetPreviousByProfile ports ShotService.js's getPreviousByProfile (#402).
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

// GetComparativeGrindAdvice ports ShotService.js's own history-aware call
// path for calcComparativeGrindAdvice (#901, design pass 4 follow-up — see
// comparative.go's own doc comment for why this needed the full shot
// history and so wasn't ported alongside ComputeGrindAdvice): loads every
// other shot on shot's own machine, then runs the pure comparison. Returns
// nil, nil (not an error) whenever ComputeComparativeGrindAdvice itself
// would — no comparable shots, no coffee/grinder set — same "nil is a
// legitimate, common answer" contract ComputeGrindAdvice already has.
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

// SetImage ports ShotService.js's setImage.
func (s *Service) SetImage(id int64, ext string) (Shot, error) {
	return s.repo.SetImage(id, ext)
}

// ClearImage ports ShotService.js's clearImage.
func (s *Service) ClearImage(id int64) (Shot, error) {
	return s.repo.ClearImage(id)
}

// TrashShot ports ShotService.js's trashShot: 404 (ErrShotNotFound) when
// the shot doesn't exist, otherwise moves it to trash.
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

// RestoreShot ports ShotService.js's restoreShot — no existence check,
// matching the Node original.
func (s *Service) RestoreShot(id int64) error {
	return s.repo.RestoreFromTrash(id)
}

// PermanentDelete ports ShotService.js's permanentDelete.
func (s *Service) PermanentDelete(id int64) error {
	return s.repo.DeleteByID(id)
}

// PurgeExpiredTrash ports ShotService.js's purgeExpiredTrash (#1152):
// permanently deletes every shot whose trash entry is older than 30 days,
// logging the count the way Node logged `Auto-purged N shot(s) from trash
// (>30 days)` — only when N > 0.
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

// StartTrashPurge ports server.js's startup purge call plus its 24h
// setInterval: it runs one purge immediately, then one per interval on a
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

// GetBlocklist ports ShotService.js's getBlocklist.
func (s *Service) GetBlocklist() ([]string, error) {
	return s.repo.GetBlocklist()
}

// SaveBlocklist ports ShotService.js's saveBlocklist.
func (s *Service) SaveBlocklist(list []string) error {
	return s.repo.SaveBlocklist(list)
}

// AppendToBlocklist atomically adds a single value to the blocklist — see
// Repository.AppendToBlocklist's doc comment for why the delete handler
// uses this instead of a GetBlocklist+SaveBlocklist read-modify-write.
func (s *Service) AppendToBlocklist(value string) error {
	return s.repo.AppendToBlocklist(value)
}

// ComputeScoreDetail ports ShotService.js's computeScoreDetail (#457): score
// shot against its own library bean's brewTempC/brewRatio target when one is
// installed (see SetBeanSource), falling back to the generic fixed bands when
// no bean resolves or no source is set.
func (s *Service) ComputeScoreDetail(shot Shot) ScoreDetail {
	return s.DetailScorer()(shot)
}

// ComputeScore ports ShotService.js's computeScore — the score-only
// counterpart of ComputeScoreDetail.
func (s *Service) ComputeScore(shot Shot) *int {
	return s.Scorer()(shot)
}
