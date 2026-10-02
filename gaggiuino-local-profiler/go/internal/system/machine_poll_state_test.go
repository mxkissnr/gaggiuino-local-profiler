package system

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// newMultiMachinePoller builds a poller around a fresh registry holding the
// seeded default machine (id 1, with a host the fake adapter never dials) and
// a wired shots repo, so a test can register extra machines and drive both the
// live poll (default) and the per-machine sync paths.
func newMultiMachinePoller(t *testing.T) (*Poller, *machines.Registry, *fakeAdapter, *sql.DB) {
	t.Helper()
	sqlDB := newTestDB(t)
	registry := machines.NewRegistry(sqlDB)
	if err := registry.EnsureDefaultMachine(); err != nil {
		t.Fatalf("EnsureDefaultMachine: %v", err)
	}
	host := "fake-machine.invalid"
	if _, err := registry.UpdateMachine(1, machines.MachineInput{Host: &host}, nil); err != nil {
		t.Fatalf("UpdateMachine: %v", err)
	}
	fake := &fakeAdapter{}
	p := NewPoller(registry, fakeAdapterProvider{adapter: fake}, newHubForTest(), newDisabledHAClient())
	p.SetShotsRepo(shots.NewRepository(sqlDB))
	return p, registry, fake, sqlDB
}

// TestMachinePollState_SyncErrorIsolatedPerMachine is the #1201 core proof:
// machine 2's sync failure records its own reachability/error without
// touching the default machine's StatusInfo() values.
func TestMachinePollState_SyncErrorIsolatedPerMachine(t *testing.T) {
	p, registry, fake, _ := newMultiMachinePoller(t)
	m2 := addOtherMachine(t, registry, "Second", "gaggiuino", "machine2.test", true)

	fake.setStatus(okStatus(t, `{"softwareVersion":"1.0.0"}`, 93, 94, 1, 0, false, "Espresso", 1), nil)
	p.pollViaGaggiuinoStatus(context.Background())
	if info := p.StatusInfo(); info.MachineReachable == nil || !*info.MachineReachable {
		t.Fatalf("precondition: default machine should be reachable")
	}

	// Machine 2 dials a closed port, so its sync fails on the /latest probe.
	withOtherMachineSyncServer(t, map[int64]string{m2.ID: "http://127.0.0.1:1"})
	p.syncOtherMachines(context.Background())

	info := p.StatusInfo()
	if info.MachineReachable == nil || !*info.MachineReachable {
		t.Errorf("default machine reachability changed by machine 2's error: %v", info.MachineReachable)
	}
	if info.LastMachineError != nil {
		t.Errorf("default lastMachineError changed by machine 2's error: %q", *info.LastMachineError)
	}
	if info.CachedMachineVersion == nil || *info.CachedMachineVersion != "1.0.0" {
		t.Errorf("default firmware version = %v, want 1.0.0", info.CachedMachineVersion)
	}

	st2 := p.MachineStatus(m2.ID)
	if st2.Reachable == nil || *st2.Reachable {
		t.Errorf("machine 2 reachable = %v, want false", st2.Reachable)
	}
	if st2.LastError == nil || *st2.LastError == "" {
		t.Errorf("machine 2 lastError = %v, want a non-empty error", st2.LastError)
	}
}

