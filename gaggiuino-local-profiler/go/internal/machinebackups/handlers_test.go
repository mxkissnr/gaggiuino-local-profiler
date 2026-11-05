package machinebackups

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines"
)

// ── handler helpers ─────────────────────────────────────────────────────

type fakeGetter []machines.Machine

func (f fakeGetter) GetMachine(id int64) (*machines.Machine, error) {
	for i := range f {
		if f[i].ID == id {
			m := f[i]
			return &m, nil
		}
	}
	return nil, nil
}

func newHandlerEnv(t *testing.T, list ...machines.Machine) (*testEnv, http.Handler) {
	t.Helper()
	e := newTestEnv(t, list...)
	h := NewHandlers(HandlerDeps{
		Repo:     e.repo,
		Machines: fakeGetter(list),
		Client: func(m *machines.Machine) (Client, bool) {
			c, ok := e.clients[m.ID]
			return c, ok
		},
		Now: func() time.Time { return e.clock },
	})
	mux := http.NewServeMux()
	h.RegisterRoutes(mux)
	return e, mux
}

func do(h http.Handler, method, target, body, remoteAddr string) *httptest.ResponseRecorder {
	var rdr *strings.Reader
	if body != "" {
		rdr = strings.NewReader(body)
	} else {
		rdr = strings.NewReader("")
	}
	req := httptest.NewRequest(method, target, rdr)
	if remoteAddr == "" {
		remoteAddr = "192.0.2.10:1234"
	}
	req.RemoteAddr = remoteAddr
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func decodeEntry(t *testing.T, body []byte) Entry {
	t.Helper()
	var e Entry
	if err := json.Unmarshal(body, &e); err != nil {
		t.Fatalf("decoding entry: %v (body %s)", err, body)
	}
	return e
}

func decodeEntries(t *testing.T, body []byte) []Entry {
	t.Helper()
	var out []Entry
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatalf("decoding entries: %v (body %s)", err, body)
	}
	return out
}

func errorCode(t *testing.T, body []byte) string {
	t.Helper()
	var e struct {
		Error string `json:"error"`
		Code  string `json:"code"`
	}
	if err := json.Unmarshal(body, &e); err != nil {
		t.Fatalf("decoding error body: %v (body %s)", err, body)
	}
	return e.Code
}

func (e *testEnv) noteOfNewestRow() string {
	e.t.Helper()
	var note string
	if err := e.db.QueryRow(`SELECT note FROM machine_backups ORDER BY id DESC LIMIT 1`).Scan(&note); err != nil {
		e.t.Fatalf("reading note: %v", err)
	}
	return note
}

// ── back up now ─────────────────────────────────────────────────────────

func TestBackUpNow_StoresManualEntryWithoutSecrets(t *testing.T) {
	e, h := newHandlerEnv(t, gaggiuinoMachine(1))
	e.clients[1] = &fakeClient{docs: []string{fixtureDoc}}

	rec := do(h, http.MethodPost, "/api/machine/backups",
		`{"machineId":1,"note":"  before\u0007 steam tweak\n "}`, "")
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201 (body %s)", rec.Code, rec.Body.String())
	}
	entry := decodeEntry(t, rec.Body.Bytes())
	rows := e.rows()
	if len(rows) != 1 {
		t.Fatalf("stored %d rows, want 1", len(rows))
	}
	row := rows[0]
	if entry.Kind != KindManual || entry.MachineID != 1 || entry.Note != "before steam tweak" {
		t.Errorf("unexpected entry: %+v", entry)
	}
	if entry.ProfileCount != 2 || entry.FirmwareCore != "8aaf6f0" {
		t.Errorf("unexpected entry metadata: %+v", entry)
	}
	if entry.ContentHash != row.contentHash || entry.SizeBytes != len(row.data) {
		t.Errorf("entry hash/size = %q/%d, row has %q/%d", entry.ContentHash, entry.SizeBytes, row.contentHash, len(row.data))
	}
	if entry.CreatedAt != row.createdAt*1000 {
		t.Errorf("entry created at %d, row has %d seconds", entry.CreatedAt, row.createdAt)
	}
	if entry.ID != 1 {
		t.Errorf("entry id = %d, want 1", entry.ID)
	}

	assertNoSecrets(t, "response body", rec.Body.Bytes())
	assertNoSecrets(t, "stored row", []byte(row.data))
	assertNoSecrets(t, "log", e.logs.Bytes())
	var raw map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &raw); err != nil {
		t.Fatalf("decoding response: %v", err)
	}
	for _, key := range []string{"data", "document"} {
		if _, ok := raw[key]; ok {
			t.Errorf("response carries %q", key)
		}
	}

	// A manual backup always stores, even with identical content.
	rec = do(h, http.MethodPost, "/api/machine/backups", `{"machineId":1}`, "")
	if rec.Code != http.StatusCreated {
		t.Fatalf("second status = %d, want 201 (body %s)", rec.Code, rec.Body.String())
	}
	if got := len(e.rows()); got != 2 {
		t.Fatalf("stored %d rows after two manual backups, want 2", got)
	}

	longNote := strings.Repeat("ä", 250)
	body, err := json.Marshal(map[string]any{"machineId": 1, "note": longNote})
	if err != nil {
		t.Fatalf("encoding long note: %v", err)
	}
	rec = do(h, http.MethodPost, "/api/machine/backups", string(body), "")
	if rec.Code != http.StatusCreated {
		t.Fatalf("status with a long note = %d, want 201 (body %s)", rec.Code, rec.Body.String())
	}
	if got := []rune(e.noteOfNewestRow()); len(got) != maxNoteRunes {
		t.Fatalf("stored note has %d runes, want %d", len(got), maxNoteRunes)
	}
}

