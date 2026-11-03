package machinebackups

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/db"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines"
)

const fixtureDoc = `{
  "format": "gaggiuino-settings",
  "version": 1,
  "firmware": {"core": "8aaf6f0", "frontend": "8aaf6f0"},
  "defaultProfileId": 3,
  "profiles": [
    {"id": 3, "name": "Bloom <b>&co", "phases": [{"type": "brew", "target": 9.0}, {"type": "infusion", "target": 3.5}]},
    {"id": 5, "name": "Simple", "phases": [{"type": "brew", "target": 9.0}]}
  ],
  "pumpCalibration": {"bands": [0, 50, 100], "lut": [1.0, 1.1, 1.2], "lutValid": true},
  "settings": {
    "boiler": {"brewDeltaState": "true", "steamSetPoint": 145, "offset": 93.50},
    "system": {"mqttHost": "broker.local", "releaseChannel": 1, "mqttUsername": "SECRET-mqtt-user-4d1", "mqttPassword": "SECRET-mqtt-pass-9c2", "visualizerToken": "SECRET-vis-7e3", "sprofilerToken": "SECRET-spro-1a8"},
    "display": {}
  },
  "wifi": {"ssid": "SECRET-ssid-5b6", "password": "SECRET-wifi-pass-2f0"}
}`

// fixtureDocReordered carries the same content as fixtureDoc with different
// secret values, different key order and different formatting.
const fixtureDocReordered = `{"wifi":{"password":"SECRET-wifi-pass-zzz","ssid":"SECRET-ssid-zzz"},"settings":{"display":{},"system":{"sprofilerToken":"SECRET-spro-zzz","visualizerToken":"SECRET-vis-zzz","mqttPassword":"SECRET-mqtt-pass-zzz","mqttUsername":"SECRET-mqtt-user-zzz","releaseChannel":1,"mqttHost":"broker.local"},"boiler":{"offset":93.50,"steamSetPoint":145,"brewDeltaState":"true"}},"pumpCalibration":{"lutValid":true,"lut":[1.0,1.1,1.2],"bands":[0,50,100]},"profiles":[{"phases":[{"target":9.0,"type":"brew"},{"target":3.5,"type":"infusion"}],"name":"Bloom <b>&co","id":3},{"phases":[{"target":9.0,"type":"brew"}],"name":"Simple","id":5}],"defaultProfileId":3,"firmware":{"frontend":"8aaf6f0","core":"8aaf6f0"},"version":1,"format":"gaggiuino-settings"}`

func secretValues() []string {
	return []string{
		"SECRET-mqtt-user-4d1", "SECRET-mqtt-pass-9c2", "SECRET-vis-7e3",
		"SECRET-spro-1a8", "SECRET-ssid-5b6", "SECRET-wifi-pass-2f0",
	}
}

func assertNoSecrets(t *testing.T, label string, b []byte) {
	t.Helper()
	for _, secret := range secretValues() {
		if bytes.Contains(b, []byte(secret)) {
			t.Errorf("%s contains secret %q", label, secret)
		}
	}
}

func TestSecretPathsList(t *testing.T) {
	want := [][]string{
		{"wifi"},
		{"settings", "system", "mqttUsername"},
		{"settings", "system", "mqttPassword"},
		{"settings", "system", "visualizerToken"},
		{"settings", "system", "sprofilerToken"},
	}
	if !reflect.DeepEqual(secretPaths, want) {
		t.Fatalf("secretPaths = %v, want %v", secretPaths, want)
	}
}

