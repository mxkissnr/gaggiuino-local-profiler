package system

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/db"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/ha"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines/proto"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/sse"
)

// testAPIToken is the fixed X-GLP-Token every test in this package's
// Handlers are constructed with — a fake value (not a real
// auth.LoadOrCreateToken result), used only so getToken/getStatus's
// auth.IsTokenValid checks have something deterministic to compare
// against.
const testAPIToken = "test-token-not-a-real-secret"

// newTestDB opens a throwaway on-disk SQLite DB, same fixture pattern
// every other domain package's tests use (see e.g.
// internal/machines/helpers_test.go's newTestRegistry).
func newTestDB(t *testing.T) *sql.DB {
	t.Helper()
	dbPath := filepath.Join(t.TempDir(), "glp.db")
	sqlDB, err := db.Open(dbPath)
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { sqlDB.Close() })
	return sqlDB
}

// fakeAdapter is a hand-written stand-in for machines.Adapter — the "fake
// machine adapter" half of the task brief's test-harness ask. It sidesteps
// internal/machines' real SSRF guard entirely (a loopback httptest.Server,
// the obvious alternative, is exactly what that guard exists to reject for
// a real machine host — see internal/machines/ssrf.go/helpers_test.go's
// own allowLoopbackMachineHost seam, which is unexported and not reachable
// from this package). Only GetStatus/GetLiveSensorSnapshot/
// GetLiveSystemState are ever called by poll.go; every other method is a
// stub that would fail loudly (panic) if this package's code path ever
// changed to call it, rather than silently returning zero values.
type fakeAdapter struct {
	mu         sync.Mutex
	status     machines.Status
	statusErr  error
	sensorSnap *proto.SensorStateSnapshotDto
	sysState   *proto.SystemStateDto
}

var _ machines.Adapter = (*fakeAdapter)(nil)

func (f *fakeAdapter) setStatus(s machines.Status, err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.status, f.statusErr = s, err
}

// setLive sets what GetLiveSensorSnapshot/GetLiveSystemState return — the
// cached-live-WS-sample half of a poll tick. Either may be nil (no live
// transport for that half).
func (f *fakeAdapter) setLive(snap *proto.SensorStateSnapshotDto, sys *proto.SystemStateDto) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sensorSnap, f.sysState = snap, sys
}

func (f *fakeAdapter) GetStatus(ctx context.Context, m *machines.Machine) (machines.Status, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.status, f.statusErr
}

func (f *fakeAdapter) GetLiveSensorSnapshot(ctx context.Context, m *machines.Machine) (*proto.SensorStateSnapshotDto, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.sensorSnap, nil
}

func (f *fakeAdapter) GetLiveSystemState(ctx context.Context, m *machines.Machine) (*proto.SystemStateDto, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.sysState, nil
}

func (f *fakeAdapter) notImplemented(name string) error {
	panic("fakeAdapter: unexpected call to " + name)
}

func (f *fakeAdapter) ListProfiles(context.Context, *machines.Machine) ([]machines.ProfileSummary, error) {
	return nil, f.notImplemented("ListProfiles")
}
func (f *fakeAdapter) GetProfile(context.Context, *machines.Machine, string) (json.RawMessage, error) {
	return nil, f.notImplemented("GetProfile")
}
func (f *fakeAdapter) CreateProfile(context.Context, *machines.Machine, machines.ProfileInput) (machines.ProfileSummary, error) {
	return machines.ProfileSummary{}, f.notImplemented("CreateProfile")
}
func (f *fakeAdapter) UpdateProfile(context.Context, *machines.Machine, machines.ProfileInput) (machines.ProfileSummary, error) {
	return machines.ProfileSummary{}, f.notImplemented("UpdateProfile")
}
func (f *fakeAdapter) DeleteProfile(context.Context, *machines.Machine, string) ([]machines.ProfileSummary, error) {
	return nil, f.notImplemented("DeleteProfile")
}
func (f *fakeAdapter) SelectProfile(context.Context, *machines.Machine, string) error {
	return f.notImplemented("SelectProfile")
}
func (f *fakeAdapter) Capabilities() machines.Capabilities { return machines.Capabilities{} }
func (f *fakeAdapter) GetSettings(context.Context, *machines.Machine, string) (json.RawMessage, error) {
	return nil, f.notImplemented("GetSettings")
}
func (f *fakeAdapter) UpdateSettings(context.Context, *machines.Machine, string, json.RawMessage) (json.RawMessage, error) {
	return nil, f.notImplemented("UpdateSettings")
}
func (f *fakeAdapter) SaveSettings(context.Context, *machines.Machine) error {
	return f.notImplemented("SaveSettings")
}
func (f *fakeAdapter) SetOperationMode(context.Context, *machines.Machine, proto.OperationMode) error {
	return f.notImplemented("SetOperationMode")
}
func (f *fakeAdapter) Tare(context.Context, *machines.Machine) error { return f.notImplemented("Tare") }
func (f *fakeAdapter) ServiceTest(context.Context, *machines.Machine, proto.ServiceTestPeripheral) error {
	return f.notImplemented("ServiceTest")
}
func (f *fakeAdapter) SaveActiveProfile(context.Context, *machines.Machine) error {
	return f.notImplemented("SaveActiveProfile")
}
func (f *fakeAdapter) GetFirmwareProgress(context.Context, *machines.Machine) (json.RawMessage, error) {
	return nil, f.notImplemented("GetFirmwareProgress")
}
func (f *fakeAdapter) TriggerFirmwareUpdate(context.Context, *machines.Machine) (json.RawMessage, error) {
	return nil, f.notImplemented("TriggerFirmwareUpdate")
}