func TestBackUpNow_Errors(t *testing.T) {
	gaggimate := gaggiuinoMachine(1)
	gaggimate.Type = "gaggimate"

	cases := []struct {
		name        string
		machine     machines.Machine
		client      bool
		status      machines.Status
		statusErr   error
		docs        func(t *testing.T) []string
		backupErr   error
		body        string
		wantStatus  int
		wantCode    string
		wantBackups int
	}{
		{name: "invalid json", machine: gaggiuinoMachine(1), client: true, docs: func(*testing.T) []string { return []string{fixtureDoc} },
			body: `{`, wantStatus: http.StatusBadRequest},
		{name: "missing machine id", machine: gaggiuinoMachine(1), client: true, docs: func(*testing.T) []string { return []string{fixtureDoc} },
			body: `{}`, wantStatus: http.StatusBadRequest},
		{name: "machine id zero", machine: gaggiuinoMachine(1), client: true, docs: func(*testing.T) []string { return []string{fixtureDoc} },
			body: `{"machineId":0}`, wantStatus: http.StatusBadRequest},
		{name: "unknown machine", machine: gaggiuinoMachine(1), client: true, docs: func(*testing.T) []string { return []string{fixtureDoc} },
			body: `{"machineId":99}`, wantStatus: http.StatusNotFound},
		{name: "not a gaggiuino machine", machine: gaggimate, client: false,
			body: `{"machineId":1}`, wantStatus: http.StatusNotImplemented, wantCode: codeUnsupportedMachine},
		{name: "status error", machine: gaggiuinoMachine(1), client: true, statusErr: errTestOffline,
			body: `{"machineId":1}`, wantStatus: http.StatusBadGateway, wantCode: codeMachineUnreachable},
		{name: "brewing", machine: gaggiuinoMachine(1), client: true, status: machines.Status{Brewing: true},
			docs: func(*testing.T) []string { return []string{fixtureDoc} },
			body: `{"machineId":1}`, wantStatus: http.StatusConflict, wantCode: codeMachineBusy},
		{name: "steaming", machine: gaggiuinoMachine(1), client: true, status: machines.Status{SteamOn: boolPtr(true)},
			docs: func(*testing.T) []string { return []string{fixtureDoc} },
			body: `{"machineId":1}`, wantStatus: http.StatusConflict, wantCode: codeMachineBusy},
		{name: "firmware without the endpoint", machine: gaggiuinoMachine(1), client: true,
			backupErr: machines.ErrSettingsBackupUnsupported,
			body:      `{"machineId":1}`, wantStatus: http.StatusNotImplemented, wantCode: codeUnsupportedFirmware},
		{name: "transport error", machine: gaggiuinoMachine(1), client: true,
			backupErr: errTestTransport,
			body:      `{"machineId":1}`, wantStatus: http.StatusBadGateway, wantCode: codeMachineUnreachable},
		{name: "too large", machine: gaggiuinoMachine(1), client: true,
			backupErr: machines.ErrSettingsBackupTooLarge,
			body:      `{"machineId":1}`, wantStatus: http.StatusBadGateway, wantCode: codeInvalidBackup},
		{name: "unknown document version", machine: gaggiuinoMachine(1), client: true,
			docs: func(t *testing.T) []string {
				return []string{string(mutatedDoc(t, func(d map[string]any) { d["version"] = json.Number("2") }))}
			},
			body: `{"machineId":1}`, wantStatus: http.StatusBadGateway, wantCode: codeInvalidBackup},
		{name: "oversized body", machine: gaggiuinoMachine(1), client: true,
			docs: func(*testing.T) []string { return []string{fixtureDoc} },
			body: `{"machineId":1,"note":"` + strings.Repeat("a", 5000) + `"}`, wantStatus: http.StatusRequestEntityTooLarge},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			e, h := newHandlerEnv(t, tc.machine)
			client := &fakeClient{status: tc.status, statusErr: tc.statusErr, backupErr: tc.backupErr}
			if tc.docs != nil {
				client.docs = tc.docs(t)
			}
			if tc.client {
				e.clients[tc.machine.ID] = client
			}

			rec := do(h, http.MethodPost, "/api/machine/backups", tc.body, "")
			if rec.Code != tc.wantStatus {
				t.Fatalf("status = %d, want %d (body %s)", rec.Code, tc.wantStatus, rec.Body.String())
			}
			if tc.wantCode != "" && errorCode(t, rec.Body.Bytes()) != tc.wantCode {
				t.Errorf("code = %q, want %q (body %s)", errorCode(t, rec.Body.Bytes()), tc.wantCode, rec.Body.String())
			}
			if got := len(e.rows()); got != 0 {
				t.Errorf("stored %d rows, want none", got)
			}
			if tc.wantCode == codeMachineBusy && client.backupCalls != 0 {
				t.Errorf("a busy machine was fetched (%d backup calls)", client.backupCalls)
			}
			for _, out := range [][]byte{rec.Body.Bytes(), e.logs.Bytes()} {
				assertNoSecrets(t, "response/log", out)
				if bytes.Contains(out, []byte("192.168.1.50")) {
					t.Errorf("leaks the machine host: %s", out)
				}
			}
		})
	}
}

var (
	errTestOffline   = &testError{"dial tcp 192.168.1.50:80: connection refused"}
	errTestTransport = &testError{`Get "http://192.168.1.50/api/settings/backup": dial tcp 192.168.1.50:80: i/o timeout`}
)

type testError struct{ msg string }

func (e *testError) Error() string { return e.msg }

func boolPtr(b bool) *bool { return &b }

// ── lock shared with the scheduler ──────────────────────────────────────

