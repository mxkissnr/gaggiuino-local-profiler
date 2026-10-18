package system

import (
	"context"
	"encoding/json"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines"
)

// TestPushDirtyProfiles_ConcurrentCallsForSameMachineAreSerialized verifies
// the per-machine mutex: two overlapping PushDirtyProfiles calls for the
// same machine (e.g. the periodic sweep and a post-brew trigger firing in
// the same window) must not both push — the second one, finding a push for
// this machine already in flight, skips rather than racing the first (see
// PushDirtyProfiles' own doc comment on why a race here is a correctness
// problem: two concurrent CreateProfile calls for one pending row would
// leave a duplicate on the machine).
func TestPushDirtyProfiles_ConcurrentCallsForSameMachineAreSerialized(t *testing.T) {
	fake := &fakeAdapter{}
	p, sqlDB := newTestPoller(t, fake)
	repo := machines.NewProfilesRepository(sqlDB)
	p.SetProfilesRepo(repo)

	if _, err := repo.UpsertDirty(1, nil, nil, "Slow Push", json.RawMessage(`{}`)); err != nil {
		t.Fatalf("UpsertDirty: %v", err)
	}

	var calls int32
	inFlight := make(chan struct{})
	release := make(chan struct{})
	fake.createProfileFn = func(context.Context, *machines.Machine, machines.ProfileInput) (machines.ProfileSummary, error) {
		atomic.AddInt32(&calls, 1)
		close(inFlight)
		<-release
		return machines.ProfileSummary{ID: "gm-1", Name: "Slow Push"}, nil
	}

	done := make(chan error, 2)
	go func() { done <- p.PushDirtyProfiles(context.Background(), 1) }()

	select {
	case <-inFlight:
	case <-time.After(2 * time.Second):
		t.Fatal("first PushDirtyProfiles never reached the adapter call")
	}

	// The first call now holds the per-machine lock inside the (blocked)
	// adapter call. A second call for the same machine must skip instead
	// of blocking behind it or racing it.
	go func() { done <- p.PushDirtyProfiles(context.Background(), 1) }()

	if err := <-done; err != nil {
		t.Fatalf("second (concurrent) PushDirtyProfiles: %v", err)
	}
	close(release)
	if err := <-done; err != nil {
		t.Fatalf("first PushDirtyProfiles: %v", err)
	}

	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Fatalf("adapter.CreateProfile call count = %d, want 1 (the concurrent call should have skipped, not pushed a duplicate)", got)
	}
}

// TestPushDirtyProfiles_SharesTheHandlerMachineLock proves the sweep and the
// HTTP handlers (machines/handlers_profiles.go) contend on the very same
// mutex: holding machines.ProfilesRepository.MachineLock externally, exactly
// as an in-flight create/update/delete handler does, must make
// PushDirtyProfiles skip rather than push — without that sharing, a handler's
// local write + adapter call could still race the sweep for the same pending
// row.
func TestPushDirtyProfiles_SharesTheHandlerMachineLock(t *testing.T) {
	fake := &fakeAdapter{}
	p, sqlDB := newTestPoller(t, fake)
	repo := machines.NewProfilesRepository(sqlDB)
	p.SetProfilesRepo(repo)

	if _, err := repo.UpsertDirty(1, nil, nil, "Held", json.RawMessage(`{}`)); err != nil {
		t.Fatalf("UpsertDirty: %v", err)
	}
	var calls int32
	fake.createProfileFn = func(context.Context, *machines.Machine, machines.ProfileInput) (machines.ProfileSummary, error) {
		atomic.AddInt32(&calls, 1)
		return machines.ProfileSummary{ID: "gm-1", Name: "Held"}, nil
	}

	mu := repo.MachineLock(1)
	mu.Lock()
	if err := p.PushDirtyProfiles(context.Background(), 1); err != nil {
		t.Fatalf("PushDirtyProfiles with the machine lock held: %v", err)
	}
	if got := atomic.LoadInt32(&calls); got != 0 {
		t.Fatalf("adapter.CreateProfile calls while the handler lock was held = %d, want 0 (the sweep must share that lock)", got)
	}
	mu.Unlock()

	// Releasing it lets the next sweep push the row normally.
	if err := p.PushDirtyProfiles(context.Background(), 1); err != nil {
		t.Fatalf("PushDirtyProfiles after unlock: %v", err)
	}
	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Fatalf("adapter.CreateProfile calls after unlock = %d, want 1", got)
	}
}

