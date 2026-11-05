package machines

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines/proto"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/perfstats"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/sse"
)

func testMachine(host string) *Machine {
	return &Machine{ID: 1, Name: "Test", Type: "gaggiuino", Host: host, Enabled: true}
}

func TestGaggiuinoAdapter_GetStatus(t *testing.T) {
	allowLoopbackMachineHost(t)
	fake := newFakeGaggiuinoMachine()
	defer fake.Close()
	a := NewGaggiuinoAdapter(newGaggiuinoLiveClient(sse.NewHub()))

	status, err := a.GetStatus(context.Background(), testMachine(fake.URL))
	if err != nil {
		t.Fatalf("GetStatus: %v", err)
	}
	if !status.Reachable || status.Temperature != 93.5 || !status.Brewing {
		t.Fatalf("unexpected status: %+v", status)
	}
	if status.ProfileID == nil || *status.ProfileID != 1 {
		t.Fatalf("ProfileID = %v, want 1", status.ProfileID)
	}
}

func TestGaggiuinoAdapter_ProfileCRUD_ViaWebSocket(t *testing.T) {
	allowLoopbackMachineHost(t)
	fake := newFakeGaggiuinoMachine()
	fake.restProfileCreate404 = true // force CreateProfile onto the WS fallback path
	defer fake.Close()
	a := NewGaggiuinoAdapter(newGaggiuinoLiveClient(sse.NewHub()))
	m := testMachine(fake.URL)
	ctx := context.Background()

	created, err := a.CreateProfile(ctx, m, ProfileInput{Name: "Espresso", Phases: []PhaseInput{{Type: proto.PhasePressure}}})
	if err != nil {
		t.Fatalf("CreateProfile: %v", err)
	}
	if created.Name != "Espresso" || created.ID == "" {
		t.Fatalf("unexpected created profile: %+v", created)
	}

	list, err := a.ListProfiles(ctx, m)
	if err != nil {
		t.Fatalf("ListProfiles: %v", err)
	}
	if len(list) != 1 || list[0].ID != created.ID {
		t.Fatalf("ListProfiles = %+v, want [%+v]", list, created)
	}

	id64, _ := strconv.ParseInt(created.ID, 10, 64)
	updated, err := a.UpdateProfile(ctx, m, ProfileInput{ID: &id64, Name: "Espresso v2", Phases: []PhaseInput{{Type: proto.PhaseFlow}}})
	if err != nil {
		t.Fatalf("UpdateProfile: %v", err)
	}
	if updated.Name != "Espresso v2" {
		t.Fatalf("UpdateProfile name = %q, want \"Espresso v2\"", updated.Name)
	}

	remaining, err := a.DeleteProfile(ctx, m, created.ID)
	if err != nil {
		t.Fatalf("DeleteProfile: %v", err)
	}
	if len(remaining) != 0 {
		t.Fatalf("DeleteProfile remaining = %+v, want empty", remaining)
	}
}

func TestGaggiuinoAdapter_GetProfile_RESTFirstThenWSFallback(t *testing.T) {
	allowLoopbackMachineHost(t)
	fake := newFakeGaggiuinoMachine()
	defer fake.Close()
	a := NewGaggiuinoAdapter(newGaggiuinoLiveClient(sse.NewHub()))
	m := testMachine(fake.URL)

	// REST succeeds by default.
	raw, err := a.GetProfile(context.Background(), m, "5")
	if err != nil {
		t.Fatalf("GetProfile (REST): %v", err)
	}
	var profile map[string]any
	_ = json.Unmarshal(raw, &profile)
	if profile["name"] != "REST Profile" {
		t.Fatalf("expected the REST profile, got %v", profile)
	}

	// Force REST to 404 — must fall back to the WS path.
	fake.restProfileDetail404 = true
	raw, err = a.GetProfile(context.Background(), m, "5")
	if err != nil {
		t.Fatalf("GetProfile (WS fallback): %v", err)
	}
	_ = json.Unmarshal(raw, &profile)
	if profile["name"] != "WS Profile" {
		t.Fatalf("expected the WS-fallback profile, got %v", profile)
	}
}