func TestBackUpNow_PerMachineLockSharedWithScheduler(t *testing.T) {
	e, h := newHandlerEnv(t, gaggiuinoMachine(1), gaggiuinoMachine(2))
	c1 := &fakeClient{docs: []string{fixtureDoc}}
	c2 := &fakeClient{docs: []string{fixtureDoc}}
	e.clients[1] = c1
	e.clients[2] = c2

	mu := e.repo.machineLock(1)
	mu.Lock()

	rec := do(h, http.MethodPost, "/api/machine/backups", `{"machineId":1}`, "")
	if rec.Code != http.StatusConflict || errorCode(t, rec.Body.Bytes()) != codeOperationRunning {
		t.Fatalf("status with the lock held = %d %s, want 409 operation_running", rec.Code, rec.Body.String())
	}
	if c1.statusCalls != 0 || c1.backupCalls != 0 {
		t.Fatal("a locked machine was contacted")
	}

	rec = do(h, http.MethodPost, "/api/machine/backups", `{"machineId":2}`, "")
	if rec.Code != http.StatusCreated {
		t.Fatalf("machine 2 status = %d, want 201 (body %s)", rec.Code, rec.Body.String())
	}

	e.tick()
	if c1.statusCalls != 0 || c1.backupCalls != 0 {
		t.Fatal("the scheduler contacted a locked machine")
	}
	for _, row := range e.rows() {
		if row.machineID == 1 {
			t.Fatal("the scheduler stored a row for a locked machine")
		}
	}

	mu.Unlock()
	e.tick()
	count := 0
	for _, row := range e.rows() {
		if row.machineID == 1 && row.kind == KindScheduled {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("scheduled rows for machine 1 = %d, want 1: the lock must not mark it checked", count)
	}
}

// ── list and delete ─────────────────────────────────────────────────────

func TestList_AndDelete(t *testing.T) {
	e, h := newHandlerEnv(t, gaggiuinoMachine(1))
	p, err := prepare([]byte(fixtureDoc))
	if err != nil {
		t.Fatalf("prepare fixture: %v", err)
	}
	first, err := e.repo.insert(1, KindScheduled, "", p, e.clock)
	if err != nil {
		t.Fatalf("insert: %v", err)
	}
	second, err := e.repo.insert(1, KindManual, "note", p, e.clock.Add(time.Hour))
	if err != nil {
		t.Fatalf("insert: %v", err)
	}
	// Machine 7 is not in the registry: it stands for a deleted machine.
	deleted, err := e.repo.insert(7, KindScheduled, "", p, e.clock.Add(2*time.Hour))
	if err != nil {
		t.Fatalf("insert: %v", err)
	}

	rec := do(h, http.MethodGet, "/api/machine/backups", "", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
	list := decodeEntries(t, rec.Body.Bytes())
	want := []int64{deleted.ID, second.ID, first.ID}
	if len(list) != len(want) {
		t.Fatalf("listed %d entries, want %d: %s", len(list), len(want), rec.Body.String())
	}
	for i, id := range want {
		if list[i].ID != id {
			t.Fatalf("entry %d has id %d, want %d (newest first)", i, list[i].ID, id)
		}
	}
	if bytes.Contains(rec.Body.Bytes(), []byte(`"data"`)) {
		t.Error("the list carries a data key")
	}
	assertNoSecrets(t, "list body", rec.Body.Bytes())

	rec = do(h, http.MethodGet, "/api/machine/backups?machineId=7", "", "")
	if list := decodeEntries(t, rec.Body.Bytes()); len(list) != 1 || list[0].ID != deleted.ID {
		t.Fatalf("machine 7 list = %+v, want its one entry", list)
	}

	rec = do(h, http.MethodGet, "/api/machine/backups?machineId=5", "", "")
	if got := strings.TrimSpace(rec.Body.String()); got != "[]" {
		t.Fatalf("machine 5 list = %s, want []", got)
	}

	for _, target := range []string{"/api/machine/backups?machineId=abc", "/api/machine/backups?machineId=0"} {
		rec = do(h, http.MethodGet, target, "", "")
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%s status = %d, want 400", target, rec.Code)
		}
	}

	rec = do(h, http.MethodDelete, "/api/machine/backups/"+strconv.FormatInt(deleted.ID, 10), "", "")
	if rec.Code != http.StatusOK || strings.TrimSpace(rec.Body.String()) != `{"ok":true}` {
		t.Fatalf("delete status = %d body %s, want 200 {\"ok\":true}", rec.Code, rec.Body.String())
	}
	remaining := e.rows()
	if len(remaining) != 2 {
		t.Fatalf("%d rows remain, want 2", len(remaining))
	}
	for _, row := range remaining {
		if row.machineID == 7 {
			t.Fatal("machine 7's row survived the delete")
		}
	}

	rec = do(h, http.MethodDelete, "/api/machine/backups/"+strconv.FormatInt(deleted.ID, 10), "", "")
	if rec.Code != http.StatusNotFound {
		t.Errorf("second delete status = %d, want 404", rec.Code)
	}
	for _, target := range []string{"/api/machine/backups/abc", "/api/machine/backups/0"} {
		rec = do(h, http.MethodDelete, target, "", "")
		if rec.Code != http.StatusNotFound {
			t.Errorf("%s status = %d, want 404", target, rec.Code)
		}
	}
}

func TestBackUpNow_RateLimitPerIP(t *testing.T) {
	_, h := newHandlerEnv(t, gaggiuinoMachine(1))

	for i := 0; i < backUpNowPerMinute; i++ {
		rec := do(h, http.MethodPost, "/api/machine/backups", `{"machineId":99}`, "192.0.2.1:1234")
		if rec.Code != http.StatusNotFound {
			t.Fatalf("request %d status = %d, want 404", i+1, rec.Code)
		}
	}
	rec := do(h, http.MethodPost, "/api/machine/backups", `{"machineId":99}`, "192.0.2.1:1234")
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("request over the limit status = %d, want 429", rec.Code)
	}
	rec = do(h, http.MethodPost, "/api/machine/backups", `{"machineId":99}`, "192.0.2.2:1234")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("another IP status = %d, want 404", rec.Code)
	}
}