func TestPushDirtyProfiles_PendingCreate_SucceedsAndReplacesRemoteID(t *testing.T) {
	fake := &fakeAdapter{}
	p, sqlDB := newTestPoller(t, fake)
	repo := machines.NewProfilesRepository(sqlDB)
	p.SetProfilesRepo(repo)

	row, err := repo.UpsertDirty(1, nil, nil, "Offline Profile", json.RawMessage(`{"label":"Offline Profile"}`))
	if err != nil {
		t.Fatalf("UpsertDirty: %v", err)
	}
	fake.createProfileFn = func(context.Context, *machines.Machine, machines.ProfileInput) (machines.ProfileSummary, error) {
		return machines.ProfileSummary{ID: "gm-1", Name: "Offline Profile"}, nil
	}

	if err := p.PushDirtyProfiles(context.Background(), 1); err != nil {
		t.Fatalf("PushDirtyProfiles: %v", err)
	}

	got, err := repo.Get(1, "gm-1")
	if err != nil {
		t.Fatalf("Get after push: %v", err)
	}
	if got == nil {
		t.Fatal("expected the profile to be gettable by its new remote id")
	}
	if got.SyncStatus != machines.ProfileSyncSynced {
		t.Errorf("SyncStatus = %q, want synced", got.SyncStatus)
	}

	dirty, err := repo.DirtyRows(1)
	if err != nil {
		t.Fatalf("DirtyRows: %v", err)
	}
	if len(dirty) != 0 {
		t.Fatalf("DirtyRows = %+v, want empty after a successful push", dirty)
	}
	_ = row
}

func TestPushDirtyProfiles_FailurePreservesRowForNextSweep(t *testing.T) {
	fake := &fakeAdapter{}
	p, sqlDB := newTestPoller(t, fake)
	repo := machines.NewProfilesRepository(sqlDB)
	p.SetProfilesRepo(repo)

	if _, err := repo.UpsertDirty(1, nil, nil, "Still Offline", json.RawMessage(`{}`)); err != nil {
		t.Fatalf("UpsertDirty: %v", err)
	}
	fake.createProfileFn = func(context.Context, *machines.Machine, machines.ProfileInput) (machines.ProfileSummary, error) {
		return machines.ProfileSummary{}, errBoom
	}

	if err := p.PushDirtyProfiles(context.Background(), 1); err != nil {
		t.Fatalf("PushDirtyProfiles: %v", err)
	}

	dirty, err := repo.DirtyRows(1)
	if err != nil {
		t.Fatalf("DirtyRows: %v", err)
	}
	if len(dirty) != 1 {
		t.Fatalf("DirtyRows = %+v, want the still-unsynced row preserved for the next sweep", dirty)
	}
	if dirty[0].LastSyncError == nil || *dirty[0].LastSyncError == "" {
		t.Error("LastSyncError should be recorded after a failed push")
	}
}

// TestPushDirtyProfiles_Gaggiuino_DecodesTypedFieldsInsteadOfRawBody guards
// the RawBody-vs-typed-struct bug: GaggiuinoAdapter.CreateProfile/
// UpdateProfile json.Marshal the whole ProfileInput (RawBody has `json:"-"`,
// so it's silently dropped) — pushOneProfile must decode row.Data into the
// typed fields (Name/Phases/etc) for non-gaggimate machines rather than
// stuffing it into RawBody, or every offline Gaggiuino edit gets pushed as
// an empty profile.
func TestPushDirtyProfiles_Gaggiuino_DecodesTypedFieldsInsteadOfRawBody(t *testing.T) {
	fake := &fakeAdapter{}
	p, sqlDB := newTestPoller(t, fake) // default seeded machine is type "gaggiuino"
	repo := machines.NewProfilesRepository(sqlDB)
	p.SetProfilesRepo(repo)

	data := json.RawMessage(`{"name":"Offline Gaggiuino Profile","phases":[{"name":"Preinfusion","type":"PRESSURE"}]}`)
	if _, err := repo.UpsertDirty(1, nil, nil, "Offline Gaggiuino Profile", data); err != nil {
		t.Fatalf("UpsertDirty: %v", err)
	}
	var gotIn machines.ProfileInput
	fake.createProfileFn = func(_ context.Context, _ *machines.Machine, in machines.ProfileInput) (machines.ProfileSummary, error) {
		gotIn = in
		return machines.ProfileSummary{ID: "1", Name: in.Name}, nil
	}

	if err := p.PushDirtyProfiles(context.Background(), 1); err != nil {
		t.Fatalf("PushDirtyProfiles: %v", err)
	}

	if gotIn.RawBody != nil {
		t.Errorf("RawBody = %s, want nil (Gaggiuino adapter never reads it — json:\"-\" drops it on marshal)", gotIn.RawBody)
	}
	if gotIn.Name != "Offline Gaggiuino Profile" {
		t.Errorf("Name = %q, want decoded from row.Data", gotIn.Name)
	}
	if len(gotIn.Phases) != 1 || gotIn.Phases[0].Name == nil || *gotIn.Phases[0].Name != "Preinfusion" {
		t.Errorf("Phases = %+v, want the one decoded phase", gotIn.Phases)
	}
}