func TestGaggiuinoAdapter_OpModeTareServiceTest(t *testing.T) {
	allowLoopbackMachineHost(t)
	fake := newFakeGaggiuinoMachine()
	defer fake.Close()
	a := NewGaggiuinoAdapter(newGaggiuinoLiveClient(sse.NewHub()))
	m := testMachine(fake.URL)
	ctx := context.Background()

	if err := a.SetOperationMode(ctx, m, proto.ModeSteam); err != nil {
		t.Fatalf("SetOperationMode: %v", err)
	}
	if err := a.Tare(ctx, m); err != nil {
		t.Fatalf("Tare: %v", err)
	}
	// c_service_test answers via d_notif, not d_resp (#600) — must still
	// resolve successfully, not time out waiting for an ack that never comes.
	if err := a.ServiceTest(ctx, m, proto.PeripheralLED); err != nil {
		t.Fatalf("ServiceTest: %v", err)
	}
	if err := a.SaveSettings(ctx, m); err != nil {
		t.Fatalf("SaveSettings: %v", err)
	}
	if err := a.SaveActiveProfile(ctx, m); err != nil {
		t.Fatalf("SaveActiveProfile: %v", err)
	}
}

// TestGaggiuinoAdapter_SettingsQuirkPassthrough is the ground-truth test
// the task brief explicitly called for: every field the Gaggiuino REST API
// encodes as the JSON *string* "true"/"false" instead of a real JSON
// boolean (boiler.brewDeltaState/dreamSteamState, display.lcdDarkMode,
// scales.forcePredictive/hwScalesEnabled/btScalesEnabled, led.state/disco
// — see glp-integration's gaggiuino_bool.py, the consumer this quirk
// exists for) must survive this package's proxy byte-for-byte in both
// directions: GetSettings must not silently "fix" a string into a real
// bool, and UpdateSettings must forward the client's exact request bytes
// unmodified rather than decoding into a typed struct and re-encoding
// (which would normalize the quirk away and break glp-integration's
// switch/light entities — see gaggiuino_adapter.go's doc comments).
func TestGaggiuinoAdapter_SettingsQuirkPassthrough(t *testing.T) {
	allowLoopbackMachineHost(t)
	quirkFields := []string{
		`"brewDeltaState":"true"`, `"dreamSteamState":"false"`,
	}
	quirkPayload := `{"brewDeltaState":"true","dreamSteamState":"false","someRealBool":true,"someNumber":93.5}`

	fake := newFakeGaggiuinoMachine()
	fake.settingsBody = []byte(quirkPayload)
	defer fake.Close()
	a := NewGaggiuinoAdapter(newGaggiuinoLiveClient(sse.NewHub()))
	m := testMachine(fake.URL)

	got, err := a.GetSettings(context.Background(), m, "boiler")
	if err != nil {
		t.Fatalf("GetSettings: %v", err)
	}
	for _, field := range quirkFields {
		if !jsonContains(string(got), field) {
			t.Errorf("GetSettings result %s does not contain expected literal %s — the string-bool quirk was normalized away", got, field)
		}
	}
	if !jsonContains(string(got), `"someRealBool":true`) {
		t.Errorf("GetSettings result %s lost a genuine boolean field", got)
	}

	// Now the write direction: POST a body containing the same quirk shape
	// and confirm the exact bytes reached the machine unmodified.
	writeBody := []byte(`{"brewDeltaState":"false","dreamSteamState":"true","someRealBool":false}`)
	if _, err := a.UpdateSettings(context.Background(), m, "boiler", writeBody); err != nil {
		t.Fatalf("UpdateSettings: %v", err)
	}
	fake.mu.Lock()
	captured := string(fake.lastUpdateSettingsBody)
	fake.mu.Unlock()
	if captured != string(writeBody) {
		t.Fatalf("machine received %s, want the exact client bytes %s", captured, writeBody)
	}
}

// jsonContains is a crude but sufficient substring check — safe here
// because the fixture bodies are hand-written literals with a known
// formatting, and the point of this test is exactly that formatting must
// NOT change across the proxy.
func jsonContains(haystack, needle string) bool {
	return len(haystack) >= len(needle) && indexOf(haystack, needle) >= 0
}