// ── stored document, download and upload ────────────────────────────────

func (e *testEnv) seedBackup(machineID int64, kind string) Entry {
	e.t.Helper()
	p, err := prepare([]byte(fixtureDoc))
	if err != nil {
		e.t.Fatalf("prepare fixture: %v", err)
	}
	entry, err := e.repo.insert(machineID, kind, "", p, e.clock)
	if err != nil {
		e.t.Fatalf("insert: %v", err)
	}
	return entry
}

// currentMachineDoc stands for the machine at download time: the reordered
// fixture with a changed setting and broker, so the stored version must win
// everywhere but the secrets.
func currentMachineDoc() string {
	doc := strings.Replace(fixtureDocReordered, `"steamSetPoint":145`, `"steamSetPoint":146`, 1)
	return strings.Replace(doc, `"mqttHost":"broker.local"`, `"mqttHost":"other.local"`, 1)
}

func assertNoSecretMarker(t *testing.T, label string, b []byte) {
	t.Helper()
	if bytes.Contains(b, []byte("SECRET-")) {
		t.Errorf("%s contains a secret marker: %s", label, b)
	}
}

func assertDBFilesHaveNoSecret(t *testing.T, e *testEnv) {
	t.Helper()
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
		assertNoSecretMarker(t, path, b)
	}
}

func backupURL(id int64, suffix string) string {
	return "/api/machine/backups/" + strconv.FormatInt(id, 10) + suffix
}

// docOfSize returns a compact settings document of exactly n bytes, padded
// inside the pad string (a decoder drops whitespace after the object).
func docOfSize(t *testing.T, n int) string {
	t.Helper()
	const head = `{"format":"gaggiuino-settings","version":1,"pad":"`
	const tail = `"}`
	pad := n - len(head) - len(tail)
	if pad < 0 {
		t.Fatalf("cannot build a document of %d bytes", n)
	}
	doc := head + strings.Repeat("x", pad) + tail
	if len(doc) != n {
		t.Fatalf("built a document of %d bytes, want %d", len(doc), n)
	}
	return doc
}