// TestPushDirtyProfiles_Gaggiuino_UpdateSetsNumericIDOnTypedStruct covers
// the ProfileSyncDirty branch with an existing remote id: Gaggiuino's
// UpdateProfile needs the numeric id set on ProfileInput.ID itself (unlike
// the HTTP handler, which has it in the URL path), so pushOneProfile must
// parse row.RemoteID and set in.ID before calling the adapter.
func TestPushDirtyProfiles_Gaggiuino_UpdateSetsNumericIDOnTypedStruct(t *testing.T) {
	fake := &fakeAdapter{}
	p, sqlDB := newTestPoller(t, fake)
	repo := machines.NewProfilesRepository(sqlDB)
	p.SetProfilesRepo(repo)

	remoteID := "42"
	if err := repo.UpsertSynced(1, remoteID, "Existing", json.RawMessage(`{"name":"Existing"}`), false); err != nil {
		t.Fatalf("UpsertSynced: %v", err)
	}
	synced, err := repo.Get(1, remoteID)
	if err != nil || synced == nil {
		t.Fatalf("Get after seed: %+v, %v", synced, err)
	}
	if _, err := repo.UpsertDirty(1, &synced.LocalID, &remoteID, "Existing Edited", json.RawMessage(`{"name":"Existing Edited"}`)); err != nil {
		t.Fatalf("UpsertDirty: %v", err)
	}
	var gotIn machines.ProfileInput
	fake.updateProfileFn = func(_ context.Context, _ *machines.Machine, in machines.ProfileInput) (machines.ProfileSummary, error) {
		gotIn = in
		return machines.ProfileSummary{ID: "42", Name: in.Name}, nil
	}

	if err := p.PushDirtyProfiles(context.Background(), 1); err != nil {
		t.Fatalf("PushDirtyProfiles: %v", err)
	}

	if gotIn.ID == nil || *gotIn.ID != 42 {
		t.Errorf("ID = %v, want *int64(42) parsed from RemoteID", gotIn.ID)
	}
	if gotIn.Name != "Existing Edited" {
		t.Errorf("Name = %q, want decoded from row.Data", gotIn.Name)
	}
}

func TestPushDirtyProfiles_PendingDelete_HardDeletesLocallyOnSuccess(t *testing.T) {
	fake := &fakeAdapter{}
	p, sqlDB := newTestPoller(t, fake)
	repo := machines.NewProfilesRepository(sqlDB)
	p.SetProfilesRepo(repo)

	if err := repo.UpsertSynced(1, "gm-1", "To Delete", json.RawMessage(`{}`), false); err != nil {
		t.Fatalf("UpsertSynced: %v", err)
	}
	if err := repo.MarkPendingDelete(1, "gm-1"); err != nil {
		t.Fatalf("MarkPendingDelete: %v", err)
	}
	fake.deleteProfileFn = func(context.Context, *machines.Machine, string) ([]machines.ProfileSummary, error) {
		return nil, nil
	}

	if err := p.PushDirtyProfiles(context.Background(), 1); err != nil {
		t.Fatalf("PushDirtyProfiles: %v", err)
	}

	got, err := repo.Get(1, "gm-1")
	if err != nil {
		t.Fatalf("Get after push: %v", err)
	}
	if got != nil {
		t.Fatalf("Get = %+v, want nil (hard-deleted after a successful remote delete)", got)
	}
}