func indexOf(s, substr string) int {
	for i := 0; i+len(substr) <= len(s); i++ {
		if s[i:i+len(substr)] == substr {
			return i
		}
	}
	return -1
}

// TestGaggiuinoAdapter_GetLiveSnapshot_SSRFGuarded is the #901 code-review
// regression test: GetLiveSensorSnapshot/GetLiveSystemState previously
// built their base URL via the unguarded normalizeBaseURL instead of
// BaseURLFor, bypassing assertMachineHost entirely for these two methods
// while every other adapter method went through it. Deliberately does NOT
// call allowLoopbackMachineHost — the fake machine server is an
// httptest.Server bound to 127.0.0.1, a loopback address the real SSRF
// guard must reject, exercising the actual assertMachineHost path rather
// than a stubbed-out one.
func TestGaggiuinoAdapter_GetLiveSnapshot_SSRFGuarded(t *testing.T) {
	fake := newFakeGaggiuinoMachine()
	defer fake.Close()
	a := NewGaggiuinoAdapter(newGaggiuinoLiveClient(sse.NewHub()))
	m := testMachine(fake.URL)
	ctx := context.Background()

	if snap, err := a.GetLiveSensorSnapshot(ctx, m); err == nil || !isSSRFBlocked(err) {
		t.Fatalf("GetLiveSensorSnapshot(loopback host) = (%v, %v), want an ErrBlocked error", snap, err)
	}
	if state, err := a.GetLiveSystemState(ctx, m); err == nil || !isSSRFBlocked(err) {
		t.Fatalf("GetLiveSystemState(loopback host) = (%v, %v), want an ErrBlocked error", state, err)
	}
}

func TestGaggiuinoAdapter_Firmware(t *testing.T) {
	allowLoopbackMachineHost(t)
	fake := newFakeGaggiuinoMachine()
	defer fake.Close()
	a := NewGaggiuinoAdapter(newGaggiuinoLiveClient(sse.NewHub()))
	m := testMachine(fake.URL)

	progress, err := a.GetFirmwareProgress(context.Background(), m)
	if err != nil {
		t.Fatalf("GetFirmwareProgress: %v", err)
	}
	if !jsonContains(string(progress), `"status":"IDLE"`) {
		t.Fatalf("unexpected firmware progress: %s", progress)
	}

	result, err := a.TriggerFirmwareUpdate(context.Background(), m)
	if err != nil {
		t.Fatalf("TriggerFirmwareUpdate: %v", err)
	}
	if !jsonContains(string(result), `"success":true`) {
		t.Fatalf("unexpected firmware update result: %s", result)
	}
}

// TestWSReadCountsMachineTraffic is the #1568 review fix for the short-lived
// Gaggiuino WebSocket client: every message read in ws.go must increment the
// machine-traffic WS counter, the same way the two live clients do.
func TestWSReadCountsMachineTraffic(t *testing.T) {
	allowLoopbackMachineHost(t)
	counter := perfstats.NewMachineCounter()
	SetMachineTrafficCounter(counter)
	t.Cleanup(func() { SetMachineTrafficCounter(nil) })

	fake := newFakeGaggiuinoMachine()
	defer fake.Close()

	host := hostFromBaseURL(fake.URL)
	if _, err := wsGetProfileByID(context.Background(), fake.URL, 5); err != nil {
		t.Fatalf("wsGetProfileByID: %v", err)
	}

	snap := counter.Snapshot(time.Now(), func(h string) (int64, bool) { return 1, h == host })
	if len(snap) != 1 || snap[0].MachineID != 1 || snap[0].WSMessagesPerMin <= 0 {
		t.Fatalf("expected the WebSocket response to be counted, got %+v", snap)
	}
}

// TestGaggiuinoAdapter_ListProfiles_MalformedResponseErrors pins #1610: a
// machine that answers GET /api/profiles/all with something that is not a
// JSON array — a firmware bug, a proxy error page, a truncated body — must
// surface an error, not be silently reported as an empty profile list. The
// handler relies on that error to fall back to the local cache instead of
// pruning every synced local row.
func TestGaggiuinoAdapter_ListProfiles_MalformedResponseErrors(t *testing.T) {
	allowLoopbackMachineHost(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/profiles/all" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/plain")
		fmt.Fprint(w, "not json")
	}))
	defer srv.Close()

	a := NewGaggiuinoAdapter(newGaggiuinoLiveClient(sse.NewHub()))
	if _, err := a.ListProfiles(context.Background(), testMachine(srv.URL)); err == nil {
		t.Fatal("ListProfiles with a non-JSON body returned nil error; want an error so the handler keeps the local cache")
	}
}