// fakeAdapterProvider ports this package's AdapterProvider around a single
// fakeAdapter, regardless of which machine is asked for — every test here
// only ever has the one default machine.
type fakeAdapterProvider struct{ adapter *fakeAdapter }

func (p fakeAdapterProvider) GetAdapter(m *machines.Machine) (machines.Adapter, error) {
	return p.adapter, nil
}

// okStatus builds a machines.Status with the given JSON status body as its
// Raw field (poll.go's rawStatusFrom decodes waterLevel/upTime straight
// off Raw) plus the already-parsed fields Node's own adapter would have
// extracted — mirrors gaggiuino_adapter.go's GetStatus so a test can set up
// a fake response as tersely as the real one would produce it.
func okStatus(t *testing.T, rawJSON string, temp, targetTemp, pressure float64, weight float64, brewing bool, profileName string, profileID int) machines.Status {
	t.Helper()
	pn := profileName
	pid := profileID
	w := weight
	steamOff := false
	return machines.Status{
		Reachable: true, Temperature: temp, TargetTemperature: targetTemp, Pressure: pressure,
		Weight: &w, Brewing: brewing, SteamOn: &steamOff, ProfileID: &pid, ProfileName: &pn,
		Raw: json.RawMessage(rawJSON),
	}
}

// errBoom is a generic sentinel error for tests that need GetStatus to
// fail without caring about the exact message.
var errBoom = errors.New("boom")

// machinesStatusZero returns the zero-value machines.Status, paired with
// errBoom by fake.setStatus to simulate an unreachable machine (the
// GetStatus contract error path never gives a usable Status alongside the
// error, matching gaggiuino_adapter.go's own `return Status{}, err`).
func machinesStatusZero() machines.Status { return machines.Status{} }

// newTestPoller wires a Poller around a fresh registry (default machine
// with a non-empty, but otherwise irrelevant, host — fakeAdapter never
// dials it) and the given fakeAdapter.
func newTestPoller(t *testing.T, fake *fakeAdapter) (*Poller, *sql.DB) {
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
	hub := sse.NewHub()
	haClient := newDisabledHAClient()
	return NewPoller(registry, fakeAdapterProvider{adapter: fake}, hub, haClient), sqlDB
}

// newTestPollerWithHA is newTestPoller with a caller-supplied ha.Client and
// switch entity — for tests exercising checkAndApplyMachinePower/
// checkReadyByPreheat, which need a real (fake-server-backed) HA client
// rather than the always-disabled one newTestPoller wires by default.
func newTestPollerWithHA(t *testing.T, fake *fakeAdapter, sqlDB *sql.DB, haClient *ha.Client, switchEntity string) *Poller {
	t.Helper()
	registry := machines.NewRegistry(sqlDB)
	if err := registry.EnsureDefaultMachine(); err != nil {
		t.Fatalf("EnsureDefaultMachine: %v", err)
	}
	host := "fake-machine.invalid"
	if _, err := registry.UpdateMachine(1, machines.MachineInput{Host: &host, SwitchEntity: &switchEntity}, nil); err != nil {
		t.Fatalf("UpdateMachine: %v", err)
	}
	hub := sse.NewHub()
	return NewPoller(registry, fakeAdapterProvider{adapter: fake}, hub, haClient)
}

// newRegistryForTest builds a registry with only EnsureDefaultMachine
// applied — the default machine's host stays "" (#718's "not configured"
// case), unlike newTestPoller's registry.
func newRegistryForTest(t *testing.T, sqlDB *sql.DB) *machines.Registry {
	t.Helper()
	registry := machines.NewRegistry(sqlDB)
	if err := registry.EnsureDefaultMachine(); err != nil {
		t.Fatalf("EnsureDefaultMachine: %v", err)
	}
	return registry
}

func newHubForTest() *sse.Hub { return sse.NewHub() }

// newDisabledHAClient returns an ha.Client with no HA connection
// configured (no SUPERVISOR_TOKEN/GLP_HA_URL in the test process
// environment) — every method on it degrades to its no-op/empty-result
// behavior, matching a real install with no HA integration.
func newDisabledHAClient() *ha.Client { return ha.NewClientFromEnv() }

// newSystemMux routes h's endpoints through a real *http.ServeMux — same
// pattern internal/machines/helpers_test.go's newMux uses.
func newSystemMux(h *Handlers) *http.ServeMux {
	mux := http.NewServeMux()
	h.RegisterRoutes(mux)
	return mux
}

func doGet(mux *http.ServeMux, path string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
	return rec
}

func doPost(mux *http.ServeMux, path, body string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	var req *http.Request
	if body == "" {
		req = httptest.NewRequest(http.MethodPost, path, nil)
	} else {
		req = httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
	}
	mux.ServeHTTP(rec, req)
	return rec
}

func decodeMap(t *testing.T, body []byte) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(body, &m); err != nil {
		t.Fatalf("decoding response body %q: %v", body, err)
	}
	return m
}