func TestPrepare_StripsEverySecretAndKeepsTheRest(t *testing.T) {
	p, err := prepare([]byte(fixtureDoc))
	if err != nil {
		t.Fatalf("prepare: %v", err)
	}
	assertNoSecrets(t, "prepared data", p.Data)
	for _, key := range []string{`"wifi"`, `"ssid"`, `"password"`, `"mqttUsername"`, `"mqttPassword"`, `"visualizerToken"`, `"sprofilerToken"`} {
		if bytes.Contains(p.Data, []byte(key)) {
			t.Errorf("prepared data still has key %s: %s", key, p.Data)
		}
	}
	for _, keep := range []string{`"mqttHost"`, `"releaseChannel"`, `"pumpCalibration"`, `"Bloom <b>&co"`, `"brewDeltaState":"true"`, `93.50`} {
		if !bytes.Contains(p.Data, []byte(keep)) {
			t.Errorf("prepared data lost %s: %s", keep, p.Data)
		}
	}
	if p.ProfileCount != 2 || p.FirmwareCore != "8aaf6f0" || p.FirmwareFrontend != "8aaf6f0" {
		t.Fatalf("prepared metadata = %+v", p)
	}

	// The whole wifi block is a secret: an extra field inside it must not keep
	// the block (or the field) in the stored document.
	withHostname := strings.Replace(fixtureDoc,
		`"password": "SECRET-wifi-pass-2f0"`,
		`"password": "SECRET-wifi-pass-2f0", "hostname": "glp"`, 1)
	p, err = prepare([]byte(withHostname))
	if err != nil {
		t.Fatalf("prepare with an extra wifi field: %v", err)
	}
	for _, key := range []string{`"wifi"`, `"hostname"`} {
		if bytes.Contains(p.Data, []byte(key)) {
			t.Errorf("prepared data still has %s: %s", key, p.Data)
		}
	}
}

// mutatedDoc applies mutate to the fixture and returns the re-encoded document.
func mutatedDoc(t *testing.T, mutate func(map[string]any)) []byte {
	t.Helper()
	dec := json.NewDecoder(strings.NewReader(fixtureDoc))
	dec.UseNumber()
	var doc map[string]any
	if err := dec.Decode(&doc); err != nil {
		t.Fatalf("decoding fixture: %v", err)
	}
	mutate(doc)
	out, err := json.Marshal(doc)
	if err != nil {
		t.Fatalf("encoding mutated fixture: %v", err)
	}
	return out
}

func TestPrepare_RejectsInvalidDocuments(t *testing.T) {
	pad := func(n int) []byte {
		out := []byte(fixtureDoc)
		return append(out, bytes.Repeat([]byte(" "), n-len(out))...)
	}
	cases := []struct {
		name string
		raw  []byte
	}{
		{"empty", nil},
		{"array", []byte(`[]`)},
		{"string", []byte(`"x"`)},
		{"broken json", []byte(`{`)},
		{"trailing object", []byte(fixtureDoc + `{}`)},
		{"wrong format", mutatedDoc(t, func(d map[string]any) { d["format"] = "other" })},
		{"missing format", mutatedDoc(t, func(d map[string]any) { delete(d, "format") })},
		{"version 2", mutatedDoc(t, func(d map[string]any) { d["version"] = json.Number("2") })},
		{"version string", mutatedDoc(t, func(d map[string]any) { d["version"] = "1" })},
		{"missing version", mutatedDoc(t, func(d map[string]any) { delete(d, "version") })},
		{"wifi not an object", mutatedDoc(t, func(d map[string]any) { d["wifi"] = "x" })},
		{"system not an object", mutatedDoc(t, func(d map[string]any) {
			d["settings"].(map[string]any)["system"] = []any{}
		})},
		{"too large", pad(machines.MaxSettingsBackupBytes + 1)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := prepare(tc.raw)
			if !errors.Is(err, ErrInvalidDocument) {
				t.Fatalf("prepare error = %v, want ErrInvalidDocument", err)
			}
			assertNoSecrets(t, "error text", []byte(err.Error()))
		})
	}

	if _, err := prepare(pad(machines.MaxSettingsBackupBytes)); err != nil {
		t.Fatalf("a document padded to exactly the size cap must be accepted: %v", err)
	}
}

