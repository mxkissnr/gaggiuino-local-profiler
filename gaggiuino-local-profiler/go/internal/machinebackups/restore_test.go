package machinebackups

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines/proto"
)

// ── restore helpers ─────────────────────────────────────────────────────

// fakeRestorer is a fakeClient with the three methods a restore needs on top of
// Client, so a case can make one read or the post fail on its own.
type fakeRestorer struct {
	*fakeClient
	sysState    *proto.SystemStateDto // nil: no fresh live state
	sysErr      error
	progress    string
	progressErr error
	restoreErr  error
	posted      [][]byte // every RestoreSettingsBackup call, also failed ones
}

func (f *fakeRestorer) GetLiveSystemState(context.Context, *machines.Machine) (*proto.SystemStateDto, error) {
	return f.sysState, f.sysErr
}

func (f *fakeRestorer) GetFirmwareProgress(context.Context, *machines.Machine) (json.RawMessage, error) {
	if f.progressErr != nil {
		return nil, f.progressErr
	}
	return json.RawMessage(f.progress), nil
}

func (f *fakeRestorer) RestoreSettingsBackup(_ context.Context, _ *machines.Machine, body []byte) error {
	f.posted = append(f.posted, append([]byte(nil), body...))
	return f.restoreErr
}

// idleRestorer is a fakeRestorer whose machine may take a restore.
func idleRestorer(docs ...string) *fakeRestorer {
	return &fakeRestorer{
		fakeClient: &fakeClient{docs: docs},
		sysState:   &proto.SystemStateDto{OperationMode: proto.ModeHome},
		progress:   `{"status":"IDLE","progress":0,"migration":{"active":false,"state":"complete"}}`,
	}
}

type restoreEnv struct {
	*testEnv
	h        http.Handler
	clients  map[int64]Client
	profiles *machines.ProfilesRepository
}

func newRestoreEnv(t *testing.T, list ...machines.Machine) *restoreEnv {
	t.Helper()
	e := newTestEnv(t, list...)
	re := &restoreEnv{
		testEnv:  e,
		clients:  map[int64]Client{},
		profiles: machines.NewProfilesRepository(e.db),
	}
	s := NewRestore(RestoreDeps{
		Repo:     re.repo,
		Machines: fakeGetter(list),
		Client: func(m *machines.Machine) (Client, bool) {
			c, ok := re.clients[m.ID]
			return c, ok
		},
		Profiles: re.profiles,
	})
	mux := http.NewServeMux()
	s.RegisterRoutes(mux)
	re.h = mux
	return re
}

func (re *restoreEnv) post(id, machineID int64, remoteAddr string) *httptest.ResponseRecorder {
	body := `{"machineId":` + itoa(machineID) + `}`
	return do(re.h, http.MethodPost, backupURL(id, "/restore"), body, remoteAddr)
}

func itoa(n int64) string { return strconv.FormatInt(n, 10) }

func restoreError(t *testing.T, body []byte) (code, reason, machineError string) {
	t.Helper()
	var e struct {
		Error        string `json:"error"`
		Code         string `json:"code"`
		Reason       string `json:"reason"`
		MachineError string `json:"machineError"`
	}
	if err := json.Unmarshal(body, &e); err != nil {
		t.Fatalf("decoding restore error body: %v (body %s)", err, body)
	}
	return e.Code, e.Reason, e.MachineError
}

func (re *restoreEnv) seedSynced(machineID int64, remoteID string) {
	re.t.Helper()
	if err := re.profiles.UpsertSynced(machineID, remoteID, "P"+remoteID, json.RawMessage(`{}`), false); err != nil {
		re.t.Fatalf("seeding synced profile: %v", err)
	}
}

func strPtr(s string) *string { return &s }

// assertLocksFree checks both per-machine locks of machineID are released.
func (re *restoreEnv) assertLocksFree(t *testing.T, machineID int64) {
	t.Helper()
	mu := re.repo.machineLock(machineID)
	if !mu.TryLock() {
		t.Errorf("machine %d's backup lock is still held", machineID)
	} else {
		mu.Unlock()
	}
	pmu := re.profiles.MachineLock(machineID)
	if !pmu.TryLock() {
		t.Errorf("machine %d's profile lock is still held", machineID)
	} else {
		pmu.Unlock()
	}
}

// ── restore ─────────────────────────────────────────────────────────────

