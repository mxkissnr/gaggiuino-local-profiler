package machinebackups

import (
	"context"
	"errors"
	"fmt"
	"log"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/redact"
)

// This file holds the pre-update backup (#1878): one settings backup taken
// right before every firmware update started from GLP. cmd/server wires Backup
// into machines.Handlers.SetBeforeFirmwareUpdate, and any error stops the
// update. The document is stored every time, without change detection, and
// pre_update rows are never pruned (pruneScheduled only deletes kind
// scheduled).

// PreUpdate takes the settings backup GLP stores before every firmware update
// started from GLP (#1878). cmd/server wires Backup into
// machines.Handlers.SetBeforeFirmwareUpdate; an error stops the update.
type PreUpdate struct {
	Repo   *Repository
	Client func(*machines.Machine) (Client, bool)
	Now    func() time.Time // optional
}

// Backup stores one pre-update settings backup of m and returns nil when the
// update may start. It returns machines.ErrPreUpdateBusy when another backup or
// restore of the machine holds the lock, machines.ErrPreUpdateUnreachable when
// the machine did not answer the status request, and any other error when the
// backup failed; every error stops the update. skipBackup is the user's
// explicit "update without a backup" confirmation: it skips the machine call
// but never the lock. A machine without a backup client (not a Gaggiuino
// machine) and firmware without the backup endpoint (404) update without a
// backup.
func (p PreUpdate) Backup(ctx context.Context, m *machines.Machine, skipBackup bool) error {
	if m == nil || p.Client == nil {
		return nil
	}
	c, ok := p.Client(m)
	if !ok || c == nil {
		return nil
	}
	// 409 instead of waiting: the scheduler and Back up now hold the lock for at
	// most about 13 s, and a restore ends with the machine restarting, so waiting
	// and then updating would be wrong.
	mu := p.Repo.machineLock(m.ID)
	if !mu.TryLock() {
		return machines.ErrPreUpdateBusy
	}
	defer mu.Unlock()

	if skipBackup {
		log.Printf("machinebackups: firmware update of machine %d starts without a pre-update backup (the user chose to skip it)", m.ID)
		return nil
	}

	prep, err := fetchPrepared(ctx, c, m)
	switch {
	case errors.Is(err, machines.ErrSettingsBackupUnsupported):
		log.Printf("machinebackups: machine %d firmware has no settings backup; updating without a pre-update backup", m.ID)
		return nil
	case errors.Is(err, errMachineOffline):
		log.Printf("machinebackups: pre-update backup of machine %d failed: the machine did not answer", m.ID)
		return machines.ErrPreUpdateUnreachable
	case err != nil:
		log.Printf("machinebackups: pre-update backup of machine %d failed, firmware update not started: %s", m.ID, redact.Redact(err.Error()))
		return fmt.Errorf("machinebackups: pre-update backup of machine %d: %w", m.ID, err)
	}

	entry, err := p.Repo.insert(m.ID, KindPreUpdate, "", prep, p.now())
	if err != nil {
		log.Printf("machinebackups: pre-update backup of machine %d failed, firmware update not started: %s", m.ID, redact.Redact(err.Error()))
		return err
	}
	log.Printf("machinebackups: stored pre-update backup of machine %d (%d profiles, %d bytes)", entry.MachineID, entry.ProfileCount, entry.SizeBytes)
	return nil
}

func (p PreUpdate) now() time.Time {
	if p.Now != nil {
		return p.Now()
	}
	return time.Now()
}