func TestDocument_ReturnsEntryAndSecretFreeDocument(t *testing.T) {
	e, h := newHandlerEnv(t, gaggiuinoMachine(1))
	client := &fakeClient{docs: []string{fixtureDoc}}
	e.clients[1] = client

	entry := e.seedBackup(1, KindManual)
	rec := do(h, http.MethodGet, backupURL(entry.ID, ""), "", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
	var got struct {
		Entry
		Document map[string]any `json:"document"`
	}
	dec := json.NewDecoder(bytes.NewReader(rec.Body.Bytes()))
	dec.UseNumber()
	if err := dec.Decode(&got); err != nil {
		t.Fatalf("decoding response: %v (body %s)", err, rec.Body.String())
	}
	if got.ID != entry.ID || got.MachineID != entry.MachineID || got.Kind != entry.Kind || got.ContentHash != entry.ContentHash {
		t.Errorf("response entry = %+v, want %+v", got.Entry, entry)
	}
	if got.Document["format"] != "gaggiuino-settings" {
		t.Errorf("document.format = %#v, want gaggiuino-settings", got.Document["format"])
	}
	if _, ok := got.Document["wifi"]; ok {
		t.Errorf("document carries a wifi block: %s", rec.Body.String())
	}
	offset, ok := valueAt(got.Document, []string{"settings", "boiler", "offset"})
	if !ok || offset != json.Number("93.50") {
		t.Errorf("document settings.boiler.offset = %#v, want 93.50", offset)
	}
	assertNoSecretMarker(t, "document body", rec.Body.Bytes())
	if client.statusCalls != 0 || client.backupCalls != 0 {
		t.Errorf("the document route contacted the machine (%d status, %d backup calls)", client.statusCalls, client.backupCalls)
	}

	// Machine 7 is not in the registry: a deleted machine's backup stays readable.
	deleted := e.seedBackup(7, KindScheduled)
	if rec := do(h, http.MethodGet, backupURL(deleted.ID, ""), "", ""); rec.Code != http.StatusOK {
		t.Errorf("deleted machine's backup status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}

	for _, target := range []string{
		"/api/machine/backups/abc", "/api/machine/backups/0", "/api/machine/backups/99",
		"/api/machine/backups/upload",
	} {
		if rec := do(h, http.MethodGet, target, "", ""); rec.Code != http.StatusNotFound {
			t.Errorf("%s status = %d, want 404", target, rec.Code)
		}
	}
	// The literal settings route still wins over {id}.
	if rec := do(h, http.MethodGet, "/api/machine/backups/settings", "", ""); rec.Code != http.StatusBadRequest {
		t.Errorf("settings without machineId status = %d, want 400 (body %s)", rec.Code, rec.Body.String())
	}
}

func TestDownload_MergesTheMachinesCurrentSecrets(t *testing.T) {
	e, h := newHandlerEnv(t, gaggiuinoMachine(1), gaggiuinoMachine(2))
	other := &fakeClient{docs: []string{fixtureDoc}}
	client := &fakeClient{docs: []string{currentMachineDoc()}}
	e.clients[1] = other
	e.clients[2] = client

	entry := e.seedBackup(2, KindManual)
	rec := do(h, http.MethodGet, backupURL(entry.ID, "/download"), "", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
	wantHeaders := map[string]string{
		secretsHeader:         secretsMerged,
		"Cache-Control":       "no-store",
		"Content-Type":        "application/json",
		"Content-Disposition": `attachment; filename="gaggiuino-backup-m2-2026-11-03_0900.json"`,
	}
	for key, want := range wantHeaders {
		if got := rec.Header().Get(key); got != want {
			t.Errorf("%s = %q, want %q", key, got, want)
		}
	}

	body := rec.Body.Bytes()
	var doc map[string]any
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	if err := dec.Decode(&doc); err != nil {
		t.Fatalf("decoding body: %v (body %s)", err, body)
	}
	for _, tc := range []struct {
		path []string
		want string
	}{
		{[]string{"wifi", "ssid"}, "SECRET-ssid-zzz"},
		{[]string{"wifi", "password"}, "SECRET-wifi-pass-zzz"},
		{[]string{"settings", "system", "mqttUsername"}, "SECRET-mqtt-user-zzz"},
		{[]string{"settings", "system", "mqttPassword"}, "SECRET-mqtt-pass-zzz"},
		{[]string{"settings", "system", "visualizerToken"}, "SECRET-vis-zzz"},
		{[]string{"settings", "system", "sprofilerToken"}, "SECRET-spro-zzz"},
	} {
		if got, _ := valueAt(doc, tc.path); got != tc.want {
			t.Errorf("%v = %#v, want the machine's current secret", tc.path, got)
		}
	}
	for _, want := range []string{`"steamSetPoint":145`, `"mqttHost":"broker.local"`, "93.50", "Bloom <b>&co"} {
		if !bytes.Contains(body, []byte(want)) {
			t.Errorf("body lost the stored value %s: %s", want, body)
		}
	}
	for _, unwanted := range []string{`"steamSetPoint":146`, "other.local"} {
		if bytes.Contains(body, []byte(unwanted)) {
			t.Errorf("body carries the machine's newer value %s: %s", unwanted, body)
		}
	}
	assertNoSecrets(t, "download body", body)
	reprepared, err := prepare(body)
	if err != nil {
		t.Fatalf("prepare downloaded body: %v", err)
	}
	if reprepared.Hash != entry.ContentHash {
		t.Errorf("downloaded body hash = %q, want the stored hash %q", reprepared.Hash, entry.ContentHash)
	}
	if client.statusCalls != 1 || client.backupCalls != 1 {
		t.Errorf("machine 2 calls = %d status, %d backup; want 1 each", client.statusCalls, client.backupCalls)
	}
	if other.statusCalls != 0 || other.backupCalls != 0 {
		t.Errorf("the download read secrets from another machine (%d status, %d backup calls)", other.statusCalls, other.backupCalls)
	}

	mu := e.repo.machineLock(2)
	if !mu.TryLock() {
		t.Error("the download left machine 2's lock held")
	} else {
		mu.Unlock()
	}

	rows := e.rows()
	if len(rows) != 1 {
		t.Fatalf("stored %d rows, want 1: a download must not store anything", len(rows))
	}
	if rows[0].contentHash != entry.ContentHash {
		t.Errorf("stored row hash = %q, want %q", rows[0].contentHash, entry.ContentHash)
	}
	assertNoSecretMarker(t, "stored row", []byte(rows[0].data))

	logs := e.logs.Bytes()
	if !bytes.Contains(logs, []byte("with the machine's current secrets")) {
		t.Errorf("log does not mention the merge: %s", logs)
	}
	assertNoSecretMarker(t, "log", logs)
	if bytes.Contains(logs, []byte("192.168.1.50")) {
		t.Errorf("log leaks the machine host: %s", logs)
	}

	assertDBFilesHaveNoSecret(t, e)
}

// gaggimateMachine is gaggiuinoMachine with the other machine type.
func gaggimateMachine(id int64) machines.Machine {
	m := gaggiuinoMachine(id)
	m.Type = "gaggimate"
	return m
}

func TestDownload_FallsBackToTheSecretFreeFile(t *testing.T) {
	cases := []struct {
		name     string
		machines []machines.Machine
		client   *fakeClient
		clientOn int64
		entryOn  int64
	}{
		{name: "status error", machines: []machines.Machine{gaggiuinoMachine(1)},
			client: &fakeClient{statusErr: errTestOffline, docs: []string{fixtureDoc}}, clientOn: 1, entryOn: 1},
		{name: "transport error", machines: []machines.Machine{gaggiuinoMachine(1)},
			client: &fakeClient{backupErr: errTestTransport, docs: []string{fixtureDoc}}, clientOn: 1, entryOn: 1},
		{name: "firmware without the endpoint", machines: []machines.Machine{gaggiuinoMachine(1)},
			client: &fakeClient{backupErr: machines.ErrSettingsBackupUnsupported}, clientOn: 1, entryOn: 1},
		{name: "fresh backup too large", machines: []machines.Machine{gaggiuinoMachine(1)},
			client: &fakeClient{backupErr: machines.ErrSettingsBackupTooLarge}, clientOn: 1, entryOn: 1},
		{name: "unreadable fresh backup", machines: []machines.Machine{gaggiuinoMachine(1)},
			client: &fakeClient{docs: []string{`{`}}, clientOn: 1, entryOn: 1},
		{name: "unknown version", machines: []machines.Machine{gaggiuinoMachine(1)},
			client: &fakeClient{docs: []string{strings.Replace(fixtureDocReordered, `"version":1`, `"version":2`, 1)}},
			clientOn: 1, entryOn: 1},
		{name: "no secret", machines: []machines.Machine{gaggiuinoMachine(1)},
			client: &fakeClient{docs: []string{`{"format":"gaggiuino-settings","version":1}`}}, clientOn: 1, entryOn: 1},
		{name: "deleted machine", machines: []machines.Machine{gaggiuinoMachine(1)}, entryOn: 7},
		{name: "not a gaggiuino machine", machines: []machines.Machine{gaggimateMachine(1)}, entryOn: 1},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			e, h := newHandlerEnv(t, tc.machines...)
			if tc.client != nil {
				e.clients[tc.clientOn] = tc.client
			}
			entry := e.seedBackup(tc.entryOn, KindManual)
			_, stored, found, err := e.repo.get(entry.ID)
			if err != nil || !found {
				t.Fatalf("reading the stored row: found %v, err %v", found, err)
			}

			rec := do(h, http.MethodGet, backupURL(entry.ID, "/download"), "", "")
			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
			}
			if got := rec.Header().Get(secretsHeader); got != secretsMissing {
				t.Errorf("%s = %q, want %q", secretsHeader, got, secretsMissing)
			}
			if got := rec.Header().Get("Cache-Control"); got != "no-store" {
				t.Errorf("Cache-Control = %q, want no-store", got)
			}
			if !bytes.Equal(rec.Body.Bytes(), []byte(stored)) {
				t.Errorf("body = %s, want the stored document byte for byte: %s", rec.Body.Bytes(), stored)
			}
			assertNoSecretMarker(t, "download body", rec.Body.Bytes())
			logs := e.logs.Bytes()
			if !bytes.Contains(logs, []byte("downloaded without secrets")) {
				t.Errorf("log does not mention the fallback: %s", logs)
			}
			assertNoSecretMarker(t, "log", logs)
			if bytes.Contains(logs, []byte("192.168.1.50")) {
				t.Errorf("log leaks the machine host: %s", logs)
			}

			mu := e.repo.machineLock(1)
			if !mu.TryLock() {
				t.Error("the download left machine 1's lock held")
			} else {
				mu.Unlock()
			}
		})
	}
}

func TestDownload_RefusesWhileBusy(t *testing.T) {
	t.Run("brewing", func(t *testing.T) {
		e, h := newHandlerEnv(t, gaggiuinoMachine(1))
		client := &fakeClient{status: machines.Status{Brewing: true}, docs: []string{fixtureDoc}}
		e.clients[1] = client
		entry := e.seedBackup(1, KindManual)

		rec := do(h, http.MethodGet, backupURL(entry.ID, "/download"), "", "")
		if rec.Code != http.StatusConflict || errorCode(t, rec.Body.Bytes()) != codeMachineBusy {
			t.Fatalf("status = %d %s, want 409 machine_busy", rec.Code, rec.Body.String())
		}
		if client.backupCalls != 0 {
			t.Errorf("a brewing machine was fetched (%d backup calls)", client.backupCalls)
		}
	})

	t.Run("steaming", func(t *testing.T) {
		e, h := newHandlerEnv(t, gaggiuinoMachine(1))
		client := &fakeClient{status: machines.Status{SteamOn: boolPtr(true)}, docs: []string{fixtureDoc}}
		e.clients[1] = client
		entry := e.seedBackup(1, KindManual)

		rec := do(h, http.MethodGet, backupURL(entry.ID, "/download"), "", "")
		if rec.Code != http.StatusConflict || errorCode(t, rec.Body.Bytes()) != codeMachineBusy {
			t.Fatalf("status = %d %s, want 409 machine_busy", rec.Code, rec.Body.String())
		}
		if client.backupCalls != 0 {
			t.Errorf("a steaming machine was fetched (%d backup calls)", client.backupCalls)
		}
	})

	t.Run("lock held", func(t *testing.T) {
		e, h := newHandlerEnv(t, gaggiuinoMachine(1), gaggiuinoMachine(2))
		c1 := &fakeClient{docs: []string{fixtureDoc}}
		c2 := &fakeClient{docs: []string{fixtureDoc}}
		e.clients[1] = c1
		e.clients[2] = c2
		first := e.seedBackup(1, KindManual)
		second := e.seedBackup(2, KindManual)

		mu := e.repo.machineLock(1)
		mu.Lock()

		rec := do(h, http.MethodGet, backupURL(first.ID, "/download"), "", "")
		if rec.Code != http.StatusConflict || errorCode(t, rec.Body.Bytes()) != codeOperationRunning {
			t.Fatalf("status with the lock held = %d %s, want 409 operation_running", rec.Code, rec.Body.String())
		}
		if c1.statusCalls != 0 || c1.backupCalls != 0 {
			t.Error("a locked machine was contacted")
		}

		rec = do(h, http.MethodGet, backupURL(second.ID, "/download"), "", "")
		if rec.Code != http.StatusOK || rec.Header().Get(secretsHeader) != secretsMerged {
			t.Fatalf("machine 2 status = %d %q, want 200 merged (body %s)",
				rec.Code, rec.Header().Get(secretsHeader), rec.Body.String())
		}

		mu.Unlock()
		rec = do(h, http.MethodGet, backupURL(first.ID, "/download"), "", "")
		if rec.Code != http.StatusOK || rec.Header().Get(secretsHeader) != secretsMerged {
			t.Fatalf("status after unlocking = %d %q, want 200 merged (body %s)",
				rec.Code, rec.Header().Get(secretsHeader), rec.Body.String())
		}
	})
}

func TestDownload_UnknownID(t *testing.T) {
	e, h := newHandlerEnv(t, gaggiuinoMachine(1))
	client := &fakeClient{docs: []string{fixtureDoc}}
	e.clients[1] = client

	for _, target := range []string{
		"/api/machine/backups/abc/download", "/api/machine/backups/0/download", "/api/machine/backups/99/download",
	} {
		if rec := do(h, http.MethodGet, target, "", ""); rec.Code != http.StatusNotFound {
			t.Errorf("%s status = %d, want 404", target, rec.Code)
		}
	}
	if client.statusCalls != 0 || client.backupCalls != 0 {
		t.Errorf("an unknown id contacted the machine (%d status, %d backup calls)", client.statusCalls, client.backupCalls)
	}
}

func TestUpload_StripsSecretsBeforeStoring(t *testing.T) {
	// No client on purpose: upload never contacts the machine.
	e, h := newHandlerEnv(t, gaggiuinoMachine(1))

	body := `{"machineId":1,"note":"  before\u0007 flash\n ","document":` + fixtureDoc + `}`
	rec := do(h, http.MethodPost, "/api/machine/backups/upload", body, "")
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201 (body %s)", rec.Code, rec.Body.String())
	}
	entry := decodeEntry(t, rec.Body.Bytes())
	if entry.Kind != KindUploaded || entry.MachineID != 1 || entry.Note != "before flash" {
		t.Errorf("unexpected entry: %+v", entry)
	}
	if entry.ProfileCount != 2 || entry.FirmwareCore != "8aaf6f0" {
		t.Errorf("unexpected entry metadata: %+v", entry)
	}
	if entry.CreatedAt != e.clock.Unix()*1000 {
		t.Errorf("createdAt = %d, want %d", entry.CreatedAt, e.clock.Unix()*1000)
	}

	want, err := prepare([]byte(fixtureDoc))
	if err != nil {
		t.Fatalf("prepare fixture: %v", err)
	}
	rows := e.rows()
	if len(rows) != 1 {
		t.Fatalf("stored %d rows, want 1", len(rows))
	}
	if rows[0].data != string(want.Data) {
		t.Errorf("stored data = %s, want %s", rows[0].data, want.Data)
	}
	for _, keep := range []string{"93.50", "Bloom <b>&co"} {
		if !bytes.Contains([]byte(rows[0].data), []byte(keep)) {
			t.Errorf("stored data lost %s", keep)
		}
	}
	if bytes.Contains([]byte(rows[0].data), []byte(`"wifi"`)) {
		t.Errorf("stored data carries a wifi block: %s", rows[0].data)
	}

	// No change detection: the same upload stores a second row.
	rec = do(h, http.MethodPost, "/api/machine/backups/upload", body, "")
	if rec.Code != http.StatusCreated {
		t.Fatalf("second status = %d, want 201 (body %s)", rec.Code, rec.Body.String())
	}
	if got := len(e.rows()); got != 2 {
		t.Fatalf("stored %d rows after two uploads, want 2", got)
	}

	assertNoSecretMarker(t, "upload response", rec.Body.Bytes())
	logs := e.logs.Bytes()
	if !bytes.Contains(logs, []byte("stored uploaded backup of machine 1")) {
		t.Errorf("log does not mention the stored upload: %s", logs)
	}
	assertNoSecretMarker(t, "log", logs)

	assertDBFilesHaveNoSecret(t, e)
}