func TestRestore_PostsTheStoredDocumentWithTheMachinesCurrentSecrets(t *testing.T) {
	re := newRestoreEnv(t, gaggiuinoMachine(1), gaggiuinoMachine(3))
	r1 := idleRestorer(currentMachineDoc())
	r3 := idleRestorer(fixtureDoc)
	re.clients[1] = r1
	re.clients[3] = r3

	entry := re.seedBackup(1, KindManual)
	re.seedSynced(1, "3")
	re.seedSynced(1, "5")
	re.seedSynced(3, "3")
	rowsBefore := len(re.rows())

	rec := re.post(entry.ID, 1, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
	if got := strings.TrimSpace(rec.Body.String()); got != `{"ok":true,"restarting":true}` {
		t.Fatalf("body = %s, want {ok:true,restarting:true}", got)
	}

	if len(r1.posted) != 1 {
		t.Fatalf("machine 1 got %d posts, want 1", len(r1.posted))
	}
	posted := r1.posted[0]
	var doc map[string]any
	dec := json.NewDecoder(bytes.NewReader(posted))
	dec.UseNumber()
	if err := dec.Decode(&doc); err != nil {
		t.Fatalf("decoding the posted document: %v", err)
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
		if !bytes.Contains(posted, []byte(want)) {
			t.Errorf("posted document lost the stored value %s: %s", want, posted)
		}
	}
	for _, unwanted := range []string{`"steamSetPoint":146`, "other.local"} {
		if bytes.Contains(posted, []byte(unwanted)) {
			t.Errorf("posted document carries the machine's newer value %s: %s", unwanted, posted)
		}
	}
	reprepared, err := prepare(posted)
	if err != nil {
		t.Fatalf("prepare the posted document: %v", err)
	}
	if reprepared.Hash != entry.ContentHash {
		t.Errorf("posted document hash = %q, want the stored hash %q", reprepared.Hash, entry.ContentHash)
	}

	if r1.statusCalls != 1 || r1.backupCalls != 1 {
		t.Errorf("machine 1 calls = %d status, %d backup; want 1 each", r1.statusCalls, r1.backupCalls)
	}
	if r3.statusCalls != 0 || r3.backupCalls != 0 || len(r3.posted) != 0 {
		t.Errorf("the restore contacted machine 3 (%d status, %d backup, %d posts)",
			r3.statusCalls, r3.backupCalls, len(r3.posted))
	}

	if rows, err := re.profiles.ListByMachine(1); err != nil || len(rows) != 0 {
		t.Errorf("machine 1 profile cache = %d rows (err %v), want none", len(rows), err)
	}
	if rows, err := re.profiles.ListByMachine(3); err != nil || len(rows) != 1 {
		t.Errorf("machine 3 profile cache = %d rows (err %v), want 1", len(rows), err)
	}

	rows := re.rows()
	if len(rows) != rowsBefore {
		t.Fatalf("stored rows = %d, want %d: a restore must not store anything", len(rows), rowsBefore)
	}
	if rows[0].contentHash != entry.ContentHash {
		t.Errorf("stored row hash = %q, want %q", rows[0].contentHash, entry.ContentHash)
	}
	assertNoSecretMarker(t, "stored row", []byte(rows[0].data))

	assertNoSecretMarker(t, "response", rec.Body.Bytes())
	logs := re.logs.Bytes()
	if !bytes.Contains(logs, []byte("restored backup 1 onto machine 1")) {
		t.Errorf("log does not mention the restore: %s", logs)
	}
	assertNoSecretMarker(t, "log", logs)
	if bytes.Contains(logs, []byte("192.168.1.50")) {
		t.Errorf("log leaks the machine host: %s", logs)
	}

	re.assertLocksFree(t, 1)
	assertDBFilesHaveNoSecret(t, re.testEnv)
}

func TestRestore_RefusesAndSendsNothing(t *testing.T) {
	// pendingDelete seeds one synced profile and marks it pending_delete, the
	// third shape of an unsent change.
	pendingDelete := func(re *restoreEnv, _ *fakeRestorer) {
		re.seedSynced(1, "5")
		if err := re.profiles.MarkPendingDelete(1, "5"); err != nil {
			re.t.Fatalf("marking pending delete: %v", err)
		}
	}

	cases := []struct {
		name       string
		mutate     func(*restoreEnv, *fakeRestorer)
		entryOn    int64
		body       string
		path       string
		status     int
		code       string
		reason     string
		machineErr string
		posts      int
		noContact  bool
	}{
		// busy
		{name: "brewing", mutate: func(_ *restoreEnv, r *fakeRestorer) { r.status = machines.Status{Brewing: true} }, status: 409, code: codeMachineBusy, reason: reasonBrew},
		{name: "steaming", mutate: func(_ *restoreEnv, r *fakeRestorer) { r.status = machines.Status{SteamOn: boolPtr(true)} }, status: 409, code: codeMachineBusy, reason: reasonSteam},
		{name: "descaling", mutate: func(_ *restoreEnv, r *fakeRestorer) { r.sysState.OperationMode = proto.ModeDescale }, status: 409, code: codeMachineBusy, reason: reasonDescale},
		{name: "firmware in progress", mutate: func(_ *restoreEnv, r *fakeRestorer) { r.progress = `{"status":"IN_PROGRESS"}` }, status: 409, code: codeMachineBusy, reason: reasonFirmwareUpdate},
		{name: "firmware in progress lower case", mutate: func(_ *restoreEnv, r *fakeRestorer) { r.progress = `{"status":"in_progress"}` }, status: 409, code: codeMachineBusy, reason: reasonFirmwareUpdate},
		{name: "migration active", mutate: func(_ *restoreEnv, r *fakeRestorer) { r.progress = `{"status":"IDLE","migration":{"active":true}}` }, status: 409, code: codeMachineBusy, reason: reasonFirmwareUpdate},
		{name: "migration working", mutate: func(_ *restoreEnv, r *fakeRestorer) {
			r.progress = `{"status":"SUCCESS","migration":{"active":false,"state":"Working"}}`
		}, status: 409, code: codeMachineBusy, reason: reasonFirmwareUpdate},

		// unreadable
		{name: "status error", mutate: func(_ *restoreEnv, r *fakeRestorer) { r.statusErr = errTestOffline }, status: 502, code: codeMachineUnreachable},
		{name: "live state error", mutate: func(_ *restoreEnv, r *fakeRestorer) { r.sysErr = errors.New("blocked host 192.168.1.50") }, status: 502, code: codeMachineUnreachable},
		{name: "no live state", mutate: func(_ *restoreEnv, r *fakeRestorer) { r.sysState = nil }, status: 502, code: codeMachineUnreachable},
		{name: "firmware progress error", mutate: func(_ *restoreEnv, r *fakeRestorer) { r.progressErr = errTestTransport }, status: 502, code: codeMachineUnreachable},
		{name: "firmware progress not json", mutate: func(_ *restoreEnv, r *fakeRestorer) { r.progress = `not json` }, status: 502, code: codeMachineUnreachable},
		{name: "firmware progress wrong type", mutate: func(_ *restoreEnv, r *fakeRestorer) { r.progress = `{"status":"IDLE","migration":{"active":"yes"}}` }, status: 502, code: codeMachineUnreachable},
		{name: "backup transport error", mutate: func(_ *restoreEnv, r *fakeRestorer) { r.backupErr = errTestTransport }, status: 502, code: codeMachineUnreachable},
		{name: "firmware without the endpoint", mutate: func(_ *restoreEnv, r *fakeRestorer) { r.backupErr = machines.ErrSettingsBackupUnsupported }, status: 501, code: codeUnsupportedFirmware},
		{name: "fresh backup too large", mutate: func(_ *restoreEnv, r *fakeRestorer) { r.backupErr = machines.ErrSettingsBackupTooLarge }, status: 502, code: codeInvalidBackup},
		{name: "unreadable fresh backup", mutate: func(_ *restoreEnv, r *fakeRestorer) { r.docs = []string{`{`} }, status: 502, code: codeInvalidBackup},
		{name: "fresh backup without wifi", mutate: func(_ *restoreEnv, r *fakeRestorer) {
			r.docs = []string{`{"format":"gaggiuino-settings","version":1,"settings":{"system":{"mqttPassword":"SECRET-x"}}}`}
		}, status: 502, code: codeInvalidBackup},
		{name: "fresh backup unknown version", mutate: func(_ *restoreEnv, r *fakeRestorer) {
			r.docs = []string{strings.Replace(fixtureDocReordered, `"version":1`, `"version":2`, 1)}
		}, status: 502, code: codeInvalidBackup},

		// unsent profile changes
		{name: "dirty profile", mutate: func(re *restoreEnv, _ *fakeRestorer) { re.mustUpsertDirty(1, nil, strPtr("9"), "edited") }, status: 409, code: codePendingProfileChanges, noContact: true},
		{name: "pending create", mutate: func(re *restoreEnv, _ *fakeRestorer) { re.mustUpsertDirty(1, nil, nil, "new") }, status: 409, code: codePendingProfileChanges, noContact: true},
		{name: "pending delete", mutate: pendingDelete, status: 409, code: codePendingProfileChanges, noContact: true},

		// the machine answers
		{name: "machine refuses", mutate: func(_ *restoreEnv, r *fakeRestorer) {
			r.restoreErr = &machines.SettingsRestoreError{Status: 400, Message: "Invalid\u0007 backup"}
		}, status: 502, code: codeRestoreRejected, machineErr: "Invalid backup", posts: 1},
		{name: "merged document too large", mutate: func(_ *restoreEnv, r *fakeRestorer) { r.restoreErr = machines.ErrSettingsBackupTooLarge }, status: 409, code: codeInvalidBackup, posts: 1},

		// the request itself
		{name: "bad id in the path", path: `/api/machine/backups/abc/restore`, status: 404, noContact: true},
		{name: "unknown backup", body: `{"machineId":1}`, path: backupURL(99, "/restore"), status: 404, noContact: true},
		{name: "invalid json", body: `{`, status: 400, noContact: true},
		{name: "missing machineId", body: `{}`, status: 400, noContact: true},
		{name: "machineId zero", body: `{"machineId":0}`, status: 400, noContact: true},
		{name: "another machine", body: `{"machineId":3}`, status: 404, noContact: true},
		{name: "deleted machine", entryOn: 7, body: `{"machineId":7}`, status: 404, noContact: true},
		{name: "gaggimate", entryOn: 2, status: 501, code: codeUnsupportedMachine, noContact: true},
		{name: "client without restore", entryOn: 4, status: 501, code: codeUnsupportedMachine, noContact: true},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			re := newRestoreEnv(t, gaggiuinoMachine(1), gaggimateMachine(2), gaggiuinoMachine(3), gaggiuinoMachine(4))
			r := idleRestorer(currentMachineDoc())
			other := idleRestorer(fixtureDoc)
			re.clients[1] = r
			re.clients[3] = other
			re.clients[4] = &fakeClient{docs: []string{fixtureDoc}}

			entryOn := tc.entryOn
			if entryOn == 0 {
				entryOn = 1
			}
			entry := re.seedBackup(entryOn, KindManual)
			re.seedSynced(1, "3")
			rowsBefore := len(re.rows())

			if tc.mutate != nil {
				tc.mutate(re, r)
			}

			target := backupURL(entry.ID, "/restore")
			body := tc.body
			if tc.path != "" {
				target = tc.path
			}
			if body == "" {
				body = `{"machineId":` + itoa(entry.MachineID) + `}`
			}
			rec := do(re.h, http.MethodPost, target, body, "")

			if rec.Code != tc.status {
				t.Fatalf("status = %d, want %d (body %s)", rec.Code, tc.status, rec.Body.String())
			}
			code, reason, machineError := restoreError(t, rec.Body.Bytes())
			if code != tc.code || reason != tc.reason {
				t.Errorf("error = %q reason %q, want %q reason %q", code, reason, tc.code, tc.reason)
			}
			if machineError != tc.machineErr {
				t.Errorf("machineError = %q, want %q", machineError, tc.machineErr)
			}
			if len(r.posted) != tc.posts {
				t.Errorf("machine 1 got %d posts, want %d", len(r.posted), tc.posts)
			}
			if other.statusCalls != 0 || other.backupCalls != 0 || len(other.posted) != 0 {
				t.Errorf("the restore contacted machine 3 (%d status, %d backup, %d posts)",
					other.statusCalls, other.backupCalls, len(other.posted))
			}
			if tc.noContact && r.statusCalls != 0 {
				t.Errorf("a refusal before the state check still read the status (%d calls)", r.statusCalls)
			}
			if row, err := re.profiles.GetByRemoteID(1, "3"); err != nil || row == nil {
				t.Errorf("the synced profile cache was dropped (row %v, err %v)", row, err)
			}
			re.assertLocksFree(t, 1)
			if len(re.rows()) != rowsBefore {
				t.Errorf("stored rows = %d, want %d", len(re.rows()), rowsBefore)
			}
			assertNoSecretMarker(t, "response", rec.Body.Bytes())
			assertNoSecretMarker(t, "log", re.logs.Bytes())
			if bytes.Contains(re.logs.Bytes(), []byte("192.168.1.50")) {
				t.Errorf("log leaks the machine host: %s", re.logs.Bytes())
			}
		})
	}
}

