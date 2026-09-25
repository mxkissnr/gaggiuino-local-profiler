package system

import (
	"context"
	"testing"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// TestEffectiveSyncMax covers #1148: only native ids (0 < n < 10M) on the
// blocklist may advance the sync cursor. Demo ids (>=900M) and second-machine
// ids (>=10M) must be ignored, or they push effectiveMax past every real id for
// good and new shots stop importing.
func TestEffectiveSyncMax(t *testing.T) {
	cases := []struct {
		name      string
		maxLocal  int64
		blocklist []string
		want      int64
	}{
		{"high ids ignored", 3, []string{"900000001", "20000005"}, 3},
		{"native id advances", 3, []string{"5"}, 5},
		{"only valid native ids count", 3, []string{"0", "-1", "abc", "9999999"}, 9999999},
		{"upper boundary excluded", 3, []string{"10000000"}, 3},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := effectiveSyncMax(tc.maxLocal, tc.blocklist); got != tc.want {
				t.Fatalf("effectiveSyncMax(%d, %v) = %d, want %d", tc.maxLocal, tc.blocklist, got, tc.want)
			}
		})
	}
}

// TestSyncDefaultMachineShots_HighBlocklistIDsDoNotStopSync is the end-to-end
// proof of #1148: permanently deleting a demo shot or a second machine's shot
// leaves a huge id on the blocklist, which used to make every sync short-circuit
// with "already up to date". Shots 1-3 must still import.
func TestSyncDefaultMachineShots_HighBlocklistIDsDoNotStopSync(t *testing.T) {
	srv := newSyncFakeMachine(t, `[{"lastShotId":3}]`, map[string]string{
		"1": shotJSON(`1`, "1000"),
		"2": shotJSON(`2`, "2000"),
		"3": shotJSON(`3`, "3000"),
	})
	p, sqlDB := newTestPoller(t, &fakeAdapter{})
	repo := shots.NewRepository(sqlDB)
	p.SetShotsRepo(repo)
	withSyncTestServer(t, srv.URL)

	if err := repo.AppendToBlocklist("900000001"); err != nil {
		t.Fatalf("AppendToBlocklist(demo): %v", err)
	}
	if err := repo.AppendToBlocklist("20000005"); err != nil {
		t.Fatalf("AppendToBlocklist(second machine): %v", err)
	}

	if err := p.syncDefaultMachineShots(context.Background()); err != nil {
		t.Fatalf("syncDefaultMachineShots: %v", err)
	}
	if n, err := repo.Count(); err != nil {
		t.Fatalf("Count: %v", err)
	} else if n != 3 {
		t.Fatalf("shot count = %d, want 3 (high blocklist id likely skipped the sync)", n)
	}
}

// TestSyncDefaultMachineShots_NativeBlocklistIDStillHonored makes sure the fix
// keeps the legitimate case working: a native id on the blocklist (a shot
// permanently gone from the machine) must still move the cursor past it.
func TestSyncDefaultMachineShots_NativeBlocklistIDStillHonored(t *testing.T) {
	srv := newSyncFakeMachine(t, `[{"lastShotId":3}]`, map[string]string{
		"1": shotJSON(`1`, "1000"),
		"2": shotJSON(`2`, "2000"),
		"3": shotJSON(`3`, "3000"),
	})
	p, sqlDB := newTestPoller(t, &fakeAdapter{})
	repo := shots.NewRepository(sqlDB)
	p.SetShotsRepo(repo)
	withSyncTestServer(t, srv.URL)

	if err := repo.AppendToBlocklist("2"); err != nil {
		t.Fatalf("AppendToBlocklist: %v", err)
	}

	if err := p.syncDefaultMachineShots(context.Background()); err != nil {
		t.Fatalf("syncDefaultMachineShots: %v", err)
	}
	if n, err := repo.Count(); err != nil {
		t.Fatalf("Count: %v", err)
	} else if n != 1 {
		t.Fatalf("shot count = %d, want 1 (only shot 3 should import)", n)
	}
	if s, err := repo.FindByID(3); err != nil {
		t.Fatalf("FindByID(3): %v", err)
	} else if s == nil {
		t.Fatalf("shot 3 missing after sync")
	}
}