func TestPrepare_HashIgnoresSecretsAndFormatting(t *testing.T) {
	a, err := prepare([]byte(fixtureDoc))
	if err != nil {
		t.Fatalf("prepare fixture: %v", err)
	}
	b, err := prepare([]byte(fixtureDocReordered))
	if err != nil {
		t.Fatalf("prepare reordered fixture: %v", err)
	}
	if a.Hash != b.Hash || !bytes.Equal(a.Data, b.Data) {
		t.Fatalf("reindented fixture with other secrets produced different content:\n%s\n%s", a.Data, b.Data)
	}

	hotter, err := prepare([]byte(strings.Replace(fixtureDoc, `"steamSetPoint": 145`, `"steamSetPoint": 146`, 1)))
	if err != nil {
		t.Fatalf("prepare with a changed setting: %v", err)
	}
	if hotter.Hash == a.Hash {
		t.Fatal("changing a non-secret setting must change the hash")
	}

	swapped, err := prepare(mutatedDoc(t, func(d map[string]any) {
		profiles := d["profiles"].([]any)
		d["profiles"] = []any{profiles[1], profiles[0]}
	}))
	if err != nil {
		t.Fatalf("prepare with swapped profiles: %v", err)
	}
	if swapped.Hash == a.Hash {
		t.Fatal("swapping profiles must change the hash: arrays are ordered")
	}
}

// ── scheduler ───────────────────────────────────────────────────────────

type fakeLister struct{ list []machines.Machine }

func (f *fakeLister) ListMachines() ([]machines.Machine, error) { return f.list, nil }

type fakeClient struct {
	status      machines.Status
	statusErr   error
	docs        []string
	backupErr   error
	statusCalls int
	backupCalls int
}

func (f *fakeClient) GetStatus(context.Context, *machines.Machine) (machines.Status, error) {
	f.statusCalls++
	if f.statusErr != nil {
		return machines.Status{}, f.statusErr
	}
	return f.status, nil
}

func (f *fakeClient) GetSettingsBackup(context.Context, *machines.Machine) ([]byte, error) {
	f.backupCalls++
	if f.backupErr != nil {
		return nil, f.backupErr
	}
	if len(f.docs) == 0 {
		return nil, errors.New("fakeClient: no document")
	}
	i := f.backupCalls - 1
	if i >= len(f.docs) {
		i = len(f.docs) - 1
	}
	return []byte(f.docs[i]), nil
}

type backupRow struct {
	machineID    int64
	createdAt    int64
	kind         string
	firmwareCore string
	profileCount int
	sizeBytes    int
	contentHash  string
	data         string
}

type testEnv struct {
	t             *testing.T
	dir           string
	db            *sql.DB
	repo          *Repository
	clients       map[int64]*fakeClient
	clientLookups map[int64]int
	offline       map[int64]bool
	clock         time.Time
	logs          *bytes.Buffer
	sched         *Scheduler
}

func newTestEnv(t *testing.T, list ...machines.Machine) *testEnv {
	t.Helper()
	dir := t.TempDir()
	sqlDB, err := db.Open(filepath.Join(dir, "glp.db"))
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	e := &testEnv{
		t:             t,
		dir:           dir,
		db:            sqlDB,
		repo:          NewRepository(sqlDB),
		clients:       map[int64]*fakeClient{},
		clientLookups: map[int64]int{},
		offline:       map[int64]bool{},
		logs:          &bytes.Buffer{},
		clock:         time.Date(2026, 11, 3, 9, 0, 0, 0, time.Local),
	}
	e.sched = NewScheduler(SchedulerDeps{
		Repo:     e.repo,
		Machines: &fakeLister{list: list},
		Client: func(m *machines.Machine) (Client, bool) {
			e.clientLookups[m.ID]++
			c, ok := e.clients[m.ID]
			return c, ok
		},
		KnownOffline: func(id int64) bool { return e.offline[id] },
		Now:          func() time.Time { return e.clock },
	})
	prev := log.Writer()
	log.SetOutput(e.logs)
	t.Cleanup(func() {
		log.SetOutput(prev)
		e.closeDB()
	})
	return e
}

func (e *testEnv) tick() { e.sched.tick(context.Background()) }

func (e *testEnv) closeDB() {
	if e.db == nil {
		return
	}
	if err := e.db.Close(); err != nil {
		e.t.Fatalf("closing db: %v", err)
	}
	e.db = nil
}