func TestRestore_LocksArePerMachine(t *testing.T) {
	re := newRestoreEnv(t, gaggiuinoMachine(1), gaggiuinoMachine(3))
	r1 := idleRestorer(currentMachineDoc())
	r3 := idleRestorer(currentMachineDoc())
	re.clients[1] = r1
	re.clients[3] = r3
	e1 := re.seedBackup(1, KindManual)
	e3 := re.seedBackup(3, KindManual)

	mu := re.repo.machineLock(1)
	mu.Lock()
	rec := re.post(e1.ID, 1, "192.0.2.21:1234")
	if rec.Code != http.StatusConflict || errorCode(t, rec.Body.Bytes()) != codeOperationRunning {
		t.Fatalf("status with the backup lock held = %d %s, want 409 operation_running", rec.Code, rec.Body.String())
	}
	if r1.statusCalls != 0 {
		t.Fatal("a locked machine was contacted")
	}
	if rec := re.post(e3.ID, 3, "192.0.2.22:1234"); rec.Code != http.StatusOK {
		t.Fatalf("another machine's restore = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
	mu.Unlock()

	pmu := re.profiles.MachineLock(1)
	pmu.Lock()
	rec = re.post(e1.ID, 1, "192.0.2.23:1234")
	if rec.Code != http.StatusConflict || errorCode(t, rec.Body.Bytes()) != codeOperationRunning {
		t.Fatalf("status with the profile lock held = %d %s, want 409 operation_running", rec.Code, rec.Body.String())
	}
	if len(r1.posted) != 0 {
		t.Fatal("a machine with a held profile lock was posted to")
	}
	pmu.Unlock()

	if rec := re.post(e1.ID, 1, "192.0.2.24:1234"); rec.Code != http.StatusOK {
		t.Fatalf("status after the locks were released = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
}

func TestRestore_NoConfirmationDropsTheProfileCache(t *testing.T) {
	re := newRestoreEnv(t, gaggiuinoMachine(1))
	r := idleRestorer(currentMachineDoc())
	r.restoreErr = errTestTransport
	re.clients[1] = r
	entry := re.seedBackup(1, KindManual)
	re.seedSynced(1, "3")

	rec := re.post(entry.ID, 1, "")
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502 (body %s)", rec.Code, rec.Body.String())
	}
	if code, _, _ := restoreError(t, rec.Body.Bytes()); code != codeNoConfirmation {
		t.Fatalf("code = %q, want %q", code, codeNoConfirmation)
	}
	if len(r.posted) != 1 {
		t.Fatalf("machine 1 got %d posts, want 1", len(r.posted))
	}
	if rows, err := re.profiles.ListByMachine(1); err != nil || len(rows) != 0 {
		t.Errorf("profile cache = %d rows (err %v), want none", len(rows), err)
	}
	logs := re.logs.Bytes()
	if !bytes.Contains(logs, []byte("got no confirmation")) {
		t.Errorf("log does not mention the missing confirmation: %s", logs)
	}
	if bytes.Contains(logs, []byte("192.168.1.50")) {
		t.Errorf("log leaks the machine host: %s", logs)
	}
	assertNoSecretMarker(t, "log", logs)
}

func TestRestore_RateLimitPerIP(t *testing.T) {
	re := newRestoreEnv(t, gaggiuinoMachine(1))
	re.clients[1] = idleRestorer(currentMachineDoc())
	for i := 0; i < restorePerMinute; i++ {
		if rec := do(re.h, http.MethodPost, backupURL(99, "/restore"), `{"machineId":1}`, "192.0.2.1:1234"); rec.Code != http.StatusNotFound {
			t.Fatalf("request %d = %d, want 404", i, rec.Code)
		}
	}
	if rec := do(re.h, http.MethodPost, backupURL(99, "/restore"), `{"machineId":1}`, "192.0.2.1:1234"); rec.Code != http.StatusTooManyRequests {
		t.Fatalf("over the limit = %d, want 429", rec.Code)
	}
	if rec := do(re.h, http.MethodPost, backupURL(99, "/restore"), `{"machineId":1}`, "192.0.2.2:1234"); rec.Code != http.StatusNotFound {
		t.Fatalf("another IP = %d, want 404", rec.Code)
	}
}

// mustUpsertDirty seeds one unsent profile change of machineID.
func (re *restoreEnv) mustUpsertDirty(machineID int64, localID *int64, remoteID *string, name string) {
	re.t.Helper()
	if _, err := re.profiles.UpsertDirty(machineID, localID, remoteID, name, json.RawMessage(`{}`)); err != nil {
		re.t.Fatalf("seeding a dirty profile: %v", err)
	}
}
