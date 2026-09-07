package shots

import "errors"

// This file ports lib/services/ShotService.js — the subset routes/shots.js
// actually calls. importShots/upsertShot/purgeExpiredTrash (sync/import/
// maintenance-cron call sites) aren't ported: nothing in this phase's HTTP
// surface reaches them; add them alongside the sync/import domain that
// does.

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
	return s.repo.FindPageExcludingTrash(cur, ClampPageLimit(limit), machineID)
}

// GetTrashPage is GetPage against the trash list.
func (s *Service) GetTrashPage(cur Cursor, limit int, machineID int64) (Page, error) {
	return s.repo.FindTrashedPage(cur, ClampPageLimit(limit), machineID)
}

// GetRecent returns the newest n non-trashed shots (metadata + curves,
// hydrated) — the templ no-JS views' bounded replacement for GetAll(),
// which scans the whole history (#957 decision 7). Order is newest first,
// so callers no longer reverse the slice.
func (s *Service) GetRecent(n int) ([]Shot, error) {
	page, err := s.repo.FindPageExcludingTrash(Cursor{}, n, 0)
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
	page, err := s.repo.FindTrashedPage(Cursor{}, n, 0)
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

// SaveAnnotation ports ShotService.js's saveAnnotation. The Node version
// also re-reads and returns the saved annotation, but every caller
// (routes/shots.js's POST /annotate) discards that return value, so this
// just performs the write.
func (s *Service) SaveAnnotation(shotID int64, annotation map[string]any) error {
	return s.repo.SaveAnnotation(shotID, annotation)
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

// ComputeScoreDetail ports ShotService.js's computeScoreDetail (#457).
//
// #450's bean-target resolution (libraryService.resolveBeanForAnnotation)
// is not wired in yet: internal/library is still a Phase 0 placeholder, so
// this always scores against the generic fixed bands, never a bean's own
// brewTempC/brewRatio recommendation — see score.go's CalcShotScoreDetail
// doc comment for exactly what that does and doesn't change. Wire a real
// bean lookup in here once the Library phase lands.
func (s *Service) ComputeScoreDetail(shot Shot) ScoreDetail {
	return CalcShotScoreDetail(shot, nil)
}

// ComputeScore ports ShotService.js's computeScore — see
// ComputeScoreDetail's doc comment for the same bean-resolution caveat.
func (s *Service) ComputeScore(shot Shot) *int {
	return CalcShotScore(shot, nil)
}
