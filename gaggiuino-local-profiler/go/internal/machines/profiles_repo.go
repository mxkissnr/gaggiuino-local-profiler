package machines

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"strconv"
	"time"
)

// This file backs the offline-first profile editor (2026-09-09): profiles
// used to live exclusively on the physical machine with zero local
// persistence (see gaggimate_profiles.go's old doc comment), so editing one
// while the machine was unreachable hard-failed outright, and even opening
// the editor for an existing profile had no offline fallback at all. This
// repository is now the local source of truth every write lands in first
// (see handlers_profiles.go); a live push to the machine is attempted
// opportunistically and SyncStatus tracks whether it has succeeded yet.
//
// Same single-file, plain *sql.DB repository shape as shots.Repository —
// see that package's repository.go for the pattern this mirrors.

// Profile sync_status values.
const (
	ProfileSyncSynced        = "synced"
	ProfileSyncDirty         = "dirty"
	ProfileSyncPendingCreate = "pending_create"
	ProfileSyncPendingDelete = "pending_delete"
)

// ProfileRow is one machine_profiles row. RemoteID is nil until the machine
// has assigned this profile a real id (a create made while offline stays
// nil until its first successful sync) — see handlers_profiles.go's
// resolveProfileID for how the HTTP layer addresses such a row via a
// "local:<LocalID>" placeholder in the meantime.
type ProfileRow struct {
	LocalID       int64
	MachineID     int64
	RemoteID      *string
	Name          string
	Data          json.RawMessage
	Utility       bool
	SyncStatus    string
	LastSyncError *string
	CreatedAt     int64
	UpdatedAt     int64
}

// ToSummary projects a row to the same {id, name, utility} shape
// ProfileSummary already uses elsewhere, for list responses.
func (row ProfileRow) ToSummary() ProfileSummary {
	return ProfileSummary{ID: row.PublicID(), Name: row.Name, Utility: row.Utility}
}

// PublicID is the value the HTTP layer hands to the frontend: the real
// remote id once known, otherwise the "local:<LocalID>" placeholder.
func (row ProfileRow) PublicID() string {
	if row.RemoteID != nil {
		return *row.RemoteID
	}
	return fmt.Sprintf("local:%d", row.LocalID)
}

type ProfilesRepository struct {
	db *sql.DB
}

func NewProfilesRepository(db *sql.DB) *ProfilesRepository {
	return &ProfilesRepository{db: db}
}

func scanProfileRow(scan func(dest ...any) error) (ProfileRow, error) {
	var row ProfileRow
	var data string
	if err := scan(&row.LocalID, &row.MachineID, &row.RemoteID, &row.Name, &data,
		&row.Utility, &row.SyncStatus, &row.LastSyncError, &row.CreatedAt, &row.UpdatedAt); err != nil {
		return ProfileRow{}, err
	}
	row.Data = json.RawMessage(data)
	return row, nil
}

const profileColumns = `local_id, machine_id, remote_id, name, data, utility, sync_status, last_sync_error, created_at, updated_at`