// TestMachinePollState_FirmwareStampedPerMachine is the #1197 point 3 /
// #1201 firmware proof: machine 2's shot carries machine 2's own cached
// version, not the default machine's.
func TestMachinePollState_FirmwareStampedPerMachine(t *testing.T) {
	p, registry, fake, sqlDB := newMultiMachinePoller(t)
	repo := shots.NewRepository(sqlDB)
	m2 := addOtherMachine(t, registry, "Second", "gaggiuino", "machine2.test", true)

	fake.setStatus(okStatus(t, `{"softwareVersion":"1.0.0"}`, 93, 94, 1, 0, false, "Espresso", 1), nil)
	p.pollViaGaggiuinoStatus(context.Background())

	srv := newSyncFakeMachine(t, `[{"lastShotId":1}]`, map[string]string{
		"1": `{"id":1,"timestamp":1000,"datapoints":[],"softwareVersion":"2.0.0"}`,
	})
	withOtherMachineSyncServer(t, map[int64]string{m2.ID: srv.URL})
	p.syncOtherMachines(context.Background())

	globalID := shots.ToGlobalShotID(m2.ID, 1)
	s, err := repo.FindByID(globalID)
	if err != nil {
		t.Fatalf("FindByID(%d): %v", globalID, err)
	}
	if s == nil {
		t.Fatalf("machine 2 shot %d missing after sync", globalID)
	}
	if got, _ := s["glpFirmwareVersion"].(string); got != "2.0.0" {
		t.Errorf("machine 2 shot firmware = %q, want 2.0.0 (machine 2's own)", got)
	}
	if st := p.MachineStatus(m2.ID); st.FirmwareVersion == nil || *st.FirmwareVersion != "2.0.0" {
		t.Errorf("machine 2 cached firmware = %v, want 2.0.0", st.FirmwareVersion)
	}
	if info := p.StatusInfo(); info.CachedMachineVersion == nil || *info.CachedMachineVersion != "1.0.0" {
		t.Errorf("default cached firmware = %v, want 1.0.0", info.CachedMachineVersion)
	}
}

// TestMachinePollState_VersionClearedOnRecovery proves the stale firmware
// cache is dropped on an unreachable->reachable transition and re-sniffed.
func TestMachinePollState_VersionClearedOnRecovery(t *testing.T) {
	// newTestPoller wires no shots repo, so the unreachable->reachable
	// transition cannot kick off the #725 catch-up sync goroutine.
	fake := &fakeAdapter{}
	p, _ := newTestPoller(t, fake)

	fake.setStatus(okStatus(t, `{"softwareVersion":"1.0.0"}`, 93, 94, 1, 0, false, "Espresso", 1), nil)
	p.pollViaGaggiuinoStatus(context.Background())
	if got := p.StatusInfo().CachedMachineVersion; got == nil || *got != "1.0.0" {
		t.Fatalf("precondition: cached version = %v, want 1.0.0", got)
	}

	fake.setStatus(machinesStatusZero(), errBoom)
	p.pollViaGaggiuinoStatus(context.Background())

	fake.setStatus(okStatus(t, `{"softwareVersion":"3.0.0"}`, 93, 94, 1, 0, false, "Espresso", 1), nil)
	p.pollViaGaggiuinoStatus(context.Background())
	if got := p.StatusInfo().CachedMachineVersion; got == nil || *got != "3.0.0" {
		t.Errorf("cached version after recovery = %v, want 3.0.0 (the stale version must be dropped)", got)
	}
}

// TestGetStatus_PerMachineFieldsAndDefaultAliases pins the /api/status
// contract: the top-level fields stay default-machine aliases while every
// machines[] entry carries its own reachable/firmwareVersion (with `on` still
// default-only). lastError is deliberately omitted from that public contract:
// it can embed the machine's host, so it is authenticated-only (see the
// RequiresToken test below).
func TestGetStatus_PerMachineFieldsAndDefaultAliases(t *testing.T) {
	p, registry, fake, sqlDB := newMultiMachinePoller(t)
	m2 := addOtherMachine(t, registry, "Second", "gaggiuino", "machine2.test", true)

	fake.setStatus(okStatus(t, `{"softwareVersion":"1.0.0"}`, 93, 94, 1, 0, false, "Espresso", 1), nil)
	p.pollViaGaggiuinoStatus(context.Background())
	p.recordMachineError(m2.ID, errors.New("machine 2 down"))

	h := NewHandlers(p, NewDemoService(sqlDB, shots.NewRepository(sqlDB), nil), testAPIToken)
	body := decodeMap(t, doGet(newSystemMux(h), "/api/status").Body.Bytes())

	if body["machineReachable"] != true {
		t.Errorf("top-level machineReachable = %v, want true (default alias)", body["machineReachable"])
	}
	if body["machineVersion"] != "1.0.0" {
		t.Errorf("top-level machineVersion = %v, want 1.0.0 (default alias)", body["machineVersion"])
	}

	machinesArr, ok := body["machines"].([]any)
	if !ok || len(machinesArr) != 2 {
		t.Fatalf("machines = %+v, want 2 entries", body["machines"])
	}
	byID := map[float64]map[string]any{}
	for _, raw := range machinesArr {
		mm, _ := raw.(map[string]any)
		id, _ := mm["id"].(float64)
		byID[id] = mm
	}

	def := byID[1]
	if def == nil {
		t.Fatalf("default machine missing from machines[]")
	}
	if def["reachable"] != true {
		t.Errorf("default machines[] reachable = %v, want true", def["reachable"])
	}
	if def["firmwareVersion"] != "1.0.0" {
		t.Errorf("default machines[] firmwareVersion = %v, want 1.0.0", def["firmwareVersion"])
	}
	if _, present := def["lastError"]; present {
		t.Errorf("default machines[] lastError = %v, want omitted", def["lastError"])
	}
	if _, present := def["on"]; !present {
		t.Errorf("default machines[] on missing")
	}

	second := byID[float64(m2.ID)]
	if second == nil {
		t.Fatalf("machine %d missing from machines[]", m2.ID)
	}
	if second["reachable"] != false {
		t.Errorf("machine 2 reachable = %v, want false", second["reachable"])
	}
	if _, present := second["lastError"]; present {
		t.Errorf("unauthenticated machine 2 lastError = %v, want omitted", second["lastError"])
	}
	if v, present := second["on"]; !present || v != nil {
		t.Errorf("machine 2 on = %v (present %v), want null (on stays default-only)", v, present)
	}
}

