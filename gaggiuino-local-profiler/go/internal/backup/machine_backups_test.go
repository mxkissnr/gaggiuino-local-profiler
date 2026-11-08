package backup

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines"
)

// canonicalMachineDoc is already canonical: compact, keys sorted, no HTML
// escaping, number literals as the machine sends them. If an equality check
// fails only on `data`, this seed is wrong, not the code.
const canonicalMachineDoc = `{"defaultProfileId":3,"firmware":{"core":"8aaf6f0","frontend":"8aaf6f0"},"format":"gaggiuino-settings","profiles":[{"id":3,"name":"Bloom <b>&co","phases":[{"target":9.0,"type":"brew"}]}],"settings":{"boiler":{"offset":93.50,"steamSetPoint":145},"system":{"mqttHost":"broker.local"}},"version":1}`

// fixedBackupTime is Thursday 2026-10-01 08:00 UTC — in the past for every run.
func fixedBackupTime() int64 {
	return time.Date(2026, 10, 1, 8, 0, 0, 0, time.UTC).Unix()
}

func seedMachineBackup(t *testing.T, sqlDB *sql.DB, machineID, createdAtSec int64, kind, note string) {
	t.Helper()
	if _, err := sqlDB.Exec(`INSERT INTO machine_backups (
		machine_id, created_at, kind, firmware_core, firmware_frontend,
		profile_count, size_bytes, content_hash, note, data
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		machineID, createdAtSec, kind, "8aaf6f0", "8aaf6f0", 1, len(canonicalMachineDoc),
		docHash(), note, canonicalMachineDoc); err != nil {
		t.Fatalf("seeding machine backup: %v", err)
	}
}

func docHash() string {
	sum := sha256.Sum256([]byte(canonicalMachineDoc))
	return hex.EncodeToString(sum[:])
}

func expectedRow(machineID, createdAtSec int64, kind, note string) string {
	return strings.Join([]string{
		strconv.FormatInt(machineID, 10), strconv.FormatInt(createdAtSec, 10), kind,
		"8aaf6f0", "8aaf6f0", "1", strconv.Itoa(len(canonicalMachineDoc)), docHash(), note,
		canonicalMachineDoc,
	}, "|")
}

func machineBackupRows(t *testing.T, sqlDB *sql.DB) []string {
	t.Helper()
	rows, err := sqlDB.Query(`SELECT machine_id, created_at, kind, firmware_core, firmware_frontend,
		profile_count, size_bytes, content_hash, note, data
		FROM machine_backups ORDER BY created_at, id`)
	if err != nil {
		t.Fatalf("reading machine backups: %v", err)
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var machineID, createdAt, profileCount, sizeBytes int64
		var kind, core, frontend, hash, note, data string
		if err := rows.Scan(&machineID, &createdAt, &kind, &core, &frontend, &profileCount,
			&sizeBytes, &hash, &note, &data); err != nil {
			t.Fatalf("scanning machine backup: %v", err)
		}
		out = append(out, strings.Join([]string{
			strconv.FormatInt(machineID, 10), strconv.FormatInt(createdAt, 10), kind, core, frontend,
			strconv.FormatInt(profileCount, 10), strconv.FormatInt(sizeBytes, 10), hash, note, data,
		}, "|"))
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("reading machine backups: %v", err)
	}
	return out
}

func backupSettingsValue(t *testing.T, sqlDB *sql.DB) string {
	t.Helper()
	var value string
	err := sqlDB.QueryRow(`SELECT value FROM kv WHERE key = 'machine_backup_settings'`).Scan(&value)
	if err == sql.ErrNoRows {
		return ""
	}
	if err != nil {
		t.Fatalf("reading backup settings: %v", err)
	}
	return value
}

func setBackupSettings(t *testing.T, sqlDB *sql.DB, value string) {
	t.Helper()
	if _, err := sqlDB.Exec(`INSERT OR REPLACE INTO kv (key, value) VALUES ('machine_backup_settings', ?)`, value); err != nil {
		t.Fatalf("writing backup settings: %v", err)
	}
}

func createTestMachine(t *testing.T, deps Dependencies, name, typ, host string) int64 {
	t.Helper()
	m, err := deps.Registry.CreateMachine(machines.MachineInput{Name: &name, Type: &typ, Host: &host})
	if err != nil {
		t.Fatalf("creating machine %q: %v", name, err)
	}
	return m.ID
}

func captureLog(t *testing.T) *bytes.Buffer {
	t.Helper()
	buf := &bytes.Buffer{}
	prev := log.Writer()
	log.SetOutput(buf)
	t.Cleanup(func() { log.SetOutput(prev) })
	return buf
}

func exportBundle(t *testing.T, mux *http.ServeMux) []byte {
	t.Helper()
	rec := doJSON(t, mux, http.MethodGet, "/api/backup", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("export status = %d; body=%s", rec.Code, rec.Body.String())
	}
	return append([]byte(nil), rec.Body.Bytes()...)
}

func restoreBundle(t *testing.T, mux *http.ServeMux, body []byte) {
	t.Helper()
	rec := doJSON(t, mux, http.MethodPost, "/api/restore", body)
	if rec.Code != http.StatusOK {
		t.Fatalf("restore status = %d; body=%s", rec.Code, rec.Body.String())
	}
}

func TestMachineBackups_RoundTripIntoFreshInstall(t *testing.T) {
	useImageDir(t)
	t0 := fixedBackupTime()

	h1, deps1, sqlDB1 := newTestHandlers(t)
	mux1 := newMux(h1)
	id1 := createTestMachine(t, deps1, "Gaggia", "gaggiuino", "gaggia.local")
	seedMachineBackup(t, sqlDB1, id1, t0, "scheduled", "")
	seedMachineBackup(t, sqlDB1, id1, t0+3600, "manual", "before descale <&>")
	seedMachineBackup(t, sqlDB1, 99, t0+5400, "uploaded", "deleted machine")
	seedMachineBackup(t, sqlDB1, id1, t0+7200, "pre_update", "")
	setBackupSettings(t, sqlDB1, fmt.Sprintf(
		`{"%d":{"schedule":"weekly","keepAutomatic":20},"99":{"schedule":"off","keepAutomatic":5}}`, id1))

	raw := exportBundle(t, mux1)
	if bytes.Contains(raw, []byte("SECRET-")) {
		t.Errorf("exported bundle contains a secret")
	}
	bundle := decodeBody(t, raw)
	entries, ok := bundle["machine_backups"].([]any)
	if !ok || len(entries) != 4 {
		t.Fatalf("machine_backups = %#v, want 4 entries", bundle["machine_backups"])
	}
	first, ok := entries[0].(map[string]any)
	if !ok {
		t.Fatalf("first machine_backups entry = %#v", entries[0])
	}
	if len(first) != 5 {
		t.Errorf("first entry keys = %v, want exactly machineId, createdAt, kind, note, document", first)
	}
	for _, key := range []string{"machineId", "createdAt", "kind", "note", "document"} {
		if _, ok := first[key]; !ok {
			t.Errorf("first entry is missing %q: %v", key, first)
		}
	}
	if got, want := first["createdAt"], float64(t0*1000); got != want {
		t.Errorf("first entry createdAt = %v, want %v", got, want)
	}
	for i, entry := range entries {
		m, _ := entry.(map[string]any)
		doc, _ := m["document"].(map[string]any)
		if _, hasWifi := doc["wifi"]; hasWifi {
			t.Errorf("entry %d: document carries a wifi block", i)
		}
	}
	kv, _ := bundle["kv"].(map[string]any)
	settings, ok := kv["machine_backup_settings"].(map[string]any)
	if !ok {
		t.Fatalf("kv.machine_backup_settings = %#v", kv["machine_backup_settings"])
	}
	for _, key := range []string{strconv.FormatInt(id1, 10), "99"} {
		if _, ok := settings[key]; !ok {
			t.Errorf("kv.machine_backup_settings is missing %q: %v", key, settings)
		}
	}

	h2, _, sqlDB2 := newTestHandlersInDir(t)
	restoreBundle(t, newMux(h2), raw)

	got, want := strings.Join(machineBackupRows(t, sqlDB2), "\n"), strings.Join(machineBackupRows(t, sqlDB1), "\n")
	if got != want {
		t.Errorf("restored machine backups differ from the source\ngot:  %s\nwant: %s", got, want)
	}
	if got, want := backupSettingsValue(t, sqlDB2), fmt.Sprintf(
		`{"%d":{"schedule":"weekly","keepAutomatic":20}}`, id1); got != want {
		t.Errorf("restored backup settings = %s, want %s", got, want)
	}
}

func TestMachineBackups_FollowTheMachinesSection(t *testing.T) {
	useImageDir(t)
	h, deps, sqlDB := newTestHandlers(t)
	mux := newMux(h)
	id := createTestMachine(t, deps, "Gaggia", "gaggiuino", "gaggia.local")
	seedMachineBackup(t, sqlDB, id, fixedBackupTime(), "manual", "")
	setBackupSettings(t, sqlDB, fmt.Sprintf(`{"%d":{"schedule":"off","keepAutomatic":2}}`, id))

	rec := doJSON(t, mux, http.MethodPost, "/api/backup", mustMarshal(t, map[string]any{"sections": []string{"machines"}}))
	if rec.Code != http.StatusOK {
		t.Fatalf("scoped export status = %d; body=%s", rec.Code, rec.Body.String())
	}
	zr, err := zip.NewReader(bytes.NewReader(rec.Body.Bytes()), int64(rec.Body.Len()))
	if err != nil {
		t.Fatalf("zip.NewReader: %v", err)
	}
	b := readBackupJSON(t, zr)
	entries, _ := b["machine_backups"].([]any)
	if len(entries) != 1 {
		t.Errorf("machines section export has %d machine_backups, want 1", len(entries))
	}
	if _, ok := b["kv"]; ok {
		t.Errorf("machines section export carries kv")
	}

	rec = doJSON(t, mux, http.MethodPost, "/api/backup", mustMarshal(t, map[string]any{"sections": []string{"settings"}}))
	if rec.Code != http.StatusOK {
		t.Fatalf("settings export status = %d; body=%s", rec.Code, rec.Body.String())
	}
	zr, err = zip.NewReader(bytes.NewReader(rec.Body.Bytes()), int64(rec.Body.Len()))
	if err != nil {
		t.Fatalf("zip.NewReader: %v", err)
	}
	b = readBackupJSON(t, zr)
	if _, ok := b["machine_backups"]; ok {
		t.Errorf("settings section export carries machine_backups")
	}
	kv, _ := b["kv"].(map[string]any)
	if _, ok := kv["machine_backup_settings"]; !ok {
		t.Errorf("settings section export is missing kv.machine_backup_settings")
	}
}

func TestMachineBackups_RestoreRefusesCraftedEntries(t *testing.T) {
	useImageDir(t)
	t0 := fixedBackupTime()
	ms := t0 * 1000

	h1, deps1, sqlDB1 := newTestHandlers(t)
	mux1 := newMux(h1)
	id1 := createTestMachine(t, deps1, "a", "gaggiuino", "a.local")
	id2 := createTestMachine(t, deps1, "b", "gaggimate", "b.local")
	id3 := createTestMachine(t, deps1, "c", "gaggiuino", "c.local")
	seedMachineBackup(t, sqlDB1, id1, t0, "manual", "")
	bundle := decodeBody(t, exportBundle(t, mux1))

	entry := func(machineID any, createdAt any, kind any, note string, document string) map[string]any {
		return map[string]any{
			"machineId": machineID, "createdAt": createdAt, "kind": kind, "note": note,
			"document": json.RawMessage(document),
		}
	}
	v1 := entry(id1, ms, "manual", "ok", canonicalMachineDoc)
	v1["contentHash"] = "forged"
	v1["sizeBytes"] = 1
	bundle["machine_backups"] = []any{
		v1,
		entry(77, ms+1000, "uploaded", "a\u0007b"+strings.Repeat("n", 250), canonicalMachineDoc),
		entry(id1, ms, "manual", "", `{"format":"gaggiuino-settings","version":1,"wifi":{"ssid":"SECRET-ssid-x","password":"SECRET-wifi-x"}}`),
		entry(id1, ms, "manual", "", `{"format":"gaggiuino-settings","version":1,"settings":{"system":{"mqttPassword":"SECRET-mqtt-x"}}}`),
		entry(id1, ms, "manual", "", `{"format":"other","version":1}`),
		entry(id1, ms, "manual", "", `{"format":"gaggiuino-settings","version":2}`),
		entry(id1, ms, "manual", "", `{"format":"gaggiuino-settings","version":1,"pad":"`+strings.Repeat("x", 262145)+`"}`),
		entry(id1, ms, "manual", "", `"x"`),
		entry(id1, ms, "hacked", "", canonicalMachineDoc),
		entry(0, ms, "manual", "", canonicalMachineDoc),
		entry("1", ms, "manual", "", canonicalMachineDoc),
		entry(id1, 0, "manual", "", canonicalMachineDoc),
		entry(id1, time.Now().Add(48*time.Hour).UnixMilli(), "manual", "", canonicalMachineDoc),
		entry(id1, float64(1.5), "manual", "", canonicalMachineDoc),
	}
	kv, _ := bundle["kv"].(map[string]any)
	kv["machine_backup_settings"] = json.RawMessage(fmt.Sprintf(
		`{"%d":{"schedule":"daily","keepAutomatic":3},"%d":{"schedule":"weekly","keepAutomatic":5},`+
			`"%d":{"schedule":"hourly","keepAutomatic":10},"77":{"schedule":"weekly","keepAutomatic":5},`+
			`"abc":{"schedule":"daily","keepAutomatic":10},"0":{"schedule":"daily","keepAutomatic":10}}`,
		id1, id2, id3))

	h2, _, sqlDB2 := newTestHandlersInDir(t)
	logs := captureLog(t)
	restoreBundle(t, newMux(h2), mustMarshal(t, bundle))

	want := []string{
		expectedRow(id1, t0, "manual", "ok"),
		expectedRow(77, t0+1, "uploaded", "ab"+strings.Repeat("n", 198)),
	}
	if got := machineBackupRows(t, sqlDB2); strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Errorf("restored rows\ngot:  %v\nwant: %v", got, want)
	}
	for _, row := range machineBackupRows(t, sqlDB2) {
		if strings.Contains(row, "SECRET-") {
			t.Errorf("stored row carries a secret: %s", row)
		}
	}
	if got, wantSettings := backupSettingsValue(t, sqlDB2),
		fmt.Sprintf(`{"%d":{"schedule":"daily","keepAutomatic":3}}`, id1); got != wantSettings {
		t.Errorf("restored backup settings = %s, want %s", got, wantSettings)
	}
	if !strings.Contains(logs.String(), "restored 2 machine backups from the GLP backup (12 skipped)") {
		t.Errorf("restore log = %q", logs.String())
	}
	if strings.Contains(logs.String(), "SECRET-") {
		t.Errorf("restore log carries a secret: %q", logs.String())
	}
}

func TestMachineBackups_RestoreSkipsUnusableData(t *testing.T) {
	useImageDir(t)
	t0 := fixedBackupTime()

	h1, deps1, sqlDB1 := newTestHandlers(t)
	id1 := createTestMachine(t, deps1, "Gaggia", "gaggiuino", "gaggia.local")
	seedMachineBackup(t, sqlDB1, id1, t0, "manual", "")
	setBackupSettings(t, sqlDB1, fmt.Sprintf(`{"%d":{"schedule":"daily","keepAutomatic":4}}`, id1))
	raw := exportBundle(t, newMux(h1))

	tooMany := make([]any, 5001)
	for i := range tooMany {
		tooMany[i] = map[string]any{}
	}

	cases := []struct {
		name   string
		mutate func(b map[string]any)
		empty  bool
		// keepsSettings marks the one case that supplies a (bad) settings value.
		keepsSettings bool
	}{
		{name: "key absent", mutate: func(b map[string]any) { delete(b, "machine_backups") }},
		{name: "not a list", mutate: func(b map[string]any) { b["machine_backups"] = map[string]any{"x": 1} }},
		{name: "too many entries", mutate: func(b map[string]any) { b["machine_backups"] = tooMany }},
		{name: "no usable entry", mutate: func(b map[string]any) {
			b["machine_backups"] = []any{map[string]any{"kind": "x"}}
		}},
		{name: "section not selected", mutate: func(b map[string]any) { b["sections"] = []string{"orders"} }},
		{name: "empty list", mutate: func(b map[string]any) { b["machine_backups"] = []any{} }, empty: true},
		{name: "bad settings value", keepsSettings: true, mutate: func(b map[string]any) {
			delete(b, "machine_backups")
			kv, _ := b["kv"].(map[string]any)
			kv["machine_backup_settings"] = "x"
		}},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			h2, deps2, sqlDB2 := newTestHandlersInDir(t)
			id2 := createTestMachine(t, deps2, "Gaggia", "gaggiuino", "gaggia.local")
			seedMachineBackup(t, sqlDB2, id2, t0, "scheduled", "")
			seedMachineBackup(t, sqlDB2, id2, t0+60, "manual", "")
			setBackupSettings(t, sqlDB2, fmt.Sprintf(`{"%d":{"schedule":"off","keepAutomatic":7}}`, id2))
			beforeRows := machineBackupRows(t, sqlDB2)
			beforeSettings := backupSettingsValue(t, sqlDB2)

			b := decodeBody(t, raw)
			kv, _ := b["kv"].(map[string]any)
			if !c.keepsSettings {
				delete(kv, "machine_backup_settings")
			}
			c.mutate(b)

			restoreBundle(t, newMux(h2), mustMarshal(t, b))

			wantRows := beforeRows
			if c.empty {
				wantRows = []string{}
			}
			if got := machineBackupRows(t, sqlDB2); strings.Join(got, "\n") != strings.Join(wantRows, "\n") {
				t.Errorf("rows after restore\ngot:  %v\nwant: %v", got, wantRows)
			}
			if got := backupSettingsValue(t, sqlDB2); got != beforeSettings {
				t.Errorf("backup settings after restore = %s, want %s", got, beforeSettings)
			}
		})
	}
}

func TestMachineBackups_LegacyBackupLeavesThemAlone(t *testing.T) {
	useImageDir(t)
	t0 := fixedBackupTime()

	h, deps, sqlDB := newTestHandlersInDir(t)
	mux := newMux(h)
	id := createTestMachine(t, deps, "Gaggia", "gaggiuino", "gaggia.local")
	seedMachineBackup(t, sqlDB, id, t0, "scheduled", "")
	seedMachineBackup(t, sqlDB, id, t0+60, "manual", "kept")
	setBackupSettings(t, sqlDB, fmt.Sprintf(`{"%d":{"schedule":"weekly","keepAutomatic":6}}`, id))
	beforeRows := machineBackupRows(t, sqlDB)
	beforeSettings := backupSettingsValue(t, sqlDB)

	zipBytes, err := os.ReadFile(filepath.Join("testdata", "legacy-backup.zip"))
	if err != nil {
		t.Fatalf("reading legacy fixture: %v", err)
	}
	rec := doZip(t, mux, "/api/restore", zipBytes, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("legacy restore status = %d; body=%s", rec.Code, rec.Body.String())
	}
	if got := machineBackupRows(t, sqlDB); strings.Join(got, "\n") != strings.Join(beforeRows, "\n") {
		t.Errorf("legacy restore changed the machine backups\ngot:  %v\nwant: %v", got, beforeRows)
	}
	if got := backupSettingsValue(t, sqlDB); got != beforeSettings {
		t.Errorf("legacy restore changed the backup settings: got %s, want %s", got, beforeSettings)
	}
}