func TestUpload_RejectsBadRequests(t *testing.T) {
	cases := []struct {
		name       string
		machine    machines.Machine
		body       string
		wantStatus int
		wantCode   string
	}{
		{name: "empty body", machine: gaggiuinoMachine(1), body: ``, wantStatus: http.StatusBadRequest},
		{name: "broken json", machine: gaggiuinoMachine(1), body: `{`, wantStatus: http.StatusBadRequest},
		{name: "no machine id", machine: gaggiuinoMachine(1), body: `{}`, wantStatus: http.StatusBadRequest},
		{name: "machine id zero", machine: gaggiuinoMachine(1), body: `{"machineId":0,"document":{}}`, wantStatus: http.StatusBadRequest},
		{name: "machine id as string", machine: gaggiuinoMachine(1), body: `{"machineId":"1","document":{}}`, wantStatus: http.StatusBadRequest},
		{name: "unknown machine", machine: gaggiuinoMachine(1),
			body: `{"machineId":99,"document":` + fixtureDoc + `}`, wantStatus: http.StatusNotFound},
		{name: "not a gaggiuino machine", machine: gaggimateMachine(1),
			body: `{"machineId":1,"document":` + fixtureDoc + `}`, wantStatus: http.StatusNotImplemented, wantCode: codeUnsupportedMachine},
		{name: "no document", machine: gaggiuinoMachine(1),
			body: `{"machineId":1}`, wantStatus: http.StatusBadRequest, wantCode: codeInvalidBackup},
		{name: "null document", machine: gaggiuinoMachine(1),
			body: `{"machineId":1,"document":null}`, wantStatus: http.StatusBadRequest, wantCode: codeInvalidBackup},
		{name: "string document", machine: gaggiuinoMachine(1),
			body: `{"machineId":1,"document":"x"}`, wantStatus: http.StatusBadRequest, wantCode: codeInvalidBackup},
		{name: "array document", machine: gaggiuinoMachine(1),
			body: `{"machineId":1,"document":[]}`, wantStatus: http.StatusBadRequest, wantCode: codeInvalidBackup},
		{name: "wrong format", machine: gaggiuinoMachine(1),
			body: `{"machineId":1,"document":{"format":"other","version":1}}`, wantStatus: http.StatusBadRequest, wantCode: codeInvalidBackup},
		{name: "unknown version", machine: gaggiuinoMachine(1),
			body: `{"machineId":1,"document":` + strings.Replace(fixtureDoc, `"version": 1`, `"version": 2`, 1) + `}`,
			wantStatus: http.StatusBadRequest, wantCode: codeInvalidBackup},
		{name: "missing version", machine: gaggiuinoMachine(1),
			body: `{"machineId":1,"document":{"format":"gaggiuino-settings"}}`, wantStatus: http.StatusBadRequest, wantCode: codeInvalidBackup},
		{name: "wifi not an object", machine: gaggiuinoMachine(1),
			body: `{"machineId":1,"document":` + string(mutatedDoc(t, func(d map[string]any) { d["wifi"] = "SECRET-as-string" })) + `}`,
			wantStatus: http.StatusBadRequest, wantCode: codeInvalidBackup},
		{name: "system not an object", machine: gaggiuinoMachine(1),
			body: `{"machineId":1,"document":` + string(mutatedDoc(t, func(d map[string]any) {
				d["settings"].(map[string]any)["system"] = []any{}
			})) + `}`,
			wantStatus: http.StatusBadRequest, wantCode: codeInvalidBackup},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			e, h := newHandlerEnv(t, tc.machine)

			rec := do(h, http.MethodPost, "/api/machine/backups/upload", tc.body, "")
			if rec.Code != tc.wantStatus {
				t.Fatalf("status = %d, want %d (body %s)", rec.Code, tc.wantStatus, rec.Body.String())
			}
			if tc.wantCode != "" && errorCode(t, rec.Body.Bytes()) != tc.wantCode {
				t.Errorf("code = %q, want %q (body %s)", errorCode(t, rec.Body.Bytes()), tc.wantCode, rec.Body.String())
			}
			if got := len(e.rows()); got != 0 {
				t.Errorf("stored %d rows, want none", got)
			}
			assertNoSecretMarker(t, "response", rec.Body.Bytes())
			assertNoSecretMarker(t, "log", e.logs.Bytes())
		})
	}
}

