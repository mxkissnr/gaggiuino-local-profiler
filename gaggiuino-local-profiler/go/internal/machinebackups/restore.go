package machinebackups

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strings"
	"sync"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/auth"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/httputil"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines/proto"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/ratelimit"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/redact"
)

// This file restores a stored settings backup onto its Gaggiuino machine
// (#1878). Right before the post the machine's current secrets — the whole
// wifi block, its MQTT credentials and its tokens — are copied into the stored
// document, so a restore never changes the machine's network or broker access.
// The merged document lives only in memory: it goes to the machine and nowhere
// else, never to the database, a response or a log.

const (
	restorePerMinute = 3

	codePendingProfileChanges = "pending_profile_changes"
	codeRestoreRejected       = "restore_rejected"
	codeNoConfirmation        = "no_confirmation"

	// reason of a machine_busy answer from the restore route
	reasonBrew           = "brew"
	reasonSteam          = "steam"
	reasonDescale        = "descale"
	reasonFirmwareUpdate = "firmware_update"
)

var (
	errNoLiveState                = errors.New("the machine sent no live system state")
	errFirmwareProgressUnreadable = errors.New("the machine's firmware progress is unreadable")
)

// ProfileCache is the part of machines.ProfilesRepository a restore needs:
// the per-machine profile lock shared with the profile editor and the sync
// sweep, the queue of unsent profile changes, and the synced cache that a
// restore makes stale.
type ProfileCache interface {
	MachineLock(machineID int64) *sync.Mutex
	DirtyRows(machineID int64) ([]machines.ProfileRow, error)
	PruneStaleSynced(machineID int64, currentRemoteIDs []string) error
}

var _ ProfileCache = (*machines.ProfilesRepository)(nil)

// restoreClient is what a restore needs from a machine adapter on top of
// Client. Only the Gaggiuino adapter has it. Client itself stays unchanged,
// so the scheduler, the pre-update backup and their fakes need nothing new.
type restoreClient interface {
	Client
	GetLiveSystemState(ctx context.Context, m *machines.Machine) (*proto.SystemStateDto, error)
	GetFirmwareProgress(ctx context.Context, m *machines.Machine) (json.RawMessage, error)
	RestoreSettingsBackup(ctx context.Context, m *machines.Machine, body []byte) error
}

var _ restoreClient = (*machines.GaggiuinoAdapter)(nil)

// RestoreDeps are the restore route's collaborators. Repo must be the
// Repository the scheduler and Handlers use: they share its per-machine lock.
type RestoreDeps struct {
	Repo     *Repository
	Machines MachineGetter
	Client   func(*machines.Machine) (Client, bool)
	Profiles ProfileCache
}

// Restore serves POST /api/machine/backups/{id}/restore (#1878).
type Restore struct {
	deps RestoreDeps
	rl   *ratelimit.KeyedLimiter
}

func NewRestore(d RestoreDeps) *Restore {
	return &Restore{deps: d, rl: ratelimit.NewKeyed()}
}

// RegisterRoutes mounts the restore route. It sits behind the global
// token/ingress auth and is not on the kiosk allow-list.
func (s *Restore) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/machine/backups/{id}/restore", s.restore)
}

