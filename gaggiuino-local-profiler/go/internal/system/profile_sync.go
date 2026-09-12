package system

import (
	"context"
	"encoding/json"
	"log"
	"strconv"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines"
)

// profile_sync.go closes the write side of the 2026-09-09 offline-profile-
// editor rework: go/internal/machines/handlers_profiles.go now saves every
// profile create/update/delete locally first (ProfilesRepository), so those
// calls never fail just because the machine is unreachable — but a locally-
// saved change still needs to reach the physical machine eventually. This
// file is that push, wired into the same "the machine just became reachable
// / a brew just completed / periodically anyway" trigger points
// sync_triggers.go already established for shot history.
//
// profilesSyncInterval is separate from preheatWatchInterval/
// backgroundHaCheckInterval (constants.go) — package-level var, not const,
// so a test can shrink it.
var profilesSyncInterval = 60 * time.Second

// SetProfilesRepo wires the offline-profile local cache/outbox — mirrors
// SetShotsRepo's rationale (sync.go): a separate setter rather than a
// NewPoller parameter keeps every existing call site unchanged.
func (p *Poller) SetProfilesRepo(repo *machines.ProfilesRepository) { p.profilesRepo = repo }

// PushDirtyProfiles pushes every not-yet-synced local profile for one
// machine through its adapter — bounded like BackfillGaggiMatePhases (60s
// self-timeout independent of the caller's context, since this can be
// called from a fire-and-forget trigger with no deadline of its own). Each
// row is independent: one failure is recorded (MarkSyncError) and the loop
// moves on rather than aborting the whole batch — the next sweep (whichever
// trigger fires next) simply tries again, which is enough backoff on its
// own without a separate retry-count/backoff scheme.
func (p *Poller) PushDirtyProfiles(ctx context.Context, machineID int64) error {
	if p.profilesRepo == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()

	machine, err := p.registry.GetMachine(machineID)
	if err != nil {
		return err
	}
	if machine == nil {
		return nil
	}
	adapter, err := p.adapters.GetAdapter(machine)
	if err != nil {
		return err
	}
	rows, err := p.profilesRepo.DirtyRows(machineID)
	if err != nil {
		return err
	}
	for _, row := range rows {
		if err := p.pushOneProfile(ctx, machine, adapter, row); err != nil {
			log.Printf("system: pushing profile %d (machine %d) failed, will retry next sweep: %v", row.LocalID, machineID, err)
			_ = p.profilesRepo.MarkSyncError(row.LocalID, err.Error())
		}
	}
	return nil
}

func (p *Poller) pushOneProfile(ctx context.Context, machine *machines.Machine, adapter machines.Adapter, row machines.ProfileRow) error {
	switch row.SyncStatus {
	case machines.ProfileSyncPendingCreate:
		in := machines.ProfileInput{RawBody: row.Data}
		if machine.Type != "gaggimate" {
			in = machines.ProfileInput{}
			if err := json.Unmarshal(row.Data, &in); err != nil {
				return err
			}
		}
		created, err := adapter.CreateProfile(ctx, machine, in)
		if err != nil {
			return err
		}
		return p.profilesRepo.ReplaceRemoteID(row.LocalID, created.ID, created.Name)
	case machines.ProfileSyncDirty:
		if row.RemoteID == nil {
			// Shouldn't happen (dirty implies a prior successful sync gave
			// it a remote id) but fall back to create rather than dropping
			// the edit silently if it ever does.
			in := machines.ProfileInput{RawBody: row.Data}
			if machine.Type != "gaggimate" {
				in = machines.ProfileInput{}
				if err := json.Unmarshal(row.Data, &in); err != nil {
					return err
				}
			}
			created, err := adapter.CreateProfile(ctx, machine, in)
			if err != nil {
				return err
			}
			return p.profilesRepo.ReplaceRemoteID(row.LocalID, created.ID, created.Name)
		}
		var in machines.ProfileInput
		if machine.Type == "gaggimate" {
			pushBody := machines.InjectIDIfAbsent(row.Data, *row.RemoteID)
			in = machines.ProfileInput{RawBody: pushBody}
		} else {
			if err := json.Unmarshal(row.Data, &in); err != nil {
				return err
			}
			parsedID, err := strconv.ParseInt(*row.RemoteID, 10, 64)
			if err != nil {
				return err
			}
			in.ID = &parsedID
		}
		if _, err := adapter.UpdateProfile(ctx, machine, in); err != nil {
			return err
		}
		return p.profilesRepo.MarkSynced(row.LocalID)
	case machines.ProfileSyncPendingDelete:
		if row.RemoteID == nil {
			return p.profilesRepo.HardDelete(row.LocalID)
		}
		if _, err := adapter.DeleteProfile(ctx, machine, *row.RemoteID); err != nil {
			return err
		}
		return p.profilesRepo.HardDelete(row.LocalID)
	default:
		return nil
	}
}

// runProfileSyncSweep is the periodic, all-machines fallback trigger: unlike
// maybeCatchUpAfterRecovery/scheduleSyncAfterBrew (both default-machine-only,
// see sync_triggers.go's own doc comment on that scope limit), this covers
// every machine that currently has pending profile changes — required
// because a second, non-default machine (this project's own dev setup runs
// GaggiMate + Gaggiuino side by side) has no other reachability-recovery
// hook to piggyback on at all.
func (p *Poller) runProfileSyncSweep(ctx context.Context) {
	if p.profilesRepo == nil {
		return
	}
	ids, err := p.profilesRepo.AnyDirtyMachineIDs()
	if err != nil {
		log.Printf("system: listing machines with pending profile changes failed: %v", err)
		return
	}
	for _, id := range ids {
		if err := p.PushDirtyProfiles(ctx, id); err != nil {
			log.Printf("system: profile sync sweep for machine %d failed: %v", id, err)
		}
	}
}
