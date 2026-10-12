package system

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/library"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/maintenance"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// The sync is driven through a fakeAdapter (the package's existing fake-machine
// helper) rather than a loopback httptest server: machines.BaseURLFor's SSRF
// guard rejects the loopback address such a server listens on, and its
// allowLoopbackMachineHost override is unexported (helpers_test.go's own note
// on fakeAdapter makes the same point). The behavior under test — capability
// gating, per-machine scoping, 404/error handling — is all in syncNativeMaintenance,
// so a fake at the adapter boundary exercises the real production path.

// newNativeMaintenanceFixture wires a poller with two Gaggiuino machines (the
// default, id 1, and a second, id 2), a shots repo and a maintenance repo.
func newNativeMaintenanceFixture(t *testing.T, fake *fakeAdapter) (*Poller, *maintenance.Repository, *machines.Registry, *machines.Machine, *machines.Machine) {
	t.Helper()
	sqlDB := newTestDB(t)
	registry := machines.NewRegistry(sqlDB)
	if err := registry.EnsureDefaultMachine(); err != nil {
		t.Fatalf("EnsureDefaultMachine: %v", err)
	}
	name, typ, host := "Gaggiuino 2", "gaggiuino", "gaggiuino2.test"
	m2, err := registry.CreateMachine(machines.MachineInput{Name: &name, Type: &typ, Host: &host})
	if err != nil {
		t.Fatalf("CreateMachine: %v", err)
	}
	m1, err := registry.GetDefaultMachine()
	if err != nil {
		t.Fatalf("GetDefaultMachine: %v", err)
	}
	p := NewPoller(registry, fakeAdapterProvider{adapter: fake}, newHubForTest(), newDisabledHAClient())
	p.SetShotsRepo(shots.NewRepository(sqlDB))
	p.SetMaintenanceRepo(maintenance.NewRepository(sqlDB, library.NewRepository(sqlDB)))
	return p, p.maintenance, registry, m1, m2
}

func machineLastDate(t *testing.T, repo *maintenance.Repository, machineID int64, task string) string {
	t.Helper()
	maint, err := repo.GetMaintenance(machineID)
	if err != nil {
		t.Fatalf("GetMaintenance(%d): %v", machineID, err)
	}
	lastDate, _ := maint[task]["lastDate"].(string)
	return lastDate
}

// TestSyncNativeMaintenance_MarksBackflushForThatMachineOnly (#1639): a
// Gaggiuino whose service log reports a backflush marks backflush done for that
// machine, back-dated to the machine's timestamp with an auto-sync log entry,
// and leaves the second machine's task untouched.
func TestSyncNativeMaintenance_MarksBackflushForThatMachineOnly(t *testing.T) {
	at := time.Date(2026, 10, 1, 8, 30, 0, 0, time.UTC)
	fake := &fakeAdapter{
		capabilities: machines.Capabilities{NativeMaintenanceLog: true},
		serviceLogFn: func(context.Context, *machines.Machine) (machines.ServiceLog, error) {
			return machines.ServiceLog{LastBackflush: at}, nil
		},
	}
	p, repo, _, m1, m2 := newNativeMaintenanceFixture(t, fake)

	p.syncNativeMaintenance(context.Background(), m1)

	want := at.Format("2006-01-02T15:04:05.000Z")
	if got := machineLastDate(t, repo, m1.ID, "backflush"); got != want {
		t.Errorf("machine %d backflush lastDate = %q, want %q", m1.ID, got, want)
	}
	if got := machineLastDate(t, repo, m1.ID, "descaling"); got != "" {
		t.Errorf("machine %d descaling lastDate = %q, want untouched (only backflush was reported)", m1.ID, got)
	}
	if got := machineLastDate(t, repo, m2.ID, "backflush"); got != "" {
		t.Errorf("machine %d backflush lastDate = %q, want untouched (the other machine must not be affected)", m2.ID, got)
	}

	log, err := repo.GetMaintenanceLog(m1.ID)
	if err != nil {
		t.Fatalf("GetMaintenanceLog: %v", err)
	}
	if len(log) != 1 {
		t.Fatalf("log entries = %d, want 1: %+v", len(log), log)
	}
	if log[0].Task != "backflush" || log[0].Notes != "Auto-synced from machine" || log[0].Date != "2026-10-01" {
		t.Errorf("log entry = %+v, want task=backflush notes=\"Auto-synced from machine\" date=2026-10-01", log[0])
	}

	// A second sync with the same (unchanged) machine timestamp is a no-op.
	p.syncNativeMaintenance(context.Background(), m1)
	if log, err := repo.GetMaintenanceLog(m1.ID); err != nil {
		t.Fatalf("GetMaintenanceLog after second sync: %v", err)
	} else if len(log) != 1 {
		t.Errorf("log entries after second sync = %d, want 1 (idempotent)", len(log))
	}
}

// TestSyncNativeMaintenance_ServiceLogUnsupportedIsNoOp (#1639): a machine whose
// firmware has no service log (ErrServiceLogUnsupported — the 404 case) changes
// nothing and reports no error.
func TestSyncNativeMaintenance_ServiceLogUnsupportedIsNoOp(t *testing.T) {
	fake := &fakeAdapter{
		capabilities: machines.Capabilities{NativeMaintenanceLog: true},
		serviceLogFn: func(context.Context, *machines.Machine) (machines.ServiceLog, error) {
			return machines.ServiceLog{}, machines.ErrServiceLogUnsupported
		},
	}
	p, repo, _, m1, _ := newNativeMaintenanceFixture(t, fake)

	p.syncNativeMaintenance(context.Background(), m1)

	if got := machineLastDate(t, repo, m1.ID, "backflush"); got != "" {
		t.Errorf("backflush lastDate = %q, want untouched for an unsupported service log", got)
	}
	if log, err := repo.GetMaintenanceLog(m1.ID); err != nil {
		t.Fatalf("GetMaintenanceLog: %v", err)
	} else if len(log) != 0 {
		t.Errorf("log entries = %d, want 0", len(log))
	}
}

// TestSyncNativeMaintenance_FetchErrorDoesNotApply (#1639): a transport error
// must not mark any task done — the shot sync that called this stays unaffected.
func TestSyncNativeMaintenance_FetchErrorDoesNotApply(t *testing.T) {
	fake := &fakeAdapter{
		capabilities: machines.Capabilities{NativeMaintenanceLog: true},
		serviceLogFn: func(context.Context, *machines.Machine) (machines.ServiceLog, error) {
			return machines.ServiceLog{}, errors.New("connection refused")
		},
	}
	p, repo, _, m1, _ := newNativeMaintenanceFixture(t, fake)

	p.syncNativeMaintenance(context.Background(), m1)

	if got := machineLastDate(t, repo, m1.ID, "backflush"); got != "" {
		t.Errorf("backflush lastDate = %q, want untouched on a fetch error", got)
	}
}

func TestSyncNativeMaintenance_CapabilityOffIsSkipped(t *testing.T) {
	at := time.Date(2026, 10, 1, 8, 30, 0, 0, time.UTC)
	fake := &fakeAdapter{
		// NativeMaintenanceLog false (the zero value).
		serviceLogFn: func(context.Context, *machines.Machine) (machines.ServiceLog, error) {
			return machines.ServiceLog{LastBackflush: at}, nil
		},
	}
	p, repo, _, m1, _ := newNativeMaintenanceFixture(t, fake)

	p.syncNativeMaintenance(context.Background(), m1)

	if got := machineLastDate(t, repo, m1.ID, "backflush"); got != "" {
		t.Errorf("backflush lastDate = %q, want untouched when the capability is off", got)
	}
}
