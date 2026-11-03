package machinebackups

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
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