// shortenPushTimeout shrinks the per-call profile push timeout for the
// duration of a test, so the lost-reply scenarios below run against the same
// short deadline they would on a real machine.
func shortenPushTimeout(t *testing.T) {
	t.Helper()
	old := profilePushTimeout
	profilePushTimeout = 50 * time.Millisecond
	t.Cleanup(func() { profilePushTimeout = old })
}

// TestPushOneProfile_CreateTimeoutAdoptsProfileOnNextSweep reproduces
// #1405's create case: the first push's CreateProfile reply is lost (times
// out) but the machine stored the profile anyway. The next sweep must adopt
// that profile instead of creating a second copy, leaving exactly one profile
// with that name on the machine and a remote id on the local row.
func TestPushOneProfile_CreateTimeoutAdoptsProfileOnNextSweep(t *testing.T) {
	fake := &fakeAdapter{}
	p, sqlDB := newTestPoller(t, fake)
	repo := machines.NewProfilesRepository(sqlDB)
	p.SetProfilesRepo(repo)
	shortenPushTimeout(t)

	row, err := repo.UpsertDirty(1, nil, nil, "Timed Out", json.RawMessage(`{"label":"Timed Out"}`))
	if err != nil {
		t.Fatalf("UpsertDirty: %v", err)
	}
	// Adoption by name only runs after a previous push timed out.
	if err := repo.MarkSyncError(row.LocalID, "context deadline exceeded"); err != nil {
		t.Fatalf("MarkSyncError: %v", err)
	}

	var machineProfiles []machines.ProfileSummary
	fake.listProfilesFn = func(context.Context, *machines.Machine) ([]machines.ProfileSummary, error) {
		return append([]machines.ProfileSummary(nil), machineProfiles...), nil
	}
	fake.createProfileFn = func(context.Context, *machines.Machine, machines.ProfileInput) (machines.ProfileSummary, error) {
		// The machine applies the create, but its reply never reaches us.
		machineProfiles = append(machineProfiles, machines.ProfileSummary{ID: "gm-1", Name: "Timed Out"})
		return machines.ProfileSummary{}, context.DeadlineExceeded
	}

	if err := p.PushDirtyProfiles(context.Background(), 1); err != nil {
		t.Fatalf("first PushDirtyProfiles: %v", err)
	}

	// The second sweep must adopt the stored profile, never create again.
	fake.createProfileFn = func(context.Context, *machines.Machine, machines.ProfileInput) (machines.ProfileSummary, error) {
		t.Fatal("CreateProfile called again: the stored profile should have been adopted")
		return machines.ProfileSummary{}, nil
	}
	if err := p.PushDirtyProfiles(context.Background(), 1); err != nil {
		t.Fatalf("second PushDirtyProfiles: %v", err)
	}

	adopted, err := repo.Get(1, "gm-1")
	if err != nil {
		t.Fatalf("Get by remote id: %v", err)
	}
	if adopted == nil {
		t.Fatal("row was not adopted: no local row carries the machine's remote id")
	}
	if adopted.LocalID != row.LocalID {
		t.Errorf("adopted LocalID = %d, want %d", adopted.LocalID, row.LocalID)
	}
	if len(machineProfiles) != 1 {
		t.Fatalf("machine has %d profiles named %q, want exactly 1", len(machineProfiles), "Timed Out")
	}
}

// TestPushOneProfile_ListProfilesFailureDoesNotCreate guards #1405's "never
// create blindly" rule: if the pre-create ListProfiles fails, the row stays
// pending for a later sweep and CreateProfile must not run at all.
func TestPushOneProfile_ListProfilesFailureDoesNotCreate(t *testing.T) {
	fake := &fakeAdapter{}
	p, sqlDB := newTestPoller(t, fake)
	repo := machines.NewProfilesRepository(sqlDB)
	p.SetProfilesRepo(repo)

	row, err := repo.UpsertDirty(1, nil, nil, "No List", json.RawMessage(`{}`))
	if err != nil {
		t.Fatalf("UpsertDirty: %v", err)
	}
	// Adoption by name only runs after a previous push timed out.
	if err := repo.MarkSyncError(row.LocalID, "context deadline exceeded"); err != nil {
		t.Fatalf("MarkSyncError: %v", err)
	}
	fake.listProfilesFn = func(context.Context, *machines.Machine) ([]machines.ProfileSummary, error) {
		return nil, errBoom
	}
	// createProfileFn is deliberately left nil: a call would panic and fail
	// the test, proving CreateProfile never ran.

	if err := p.PushDirtyProfiles(context.Background(), 1); err != nil {
		t.Fatalf("PushDirtyProfiles: %v", err)
	}

	dirty, err := repo.DirtyRows(1)
	if err != nil {
		t.Fatalf("DirtyRows: %v", err)
	}
	if len(dirty) != 1 {
		t.Fatalf("DirtyRows = %+v, want the row preserved for the next sweep", dirty)
	}
	if dirty[0].LastSyncError == nil || !strings.Contains(*dirty[0].LastSyncError, errBoom.Error()) {
		t.Errorf("LastSyncError = %v, want the ListProfiles error recorded", dirty[0].LastSyncError)
	}
}

