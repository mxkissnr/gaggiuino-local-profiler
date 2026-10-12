package system

import (
	"context"
	"errors"
	"log"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/maintenance"
)

// This file implements syncNativeMaintenance (#1639, the #578 feature ported
// to the Go rewrite): after a Gaggiuino's shots are pulled, the machine's own
// service log is read and a descale/backflush it recorded marks the matching
// GLP maintenance task done, back-dated to the machine's timestamp.

// machineServiceLog is the one adapter method syncNativeMaintenance needs.
// GetServiceLog is deliberately not part of machines.Adapter — only the
// Gaggiuino firmware has the endpoint — so the sync type-asserts for it and
// skips any adapter that doesn't provide it.
type machineServiceLog interface {
	GetServiceLog(ctx context.Context, m *machines.Machine) (machines.ServiceLog, error)
}

// nativeMaintenanceTasks maps each service event the machine records onto the
// GLP task it marks done. The "shots since" counters the firmware also returns
// are deliberately ignored: GLP keeps computing those from its own history.
var nativeMaintenanceTasks = []struct {
	task string
	at   func(machines.ServiceLog) time.Time
}{
	{"backflush", func(sl machines.ServiceLog) time.Time { return sl.LastBackflush }},
	{"descaling", func(sl machines.ServiceLog) time.Time { return sl.LastDescale }},
}

// SetMaintenanceRepo wires the maintenance Repository syncNativeMaintenance
// writes into, the same way SetShotsRepo wires the shots repo (sync.go). A nil
// repo (every test that doesn't set it) makes the native-service-log sync a
// no-op rather than a panic.
func (p *Poller) SetMaintenanceRepo(repo *maintenance.Repository) { p.maintenance = repo }

// syncNativeMaintenance mirrors a machine's own service log (#1639) onto the
// matching maintenance tasks: a backflush or descale the firmware recorded
// marks the task done, back-dated to the machine's timestamp. It is a no-op
// for a machine whose adapter has no native service log (GaggiMate, older
// Gaggiuino firmware). Every failure is logged and swallowed — a machine that
// is unreachable or has an unexpectedly shaped log must never fail the shot
// sync that called this, and the next cycle retries.
func (p *Poller) syncNativeMaintenance(ctx context.Context, machine *machines.Machine) {
	if p.maintenance == nil || machine == nil {
		return
	}
	adapter, err := p.adapters.GetAdapter(machine)
	if err != nil {
		log.Printf("system: maintenance (%s): resolving adapter: %v", machine.Name, err)
		return
	}
	if !adapter.Capabilities().NativeMaintenanceLog {
		return
	}
	fetcher, ok := adapter.(machineServiceLog)
	if !ok {
		return
	}
	svcLog, err := fetcher.GetServiceLog(ctx, machine)
	if err != nil {
		if errors.Is(err, machines.ErrServiceLogUnsupported) {
			// Older firmware (404): the machine simply has no service log.
			log.Printf("system: maintenance (%s): machine firmware has no service log", machine.Name)
			return
		}
		log.Printf("system: maintenance (%s): fetching service log: %v", machine.Name, err)
		return
	}
	for _, t := range nativeMaintenanceTasks {
		at := t.at(svcLog)
		if at.IsZero() {
			continue
		}
		marked, err := maintenance.ApplyMachineServiceLog(p.maintenance, p.shots, p.registry, machine.ID, t.task, at)
		if err != nil {
			log.Printf("system: maintenance (%s): applying %s: %v", machine.Name, t.task, err)
			continue
		}
		if marked {
			log.Printf("system: maintenance (%s): %s recorded by machine at %s — marked done",
				machine.Name, t.task, at.UTC().Format(time.RFC3339))
		}
	}
}