// ListByMachine returns every non-pending_delete row for machineID, ordered
// by name — pending_delete rows are filtered here (not just by the caller)
// so every list path (live-reconciled or offline-fallback) shows the same
// "already gone" view for a delete made while offline.
func (r *ProfilesRepository) ListByMachine(machineID int64) ([]ProfileRow, error) {
	rows, err := r.db.Query(`SELECT `+profileColumns+` FROM machine_profiles
		WHERE machine_id = ? AND sync_status != ? ORDER BY name`, machineID, ProfileSyncPendingDelete)
	if err != nil {
		return nil, fmt.Errorf("machines: listing local profiles: %w", err)
	}
	defer rows.Close()
	var out []ProfileRow
	for rows.Next() {
		row, err := scanProfileRow(rows.Scan)
		if err != nil {
			return nil, fmt.Errorf("machines: scanning local profile: %w", err)
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

// Get resolves either a real remote id or a "local:<n>" placeholder to its
// row. Returns (nil, nil) — not an error — when no such row exists, same
// convention as shots.Repository.FindByID.
func (r *ProfilesRepository) Get(machineID int64, id string) (*ProfileRow, error) {
	var query string
	var arg any
	if localID, ok := parseLocalPlaceholder(id); ok {
		query = `SELECT ` + profileColumns + ` FROM machine_profiles WHERE machine_id = ? AND local_id = ?`
		arg = localID
	} else {
		query = `SELECT ` + profileColumns + ` FROM machine_profiles WHERE machine_id = ? AND remote_id = ?`
		arg = id
	}
	row, err := scanProfileRow(r.db.QueryRow(query, machineID, arg).Scan)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("machines: getting local profile %q: %w", id, err)
	}
	return &row, nil
}

// GetByRemoteID is Get's remote-only counterpart, used when reconciling a
// live list/get response where the caller only has the machine's own id.
func (r *ProfilesRepository) GetByRemoteID(machineID int64, remoteID string) (*ProfileRow, error) {
	row, err := scanProfileRow(r.db.QueryRow(`SELECT `+profileColumns+` FROM machine_profiles
		WHERE machine_id = ? AND remote_id = ?`, machineID, remoteID).Scan)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("machines: getting local profile by remote id %q: %w", remoteID, err)
	}
	return &row, nil
}

// UpsertSynced records a profile exactly as the machine reports it —
// called for every profile returned by a successful live list/get/create/
// update, so the local cache never goes stale while the machine is
// reachable. A row already marked dirty/pending_* by a not-yet-pushed local
// edit is left untouched (the live copy doesn't get to silently clobber an
// offline edit still waiting to sync — that edit's own push, once it
// succeeds, is what calls MarkSynced instead).
func (r *ProfilesRepository) UpsertSynced(machineID int64, remoteID, name string, data json.RawMessage, utility bool) error {
	existing, err := r.GetByRemoteID(machineID, remoteID)
	if err != nil {
		return err
	}
	if existing != nil && existing.SyncStatus != ProfileSyncSynced {
		return nil
	}
	now := time.Now().UnixMilli()
	_, err = r.db.Exec(`INSERT INTO machine_profiles
			(machine_id, remote_id, name, data, utility, sync_status, last_sync_error, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
		ON CONFLICT(machine_id, remote_id) WHERE remote_id IS NOT NULL DO UPDATE SET
			name = excluded.name, data = excluded.data, utility = excluded.utility,
			sync_status = excluded.sync_status, last_sync_error = NULL, updated_at = excluded.updated_at`,
		machineID, remoteID, name, string(data), utility, ProfileSyncSynced, now, now)
	if err != nil {
		return fmt.Errorf("machines: upserting synced profile: %w", err)
	}
	return nil
}

// UpsertListSummary reconciles one entry from a live ListProfiles response —
// unlike UpsertSynced, it does NOT touch the `data` column: ListProfiles
// only ever returns {id, name, utility}, never the full profile body, so
// overwriting `data` here would blow away whatever a prior GetProfile/
// Create/Update call actually stored. A brand-new row (never seen before)
// gets an empty `{}` placeholder body — it becomes complete the first time
// someone opens it (getMachineProfile's live-success path calls
// UpsertSynced with the real body then). Same dirty-row protection as
// UpsertSynced: a local edit still waiting to push is left alone.
func (r *ProfilesRepository) UpsertListSummary(machineID int64, remoteID, name string, utility bool) error {
	existing, err := r.GetByRemoteID(machineID, remoteID)
	if err != nil {
		return err
	}
	if existing != nil && existing.SyncStatus != ProfileSyncSynced {
		return nil
	}
	now := time.Now().UnixMilli()
	_, err = r.db.Exec(`INSERT INTO machine_profiles
			(machine_id, remote_id, name, data, utility, sync_status, last_sync_error, created_at, updated_at)
		VALUES (?, ?, ?, '{}', ?, ?, NULL, ?, ?)
		ON CONFLICT(machine_id, remote_id) WHERE remote_id IS NOT NULL DO UPDATE SET
			name = excluded.name, utility = excluded.utility, sync_status = excluded.sync_status,
			last_sync_error = NULL, updated_at = excluded.updated_at`,
		machineID, remoteID, name, utility, ProfileSyncSynced, now, now)
	if err != nil {
		return fmt.Errorf("machines: upserting profile list summary: %w", err)
	}
	return nil
}

// UpsertDirty is the local-first write path: localID nil means "new row"
// (pending_create), non-nil updates an existing one (dirty, or
// pending_create again if it never got a remote id yet). Never fails due to
// the machine being unreachable — that's the entire point.
func (r *ProfilesRepository) UpsertDirty(machineID int64, localID *int64, remoteID *string, name string, data json.RawMessage) (ProfileRow, error) {
	now := time.Now().UnixMilli()
	if localID == nil {
		status := ProfileSyncPendingCreate
		if remoteID != nil {
			status = ProfileSyncDirty
		}
		res, err := r.db.Exec(`INSERT INTO machine_profiles
				(machine_id, remote_id, name, data, utility, sync_status, last_sync_error, created_at, updated_at)
			VALUES (?, ?, ?, ?, 0, ?, NULL, ?, ?)`,
			machineID, remoteID, name, string(data), status, now, now)
		if err != nil {
			return ProfileRow{}, fmt.Errorf("machines: inserting local profile: %w", err)
		}
		id, err := res.LastInsertId()
		if err != nil {
			return ProfileRow{}, fmt.Errorf("machines: reading new local profile id: %w", err)
		}
		row, err := r.getByLocalID(id, machineID)
		if err != nil {
			return ProfileRow{}, err
		}
		return *row, nil
	}
	// Existing row: pending_create stays pending_create (still no remote id
	// yet), anything else becomes dirty. The read-then-write here runs inside
	// a transaction — SQLite's single-writer lock then serializes this
	// against any other concurrent UpsertDirty call on the same row (e.g. two
	// browser tabs editing the same profile, or a UI edit racing the
	// background sync sweep), so the SyncStatus this reads can't go stale
	// between the SELECT and the UPDATE.
	tx, err := r.db.Begin()
	if err != nil {
		return ProfileRow{}, fmt.Errorf("machines: beginning local profile update: %w", err)
	}
	defer tx.Rollback()
	existing, err := scanProfileRow(tx.QueryRow(`SELECT `+profileColumns+` FROM machine_profiles WHERE local_id = ? AND machine_id = ?`, *localID, machineID).Scan)
	if err == sql.ErrNoRows {
		return ProfileRow{}, fmt.Errorf("machines: local profile %d not found", *localID)
	}
	if err != nil {
		return ProfileRow{}, fmt.Errorf("machines: getting local profile %d: %w", *localID, err)
	}
	status := ProfileSyncDirty
	if existing.SyncStatus == ProfileSyncPendingCreate {
		status = ProfileSyncPendingCreate
	}
	if _, err := tx.Exec(`UPDATE machine_profiles SET name = ?, data = ?, sync_status = ?, last_sync_error = NULL, updated_at = ?
		WHERE local_id = ?`, name, string(data), status, now, *localID); err != nil {
		return ProfileRow{}, fmt.Errorf("machines: updating local profile: %w", err)
	}
	row, err := scanProfileRow(tx.QueryRow(`SELECT `+profileColumns+` FROM machine_profiles WHERE local_id = ? AND machine_id = ?`, *localID, machineID).Scan)
	if err != nil {
		return ProfileRow{}, fmt.Errorf("machines: getting updated local profile %d: %w", *localID, err)
	}
	if err := tx.Commit(); err != nil {
		return ProfileRow{}, fmt.Errorf("machines: committing local profile update: %w", err)
	}
	return row, nil
}

// MarkPendingDelete flips a synced/dirty row to pending_delete — it stops
// appearing in ListByMachine immediately (offline delete "just works" from
// the user's point of view) without losing the row until the real delete
// on the machine actually succeeds.
func (r *ProfilesRepository) MarkPendingDelete(machineID int64, id string) error {
	row, err := r.Get(machineID, id)
	if err != nil {
		return err
	}
	if row == nil {
		return nil
	}
	if row.SyncStatus == ProfileSyncPendingCreate && row.RemoteID == nil {
		// Never made it to the machine in the first place — nothing to
		// delete remotely, just drop the local row outright.
		return r.HardDelete(row.LocalID)
	}
	_, err = r.db.Exec(`UPDATE machine_profiles SET sync_status = ?, last_sync_error = NULL, updated_at = ? WHERE local_id = ?`,
		ProfileSyncPendingDelete, time.Now().UnixMilli(), row.LocalID)
	if err != nil {
		return fmt.Errorf("machines: marking local profile %d pending_delete: %w", row.LocalID, err)
	}
	return nil
}

// ReplaceRemoteID is called once a pending_create row's first push
// succeeds: the machine's real assigned id becomes authoritative and the
// row moves to synced.
func (r *ProfilesRepository) ReplaceRemoteID(localID int64, remoteID, name string) error {
	_, err := r.db.Exec(`UPDATE machine_profiles SET remote_id = ?, name = ?, sync_status = ?, last_sync_error = NULL, updated_at = ?
		WHERE local_id = ?`, remoteID, name, ProfileSyncSynced, time.Now().UnixMilli(), localID)
	if err != nil {
		return fmt.Errorf("machines: assigning remote id to local profile %d: %w", localID, err)
	}
	return nil
}

func (r *ProfilesRepository) MarkSynced(localID int64) error {
	_, err := r.db.Exec(`UPDATE machine_profiles SET sync_status = ?, last_sync_error = NULL, updated_at = ? WHERE local_id = ?`,
		ProfileSyncSynced, time.Now().UnixMilli(), localID)
	if err != nil {
		return fmt.Errorf("machines: marking local profile %d synced: %w", localID, err)
	}
	return nil
}

func (r *ProfilesRepository) MarkSyncError(localID int64, errMsg string) error {
	_, err := r.db.Exec(`UPDATE machine_profiles SET last_sync_error = ?, updated_at = ? WHERE local_id = ?`,
		errMsg, time.Now().UnixMilli(), localID)
	if err != nil {
		return fmt.Errorf("machines: recording sync error for local profile %d: %w", localID, err)
	}
	return nil
}

func (r *ProfilesRepository) HardDelete(localID int64) error {
	if _, err := r.db.Exec(`DELETE FROM machine_profiles WHERE local_id = ?`, localID); err != nil {
		return fmt.Errorf("machines: deleting local profile %d: %w", localID, err)
	}
	return nil
}

// PruneStaleSynced deletes every `synced` row for machineID whose remote_id
// is not present in currentRemoteIDs — a profile deleted directly on the
// machine (outside GLP) otherwise leaves a stale local row lingering
// forever. Only `synced` rows are ever pruned: dirty/pending_* rows
// represent local edits not yet reconciled and must survive regardless of
// whether the machine currently reports them.
func (r *ProfilesRepository) PruneStaleSynced(machineID int64, currentRemoteIDs []string) error {
	current := make(map[string]bool, len(currentRemoteIDs))
	for _, id := range currentRemoteIDs {
		current[id] = true
	}
	rows, err := r.db.Query(`SELECT local_id, remote_id FROM machine_profiles
		WHERE machine_id = ? AND sync_status = ? AND remote_id IS NOT NULL`, machineID, ProfileSyncSynced)
	if err != nil {
		return fmt.Errorf("machines: listing synced profiles for pruning: %w", err)
	}
	var toDelete []int64
	for rows.Next() {
		var localID int64
		var remoteID string
		if err := rows.Scan(&localID, &remoteID); err != nil {
			rows.Close()
			return fmt.Errorf("machines: scanning synced profile for pruning: %w", err)
		}
		if !current[remoteID] {
			toDelete = append(toDelete, localID)
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return fmt.Errorf("machines: iterating synced profiles for pruning: %w", err)
	}
	rows.Close()
	for _, localID := range toDelete {
		if err := r.HardDelete(localID); err != nil {
			return err
		}
	}
	return nil
}

// DirtyRows returns every row for machineID still waiting on a push —
// PushDirtyProfiles' (internal/system/profile_sync.go) work queue.
func (r *ProfilesRepository) DirtyRows(machineID int64) ([]ProfileRow, error) {
	rows, err := r.db.Query(`SELECT `+profileColumns+` FROM machine_profiles
		WHERE machine_id = ? AND sync_status != ? ORDER BY updated_at`, machineID, ProfileSyncSynced)
	if err != nil {
		return nil, fmt.Errorf("machines: listing dirty profiles: %w", err)
	}
	defer rows.Close()
	var out []ProfileRow
	for rows.Next() {
		row, err := scanProfileRow(rows.Scan)
		if err != nil {
			return nil, fmt.Errorf("machines: scanning dirty profile: %w", err)
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

// AnyDirtyMachineIDs powers the periodic cross-machine sweep (profile_sync.go)
// — every machine that currently has at least one row not yet synced.
func (r *ProfilesRepository) AnyDirtyMachineIDs() ([]int64, error) {
	rows, err := r.db.Query(`SELECT DISTINCT machine_id FROM machine_profiles WHERE sync_status != ?`, ProfileSyncSynced)
	if err != nil {
		return nil, fmt.Errorf("machines: listing machines with dirty profiles: %w", err)
	}
	defer rows.Close()
	var out []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("machines: scanning dirty machine id: %w", err)
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

func (r *ProfilesRepository) getByLocalID(localID int64, machineID int64) (*ProfileRow, error) {
	row, err := scanProfileRow(r.db.QueryRow(`SELECT `+profileColumns+` FROM machine_profiles WHERE local_id = ? AND machine_id = ?`, localID, machineID).Scan)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("machines: getting local profile %d: %w", localID, err)
	}
	return &row, nil
}

// parseLocalPlaceholder recognizes handlers_profiles.go's "local:<n>" id
// scheme — the only place a caller ever needs to tell a real remote id
// apart from a not-yet-synced local one.
func parseLocalPlaceholder(id string) (int64, bool) {
	const prefix = "local:"
	if len(id) <= len(prefix) || id[:len(prefix)] != prefix {
		return 0, false
	}
	n, err := strconv.ParseInt(id[len(prefix):], 10, 64)
	if err != nil {
		return 0, false
	}
	return n, true
}
