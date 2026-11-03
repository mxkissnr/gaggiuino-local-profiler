package machinebackups

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines"
)

// This file covers the pre-update backup (#1878): machinebackups.PreUpdate.

func preUpdateFor(e *testEnv) PreUpdate {
	return PreUpdate{
		Repo: e.repo,
		Client: func(m *machines.Machine) (Client, bool) {
			c, ok := e.clients[m.ID]
			return c, ok
		},
		Now: func() time.Time { return e.clock },
	}
}

func TestPreUpdate_StoresEveryTimeWithoutSecrets(t *testing.T) {
	e := newTestEnv(t)
	e.clients[1] = &fakeClient{docs: []string{fixtureDoc}}
	m := gaggiuinoMachine(1)
	hook := preUpdateFor(e)

	if err := hook.Backup(context.Background(), &m, false); err != nil {
		t.Fatalf("first Backup: %v", err)
	}
	rows := e.rows()
	if len(rows) != 1 {
		t.Fatalf("rows = %d, want 1", len(rows))
	}
	row := rows[0]
	if row.kind != KindPreUpdate || row.machineID != 1 {
		t.Fatalf("row = %+v, want kind %q of machine 1", row, KindPreUpdate)
	}
	if row.createdAt != e.clock.Unix() {
		t.Fatalf("createdAt = %d, want %d", row.createdAt, e.clock.Unix())
	}
	if row.firmwareCore != "8aaf6f0" || row.profileCount != 2 {
		t.Fatalf("row = %+v, want firmware core 8aaf6f0 and 2 profiles", row)
	}
	assertNoSecrets(t, "stored pre-update backup", []byte(row.data))

	if err := hook.Backup(context.Background(), &m, false); err != nil {
		t.Fatalf("second Backup: %v", err)
	}
	rows = e.rows()
	if len(rows) != 2 {
		t.Fatalf("rows = %d, want 2 (no change detection)", len(rows))
	}
	for _, r := range rows {
		if r.kind != KindPreUpdate {
			t.Fatalf("row kind = %q, want %q", r.kind, KindPreUpdate)
		}
	}

	removed, err := e.repo.pruneScheduled(1, 1)
	if err != nil {
		t.Fatalf("pruneScheduled: %v", err)
	}
	if removed != 0 {
		t.Fatalf("pruneScheduled removed %d rows, want 0", removed)
	}
	if got := len(e.rows()); got != 2 {
		t.Fatalf("rows after prune = %d, want 2 (pre_update rows are never pruned)", got)
	}

	logged := e.logs.String()
	if !strings.Contains(logged, "stored pre-update backup of machine 1") {
		t.Fatalf("logs = %s, want the stored line", logged)
	}
	assertNoSecrets(t, "logs", e.logs.Bytes())
	if strings.Contains(logged, "192.168.1.50") {
		t.Fatalf("logs = %s, must not contain the machine host", logged)
	}
}

func TestPreUpdate_SkipTakesNoBackupButLogs(t *testing.T) {
	e := newTestEnv(t)
	client := &fakeClient{docs: []string{fixtureDoc}}
	e.clients[1] = client
	m := gaggiuinoMachine(1)

	if err := preUpdateFor(e).Backup(context.Background(), &m, true); err != nil {
		t.Fatalf("Backup with skipBackup: %v", err)
	}
	if client.statusCalls != 0 || client.backupCalls != 0 {
		t.Fatalf("machine calls = %d status, %d backup; want none", client.statusCalls, client.backupCalls)
	}
	if got := len(e.rows()); got != 0 {
		t.Fatalf("rows = %d, want 0", got)
	}
	if !strings.Contains(e.logs.String(), "starts without a pre-update backup") {
		t.Fatalf("logs = %s, want the skip line", e.logs.String())
	}
}

func TestPreUpdate_UnsupportedFirmwareLetsTheUpdateRun(t *testing.T) {
	e := newTestEnv(t)
	e.clients[1] = &fakeClient{backupErr: machines.ErrSettingsBackupUnsupported}
	m := gaggiuinoMachine(1)

	if err := preUpdateFor(e).Backup(context.Background(), &m, false); err != nil {
		t.Fatalf("Backup against firmware without the backup endpoint: %v", err)
	}
	if got := len(e.rows()); got != 0 {
		t.Fatalf("rows = %d, want 0", got)
	}
	if !strings.Contains(e.logs.String(), "has no settings backup") {
		t.Fatalf("logs = %s, want the unsupported-firmware line", e.logs.String())
	}
}

