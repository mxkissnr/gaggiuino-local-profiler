package machinebackups

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"sort"
	"strconv"
	"time"
)

// This file carries the machine settings backups and their per-machine
// schedule in and out of GLP's own backup bundle (#1878). Export hands over
// the stored, already secret-free documents; restore re-validates every one of
// them and refuses a document that stripping would change, because GLP never
// exports a secret. Backups of machines deleted from the registry travel too
// (maintainer decision 4).

const (
	// maxBundleEntries bounds a restored machine_backups list; each document
	// is capped at 256 KiB by parseDocument and the bundle by internal/backup's
	// body and zip-entry limits.
	maxBundleEntries = 5000
	// maxBundleClockSkew lets a bundle from an install whose clock runs a little
	// ahead restore; a later time is not a real backup time.
	maxBundleClockSkew = 24 * time.Hour
)

// BundleEntry is one machine backup in GLP's own backup bundle (#1878).
type BundleEntry struct {
	MachineID int64           `json:"machineId"`
	CreatedAt int64           `json:"createdAt"` // Unix ms, like the API
	Kind      string          `json:"kind"`
	Note      string          `json:"note"`
	Document  json.RawMessage `json:"document"`
}

// ExportBundle reads every stored backup, oldest first, for the bundle. The
// derived columns (firmware, profile count, size, hash) and the row id are left
// out: restore recomputes them from the document.
func ExportBundle(db *sql.DB) ([]BundleEntry, error) {
	rows, err := db.Query(`SELECT machine_id, created_at, kind, note, data
		FROM machine_backups ORDER BY created_at, id`)
	if err != nil {
		return nil, fmt.Errorf("machinebackups: exporting machine backups: %w", err)
	}
	defer rows.Close()
	out := []BundleEntry{}
	for rows.Next() {
		var (
			e        BundleEntry
			created  int64
			document string
		)
		if err := rows.Scan(&e.MachineID, &created, &e.Kind, &e.Note, &document); err != nil {
			return nil, fmt.Errorf("machinebackups: exporting machine backups: %w", err)
		}
		e.CreatedAt = created * 1000
		e.Document = json.RawMessage(document)
		out = append(out, e)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("machinebackups: exporting machine backups: %w", err)
	}
	return out, nil
}

// ExportSettings reads the per-machine schedule row for the bundle's kv block.
func ExportSettings(db *sql.DB) (map[int64]Settings, error) {
	all, err := NewRepository(db).allSettings()
	if err != nil {
		return nil, err
	}
	return map[int64]Settings(all), nil
}

