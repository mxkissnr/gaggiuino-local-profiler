package machines

import (
	"encoding/json"
	"strconv"
	"testing"
)

func TestProfilesRepository_UpsertDirty_CreateThenUpdateStaysPendingCreate(t *testing.T) {
	_, sqlDB := newTestRegistry(t)
	repo := NewProfilesRepository(sqlDB)

	row, err := repo.UpsertDirty(1, nil, nil, "My Profile", json.RawMessage(`{"label":"My Profile"}`))
	if err != nil {
		t.Fatalf("UpsertDirty (create): %v", err)
	}
	if row.SyncStatus != ProfileSyncPendingCreate {
		t.Fatalf("SyncStatus = %q, want pending_create", row.SyncStatus)
	}
	if row.RemoteID != nil {
		t.Fatalf("RemoteID = %v, want nil (never synced)", row.RemoteID)
	}
	if row.PublicID() != "local:"+strconv.FormatInt(row.LocalID, 10) {
		t.Fatalf("PublicID = %q, want local:%d", row.PublicID(), row.LocalID)
	}

	// A second edit before the first sync ever happens must stay
	// pending_create, not regress to plain "dirty" (which would imply a
	// remote id already exists).
	updated, err := repo.UpsertDirty(1, &row.LocalID, nil, "Renamed", json.RawMessage(`{"label":"Renamed"}`))
	if err != nil {
		t.Fatalf("UpsertDirty (edit before sync): %v", err)
	}
	if updated.SyncStatus != ProfileSyncPendingCreate {
		t.Fatalf("SyncStatus after edit = %q, want pending_create", updated.SyncStatus)
	}
	if updated.Name != "Renamed" {
		t.Fatalf("Name = %q, want Renamed", updated.Name)
	}
}

func TestProfilesRepository_ReplaceRemoteID_MarksSyncedAndGettableByRemoteID(t *testing.T) {
	_, sqlDB := newTestRegistry(t)
	repo := NewProfilesRepository(sqlDB)

	row, err := repo.UpsertDirty(1, nil, nil, "Offline Profile", json.RawMessage(`{}`))
	if err != nil {
		t.Fatalf("UpsertDirty: %v", err)
	}
	if err := repo.ReplaceRemoteID(row.LocalID, "lever", "Offline Profile"); err != nil {
		t.Fatalf("ReplaceRemoteID: %v", err)
	}

	got, err := repo.Get(1, "lever")
	if err != nil {
		t.Fatalf("Get by remote id: %v", err)
	}
	if got == nil {
		t.Fatal("Get by remote id: not found")
	}
	if got.SyncStatus != ProfileSyncSynced {
		t.Errorf("SyncStatus = %q, want synced", got.SyncStatus)
	}
	if got.RemoteID == nil || *got.RemoteID != "lever" {
		t.Errorf("RemoteID = %v, want \"lever\"", got.RemoteID)
	}

	// Old local: placeholder id must still resolve to the same row.
	byLocal, err := repo.Get(1, "local:"+strconv.FormatInt(row.LocalID, 10))
	if err != nil {
		t.Fatalf("Get by local placeholder: %v", err)
	}
	if byLocal == nil || byLocal.LocalID != row.LocalID {
		t.Fatalf("Get by local placeholder = %+v, want local_id %d", byLocal, row.LocalID)
	}
}

func TestProfilesRepository_MarkPendingDelete_HidesFromListButKeepsRow(t *testing.T) {
	_, sqlDB := newTestRegistry(t)
	repo := NewProfilesRepository(sqlDB)

	if err := repo.UpsertSynced(1, "remote-1", "Kept", json.RawMessage(`{}`), false); err != nil {
		t.Fatalf("UpsertSynced: %v", err)
	}
	if err := repo.MarkPendingDelete(1, "remote-1"); err != nil {
		t.Fatalf("MarkPendingDelete: %v", err)
	}

	list, err := repo.ListByMachine(1)
	if err != nil {
		t.Fatalf("ListByMachine: %v", err)
	}
	if len(list) != 0 {
		t.Fatalf("ListByMachine = %+v, want empty (pending_delete filtered)", list)
	}

	dirty, err := repo.DirtyRows(1)
	if err != nil {
		t.Fatalf("DirtyRows: %v", err)
	}
	if len(dirty) != 1 || dirty[0].SyncStatus != ProfileSyncPendingDelete {
		t.Fatalf("DirtyRows = %+v, want one pending_delete row", dirty)
	}
}