func (e *testEnv) advance(d time.Duration) { e.clock = e.clock.Add(d) }

func (e *testEnv) rows() []backupRow {
	e.t.Helper()
	res, err := e.db.Query(`SELECT machine_id, created_at, kind, firmware_core,
		profile_count, size_bytes, content_hash, data FROM machine_backups ORDER BY id`)
	if err != nil {
		e.t.Fatalf("reading machine_backups: %v", err)
	}
	defer res.Close()
	var out []backupRow
	for res.Next() {
		var r backupRow
		if err := res.Scan(&r.machineID, &r.createdAt, &r.kind, &r.firmwareCore,
			&r.profileCount, &r.sizeBytes, &r.contentHash, &r.data); err != nil {
			e.t.Fatalf("scanning machine_backups: %v", err)
		}
		out = append(out, r)
	}
	if err := res.Err(); err != nil {
		e.t.Fatalf("iterating machine_backups: %v", err)
	}
	return out
}

func gaggiuinoMachine(id int64) machines.Machine {
	return machines.Machine{ID: id, Name: "Machine", Type: "gaggiuino", Host: "192.168.1.50", Enabled: true}
}

func TestScheduler_StoresFirstBackupOfTheDayWithoutSecrets(t *testing.T) {
	m := gaggiuinoMachine(1)
	e := newTestEnv(t, m)
	e.clients[1] = &fakeClient{docs: []string{fixtureDoc}}

	e.tick()

	rows := e.rows()
	if len(rows) != 1 {
		t.Fatalf("stored %d rows, want 1", len(rows))
	}
	row := rows[0]
	sum := sha256.Sum256([]byte(row.data))
	if row.kind != KindScheduled || row.firmwareCore != "8aaf6f0" || row.profileCount != 2 {
		t.Errorf("unexpected row metadata: %+v", row)
	}
	if row.sizeBytes != len(row.data) {
		t.Errorf("size_bytes = %d, want %d", row.sizeBytes, len(row.data))
	}
	if row.contentHash != hex.EncodeToString(sum[:]) {
		t.Errorf("content_hash = %q, want the sha256 of data", row.contentHash)
	}
	assertNoSecrets(t, "stored row", []byte(row.data))

	e.closeDB()
	paths, err := filepath.Glob(filepath.Join(e.dir, "glp.db*"))
	if err != nil {
		t.Fatalf("globbing db files: %v", err)
	}
	for _, path := range paths {
		b, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("reading %s: %v", path, err)
		}
		assertNoSecrets(t, path, b)
	}
	assertNoSecrets(t, "log", e.logs.Bytes())
}

func TestScheduler_DailyTimelineSkipsUnchangedContent(t *testing.T) {
	e := newTestEnv(t, gaggiuinoMachine(1))
	client := &fakeClient{docs: []string{
		fixtureDoc,
		fixtureDocReordered,
		strings.Replace(fixtureDoc, `"steamSetPoint": 145`, `"steamSetPoint": 146`, 1),
		strings.Replace(fixtureDoc, `"steamSetPoint": 145`, `"steamSetPoint": 146`, 1),
	}}
	e.clients[1] = client

	e.tick()
	if got := len(e.rows()); got != 1 {
		t.Fatalf("day 1 stored %d rows, want 1", got)
	}

	statusCalls, backupCalls := client.statusCalls, client.backupCalls
	e.tick()
	if client.statusCalls != statusCalls || client.backupCalls != backupCalls {
		t.Fatalf("a second tick on the same day contacted the machine")
	}

	e.advance(24 * time.Hour)
	e.tick()
	if client.backupCalls != backupCalls+1 {
		t.Fatalf("day 2 fetched %d times, want 1", client.backupCalls-backupCalls)
	}
	if got := len(e.rows()); got != 1 {
		t.Fatalf("day 2 with unchanged content stored %d rows, want 1", got)
	}

	e.advance(24 * time.Hour)
	e.tick()
	if got := len(e.rows()); got != 2 {
		t.Fatalf("day 3 with a changed setting stored %d rows, want 2", got)
	}

	e.advance(24 * time.Hour)
	e.tick()
	if got := len(e.rows()); got != 2 {
		t.Fatalf("day 4 with unchanged content stored %d rows, want 2", got)
	}
}