func TestUpload_SizeLimits(t *testing.T) {
	e, h := newHandlerEnv(t, gaggiuinoMachine(1))

	rec := do(h, http.MethodPost, "/api/machine/backups/upload",
		`{"machineId":1,"document":`+docOfSize(t, machines.MaxSettingsBackupBytes)+`}`, "")
	if rec.Code != http.StatusCreated {
		t.Fatalf("status at the cap = %d, want 201 (body %s)", rec.Code, rec.Body.String())
	}
	rows := e.rows()
	if len(rows) != 1 || rows[0].sizeBytes != machines.MaxSettingsBackupBytes {
		t.Fatalf("rows at the cap = %+v, want one row of %d bytes", rows, machines.MaxSettingsBackupBytes)
	}

	rec = do(h, http.MethodPost, "/api/machine/backups/upload",
		`{"machineId":1,"document":`+docOfSize(t, machines.MaxSettingsBackupBytes+1)+`}`, "")
	if rec.Code != http.StatusBadRequest || errorCode(t, rec.Body.Bytes()) != codeInvalidBackup {
		t.Fatalf("status one byte over the cap = %d %s, want 400 invalid_backup", rec.Code, rec.Body.String())
	}
	if got := len(e.rows()); got != 1 {
		t.Fatalf("stored %d rows after an oversized document, want 1", got)
	}

	rec = do(h, http.MethodPost, "/api/machine/backups/upload",
		`{"machineId":1,"document":`+docOfSize(t, maxUploadRequestBytes)+`}`, "")
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status over the request cap = %d, want 413 (body %s)", rec.Code, rec.Body.String())
	}
	if got := len(e.rows()); got != 1 {
		t.Fatalf("stored %d rows after an oversized request, want 1", got)
	}

	// A document under the raw cap whose canonical form is over it.
	raw := `{"format":"gaggiuino-settings","version":1,"pad":"` + strings.Repeat("\u2028", 50000) + `"}`
	rec = do(h, http.MethodPost, "/api/machine/backups/upload", `{"machineId":1,"document":`+raw+`}`, "")
	if rec.Code != http.StatusBadRequest || errorCode(t, rec.Body.Bytes()) != codeInvalidBackup {
		t.Fatalf("status for an over-cap canonical form = %d %s, want 400 invalid_backup", rec.Code, rec.Body.String())
	}
	if got := len(e.rows()); got != 1 {
		t.Fatalf("stored %d rows after an over-cap canonical form, want 1", got)
	}
}