// TestPushOneProfile_DoesNotAdoptProfileLinkedToAnotherRow: a same-name
// machine profile that already belongs to a different local row is not ours
// to adopt, so a create must still happen.
func TestPushOneProfile_DoesNotAdoptProfileLinkedToAnotherRow(t *testing.T) {
	fake := &fakeAdapter{}
	p, sqlDB := newTestPoller(t, fake)
	repo := machines.NewProfilesRepository(sqlDB)
	p.SetProfilesRepo(repo)

	if err := repo.UpsertSynced(1, "gm-1", "Shared", json.RawMessage(`{"label":"Shared","phases":[{"name":"P","type":"PRESSURE"}]}`), false); err != nil {
		t.Fatalf("UpsertSynced: %v", err)
	}
	row, err := repo.UpsertDirty(1, nil, nil, "Shared", json.RawMessage(`{"label":"Shared"}`))
	if err != nil {
		t.Fatalf("UpsertDirty: %v", err)
	}
	// Adoption by name only runs after a previous push timed out.
	if err := repo.MarkSyncError(row.LocalID, "context deadline exceeded"); err != nil {
		t.Fatalf("MarkSyncError: %v", err)
	}
	fake.listProfilesFn = func(context.Context, *machines.Machine) ([]machines.ProfileSummary, error) {
		return []machines.ProfileSummary{{ID: "gm-1", Name: "Shared"}}, nil
	}
	var calls int32
	fake.createProfileFn = func(context.Context, *machines.Machine, machines.ProfileInput) (machines.ProfileSummary, error) {
		atomic.AddInt32(&calls, 1)
		return machines.ProfileSummary{ID: "gm-2", Name: "Shared"}, nil
	}

	if err := p.PushDirtyProfiles(context.Background(), 1); err != nil {
		t.Fatalf("PushDirtyProfiles: %v", err)
	}

	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Fatalf("CreateProfile calls = %d, want 1 (gm-1 is linked to another row, so it must not be adopted)", got)
	}
	created, err := repo.Get(1, "gm-2")
	if err != nil || created == nil {
		t.Fatalf("Get(gm-2) = %+v, %v; want the newly created row", created, err)
	}
}

// TestPushOneProfile_DeleteTimeoutHardDeletesWhenAlreadyGone reproduces
// #1405's delete case: DeleteProfile's reply is lost but the machine removed
// the profile, so a confirming list must let the row be hard-deleted instead
// of retrying an id that no longer exists forever.
func TestPushOneProfile_DeleteTimeoutHardDeletesWhenAlreadyGone(t *testing.T) {
	fake := &fakeAdapter{}
	p, sqlDB := newTestPoller(t, fake)
	repo := machines.NewProfilesRepository(sqlDB)
	p.SetProfilesRepo(repo)
	shortenPushTimeout(t)

	if err := repo.UpsertSynced(1, "gm-1", "To Delete", json.RawMessage(`{}`), false); err != nil {
		t.Fatalf("UpsertSynced: %v", err)
	}
	if err := repo.MarkPendingDelete(1, "gm-1"); err != nil {
		t.Fatalf("MarkPendingDelete: %v", err)
	}
	fake.deleteProfileFn = func(context.Context, *machines.Machine, string) ([]machines.ProfileSummary, error) {
		return nil, context.DeadlineExceeded
	}
	fake.listProfilesFn = func(context.Context, *machines.Machine) ([]machines.ProfileSummary, error) {
		return nil, nil // gm-1 is gone
	}

	if err := p.PushDirtyProfiles(context.Background(), 1); err != nil {
		t.Fatalf("PushDirtyProfiles: %v", err)
	}

	got, err := repo.Get(1, "gm-1")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got != nil {
		t.Fatalf("Get = %+v, want nil (the machine already deleted the profile)", got)
	}
}