// TestGaggiuinoAdapter_ProfileActionsRejectNonNumericIDs pins #1747: profile
// ids are unsigned integers on the wire, so a non-numeric id must be rejected
// before any request reaches the machine.
func TestGaggiuinoAdapter_ProfileActionsRejectNonNumericIDs(t *testing.T) {
	allowLoopbackMachineHost(t)
	var requests int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&requests, 1)
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"id":5,"name":"REST Profile"}`)
	}))
	defer srv.Close()

	a := NewGaggiuinoAdapter(newGaggiuinoLiveClient(sse.NewHub()))
	m := testMachine(srv.URL)
	ctx := context.Background()

	for _, id := range []string{"abc", "1/../x", "-1", "4294967296"} {
		if _, err := a.GetProfile(ctx, m, id); err == nil {
			t.Errorf("GetProfile(%q) returned nil error", id)
		}
		if _, err := a.DeleteProfile(ctx, m, id); err == nil {
			t.Errorf("DeleteProfile(%q) returned nil error", id)
		}
		if err := a.SelectProfile(ctx, m, id); err == nil {
			t.Errorf("SelectProfile(%q) returned nil error", id)
		}
	}
	if got := atomic.LoadInt32(&requests); got != 0 {
		t.Fatalf("machine received %d request(s) for invalid ids; want 0", got)
	}

	// A numeric id still reaches the machine as before.
	if _, err := a.GetProfile(ctx, m, "5"); err != nil {
		t.Fatalf("GetProfile(\"5\"): %v", err)
	}
	if err := a.SelectProfile(ctx, m, "5"); err != nil {
		t.Fatalf("SelectProfile(\"5\"): %v", err)
	}

	fake := newFakeGaggiuinoMachine()
	defer fake.Close()
	if _, err := a.DeleteProfile(ctx, testMachine(fake.URL), "5"); err != nil {
		t.Fatalf("DeleteProfile(\"5\"): %v", err)
	}
}

// TestGaggiuinoAdapter_GetSettingsBackup pins #1878: the settings backup is
// fetched byte-for-byte, an older firmware's 404 maps to
// ErrSettingsBackupUnsupported, a non-404 error never carries the machine's
// response body (it can contain secrets), and an over-cap document is
// rejected.
func TestGaggiuinoAdapter_GetSettingsBackup(t *testing.T) {
	allowLoopbackMachineHost(t)

	status := http.StatusOK
	body := []byte(`{"format":"gaggiuino-settings","version":1}`)
	want := append([]byte(nil), body...)
	var mu sync.Mutex
	reply := func(w http.ResponseWriter) {
		mu.Lock()
		defer mu.Unlock()
		w.WriteHeader(status)
		w.Write(body)
	}
	setReply := func(newStatus int, newBody []byte) {
		mu.Lock()
		defer mu.Unlock()
		status, body = newStatus, newBody
	}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/api/settings/backup" {
			http.NotFound(w, r)
			return
		}
		reply(w)
	}))
	defer srv.Close()

	a := NewGaggiuinoAdapter(newGaggiuinoLiveClient(sse.NewHub()))
	m := testMachine(srv.URL)
	ctx := context.Background()

	got, err := a.GetSettingsBackup(ctx, m)
	if err != nil {
		t.Fatalf("GetSettingsBackup: %v", err)
	}
	if string(got) != string(want) {
		t.Fatalf("GetSettingsBackup body = %q, want %q", got, want)
	}

	setReply(http.StatusNotFound, nil)
	if _, err := a.GetSettingsBackup(ctx, m); !errors.Is(err, ErrSettingsBackupUnsupported) {
		t.Fatalf("404 error = %v, want ErrSettingsBackupUnsupported", err)
	}

	setReply(http.StatusInternalServerError, []byte(`{"error":"SECRET-in-error-body"}`))
	_, err = a.GetSettingsBackup(ctx, m)
	if err == nil {
		t.Fatal("500 response returned nil error")
	}
	if strings.Contains(err.Error(), "SECRET-in-error-body") {
		t.Fatalf("error leaks the machine's response body: %v", err)
	}

	setReply(http.StatusOK, bytes.Repeat([]byte("a"), MaxSettingsBackupBytes))
	got, err = a.GetSettingsBackup(ctx, m)
	if err != nil {
		t.Fatalf("GetSettingsBackup at the size cap: %v", err)
	}
	if len(got) != MaxSettingsBackupBytes {
		t.Fatalf("GetSettingsBackup at the size cap returned %d bytes, want %d", len(got), MaxSettingsBackupBytes)
	}

	setReply(http.StatusOK, bytes.Repeat([]byte("a"), MaxSettingsBackupBytes+1))
	if _, err := a.GetSettingsBackup(ctx, m); !errors.Is(err, ErrSettingsBackupTooLarge) {
		t.Fatalf("oversized document error = %v, want ErrSettingsBackupTooLarge", err)
	}
}

// TestGaggiuinoAdapter_RestoreSettingsBackup pins the request shape the
// machine's own web UI uses on main-8aaf6f0 (#1878), because that shape is not
// in the public REST docs: POST /api/settings/backup, application/json, the
// document byte for byte. The success answer is undocumented, so any 2xx is
// accepted; a non-2xx keeps only a short JSON "error" text, never the rest of
// the answer (it could echo the posted document, which holds secrets).
func TestGaggiuinoAdapter_RestoreSettingsBackup(t *testing.T) {
	allowLoopbackMachineHost(t)

	doc := []byte(`{"format":"gaggiuino-settings","version":1,"wifi":{"password":"SECRET-p"},"settings":{"boiler":{"offset":93.50}},"profiles":[{"name":"Bloom <b>&co"}]}`)

	var mu sync.Mutex
	status := http.StatusOK
	body := []byte{}
	hijack := false
	calls := 0
	var methods, paths, contentTypes []string
	var bodies [][]byte
	setReply := func(newStatus int, newBody []byte) {
		mu.Lock()
		defer mu.Unlock()
		status, body = newStatus, newBody
	}
	count := func() int {
		mu.Lock()
		defer mu.Unlock()
		return calls
	}
	lastMethod := func() string {
		mu.Lock()
		defer mu.Unlock()
		if len(methods) == 0 {
			return ""
		}
		return methods[len(methods)-1]
	}
	lastPath := func() string {
		mu.Lock()
		defer mu.Unlock()
		if len(paths) == 0 {
			return ""
		}
		return paths[len(paths)-1]
	}
	lastContentType := func() string {
		mu.Lock()
		defer mu.Unlock()
		if len(contentTypes) == 0 {
			return ""
		}
		return contentTypes[len(contentTypes)-1]
	}
	lastBody := func() []byte {
		mu.Lock()
		defer mu.Unlock()
		if len(bodies) == 0 {
			return nil
		}
		return bodies[len(bodies)-1]
	}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got, _ := io.ReadAll(r.Body)
		mu.Lock()
		calls++
		methods = append(methods, r.Method)
		paths = append(paths, r.URL.Path)
		contentTypes = append(contentTypes, r.Header.Get("Content-Type"))
		bodies = append(bodies, got)
		drop := hijack
		st, b := status, body
		mu.Unlock()
		if drop {
			conn, _, err := w.(http.Hijacker).Hijack()
			if err == nil {
				conn.Close()
			}
			return
		}
		w.WriteHeader(st)
		_, _ = w.Write(b)
	}))
	defer srv.Close()

	a := NewGaggiuinoAdapter(newGaggiuinoLiveClient(sse.NewHub()))
	m := testMachine(srv.URL)
	ctx := context.Background()

	if err := a.RestoreSettingsBackup(ctx, m, doc); err != nil {
		t.Fatalf("RestoreSettingsBackup: %v", err)
	}
	if count() != 1 {
		t.Fatalf("requests = %d, want 1", count())
	}
	if lastMethod() != http.MethodPost || lastPath() != "/api/settings/backup" {
		t.Fatalf("request = %s %s, want POST /api/settings/backup", lastMethod(), lastPath())
	}
	if lastContentType() != "application/json" {
		t.Fatalf("Content-Type = %q, want application/json", lastContentType())
	}
	if !bytes.Equal(lastBody(), doc) {
		t.Fatalf("posted body = %q, want the document byte for byte", lastBody())
	}

	setReply(http.StatusOK, []byte(`{"ok":true}`))
	if err := a.RestoreSettingsBackup(ctx, m, doc); err != nil {
		t.Fatalf("200 with a body: %v", err)
	}
	setReply(http.StatusNoContent, nil)
	if err := a.RestoreSettingsBackup(ctx, m, doc); err != nil {
		t.Fatalf("204: %v", err)
	}

	setReply(http.StatusBadRequest, []byte(`{"error":"Invalid backup"}`))
	var refused *SettingsRestoreError
	err := a.RestoreSettingsBackup(ctx, m, doc)
	if !errors.As(err, &refused) {
		t.Fatalf("400 error = %v, want *SettingsRestoreError", err)
	}
	if refused.Status != http.StatusBadRequest || refused.Message != "Invalid backup" {
		t.Fatalf("refusal = %d %q, want 400 Invalid backup", refused.Status, refused.Message)
	}
	if !strings.Contains(err.Error(), "400") || strings.Contains(err.Error(), "Invalid backup") {
		t.Fatalf("Error() = %q, want the status but not the machine's text", err.Error())
	}

	setReply(http.StatusInternalServerError, []byte(`{"error":"bad","echo":"SECRET-p"}`))
	refused = nil
	err = a.RestoreSettingsBackup(ctx, m, doc)
	if !errors.As(err, &refused) || refused.Message != "bad" {
		t.Fatalf("500 error = %v, want the machine's error text", err)
	}
	if strings.Contains(err.Error(), "SECRET") {
		t.Fatalf("Error() leaks the machine's answer: %v", err)
	}

	setReply(http.StatusInternalServerError, []byte(`SECRET-raw, not json`))
	refused = nil
	err = a.RestoreSettingsBackup(ctx, m, doc)
	if !errors.As(err, &refused) || refused.Message != "" {
		t.Fatalf("non-JSON answer = %v, want an empty message", err)
	}
	if strings.Contains(err.Error(), "SECRET") {
		t.Fatalf("Error() leaks the machine's answer: %v", err)
	}

	setReply(http.StatusRequestEntityTooLarge, []byte(`{"error":"`+strings.Repeat("x", 300)+`"}`))
	refused = nil
	err = a.RestoreSettingsBackup(ctx, m, doc)
	if !errors.As(err, &refused) || refused.Message != "" {
		t.Fatalf("cut answer = %v, want an empty message", err)
	}

	before := count()
	if err := a.RestoreSettingsBackup(ctx, m, bytes.Repeat([]byte("a"), MaxSettingsBackupBytes)); err != nil {
		t.Fatalf("document at the size cap: %v", err)
	}
	if count() != before+1 {
		t.Fatalf("the document at the size cap was not posted (%d calls)", count()-before)
	}

	before = count()
	if err := a.RestoreSettingsBackup(ctx, m, bytes.Repeat([]byte("a"), MaxSettingsBackupBytes+1)); !errors.Is(err, ErrSettingsBackupTooLarge) {
		t.Fatalf("oversized document error = %v, want ErrSettingsBackupTooLarge", err)
	}
	if err := a.RestoreSettingsBackup(ctx, m, nil); err == nil {
		t.Fatal("an empty document returned nil error")
	}
	if count() != before {
		t.Fatalf("an empty or oversized document reached the machine (%d calls)", count()-before)
	}

	mu.Lock()
	hijack = true
	mu.Unlock()
	err = a.RestoreSettingsBackup(ctx, m, doc)
	refused = nil
	if err == nil {
		t.Fatal("a dropped connection returned nil error")
	}
	if errors.As(err, &refused) {
		t.Fatalf("a dropped connection became a refusal: %v", err)
	}
}