func TestScheduler_MachinesAreIndependent(t *testing.T) {
	e := newTestEnv(t, gaggiuinoMachine(1), gaggiuinoMachine(2))
	failing := &fakeClient{
		docs:      []string{fixtureDoc},
		backupErr: errors.New(`Get "http://192.168.1.50/api/settings/backup": dial tcp 192.168.1.50:80: i/o timeout`),
	}
	healthy := &fakeClient{docs: []string{fixtureDoc}}
	e.clients[1] = failing
	e.clients[2] = healthy

	e.tick()
	if rows := e.rows(); len(rows) != 1 || rows[0].machineID != 2 {
		t.Fatalf("rows after the first tick = %+v, want only machine 2", rows)
	}

	e.advance(10 * time.Minute)
	e.tick()
	if failing.backupCalls != 1 {
		t.Fatalf("machine 1 was retried after 10 minutes (%d fetches), want a 30 minute backoff", failing.backupCalls)
	}
	if healthy.statusCalls != 1 {
		t.Fatalf("machine 2 was contacted again the same day (status calls = %d)", healthy.statusCalls)
	}

	e.advance(21 * time.Minute)
	failing.backupErr = nil
	e.tick()
	rows := e.rows()
	if len(rows) != 2 {
		t.Fatalf("rows after machine 1 recovered = %d, want 2", len(rows))
	}
	if healthy.statusCalls != 1 {
		t.Fatalf("machine 2 was contacted again the same day (status calls = %d)", healthy.statusCalls)
	}

	logs := e.logs.String()
	if !strings.Contains(logs, "automatic backup of machine 1 failed") {
		t.Errorf("log does not mention machine 1's failure: %s", logs)
	}
	if strings.Contains(logs, "192.168.1.50") {
		t.Errorf("log leaks the machine host: %s", logs)
	}
	assertNoSecrets(t, "log", []byte(logs))
}