// restore answers POST /api/machine/backups/{id}/restore. The checks run in
// this order, and every refusal before the last step sends nothing to the
// machine: rate limit, id, body, stored backup, target machine, locks, unsent
// profile changes, the machine's state, the machine's current backup, then the
// post itself.
func (s *Restore) restore(w http.ResponseWriter, r *http.Request) {
	if !s.rl.Allow("machine-backup-restore:"+auth.RemoteIP(r), restorePerMinute) {
		httputil.WriteError(w, http.StatusTooManyRequests, "Rate limit exceeded")
		return
	}
	id, ok := parseBackupID(r)
	if !ok {
		httputil.WriteError(w, http.StatusNotFound, "Backup not found")
		return
	}
	var body struct {
		MachineID *int64 `json:"machineId"`
	}
	if !httputil.DecodeJSONBodyInto(w, r, maxRequestBytes, &body) {
		return
	}
	if body.MachineID == nil || *body.MachineID < 1 {
		httputil.WriteError(w, http.StatusBadRequest, "machineId required")
		return
	}
	entry, data, found, err := s.deps.Repo.get(id)
	if err != nil {
		httputil.InternalError(w, "machinebackups", err)
		return
	}
	if !found {
		httputil.WriteError(w, http.StatusNotFound, "Backup not found")
		return
	}
	m, c, ok := s.target(w, entry, *body.MachineID)
	if !ok {
		return
	}

	// Backup lock first, then profile lock, both TryLock, so they can never
	// deadlock. The profile lock keeps the editor and the sync sweep from writing
	// or pushing a profile between the pending-changes check and the post.
	mu := s.deps.Repo.machineLock(m.ID)
	if !mu.TryLock() {
		writeCodeError(w, http.StatusConflict, codeOperationRunning,
			"Another backup or restore of this machine is running")
		return
	}
	defer mu.Unlock()
	pmu := s.deps.Profiles.MachineLock(m.ID)
	if !pmu.TryLock() {
		writeCodeError(w, http.StatusConflict, codeOperationRunning,
			"GLP is sending a profile change to this machine; try again in a moment")
		return
	}
	defer pmu.Unlock()

	// Maintainer decision 5: their remote ids would name the wrong profiles after
	// the restore, so a pending change has to be resolved first.
	pending, err := s.deps.Profiles.DirtyRows(m.ID)
	if err != nil {
		httputil.InternalError(w, "machinebackups", err)
		return
	}
	if len(pending) > 0 {
		writeCodeError(w, http.StatusConflict, codePendingProfileChanges,
			"GLP has profile changes for this machine that were not sent yet; nothing was restored")
		return
	}

	if !s.idle(r.Context(), w, c, m) {
		return
	}
	doc, ok := s.mergedDocument(r.Context(), w, c, m, []byte(data))
	if !ok {
		return
	}

	err = c.RestoreSettingsBackup(r.Context(), m, doc)
	var refused *machines.SettingsRestoreError
	switch {
	case err == nil:
	case errors.Is(err, machines.ErrSettingsBackupTooLarge):
		writeCodeError(w, http.StatusConflict, codeInvalidBackup,
			"This backup with the machine's current Wi-Fi and MQTT settings is larger than the machine accepts; nothing was restored")
		return
	case errors.As(err, &refused):
		log.Printf("machinebackups: machine %d refused backup %d (status %d)", m.ID, entry.ID, refused.Status)
		httputil.WriteJSON(w, http.StatusBadGateway, map[string]string{
			"error":        "The machine refused the backup; nothing was restored",
			"code":         codeRestoreRejected,
			"machineError": cleanNote(refused.Message),
		})
		return
	default:
		// The machine most likely applied the document and restarted before
		// answering, so its synced profile rows now name other profiles: an empty
		// cache the next profile list rebuilds beats a stale one.
		log.Printf("machinebackups: restoring backup %d onto machine %d got no confirmation: %s",
			entry.ID, m.ID, redact.Redact(err.Error()))
		s.dropProfileCache(m.ID)
		writeCodeError(w, http.StatusBadGateway, codeNoConfirmation,
			"The machine did not confirm the restore; it may already be restarting")
		return
	}
	s.dropProfileCache(m.ID)
	log.Printf("machinebackups: restored backup %d onto machine %d; the machine restarts", entry.ID, m.ID)
	httputil.WriteJSON(w, http.StatusOK, map[string]bool{"ok": true, "restarting": true})
}

// target resolves the machine a restore posts to. In this slice the target must
// be the backup's own, still registered machine; a backup of another machine
// answers 404 like an unknown backup. S5b-2 widens this for deleted machines
// (maintainer decision 4).
func (s *Restore) target(w http.ResponseWriter, entry Entry, machineID int64) (*machines.Machine, restoreClient, bool) {
	if machineID != entry.MachineID {
		httputil.WriteError(w, http.StatusNotFound, "Backup not found")
		return nil, nil, false
	}
	m, err := s.deps.Machines.GetMachine(machineID)
	if err != nil {
		httputil.InternalError(w, "machinebackups", err)
		return nil, nil, false
	}
	if m == nil {
		httputil.WriteError(w, http.StatusNotFound, "Unknown machine")
		return nil, nil, false
	}
	c, ok := s.deps.Client(m)
	rc, canRestore := c.(restoreClient)
	if !ok || !canRestore {
		writeCodeError(w, http.StatusNotImplemented, codeUnsupportedMachine,
			"Settings backups are only available for Gaggiuino machines")
		return nil, nil, false
	}
	return m, rc, true
}

// idle reports whether the machine may take a restore: it must not be brewing
// or steaming (REST status), descaling (live system state) or updating its
// firmware (firmware progress, including the partition migration of
// main-8aaf6f0 — the same rule as the firmware panel's isFirmwareBusy). A read
// that fails or cannot be understood counts as not idle (fail closed).
func (s *Restore) idle(ctx context.Context, w http.ResponseWriter, c restoreClient, m *machines.Machine) bool {
	unreadable := func(what string, err error) bool {
		log.Printf("machinebackups: restore onto machine %d stopped, %s could not be read: %s",
			m.ID, what, redact.Redact(err.Error()))
		writeCodeError(w, http.StatusBadGateway, codeMachineUnreachable,
			"GLP could not read the machine's state; nothing was restored")
		return false
	}

	status, err := c.GetStatus(ctx, m)
	if err != nil {
		return unreadable("its status", err)
	}
	if status.Brewing {
		return writeBusy(w, reasonBrew)
	}
	if status.SteamOn != nil && *status.SteamOn {
		return writeBusy(w, reasonSteam)
	}

	state, err := c.GetLiveSystemState(ctx, m)
	if err == nil && state == nil {
		err = errNoLiveState
	}
	if err != nil {
		return unreadable("its live state", err)
	}
	if state.OperationMode == proto.ModeDescale {
		return writeBusy(w, reasonDescale)
	}

	raw, err := c.GetFirmwareProgress(ctx, m)
	if err != nil {
		return unreadable("its firmware progress", err)
	}
	busy, err := firmwareBusy(raw)
	if err != nil {
		return unreadable("its firmware progress", err)
	}
	if busy {
		return writeBusy(w, reasonFirmwareUpdate)
	}
	return true
}