// RestoreBundle replaces the stored backups with the bundle's entries. It
// returns how many were restored and how many were skipped. Unusable input
// (not a list, too long, or nothing valid in a non-empty list) leaves the
// stored backups untouched rather than destroying them.
func RestoreBundle(db *sql.DB, raw json.RawMessage, now time.Time) (restored, skipped int, err error) {
	var items []json.RawMessage
	if err := json.Unmarshal(raw, &items); err != nil || items == nil {
		log.Printf("machinebackups: restore: machine_backups is not a list, stored backups left untouched")
		return 0, 0, nil
	}
	if len(items) > maxBundleEntries {
		log.Printf("machinebackups: restore: %d machine backups is more than %d, stored backups left untouched",
			len(items), maxBundleEntries)
		return 0, len(items), nil
	}

	maxCreated := now.Add(maxBundleClockSkew).UnixMilli()
	type accepted struct {
		machineID int64
		createdAt int64
		kind      string
		note      string
		p         prepared
	}
	valid := make([]accepted, 0, len(items))
	for _, item := range items {
		var e BundleEntry
		if err := json.Unmarshal(item, &e); err != nil {
			skipped++
			continue
		}
		if e.MachineID < 1 || e.CreatedAt < 1000 || e.CreatedAt > maxCreated || !validKind(e.Kind) {
			skipped++
			continue
		}
		p, ok := bundleDocument(e.Document)
		if !ok {
			skipped++
			continue
		}
		valid = append(valid, accepted{
			machineID: e.MachineID,
			createdAt: e.CreatedAt / 1000,
			kind:      e.Kind,
			note:      cleanNote(e.Note),
			p:         p,
		})
	}
	if len(items) > 0 && len(valid) == 0 {
		log.Printf("machinebackups: restore: no usable machine backup in the bundle (%d skipped), stored backups left untouched", skipped)
		return 0, skipped, nil
	}
	sort.SliceStable(valid, func(i, j int) bool { return valid[i].createdAt < valid[j].createdAt })

	tx, err := db.Begin()
	if err != nil {
		return 0, skipped, fmt.Errorf("machinebackups: restoring machine backups: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.Exec(`DELETE FROM machine_backups`); err != nil {
		return 0, skipped, fmt.Errorf("machinebackups: restoring machine backups: %w", err)
	}
	stmt, err := tx.Prepare(`INSERT INTO machine_backups (
		machine_id, created_at, kind, firmware_core, firmware_frontend,
		profile_count, size_bytes, content_hash, note, data
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
	if err != nil {
		return 0, skipped, fmt.Errorf("machinebackups: restoring machine backups: %w", err)
	}
	defer stmt.Close()
	for _, v := range valid {
		if _, err := stmt.Exec(v.machineID, v.createdAt, v.kind, v.p.FirmwareCore, v.p.FirmwareFrontend,
			v.p.ProfileCount, len(v.p.Data), v.p.Hash, v.note, string(v.p.Data)); err != nil {
			return 0, skipped, fmt.Errorf("machinebackups: restoring machine backups: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return 0, skipped, fmt.Errorf("machinebackups: restoring machine backups: %w", err)
	}

	restored = len(valid)
	log.Printf("machinebackups: restored %d machine backups from the GLP backup (%d skipped)", restored, skipped)
	return restored, skipped, nil
}

// RestoreSettings replaces the schedule row with the bundle's valid entries.
// keep reports whether a machine id is in the restored registry as a Gaggiuino
// machine; any other entry is dropped. A missing, null or non-object value
// leaves the stored row untouched.
func RestoreSettings(db *sql.DB, raw any, keep func(machineID int64) bool) error {
	obj, ok := raw.(map[string]any)
	if !ok {
		return nil
	}
	all := settingsByMachine{}
	for key, value := range obj {
		id, err := strconv.ParseInt(key, 10, 64)
		if err != nil || id < 1 || !keep(id) {
			continue
		}
		encoded, err := json.Marshal(value)
		if err != nil {
			continue
		}
		var s Settings
		if err := json.Unmarshal(encoded, &s); err != nil || !s.valid() {
			continue
		}
		all[id] = s
	}
	return writeSettings(db, all)
}

// writeSettings replaces the one kv row. This is a fresh Repository, so the
// Repository's settingsMu does not apply: a settings PUT racing a GLP restore
// can lose one write. Accepted, because a restore is a rare explicit action and
// the wiring slice leaves main.go untouched.
func writeSettings(db *sql.DB, all settingsByMachine) error {
	b, err := json.Marshal(all)
	if err != nil {
		return fmt.Errorf("machinebackups: restoring backup settings: %w", err)
	}
	if _, err := db.Exec(`INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)`, settingsKVKey, string(b)); err != nil {
		return fmt.Errorf("machinebackups: restoring backup settings: %w", err)
	}
	return nil
}

// bundleDocument re-validates a bundled document and recomputes its derived
// columns. GLP only ever exports secret-free documents, so one that stripping
// would change was edited by hand and is refused instead of stored stripped.
func bundleDocument(raw json.RawMessage) (prepared, bool) {
	doc, err := parseDocument(raw)
	if err != nil {
		return prepared{}, false
	}
	asIs, err := encodeCanonical(doc)
	if err != nil {
		return prepared{}, false
	}
	p, err := prepare(raw)
	if err != nil {
		return prepared{}, false
	}
	if !bytes.Equal(asIs, p.Data) {
		return prepared{}, false
	}
	return p, true
}

func validKind(kind string) bool {
	switch kind {
	case KindManual, KindScheduled, KindPreUpdate, KindUploaded:
		return true
	}
	return false
}