func TestScheduler_SkipsOfflineBusyUnsupportedAndOtherMachines(t *testing.T) {
	t.Run("known offline", func(t *testing.T) {
		e := newTestEnv(t, gaggiuinoMachine(1))
		client := &fakeClient{docs: []string{fixtureDoc}}
		e.clients[1] = client
		e.offline[1] = true
		e.tick()
		if e.clientLookups[1] != 0 || client.statusCalls != 0 {
			t.Fatal("an offline machine was contacted")
		}
		if len(e.rows()) != 0 {
			t.Fatal("an offline machine stored a backup")
		}
	})

	t.Run("status error retries the same day", func(t *testing.T) {
		e := newTestEnv(t, gaggiuinoMachine(1))
		client := &fakeClient{docs: []string{fixtureDoc}}
		client.statusErr = errors.New("dial tcp 192.168.1.50:80: connection refused")
		e.clients[1] = client
		e.tick()
		if client.backupCalls != 0 || len(e.rows()) != 0 {
			t.Fatalf("a status error still fetched a backup (backup calls = %d)", client.backupCalls)
		}
		e.tick()
		if client.statusCalls != 2 {
			t.Fatalf("status calls after a second tick = %d, want 2 (no backoff)", client.statusCalls)
		}
	})

	t.Run("brewing", func(t *testing.T) {
		e := newTestEnv(t, gaggiuinoMachine(1))
		client := &fakeClient{status: machines.Status{Brewing: true}, docs: []string{fixtureDoc}}
		e.clients[1] = client
		e.tick()
		if client.backupCalls != 0 || len(e.rows()) != 0 {
			t.Fatal("a brewing machine was backed up")
		}
	})

	t.Run("steaming", func(t *testing.T) {
		e := newTestEnv(t, gaggiuinoMachine(1))
		steamOn := true
		client := &fakeClient{status: machines.Status{SteamOn: &steamOn}, docs: []string{fixtureDoc}}
		e.clients[1] = client
		e.tick()
		if client.backupCalls != 0 || len(e.rows()) != 0 {
			t.Fatal("a steaming machine was backed up")
		}
	})

	t.Run("firmware without the endpoint", func(t *testing.T) {
		e := newTestEnv(t, gaggiuinoMachine(1))
		client := &fakeClient{docs: []string{fixtureDoc}, backupErr: machines.ErrSettingsBackupUnsupported}
		e.clients[1] = client
		e.tick()
		if len(e.rows()) != 0 {
			t.Fatal("an unsupported machine stored a backup")
		}
		e.tick()
		if client.backupCalls != 1 {
			t.Fatalf("backup calls that day = %d, want 1", client.backupCalls)
		}
		e.advance(24 * time.Hour)
		e.tick()
		if client.backupCalls != 2 {
			t.Fatalf("backup calls the next day = %d, want 2", client.backupCalls)
		}
		if got := strings.Count(e.logs.String(), "has no settings backup"); got != 1 {
			t.Fatalf("the unsupported line appeared %d times, want 1", got)
		}
	})

	t.Run("unreadable document", func(t *testing.T) {
		e := newTestEnv(t, gaggiuinoMachine(1))
		client := &fakeClient{docs: []string{strings.Replace(fixtureDoc, `"version": 1`, `"version": 2`, 1)}}
		e.clients[1] = client
		e.tick()
		if len(e.rows()) != 0 {
			t.Fatal("an unknown version stored a backup")
		}
		e.tick()
		if client.backupCalls != 1 {
			t.Fatalf("backup calls that day = %d, want 1", client.backupCalls)
		}
		logs := e.logs.String()
		if !strings.Contains(logs, "cannot store") {
			t.Errorf("log does not mention the unreadable document: %s", logs)
		}
		assertNoSecrets(t, "log", []byte(logs))
	})

	t.Run("other machines are never contacted", func(t *testing.T) {
		gaggimate := gaggiuinoMachine(1)
		gaggimate.Type = "gaggimate"
		disabled := gaggiuinoMachine(2)
		disabled.Enabled = false
		noHost := gaggiuinoMachine(3)
		noHost.Host = "  "
		e := newTestEnv(t, gaggimate, disabled, noHost)
		e.clients[1] = &fakeClient{docs: []string{fixtureDoc}}
		e.clients[2] = &fakeClient{docs: []string{fixtureDoc}}
		e.clients[3] = &fakeClient{docs: []string{fixtureDoc}}
		e.tick()
		for _, id := range []int64{1, 2, 3} {
			if e.clientLookups[id] != 0 {
				t.Errorf("machine %d got a client lookup, want none", id)
			}
		}
		if len(e.rows()) != 0 {
			t.Fatal("a non-Gaggiuino, disabled or unconfigured machine stored a backup")
		}
	})
}

type fakeProvider struct {
	adapter machines.Adapter
	err     error
}

func (f fakeProvider) GetAdapter(*machines.Machine) (machines.Adapter, error) {
	return f.adapter, f.err
}

func TestClientFor(t *testing.T) {
	gaggimate := gaggiuinoMachine(1)
	gaggimate.Type = "gaggimate"
	if _, ok := ClientFor(fakeProvider{adapter: machines.NewGaggiuinoAdapter(nil)})(&gaggimate); ok {
		t.Error("a GaggiMate machine got a settings backup client")
	}

	gaggiuino := gaggiuinoMachine(1)
	if _, ok := ClientFor(fakeProvider{err: errors.New("no adapter")})(&gaggiuino); ok {
		t.Error("a provider error still produced a client")
	}

	if _, ok := ClientFor(fakeProvider{})(&gaggiuino); ok {
		t.Error("a nil adapter produced a client")
	}

	c, ok := ClientFor(fakeProvider{adapter: machines.NewGaggiuinoAdapter(nil)})(&gaggiuino)
	if !ok || c == nil {
		t.Fatal("a Gaggiuino machine did not get a settings backup client")
	}
}