// TestGetStatus_PerMachineLastErrorRequiresToken proves the #1201 follow-up:
// machines[].lastError is only exposed to a caller presenting a valid
// X-GLP-Token, matching the top-level lastMachineError (H1).
func TestGetStatus_PerMachineLastErrorRequiresToken(t *testing.T) {
	p, registry, fake, sqlDB := newMultiMachinePoller(t)
	m2 := addOtherMachine(t, registry, "Second", "gaggiuino", "machine2.test", true)

	fake.setStatus(okStatus(t, `{"softwareVersion":"1.0.0"}`, 93, 94, 1, 0, false, "Espresso", 1), nil)
	p.pollViaGaggiuinoStatus(context.Background())
	p.recordMachineError(m2.ID, errors.New("machine 2 down"))

	h := NewHandlers(p, NewDemoService(sqlDB, shots.NewRepository(sqlDB), nil), testAPIToken)
	mux := newSystemMux(h)

	unauth := decodeMap(t, doGet(mux, "/api/status").Body.Bytes())
	if mm := statusMachineByID(t, unauth, m2.ID); mm == nil {
		t.Fatalf("unauthenticated machines[] missing machine %d", m2.ID)
	} else if _, present := mm["lastError"]; present {
		t.Errorf("unauthenticated machine 2 lastError = %v, want omitted", mm["lastError"])
	}

	req := httptest.NewRequest(http.MethodGet, "/api/status", nil)
	req.Header.Set("X-GLP-Token", testAPIToken)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	authBody := decodeMap(t, rec.Body.Bytes())
	authSecond := statusMachineByID(t, authBody, m2.ID)
	if authSecond == nil {
		t.Fatalf("authenticated machines[] missing machine %d", m2.ID)
	}
	if authSecond["lastError"] != "machine 2 down" {
		t.Errorf("authenticated machine 2 lastError = %v, want %q", authSecond["lastError"], "machine 2 down")
	}
	if authDef := statusMachineByID(t, authBody, 1); authDef != nil {
		if _, present := authDef["lastError"]; present {
			t.Errorf("authenticated default lastError = %v, want omitted (no recorded error)", authDef["lastError"])
		}
	}
}

// statusMachineByID returns the machines[] entry with the given id, failing
// the test if the machines field itself is malformed. It returns nil when the
// id is absent so callers can assert on presence.
func statusMachineByID(t *testing.T, body map[string]any, id int64) map[string]any {
	t.Helper()
	arr, ok := body["machines"].([]any)
	if !ok {
		t.Fatalf("machines = %+v, want array", body["machines"])
	}
	for _, raw := range arr {
		mm, _ := raw.(map[string]any)
		if got, _ := mm["id"].(float64); got == float64(id) {
			return mm
		}
	}
	return nil
}