// TestPushOneProfile_DeleteFailureKeepsRowWhenStillListed: a delete that
// really failed (the id is still on the machine) must keep the row for a
// later sweep.
func TestPushOneProfile_DeleteFailureKeepsRowWhenStillListed(t *testing.T) {
	fake := &fakeAdapter{}
	p, sqlDB := newTestPoller(t, fake)
	repo := machines.NewProfilesRepository(sqlDB)
	p.SetProfilesRepo(repo)

	if err := repo.UpsertSynced(1, "gm-1", "Still There", json.RawMessage(`{}`), false); err != nil {
		t.Fatalf("UpsertSynced: %v", err)
	}
	if err := repo.MarkPendingDelete(1, "gm-1"); err != nil {
		t.Fatalf("MarkPendingDelete: %v", err)
	}
	fake.deleteProfileFn = func(context.Context, *machines.Machine, string) ([]machines.ProfileSummary, error) {
		return nil, errBoom
	}
	fake.listProfilesFn = func(context.Context, *machines.Machine) ([]machines.ProfileSummary, error) {
		return []machines.ProfileSummary{{ID: "gm-1", Name: "Still There"}}, nil
	}

	if err := p.PushDirtyProfiles(context.Background(), 1); err != nil {
		t.Fatalf("PushDirtyProfiles: %v", err)
	}

	rows, err := repo.DirtyRows(1)
	if err != nil {
		t.Fatalf("DirtyRows: %v", err)
	}
	if len(rows) != 1 || rows[0].SyncStatus != machines.ProfileSyncPendingDelete {
		t.Fatalf("DirtyRows = %+v, want the pending_delete row preserved", rows)
	}
	if rows[0].LastSyncError == nil || !strings.Contains(*rows[0].LastSyncError, errBoom.Error()) {
		t.Errorf("LastSyncError = %v, want the delete error recorded", rows[0].LastSyncError)
	}
}

// TestPushOneProfile_CreateTimeoutMergesListSummaryPlaceholder covers the
// path that most often produces a duplicate (#1405 review): after the save
// times out, the live profile list reconciles the machine's copy into a
// synced, empty-body placeholder row (UpsertListSummary) before the sweep
// runs. The sweep must fold that placeholder's remote id onto the pending row
// and drop it, not create a second machine profile or leave two local rows.
func TestPushOneProfile_CreateTimeoutMergesListSummaryPlaceholder(t *testing.T) {
	fake := &fakeAdapter{}
	p, sqlDB := newTestPoller(t, fake)
	repo := machines.NewProfilesRepository(sqlDB)
	p.SetProfilesRepo(repo)
	shortenPushTimeout(t)

	row, err := repo.UpsertDirty(1, nil, nil, "Placeholder", json.RawMessage(`{"label":"Placeholder"}`))
	if err != nil {
		t.Fatalf("UpsertDirty: %v", err)
	}
	// Adoption by name only runs after a previous push timed out.
	if err := repo.MarkSyncError(row.LocalID, "context deadline exceeded"); err != nil {
		t.Fatalf("MarkSyncError: %v", err)
	}

	var machineProfiles []machines.ProfileSummary
	fake.listProfilesFn = func(context.Context, *machines.Machine) ([]machines.ProfileSummary, error) {
		return append([]machines.ProfileSummary(nil), machineProfiles...), nil
	}
	fake.createProfileFn = func(context.Context, *machines.Machine, machines.ProfileInput) (machines.ProfileSummary, error) {
		machineProfiles = append(machineProfiles, machines.ProfileSummary{ID: "gm-1", Name: "Placeholder"})
		return machines.ProfileSummary{}, context.DeadlineExceeded
	}

	if err := p.PushDirtyProfiles(context.Background(), 1); err != nil {
		t.Fatalf("first PushDirtyProfiles: %v", err)
	}

	// The live list reconciles the machine's copy into a synced placeholder
	// before the next sweep, exactly as handlers_profiles.go does.
	if err := repo.UpsertListSummary(1, "gm-1", "Placeholder", false); err != nil {
		t.Fatalf("UpsertListSummary: %v", err)
	}

	fake.createProfileFn = func(context.Context, *machines.Machine, machines.ProfileInput) (machines.ProfileSummary, error) {
		t.Fatal("CreateProfile called again: the list-summary placeholder should have been merged")
		return machines.ProfileSummary{}, nil
	}
	if err := p.PushDirtyProfiles(context.Background(), 1); err != nil {
		t.Fatalf("second PushDirtyProfiles: %v", err)
	}

	profiles, err := repo.ListByMachine(1)
	if err != nil {
		t.Fatalf("ListByMachine: %v", err)
	}
	named := 0
	for _, r := range profiles {
		if r.Name == "Placeholder" {
			named++
		}
	}
	if named != 1 {
		t.Fatalf("local rows named %q = %d (%+v), want exactly 1", "Placeholder", named, profiles)
	}
	adopted, err := repo.Get(1, "gm-1")
	if err != nil {
		t.Fatalf("Get(gm-1): %v", err)
	}
	if adopted == nil || adopted.LocalID != row.LocalID {
		t.Fatalf("Get(gm-1) = %+v, want the original row %d carrying the remote id", adopted, row.LocalID)
	}
	if len(machineProfiles) != 1 {
		t.Fatalf("machine has %d profiles, want exactly 1", len(machineProfiles))
	}
}

