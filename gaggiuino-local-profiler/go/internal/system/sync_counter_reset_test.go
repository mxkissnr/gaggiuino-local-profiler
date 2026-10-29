package system

import (
	"bytes"
	"context"
	"errors"
	"log"
	"net/http"
	"strconv"
	"strings"
	"testing"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// TestSyncDefaultMachineShots_CounterResetClearsBlocklist is the reporter's
// #1824 scenario end to end: a machine whose shot counter was reset reports
// latest 72 while ids 1..150 sit in the blocklist from the previous counter.
// Before the fix the sync logged "already up to date (shots: 0)" and imported
// nothing at all; now the stale entries are cleared and 1..72 come in, minus
// the two ids the fake machine cannot serve (an empty 200 and the newest id's
// 404, which #1197 deliberately retries instead of blocklisting).
func TestSyncDefaultMachineShots_CounterResetClearsBlocklist(t *testing.T) {
	p, sqlDB := newTestPoller(t, &fakeAdapter{})
	repo := shots.NewRepository(sqlDB)
	p.SetShotsRepo(repo)

	for i := 1; i <= 150; i++ {
		if err := repo.AppendToBlocklist(strconv.Itoa(i)); err != nil {
			t.Fatalf("AppendToBlocklist(%d): %v", i, err)
		}
	}

	shotsByID := map[string]string{}
	for i := 1; i <= 72; i++ {
		if i == 70 {
			shotsByID[strconv.Itoa(i)] = "" // 200 with an empty body
			continue
		}
		if i == 72 {
			continue // newest id 404s for now -> #1197 retry, never blocklisted
		}
		shotsByID[strconv.Itoa(i)] = shotJSON(strconv.Itoa(i), strconv.Itoa(i*1000))
	}
	srv := newSyncFakeMachine(t, `[{"lastShotId":72}]`, shotsByID)
	withSyncTestServer(t, srv.URL)

	if err := p.syncDefaultMachineShots(context.Background()); err != nil {
		t.Fatalf("syncDefaultMachineShots: %v", err)
	}

	// 1..69 and 71 are readable; 70 (empty body) and 72 (newest 404) are not.
	for i := 1; i <= 72; i++ {
		s, err := repo.FindByID(int64(i))
		if err != nil {
			t.Fatalf("FindByID(%d): %v", i, err)
		}
		readable := i != 70 && i != 72
		if readable && s == nil {
			t.Fatalf("shot %d missing after the counter-reset sync", i)
		}
		if !readable && s != nil {
			t.Fatalf("shot %d was imported although the machine could not serve it", i)
		}
	}
	if n, err := repo.Count(); err != nil {
		t.Fatalf("Count: %v", err)
	} else if n != 70 {
		t.Fatalf("shot count = %d, want 70 (1..69 plus 71)", n)
	}

	block, err := repo.GetBlocklist()
	if err != nil {
		t.Fatalf("GetBlocklist: %v", err)
	}
	if len(block) != 0 {
		t.Fatalf("blocklist = %v, want empty (machine 1's stale entries cleared)", block)
	}
}

// TestSyncGaggiuinoMachineShots_CounterResetClearsOnlyOwnEntries is the #1824
// scoping half: machine 3's counter reset must clear machine 3's entries only.
// Another machine's global ids and a demo id stay in the blocklist, and none of
// them pull the cursor.
func TestSyncGaggiuinoMachineShots_CounterResetClearsOnlyOwnEntries(t *testing.T) {
	p, registry, repo := newOtherMachinesPoller(t)
	m3 := addOtherMachine(t, registry, "Third", "gaggiuino", "machine3.test", true)

	// Machine 3's own ids, another machine's id and a demo id share the list.
	owned := []string{
		strconv.FormatInt(shots.ToGlobalShotID(m3.ID, 1), 10),
		strconv.FormatInt(shots.ToGlobalShotID(m3.ID, 40), 10),
		strconv.FormatInt(shots.ToGlobalShotID(m3.ID, 90), 10),
	}
	otherMachine := strconv.FormatInt(shots.ToGlobalShotID(m3.ID+1, 7), 10)
	demo := "900000001"
	for _, v := range append(append([]string{}, owned...), otherMachine, demo) {
		if err := repo.AppendToBlocklist(v); err != nil {
			t.Fatalf("AppendToBlocklist(%q): %v", v, err)
		}
	}

	shotsByID := map[string]string{}
	for i := 1; i <= 5; i++ {
		shotsByID[strconv.Itoa(i)] = shotJSON(strconv.Itoa(i), strconv.Itoa(i*1000))
	}
	srv := newSyncFakeMachine(t, `[{"lastShotId":5}]`, shotsByID)
	withOtherMachineSyncServer(t, map[int64]string{m3.ID: srv.URL})

	if err := p.syncGaggiuinoMachineShots(context.Background(), m3); err != nil {
		t.Fatalf("syncGaggiuinoMachineShots: %v", err)
	}

	for i := 1; i <= 5; i++ {
		globalID := shots.ToGlobalShotID(m3.ID, int64(i))
		if s, err := repo.FindByID(globalID); err != nil {
			t.Fatalf("FindByID(%d): %v", globalID, err)
		} else if s == nil {
			t.Fatalf("shot %d missing after the counter-reset sync", globalID)
		}
	}

	block, err := repo.GetBlocklist()
	if err != nil {
		t.Fatalf("GetBlocklist: %v", err)
	}
	for _, gone := range owned {
		if blocklistHas(block, gone) {
			t.Fatalf("blocklist = %v, want machine 3's entry %q removed", block, gone)
		}
	}
	for _, kept := range []string{otherMachine, demo} {
		if !blocklistHas(block, kept) {
			t.Fatalf("blocklist = %v, want %q left untouched", block, kept)
		}
	}
	if len(block) != 2 {
		t.Fatalf("blocklist = %v, want exactly the other machine's and the demo id", block)
	}
}

// TestBackfillShots_AllNotFoundBlocklistsNothing is the #1824 third point: a
// machine that 404s every id it was asked for is failing, not reporting
// deleted shots. Nothing is blocklisted, the error is stamped as a sync error,
// and a later run against a healthy machine imports everything.
func TestBackfillShots_AllNotFoundBlocklistsNothing(t *testing.T) {
	p, sqlDB := newTestPoller(t, &fakeAdapter{})
	repo := shots.NewRepository(sqlDB)
	p.SetShotsRepo(repo)

	notFound := func(_ context.Context, native int64) (map[string]any, int, error) {
		return nil, http.StatusNotFound, errors.New("machine returned HTTP 404")
	}
	keep := func(shot map[string]any, _ int64) (bool, error) {
		shot["machineId"] = int64(1)
		return true, nil
	}

	recordErr, err := p.backfillShots(context.Background(), 1, 4, notFound, keep, systemBackfillLogs)
	if err == nil {
		t.Fatal("backfillShots succeeded on an all-404 run, want a retryable error")
	}
	if !recordErr {
		t.Fatal("all-404 run must report recordErr=true so the caller stamps a sync error")
	}
	block, gerr := repo.GetBlocklist()
	if gerr != nil {
		t.Fatalf("GetBlocklist: %v", gerr)
	}
	if len(block) != 0 {
		t.Fatalf("blocklist = %v, want empty after an all-404 run", block)
	}

	// The machine recovers: everything is imported on the next run.
	healthy := func(_ context.Context, native int64) (map[string]any, int, error) {
		return map[string]any{"id": native, "datapoints": []any{}}, http.StatusOK, nil
	}
	if recordErr, err := p.backfillShots(context.Background(), 1, 4, healthy, keep, systemBackfillLogs); err != nil {
		t.Fatalf("backfillShots after recovery: %v (recordErr=%v)", err, recordErr)
	}
	for i := int64(1); i <= 4; i++ {
		if s, err := repo.FindByID(i); err != nil {
			t.Fatalf("FindByID(%d): %v", i, err)
		} else if s == nil {
			t.Fatalf("shot %d missing after the recovered run", i)
		}
	}
}

// TestBackfillShots_EmptyBodySkippedNotBlocklisted is the #1824 fourth point: a
// 200 with a zero-length body is skipped and logged as an empty response, and
// never blocklisted (that would mean "permanently gone", #1151).
func TestBackfillShots_EmptyBodySkippedNotBlocklisted(t *testing.T) {
	var buf bytes.Buffer
	prev := log.Writer()
	log.SetOutput(&buf)
	t.Cleanup(func() { log.SetOutput(prev) })

	p, sqlDB := newTestPoller(t, &fakeAdapter{})
	repo := shots.NewRepository(sqlDB)
	p.SetShotsRepo(repo)

	srv := newSyncFakeMachine(t, `[{"lastShotId":3}]`, map[string]string{
		"1": shotJSON(`1`, "1000"),
		"2": "", // 200 with an empty body
		"3": shotJSON(`3`, "3000"),
	})
	withSyncTestServer(t, srv.URL)

	if err := p.syncDefaultMachineShots(context.Background()); err != nil {
		t.Fatalf("syncDefaultMachineShots: %v", err)
	}

	if s, err := repo.FindByID(2); err != nil {
		t.Fatalf("FindByID(2): %v", err)
	} else if s != nil {
		t.Fatal("shot 2 was imported from an empty body")
	}
	block, err := repo.GetBlocklist()
	if err != nil {
		t.Fatalf("GetBlocklist: %v", err)
	}
	if len(block) != 0 {
		t.Fatalf("blocklist = %v, want empty (an empty body is skipped, not blocklisted)", block)
	}
	if out := buf.String(); !strings.Contains(out, "empty response") {
		t.Fatalf("log does not mention the empty response:\n%s", out)
	}
}

// TestSyncDefaultMachineShots_UpToDateLogShowsCursorAndBlocklistCount is the
// #1824 first point: the "already up to date" line must report the cursor it
// actually compared and how many of this machine's blocklist entries fed it,
// not just the local max id — the misleading log that hid the wedge.
func TestSyncDefaultMachineShots_UpToDateLogShowsCursorAndBlocklistCount(t *testing.T) {
	var buf bytes.Buffer
	prev := log.Writer()
	log.SetOutput(&buf)
	t.Cleanup(func() { log.SetOutput(prev) })

	p, sqlDB := newTestPoller(t, &fakeAdapter{})
	repo := shots.NewRepository(sqlDB)
	p.SetShotsRepo(repo)

	// Cursor 8 comes from the blocklist; an unrelated machine's id must not
	// be counted.
	for _, v := range []string{"7", "8", "20000003"} {
		if err := repo.AppendToBlocklist(v); err != nil {
			t.Fatalf("AppendToBlocklist(%q): %v", v, err)
		}
	}

	srv := newSyncFakeMachine(t, `[{"lastShotId":8}]`, map[string]string{})
	withSyncTestServer(t, srv.URL)

	if err := p.syncDefaultMachineShots(context.Background()); err != nil {
		t.Fatalf("syncDefaultMachineShots: %v", err)
	}

	out := buf.String()
	want := "already up to date (latest 8, cursor 8, local shots up to 0, 2 blocklisted)"
	if !strings.Contains(out, want) {
		t.Fatalf("log does not contain %q:\n%s", want, out)
	}
}

// TestBackfillShots_CounterResetKeepsOtherMachinesInSync guards the reset
// against over-clearing at the helper level: clearing machine 2's stale entries
// leaves machine 1's entries intact, so machine 1's own cursor is unaffected.
func TestBackfillShots_CounterResetScopedToMachine(t *testing.T) {
	p, sqlDB := newTestPoller(t, &fakeAdapter{})
	repo := shots.NewRepository(sqlDB)
	p.SetShotsRepo(repo)

	for _, v := range []string{"9", "20000050"} {
		if err := repo.AppendToBlocklist(v); err != nil {
			t.Fatalf("AppendToBlocklist(%q): %v", v, err)
		}
	}

	fetch := func(_ context.Context, native int64) (map[string]any, int, error) {
		return map[string]any{"id": native, "datapoints": []any{}}, http.StatusOK, nil
	}
	keep := func(shot map[string]any, native int64) (bool, error) {
		shot["id"] = shots.ToGlobalShotID(2, native)
		shot["machineId"] = int64(2)
		return true, nil
	}

	if _, err := p.backfillShots(context.Background(), 2, 3, fetch, keep, systemBackfillLogs); err != nil {
		t.Fatalf("backfillShots: %v", err)
	}

	block, err := repo.GetBlocklist()
	if err != nil {
		t.Fatalf("GetBlocklist: %v", err)
	}
	if blocklistHas(block, "20000050") {
		t.Fatalf("blocklist = %v, want machine 2's stale entry removed", block)
	}
	if !blocklistHas(block, "9") {
		t.Fatalf("blocklist = %v, want machine 1's entry 9 untouched", block)
	}
}

// TestBackfillShots_TransportErrorLeavesCollectedNotFoundUnblocklisted pins the
// documented #1824 decision: a transport error mid-run aborts it, and the 404s
// collected before it stay out of the blocklist because the run was not healthy.
func TestBackfillShots_TransportErrorLeavesCollectedNotFoundUnblocklisted(t *testing.T) {
	p, sqlDB := newTestPoller(t, &fakeAdapter{})
	repo := shots.NewRepository(sqlDB)
	p.SetShotsRepo(repo)

	fetch := func(_ context.Context, native int64) (map[string]any, int, error) {
		switch native {
		case 2:
			return nil, http.StatusNotFound, errors.New("machine returned HTTP 404")
		case 3:
			return nil, 0, errors.New("connection reset")
		}
		return map[string]any{"id": native, "datapoints": []any{}}, http.StatusOK, nil
	}
	keep := func(shot map[string]any, _ int64) (bool, error) {
		shot["machineId"] = int64(1)
		return true, nil
	}

	recordErr, err := p.backfillShots(context.Background(), 1, 3, fetch, keep, systemBackfillLogs)
	if err == nil {
		t.Fatal("backfillShots hid the transport error")
	}
	if !recordErr {
		t.Fatal("a transport error must report recordErr=true")
	}
	block, gerr := repo.GetBlocklist()
	if gerr != nil {
		t.Fatalf("GetBlocklist: %v", gerr)
	}
	if len(block) != 0 {
		t.Fatalf("blocklist = %v, want empty (the run was not healthy)", block)
	}
}

// TestBackfillShots_CounterResetRemoveErrorIsLocalDBError pins that a failed
// blocklist removal is reported like every other local DB error — recordErr
// false — so a reachable machine is not flipped offline by it.
func TestBackfillShots_CounterResetRemoveErrorIsLocalDBError(t *testing.T) {
	p, sqlDB := newTestPoller(t, &fakeAdapter{})
	repo := shots.NewRepository(sqlDB)
	p.SetShotsRepo(repo)

	if err := repo.AppendToBlocklist("150"); err != nil {
		t.Fatalf("AppendToBlocklist: %v", err)
	}
	// Replace the table with a view of the same content: GetBlocklist still
	// reads the stale entry (so the reset is detected), but RemoveFromBlocklist's
	// DELETE fails like any other local DB error.
	if _, err := sqlDB.Exec(`DROP TABLE blocklist`); err != nil {
		t.Fatalf("dropping blocklist table: %v", err)
	}
	if _, err := sqlDB.Exec(`CREATE VIEW blocklist AS SELECT '150' AS value`); err != nil {
		t.Fatalf("creating blocklist view: %v", err)
	}

	recordErr, err := p.backfillShots(context.Background(), 1, 72,
		func(_ context.Context, native int64) (map[string]any, int, error) {
			return map[string]any{"id": native, "datapoints": []any{}}, http.StatusOK, nil
		},
		func(shot map[string]any, _ int64) (bool, error) { return true, nil },
		systemBackfillLogs)
	if err == nil {
		t.Fatal("backfillShots hid the failing blocklist removal")
	}
	if recordErr {
		t.Fatal("a local DB error must report recordErr=false")
	}
}