// mergedDocument returns the stored document with the machine's current
// secrets merged in. Unlike the download it never falls back to the secret-free
// document, because posting one without the machine's current wifi block could
// drop the machine off the network.
func (s *Restore) mergedDocument(ctx context.Context, w http.ResponseWriter, c restoreClient, m *machines.Machine, data []byte) ([]byte, bool) {
	current, err := c.GetSettingsBackup(ctx, m)
	switch {
	case errors.Is(err, machines.ErrSettingsBackupUnsupported):
		writeCodeError(w, http.StatusNotImplemented, codeUnsupportedFirmware,
			"The machine's firmware has no settings backup (needs Gaggiuino main-8aaf6f0 or later)")
		return nil, false
	case err != nil && !errors.Is(err, machines.ErrSettingsBackupTooLarge):
		log.Printf("machinebackups: restore onto machine %d stopped, its current backup could not be read: %s",
			m.ID, redact.Redact(err.Error()))
		writeCodeError(w, http.StatusBadGateway, codeMachineUnreachable, "The machine did not answer")
		return nil, false
	}

	doc, err := restoreDocument(data, current)
	if err != nil {
		log.Printf("machinebackups: restore onto machine %d stopped, its current backup cannot be used: %s",
			m.ID, redact.Redact(err.Error()))
		writeCodeError(w, http.StatusBadGateway, codeInvalidBackup,
			"The machine's current settings backup cannot be read, so its Wi-Fi and MQTT settings cannot be kept; nothing was restored")
		return nil, false
	}
	return doc, true
}

// dropProfileCache removes the machine's synced profile rows after a restore.
// They can name other profiles under the same remote ids; a nil list deletes
// exactly the synced rows, and dirty or pending rows cannot exist here (the
// restore refused them while holding the profile lock). The next profile list
// rebuilds the cache. handlers_profiles.go's #1610 guard is why the list path
// never passes an empty list.
func (s *Restore) dropProfileCache(machineID int64) {
	if err := s.deps.Profiles.PruneStaleSynced(machineID, nil); err != nil {
		log.Printf("machinebackups: dropping the profile cache of machine %d failed: %s",
			machineID, redact.Redact(err.Error()))
	}
}

// restoreDocument returns the stored document with the machine's current
// secrets, as canonical JSON. current must be a readable backup that carries
// the wifi object. The result holds secrets: it goes to the machine and
// nowhere else, never to the database, a response or a log. The size cap is
// the adapter's (one place).
func restoreDocument(storedData, currentRaw []byte) ([]byte, error) {
	current, err := parseDocument(currentRaw)
	if err != nil {
		return nil, err
	}
	if _, ok := current["wifi"].(map[string]any); !ok {
		return nil, fmt.Errorf("%w: the machine's backup has no wifi block", ErrInvalidDocument)
	}
	stored, err := parseDocument(storedData)
	if err != nil {
		return nil, err
	}
	mergeSecrets(stored, current)
	return encodeCanonical(stored)
}

// firmwareBusy mirrors the firmware panel's isFirmwareBusy: an update in
// progress, or a partition migration that is active or working.
func firmwareBusy(raw json.RawMessage) (bool, error) {
	var p struct {
		Status    string `json:"status"`
		Migration *struct {
			Active bool   `json:"active"`
			State  string `json:"state"`
		} `json:"migration"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return false, errFirmwareProgressUnreadable
	}
	if strings.EqualFold(p.Status, "IN_PROGRESS") {
		return true, nil
	}
	return p.Migration != nil && (p.Migration.Active || strings.EqualFold(p.Migration.State, "working")), nil
}

// writeBusy answers a machine_busy refusal with the reason and reports false.
func writeBusy(w http.ResponseWriter, reason string) bool {
	httputil.WriteJSON(w, http.StatusConflict, map[string]string{
		"error":  "The machine is brewing, steaming, descaling or updating its firmware; nothing was restored",
		"code":   codeMachineBusy,
		"reason": reason,
	})
	return false
}