// TestPushOneProfile_NoPreviousTimeoutCreatesInsteadOfAdopting: a pending row
// that has no recorded sync error must not adopt a same-name profile already
// on the machine — it can belong to a different, pre-existing profile, and
// adopting its id would let the next sweep overwrite it with this row's body
// (#1405 follow-up). With no previous error the sweep creates directly and
// never lists.
func TestPushOneProfile_NoPreviousTimeoutCreatesInsteadOfAdopting(t *testing.T) {
	fake := &fakeAdapter{}
	p, sqlDB := newTestPoller(t, fake)
	repo := machines.NewProfilesRepository(sqlDB)
	p.SetProfilesRepo(repo)

	if _, err := repo.UpsertDirty(1, nil, nil, "Same Name", json.RawMessage(`{"label":"Same Name"}`)); err != nil {
		t.Fatalf("UpsertDirty: %v", err)
	}

	var listCalls, createCalls int32
	fake.listProfilesFn = func(context.Context, *machines.Machine) ([]machines.ProfileSummary, error) {
		atomic.AddInt32(&listCalls, 1)
		return []machines.ProfileSummary{{ID: "gm-9", Name: "Same Name"}}, nil
	}
	fake.createProfileFn = func(context.Context, *machines.Machine, machines.ProfileInput) (machines.ProfileSummary, error) {
		atomic.AddInt32(&createCalls, 1)
		return machines.ProfileSummary{ID: "gm-2", Name: "Same Name"}, nil
	}

	if err := p.PushDirtyProfiles(context.Background(), 1); err != nil {
		t.Fatalf("PushDirtyProfiles: %v", err)
	}

	if got := atomic.LoadInt32(&createCalls); got != 1 {
		t.Fatalf("CreateProfile calls = %d, want 1 (no timed-out create to adopt for)", got)
	}
	if got := atomic.LoadInt32(&listCalls); got != 0 {
		t.Errorf("ListProfiles calls = %d, want 0 (adoption only follows a timed-out create)", got)
	}
	untouched, err := repo.Get(1, "gm-9")
	if err != nil {
		t.Fatalf("Get(gm-9): %v", err)
	}
	if untouched != nil {
		t.Fatalf("Get(gm-9) = %+v, want nil (the pre-existing machine profile must not be adopted)", untouched)
	}
	created, err := repo.Get(1, "gm-2")
	if err != nil || created == nil {
		t.Fatalf("Get(gm-2) = %+v, %v; want the newly created row", created, err)
	}
}