func TestDownloadAndUpload_RateLimitsPerIP(t *testing.T) {
	_, h := newHandlerEnv(t, gaggiuinoMachine(1))

	for i := 0; i < downloadPerMinute; i++ {
		rec := do(h, http.MethodGet, "/api/machine/backups/99/download", "", "192.0.2.1:1234")
		if rec.Code != http.StatusNotFound {
			t.Fatalf("download %d status = %d, want 404", i+1, rec.Code)
		}
	}
	if rec := do(h, http.MethodGet, "/api/machine/backups/99/download", "", "192.0.2.1:1234"); rec.Code != http.StatusTooManyRequests {
		t.Fatalf("download over the limit status = %d, want 429", rec.Code)
	}
	if rec := do(h, http.MethodGet, "/api/machine/backups/99/download", "", "192.0.2.2:1234"); rec.Code != http.StatusNotFound {
		t.Fatalf("download from another IP status = %d, want 404", rec.Code)
	}

	// Upload has its own bucket.
	if rec := do(h, http.MethodPost, "/api/machine/backups/upload", `{`, "192.0.2.1:1234"); rec.Code != http.StatusBadRequest {
		t.Fatalf("upload after the download limit status = %d, want 400", rec.Code)
	}
	for i := 1; i < uploadPerMinute; i++ {
		rec := do(h, http.MethodPost, "/api/machine/backups/upload", `{`, "192.0.2.1:1234")
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("upload %d status = %d, want 400", i+1, rec.Code)
		}
	}
	if rec := do(h, http.MethodPost, "/api/machine/backups/upload", `{`, "192.0.2.1:1234"); rec.Code != http.StatusTooManyRequests {
		t.Fatalf("upload over the limit status = %d, want 429 (the limit comes before the body)", rec.Code)
	}
}