func TestPreUpdate_FailuresStopTheUpdate(t *testing.T) {
	steamOn := true
	cases := []struct {
		name    string
		client  func() *fakeClient
		closeDB bool
	}{
		{
			name:   "offline",
			client: func() *fakeClient { return &fakeClient{statusErr: errors.New("dial tcp 192.168.1.50:80: connection refused")} },
		},
		{
			name:   "brewing",
			client: func() *fakeClient {
				return &fakeClient{status: machines.Status{Brewing: true}, docs: []string{fixtureDoc}}
			},
		},
		{
			name:   "steaming",
			client: func() *fakeClient {
				return &fakeClient{status: machines.Status{SteamOn: &steamOn}, docs: []string{fixtureDoc}}
			},
		},
		{
			name:   "backup transport error",
			client: func() *fakeClient {
				return &fakeClient{docs: []string{fixtureDoc}, backupErr: errors.New("read tcp 192.168.1.50:80: i/o timeout")}
			},
		},
		{
			name:   "backup too large",
			client: func() *fakeClient {
				return &fakeClient{docs: []string{fixtureDoc}, backupErr: machines.ErrSettingsBackupTooLarge}
			},
		},
		{
			name:   "unknown document format",
			client: func() *fakeClient {
				return &fakeClient{docs: []string{`{"format":"other","version":1}`}}
			},
		},
		{
			name:    "store fails",
			client:  func() *fakeClient { return &fakeClient{docs: []string{fixtureDoc}} },
			closeDB: true,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			e := newTestEnv(t)
			e.clients[1] = tc.client()
			m := gaggiuinoMachine(1)
			if tc.closeDB {
				e.closeDB()
			}

			err := preUpdateFor(e).Backup(context.Background(), &m, false)
			if err == nil {
				t.Fatalf("Backup returned nil, want an error that stops the update")
			}
			unreachable := errors.Is(err, machines.ErrPreUpdateUnreachable)
			if tc.name == "offline" {
				if !unreachable {
					t.Fatalf("err = %v, want ErrPreUpdateUnreachable", err)
				}
			} else {
				if unreachable || errors.Is(err, machines.ErrPreUpdateBusy) {
					t.Fatalf("err = %v, want the generic backup failure", err)
				}
			}
			if !tc.closeDB {
				if got := len(e.rows()); got != 0 {
					t.Fatalf("rows = %d, want 0", got)
				}
			}
			mu := e.repo.machineLock(1)
			if !mu.TryLock() {
				t.Fatalf("the machine lock was not released")
			}
			mu.Unlock()
			if strings.Contains(e.logs.String(), "192.168.1.50") {
				t.Fatalf("logs = %s, must not contain the machine host", e.logs.String())
			}
		})
	}
}

func TestPreUpdate_BusyLockAnswersBusyEvenWhenSkipping(t *testing.T) {
	e := newTestEnv(t)
	client := &fakeClient{docs: []string{fixtureDoc}}
	e.clients[1] = client
	m := gaggiuinoMachine(1)
	hook := preUpdateFor(e)

	mu := e.repo.machineLock(1)
	mu.Lock()
	if err := hook.Backup(context.Background(), &m, false); !errors.Is(err, machines.ErrPreUpdateBusy) {
		t.Fatalf("Backup while locked = %v, want ErrPreUpdateBusy", err)
	}
	if client.statusCalls != 0 {
		t.Fatalf("status calls = %d, want 0", client.statusCalls)
	}
	if err := hook.Backup(context.Background(), &m, true); !errors.Is(err, machines.ErrPreUpdateBusy) {
		t.Fatalf("Backup with skipBackup while locked = %v, want ErrPreUpdateBusy", err)
	}
	mu.Unlock()

	if err := hook.Backup(context.Background(), &m, false); err != nil {
		t.Fatalf("Backup after unlock: %v", err)
	}
	if got := len(e.rows()); got != 1 {
		t.Fatalf("rows = %d, want 1", got)
	}
}

func TestPreUpdate_NoClientMeansNothingToBackUp(t *testing.T) {
	e := newTestEnv(t)
	m := gaggiuinoMachine(1)

	if err := preUpdateFor(e).Backup(context.Background(), &m, false); err != nil {
		t.Fatalf("Backup without a client: %v", err)
	}
	if got := len(e.rows()); got != 0 {
		t.Fatalf("rows = %d, want 0", got)
	}
	mu := e.repo.machineLock(1)
	if !mu.TryLock() {
		t.Fatalf("the machine lock was taken even though there is nothing to back up")
	}
	mu.Unlock()
}