// TestPushOneProfile_NonTimeoutErrorCreatesInsteadOfAdopting: a previous push
// that failed for a reason other than a timeout (here a refused connection)
// proves the create never landed, so a same-name profile on the machine is a
// different, pre-existing one and must not be adopted (#1405 follow-up).
func TestPushOneProfile_NonTimeoutErrorCreatesInsteadOfAdopting(t *testing.T) {
	fake := &fakeAdapter{}
	p, sqlDB := newTestPoller(t, fake)
	repo := machines.NewProfilesRepository(sqlDB)
	p.SetProfilesRepo(repo)

	row, err := repo.UpsertDirty(1, nil, nil, "Same Name", json.RawMessage(`{"label":"Same Name"}`))
	if err != nil {
		t.Fatalf("UpsertDirty: %v", err)
	}
	if err := repo.MarkSyncError(row.LocalID, "dial tcp 10.0.0.5:80: connect: connection refused"); err != nil {
		t.Fatalf("MarkSyncError: %v", err)
	}

	var listCalls, createCalls int32
	fake.listProfilesFn = func(context.Context, *machines.Machine) ([]machines.ProfileSummary, error) {
		atomic.AddInt32(&listCalls, 1)
		return []machines.ProfileSummary{{ID: "gm-9", Name: "Same Name"}}, nil
	}
	fake.createProfileFn = func(context.Context, *machines.Machine, machines.ProfileInput) (machines.ProfileSummary, error) {
		atomic.AddInt32(&createCalls, 1)
		return machines.ProfileSummary{ID: "gm-2", Name: "Same Name"}, nil
	}

	if err := p.PushDirtyProfiles(context.Background(), 1); err != nil {
		t.Fatalf("PushDirtyProfiles: %v", err)
	}

	if got := atomic.LoadInt32(&createCalls); got != 1 {
		t.Fatalf("CreateProfile calls = %d, want 1 (a non-timeout error means the create never landed)", got)
	}
	if got := atomic.LoadInt32(&listCalls); got != 0 {
		t.Errorf("ListProfiles calls = %d, want 0 (adoption only follows a timed-out create)", got)
	}
	untouched, err := repo.Get(1, "gm-9")
	if err != nil {
		t.Fatalf("Get(gm-9): %v", err)
	}
	if untouched != nil {
		t.Fatalf("Get(gm-9) = %+v, want nil (a non-timeout failure must not adopt a same-name profile)", untouched)
	}
	created, err := repo.Get(1, "gm-2")
	if err != nil || created == nil {
		t.Fatalf("Get(gm-2) = %+v, %v; want the newly created row", created, err)
	}
}

// TestPushDirtyProfiles_NotifiesOnlyWhenSyncStateChanges: the sweep's
// onProfilesChanged hook publishes the "profiles" kind so other pages refetch
// the list and clear the pending badge — but only when a push actually changed
// a row's sync status or recorded error. A row that keeps failing with the same
// error must not re-notify on every sweep (that would spam every open page).
func TestPushDirtyProfiles_NotifiesOnlyWhenSyncStateChanges(t *testing.T) {
	fake := &fakeAdapter{}
	p, sqlDB := newTestPoller(t, fake)
	repo := machines.NewProfilesRepository(sqlDB)
	p.SetProfilesRepo(repo)

	var notifies int32
	p.SetOnProfilesChanged(func() { atomic.AddInt32(&notifies, 1) })

	if _, err := repo.UpsertDirty(1, nil, nil, "Boom", json.RawMessage(`{}`)); err != nil {
		t.Fatalf("UpsertDirty: %v", err)
	}
	fake.createProfileFn = func(context.Context, *machines.Machine, machines.ProfileInput) (machines.ProfileSummary, error) {
		return machines.ProfileSummary{}, errBoom
	}

	// First sweep: the row's stored error goes from empty to "boom" — changed.
	if err := p.PushDirtyProfiles(context.Background(), 1); err != nil {
		t.Fatalf("PushDirtyProfiles: %v", err)
	}
	if got := atomic.LoadInt32(&notifies); got != 1 {
		t.Fatalf("notifies after the first (changed) sweep = %d, want 1", got)
	}

	// Second sweep: the same row fails again with the same error — unchanged,
	// so the hook must not run again.
	if err := p.PushDirtyProfiles(context.Background(), 1); err != nil {
		t.Fatalf("PushDirtyProfiles: %v", err)
	}
	if got := atomic.LoadInt32(&notifies); got != 1 {
		t.Fatalf("notifies after a repeated same-error sweep = %d, want 1 (an unchanged error must not notify)", got)
	}

	// The push now succeeds and the row flips to synced — a status change.
	fake.createProfileFn = func(context.Context, *machines.Machine, machines.ProfileInput) (machines.ProfileSummary, error) {
		return machines.ProfileSummary{ID: "gm-1", Name: "Boom"}, nil
	}
	if err := p.PushDirtyProfiles(context.Background(), 1); err != nil {
		t.Fatalf("PushDirtyProfiles: %v", err)
	}
	if got := atomic.LoadInt32(&notifies); got != 2 {
		t.Fatalf("notifies after the row synced = %d, want 2 (a status change notifies)", got)
	}
}