func TestProfilesRepository_MarkPendingDelete_NeverSyncedRowHardDeletesImmediately(t *testing.T) {
	_, sqlDB := newTestRegistry(t)
	repo := NewProfilesRepository(sqlDB)

	row, err := repo.UpsertDirty(1, nil, nil, "Never Synced", json.RawMessage(`{}`))
	if err != nil {
		t.Fatalf("UpsertDirty: %v", err)
	}
	if err := repo.MarkPendingDelete(1, row.PublicID()); err != nil {
		t.Fatalf("MarkPendingDelete: %v", err)
	}

	dirty, err := repo.DirtyRows(1)
	if err != nil {
		t.Fatalf("DirtyRows: %v", err)
	}
	if len(dirty) != 0 {
		t.Fatalf("DirtyRows = %+v, want empty — a pending_create profile deleted before its first sync has nothing to push", dirty)
	}
}

func TestProfilesRepository_PruneStaleSynced_RemovesMissingSyncedButKeepsDirty(t *testing.T) {
	_, sqlDB := newTestRegistry(t)
	repo := NewProfilesRepository(sqlDB)

	if err := repo.UpsertSynced(1, "gone", "Deleted On Machine", json.RawMessage(`{}`), false); err != nil {
		t.Fatalf("UpsertSynced (gone): %v", err)
	}
	if err := repo.UpsertSynced(1, "still-here", "Kept", json.RawMessage(`{}`), false); err != nil {
		t.Fatalf("UpsertSynced (still-here): %v", err)
	}
	dirtyRemote := "dirty-remote"
	dirtyRow, err := repo.UpsertDirty(1, nil, nil, "Local Edit", json.RawMessage(`{}`))
	if err != nil {
		t.Fatalf("UpsertDirty: %v", err)
	}
	if err := repo.ReplaceRemoteID(dirtyRow.LocalID, dirtyRemote, "Local Edit"); err != nil {
		t.Fatalf("ReplaceRemoteID: %v", err)
	}
	if _, err := repo.UpsertDirty(1, &dirtyRow.LocalID, &dirtyRemote, "Local Edit Changed", json.RawMessage(`{"v":2}`)); err != nil {
		t.Fatalf("UpsertDirty (make dirty): %v", err)
	}

	// "gone" is missing from the live list, "still-here" and the dirty row's
	// remote id are still present — the dirty row must survive pruning
	// regardless of whether it's in the live list at all.
	if err := repo.PruneStaleSynced(1, []string{"still-here"}); err != nil {
		t.Fatalf("PruneStaleSynced: %v", err)
	}

	if got, err := repo.Get(1, "gone"); err != nil || got != nil {
		t.Fatalf("Get(gone) = %+v, %v, want nil, nil (pruned)", got, err)
	}
	if got, err := repo.Get(1, "still-here"); err != nil || got == nil {
		t.Fatalf("Get(still-here) = %+v, %v, want a row", got, err)
	}
	if got, err := repo.Get(1, dirtyRemote); err != nil || got == nil || got.SyncStatus != ProfileSyncDirty {
		t.Fatalf("Get(dirtyRemote) = %+v, %v, want surviving dirty row", got, err)
	}
}

func TestProfilesRepository_UpsertSynced_DoesNotClobberDirtyRow(t *testing.T) {
	_, sqlDB := newTestRegistry(t)
	repo := NewProfilesRepository(sqlDB)

	remoteID := "remote-1"
	if err := repo.UpsertSynced(1, remoteID, "Original", json.RawMessage(`{"v":1}`), false); err != nil {
		t.Fatalf("UpsertSynced (seed): %v", err)
	}
	synced, err := repo.Get(1, remoteID)
	if err != nil || synced == nil {
		t.Fatalf("Get after seed: %v", err)
	}
	if _, err := repo.UpsertDirty(1, &synced.LocalID, &remoteID, "Locally Edited", json.RawMessage(`{"v":2}`)); err != nil {
		t.Fatalf("UpsertDirty: %v", err)
	}

	// A live list reconcile call must not overwrite the not-yet-pushed
	// local edit with the machine's still-old copy.
	if err := repo.UpsertSynced(1, remoteID, "Original", json.RawMessage(`{"v":1}`), false); err != nil {
		t.Fatalf("UpsertSynced (reconcile while dirty): %v", err)
	}
	got, err := repo.Get(1, remoteID)
	if err != nil || got == nil {
		t.Fatalf("Get after reconcile: %v", err)
	}
	if got.Name != "Locally Edited" || got.SyncStatus != ProfileSyncDirty {
		t.Fatalf("got = %+v, want the dirty local edit preserved", got)
	}
}
