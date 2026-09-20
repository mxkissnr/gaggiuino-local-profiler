package system

import (
	"context"
	"encoding/json"
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
