package machines

import (
	"context"
	"encoding/json"
	"strconv"
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

// TestGaggiuinoAdapter_GetStatusSetsBrewingFlag is the #1568 review fix for the
// Gaggiuino side: GetStatus must flag the host as brewing when the machine
// reports brewSwitchState, so its subsequent counted requests split into the
// brewing bucket instead of all being filed as idle.
func TestGaggiuinoAdapter_GetStatusSetsBrewingFlag(t *testing.T) {
	allowLoopbackMachineHost(t)
	counter := perfstats.NewMachineCounter()
	SetMachineTrafficCounter(counter)
	t.Cleanup(func() { SetMachineTrafficCounter(nil) })

	fake := newFakeGaggiuinoMachine() // /api/system/status reports brewSwitchState:true
	defer fake.Close()
	a := NewGaggiuinoAdapter(newGaggiuinoLiveClient(sse.NewHub()))

	host := hostFromBaseURL(fake.URL)
	if _, err := a.GetStatus(context.Background(), testMachine(fake.URL)); err != nil {
		t.Fatalf("GetStatus: %v", err)
	}
	// The status request itself was counted while the flag was still false, so it
	// is idle; the next counted request must be brewing.
	countMachineRequest(host, false)

	snap := counter.Snapshot(time.Now(), func(h string) (int64, bool) { return 1, h == host })
	if len(snap) != 1 || snap[0].MachineID != 1 || snap[0].RequestsPerMinBrewing <= 0 {
		t.Fatalf("expected a counted request in the brewing bucket after GetStatus, got %+v", snap)
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
