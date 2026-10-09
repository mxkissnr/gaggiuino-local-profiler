package system

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines/proto"
)

// TestPollViaGaggiuinoStatus_MachineReachable is the #655 regression test:
// a powered-off/unreachable machine must be distinguishable from an
// idle-but-reachable one via machineReachable (false vs. true), not both
// collapsing to the same "isLive: false" shape.
func TestPollViaGaggiuinoStatus_MachineReachable(t *testing.T) {
	fake := &fakeAdapter{}
	fake.setStatus(okStatus(t, `{"waterLevel":80,"upTime":1234}`, 93.5, 94, 9, 18.2, false, "Espresso", 1), nil)
	p, _ := newTestPoller(t, fake)

	p.pollViaGaggiuinoStatus(context.Background())
	ld := p.LiveData()
	if ld.MachineReachable == nil || !*ld.MachineReachable {
		t.Fatalf("MachineReachable = %v, want true after a successful poll", ld.MachineReachable)
	}
	if ld.IsLive {
		t.Errorf("IsLive = true, want false (machine not brewing)")
	}

	fake.setStatus(machinesStatusZero(), errBoom)
	p.pollViaGaggiuinoStatus(context.Background())
	ld = p.LiveData()
	if ld.MachineReachable == nil || *ld.MachineReachable {
		t.Fatalf("MachineReachable = %v, want false after a failed poll", ld.MachineReachable)
	}
	// #655: still must NOT look identical to "isLive: false, reachable" —
	// the whole point of this field.
	if ld.IsLive {
		t.Errorf("IsLive = true, want false while unreachable")
	}
}

// TestPollViaGaggiuinoStatus_NoHostConfigured_SkipsCleanly covers #718: an
// unconfigured host must never flip machineReachable at all (stays nil, not
// false) — a false machineReachable specifically claims "this host was
// contacted and didn't answer," which isn't true when there's no host to
// contact.
func TestPollViaGaggiuinoStatus_NoHostConfigured_SkipsCleanly(t *testing.T) {
	sqlDB := newTestDB(t)
	registry := newRegistryForTest(t, sqlDB)
	hub := newHubForTest()
	haClient := newDisabledHAClient()
	poller := NewPoller(registry, fakeAdapterProvider{adapter: &fakeAdapter{}}, hub, haClient)

	poller.pollViaGaggiuinoStatus(context.Background())
	ld := poller.LiveData()
	if ld.MachineReachable != nil {
		t.Fatalf("MachineReachable = %v, want nil (never checked) when no host is configured", *ld.MachineReachable)
	}
}

// TestMachineStatus_AvailableAndStale exercises GET /api/machine/status'
// two booleans across a poll cycle.
func TestMachineStatus_AvailableAndStale(t *testing.T) {
	fake := &fakeAdapter{}
	fake.setStatus(okStatus(t, `{}`, 93.5, 94, 9, 18.2, false, "Espresso", 1), nil)
	p, sqlDB := newTestPoller(t, fake)
	demo := NewDemoService(sqlDB, nil, nil)
	h := NewHandlers(p, demo, testAPIToken)
	mux := newSystemMux(h)

	// Before any poll: available:false.
	rec := doGet(mux, "/api/machine/status")
	body := decodeMap(t, rec.Body.Bytes())
	if body["available"] != false {
		t.Fatalf("available = %v, want false before any poll", body["available"])
	}

	p.pollViaGaggiuinoStatus(context.Background())
	rec = doGet(mux, "/api/machine/status")
	body = decodeMap(t, rec.Body.Bytes())
	if body["available"] != true {
		t.Fatalf("available = %v, want true after a poll", body["available"])
	}
	if body["stale"] != false {
		t.Fatalf("stale = %v, want false right after a fresh poll", body["stale"])
	}
	if body["temperature"] != 93.5 {
		t.Errorf("temperature = %v, want 93.5", body["temperature"])
	}

	// Force staleness by backdating updatedAt directly on the runtime.
	snap := p.Runtime().Get()
	backdated := *snap.MachineStatus
	backdated.UpdatedAt = time.Now().UnixMilli() - 11_000
	p.Runtime().SetMachineStatus(&backdated)
	rec = doGet(mux, "/api/machine/status")
	body = decodeMap(t, rec.Body.Bytes())
	if body["stale"] != true {
		t.Fatalf("stale = %v, want true once updatedAt is >10s old", body["stale"])
	}
}

// TestBrewAccumulation_LiveDataDatapoints exercises the isBrewing
// start/accumulate/stop cycle that feeds GET /api/live/data's datapoints.
func TestBrewAccumulation_LiveDataDatapoints(t *testing.T) {
	fake := &fakeAdapter{}
	p, _ := newTestPoller(t, fake)

	fake.setStatus(okStatus(t, `{}`, 93, 94, 9, 5, true, "Test Profile", 1), nil)
	p.pollViaGaggiuinoStatus(context.Background())
	ld := p.LiveData()
	if !ld.IsLive {
		t.Fatal("expected IsLive=true once brewSwitchState flips true")
	}
	if ld.ProfileName != "Test Profile" {
		t.Errorf("ProfileName = %q, want Test Profile", ld.ProfileName)
	}
	if ld.Datapoints == nil || len(ld.Datapoints.TimeInShot) != 1 {
		t.Fatalf("expected exactly one datapoint after the first brewing poll, got %+v", ld.Datapoints)
	}
	seqBeforeStop := ld.Seq

	fake.setStatus(okStatus(t, `{}`, 93, 94, 9, 9, true, "Test Profile", 1), nil)
	p.pollViaGaggiuinoStatus(context.Background())
	ld = p.LiveData()
	if len(ld.Datapoints.TimeInShot) != 2 {
		t.Fatalf("expected two datapoints after the second brewing poll, got %d", len(ld.Datapoints.TimeInShot))
	}

	fake.setStatus(okStatus(t, `{}`, 93, 94, 0, 9, false, "Test Profile", 1), nil)
	p.pollViaGaggiuinoStatus(context.Background())
	ld = p.LiveData()
	if ld.IsLive {
		t.Fatal("expected IsLive=false once brewSwitchState flips false")
	}
	if ld.Seq != seqBeforeStop+1 {
		t.Errorf("Seq = %d, want %d (incremented on brew finish)", ld.Seq, seqBeforeStop+1)
	}
}

// TestCheckAndApplyMachinePower_NoHAToken_StartsLivePollingAnyway is the
// #901 code-review regression test for finding #1: checkAndApplyMachinePower
// early-exits (and ensures live polling is running) on `!entity || !HA_TOKEN`,
// not just `!entity`. A switch entity configured but no HA token available must
// still start live polling — the bug this used to have fell through to
// GetSwitchState instead, which always returns nil when no token is configured
// (ha/client.go's `!c.enabled()` guard), so isOn stayed nil and
// startLivePolling was never reached for the entire process lifetime.
func TestCheckAndApplyMachinePower_NoHAToken_StartsLivePollingAnyway(t *testing.T) {
	fake := &fakeAdapter{}
	fake.setStatus(okStatus(t, `{}`, 93, 94, 9, 5, false, "Espresso", 1), nil)
	sqlDB := newTestDB(t)
	haClient := newDisabledHAClient() // no SUPERVISOR_TOKEN/GLP_HA_URL -- Enabled() == false
	p := newTestPollerWithHA(t, fake, sqlDB, haClient, "switch.machine")

	if p.livePollActive() {
		t.Fatal("precondition failed: live polling already active")
	}
	if err := p.checkAndApplyMachinePower(context.Background()); err != nil {
		t.Fatalf("checkAndApplyMachinePower: %v", err)
	}
	if !p.livePollActive() {
		t.Fatal("expected live polling to start despite a configured switch entity, because no HA token is configured")
	}
}

// TestBuildLiveDataResponse_NoDataRaceWithConcurrentPollTick is the #901
// code-review regression test for finding #2: buildLiveDataResponse used to
// return a pointer straight into the lock-guarded liveAccum.datapoints
// struct, which pollTick keeps appending to under its own, separately
// re-acquired lock. A caller holding onto that returned LiveData (this
// package's emitLiveSnapshot -> a Hub subscriber's buffered channel ->
// json.Marshal, arbitrarily later — see internal/sse.Handler.send) raced
// with the next tick's writes. Run with `go test -race`: this test only
// proves anything under -race — without the fix in buildLiveDataResponse,
// it fails with a DATA RACE report; with the fix (a deep copy taken under
// lock), it passes clean.
func TestBuildLiveDataResponse_NoDataRaceWithConcurrentPollTick(t *testing.T) {
	fake := &fakeAdapter{}
	p, _ := newTestPoller(t, fake)

	stop := make(chan struct{})
	var wg sync.WaitGroup

	wg.Add(1)
	go func() {
		defer wg.Done()
		weight := 0.0
		for {
			select {
			case <-stop:
				return
			default:
			}
			weight++
			fake.setStatus(okStatus(t, `{}`, 93, 94, 9, weight, true, "Test Profile", 1), nil)
			p.pollViaGaggiuinoStatus(context.Background())
		}
	}()

	for i := 0; i < 200; i++ {
		ld := p.LiveData()
		if _, err := json.Marshal(ld); err != nil {
			t.Errorf("json.Marshal(LiveData): %v", err)
		}
	}

	close(stop)
	wg.Wait()
}

// TestLiveData_IdleStatsAlwaysPresent is the #908 regression test: the
// idle payload exposes current temperature/target, pressure and water
// level even when nothing is brewing, sourced from the per-tick
// machineStatus (no extra sensor calls).
func TestLiveData_IdleStatsAlwaysPresent(t *testing.T) {
	fake := &fakeAdapter{}
	p, sqlDB := newTestPoller(t, fake)

	// Enable water sensor on the default machine so wl is parsed.
	reg := machines.NewRegistry(sqlDB)
	hasWater := true
	if _, err := reg.UpdateMachine(1, machines.MachineInput{HasWaterSensor: &hasWater}, nil); err != nil {
		t.Fatalf("UpdateMachine: %v", err)
	}

	// Before any poll: idle stats are null (no machineStatus yet).
	ld := p.LiveData()
	if ld.Temperature != nil || ld.WaterLevel != nil {
		t.Fatalf("expected nil idle stats before first poll, got temp=%v water=%v", ld.Temperature, ld.WaterLevel)
	}

	// GaggiMate sends "wl" only when sensor is present. hasWaterSensor=true
	// above gates parsing so wl=72 is read and nil is returned when absent.
	fake.setStatus(okStatus(t, `{"wl":72}`, 93.5, 94, 6.2, 0, false, "Espresso", 1), nil)
	p.pollViaGaggiuinoStatus(context.Background())
	ld = p.LiveData()
	if ld.IsLive {
		t.Fatal("IsLive should be false while idle")
	}
	if ld.Temperature == nil || *ld.Temperature != 93.5 {
		t.Errorf("Temperature = %v, want 93.5", ld.Temperature)
	}
	if ld.TargetTemperature == nil || *ld.TargetTemperature != 94 {
		t.Errorf("TargetTemperature = %v, want 94", ld.TargetTemperature)
	}
	if ld.Pressure == nil || *ld.Pressure != 6.2 {
		t.Errorf("Pressure = %v, want 6.2", ld.Pressure)
	}
	if ld.WaterLevel == nil || *ld.WaterLevel != 72 {
		t.Errorf("WaterLevel = %v, want 72", ld.WaterLevel)
	}
}

// TestSteamFlushLiveSessions is the #908 regression test for
// state.steamAccum/flushAccum: a steam session starts/accumulates/stops
// mirroring the brew accumulator, guarded by the brewing>steaming>flushing
// priority.
func TestSteamFlushLiveSessions(t *testing.T) {
	fake := &fakeAdapter{}
	p, _ := newTestPoller(t, fake)

	// Steam on via live SensorSnap.SteamActive.
	fake.setStatus(okStatus(t, `{}`, 130, 135, 1.5, 0, false, "Espresso", 1), nil)
	fake.setLive(&proto.SensorStateSnapshotDto{Temperature: 130, SteamActive: true}, nil)
	p.pollViaGaggiuinoStatus(context.Background())
	ld := p.LiveData()
	if !ld.IsSteaming {
		t.Fatal("expected IsSteaming=true once SensorSnap.SteamActive flips true")
	}
	if ld.SteamDatapoints == nil || len(ld.SteamDatapoints.TimeInMode) != 1 {
		t.Fatalf("expected one steam datapoint, got %+v", ld.SteamDatapoints)
	}
	if ld.IsLive || ld.IsFlushing {
		t.Error("steam session must not set IsLive/IsFlushing")
	}
	steamSeqBefore := ld.SteamSeq

	p.pollViaGaggiuinoStatus(context.Background())
	if ld = p.LiveData(); len(ld.SteamDatapoints.TimeInMode) != 2 {
		t.Fatalf("expected two steam datapoints after second poll, got %d", len(ld.SteamDatapoints.TimeInMode))
	}

	// Steam off.
	fake.setLive(&proto.SensorStateSnapshotDto{Temperature: 120, SteamActive: false}, nil)
	p.pollViaGaggiuinoStatus(context.Background())
	ld = p.LiveData()
	if ld.IsSteaming {
		t.Fatal("expected IsSteaming=false once SteamActive flips false")
	}
	if ld.SteamSeq != steamSeqBefore+1 {
		t.Errorf("SteamSeq = %d, want %d (incremented on steam finish)", ld.SteamSeq, steamSeqBefore+1)
	}

	// Flush via SysState.OperationMode == FLUSH.
	fake.setLive(nil, &proto.SystemStateDto{OperationMode: proto.ModeFlush})
	p.pollViaGaggiuinoStatus(context.Background())
	ld = p.LiveData()
	if !ld.IsFlushing || ld.FlushDatapoints == nil || len(ld.FlushDatapoints.TimeInMode) != 1 {
		t.Fatalf("expected a flush session to start, got IsFlushing=%v dp=%+v", ld.IsFlushing, ld.FlushDatapoints)
	}

	// Brewing wins over a concurrently-true steam signal (priority guard).
	fake.setStatus(okStatus(t, `{}`, 93, 94, 9, 2, true, "Espresso", 1), nil)
	fake.setLive(&proto.SensorStateSnapshotDto{Temperature: 93, BrewActive: true, SteamActive: true}, nil)
	p.pollViaGaggiuinoStatus(context.Background())
	ld = p.LiveData()
	if !ld.IsLive {
		t.Fatal("expected IsLive=true (brew)")
	}
	if ld.IsSteaming {
		t.Error("steam session must not start while brewing (brewing > steaming priority)")
	}
}

// TestDescaleLiveSession is the #983 regression test for
// state.descaleAccum: a descale session starts/accumulates/stops mirroring
// the steam/flush accumulators, guarded by the
// brewing>steaming>flushing>descaling priority.
func TestDescaleLiveSession(t *testing.T) {
	fake := &fakeAdapter{}
	p, _ := newTestPoller(t, fake)

	// Descale via SysState.OperationMode == DESCALE.
	fake.setStatus(okStatus(t, `{}`, 93, 94, 1.5, 0, false, "Espresso", 1), nil)
	fake.setLive(nil, &proto.SystemStateDto{OperationMode: proto.ModeDescale})
	p.pollViaGaggiuinoStatus(context.Background())
	ld := p.LiveData()
	if !ld.IsDescaling {
		t.Fatal("expected IsDescaling=true once SysState.OperationMode flips to DESCALE")
	}
	if ld.DescaleDatapoints == nil || len(ld.DescaleDatapoints.TimeInMode) != 1 {
		t.Fatalf("expected one descale datapoint, got %+v", ld.DescaleDatapoints)
	}
	if ld.IsLive || ld.IsSteaming || ld.IsFlushing {
		t.Error("descale session must not set IsLive/IsSteaming/IsFlushing")
	}
	descaleSeqBefore := ld.DescaleSeq

	p.pollViaGaggiuinoStatus(context.Background())
	if ld = p.LiveData(); len(ld.DescaleDatapoints.TimeInMode) != 2 {
		t.Fatalf("expected two descale datapoints after second poll, got %d", len(ld.DescaleDatapoints.TimeInMode))
	}

	// Descale off.
	fake.setLive(nil, &proto.SystemStateDto{OperationMode: proto.ModeBrewAuto})
	p.pollViaGaggiuinoStatus(context.Background())
	ld = p.LiveData()
	if ld.IsDescaling {
		t.Fatal("expected IsDescaling=false once OperationMode leaves DESCALE")
	}
	if ld.DescaleSeq != descaleSeqBefore+1 {
		t.Errorf("DescaleSeq = %d, want %d (incremented on descale finish)", ld.DescaleSeq, descaleSeqBefore+1)
	}

	// Flushing wins over a concurrently-true descale signal (priority guard).
	fake.setLive(nil, &proto.SystemStateDto{OperationMode: proto.ModeFlush})
	p.pollViaGaggiuinoStatus(context.Background())
	ld = p.LiveData()
	if !ld.IsFlushing {
		t.Fatal("expected IsFlushing=true (flush)")
	}
	if ld.IsDescaling {
		t.Error("descale session must not start while flushing/steaming/brewing take priority")
	}
}

// TestStopLivePolling_ClearsDescaleAccum covers stopLivePolling's #983
// descale accumulator reset.
func TestStopLivePolling_ClearsDescaleAccum(t *testing.T) {
	fake := &fakeAdapter{}
	fake.setStatus(okStatus(t, `{}`, 93, 94, 1.5, 0, false, "Espresso", 1), nil)
	fake.setLive(nil, &proto.SystemStateDto{OperationMode: proto.ModeDescale})
	p, _ := newTestPoller(t, fake)

	p.startLivePolling() // stopLivePolling only resets accumulators when a ticker is active
	p.pollViaGaggiuinoStatus(context.Background())
	if !p.LiveData().IsDescaling {
		t.Fatal("precondition: expected a live descale session")
	}
	p.stopLivePolling()
	if p.LiveData().IsDescaling {
		t.Fatal("expected descale session cleared after stopLivePolling")
	}
}

// TestStopLivePolling_ClearsSteamFlushAccum covers stopLivePolling's #908
// steam/flush accumulator reset.
func TestStopLivePolling_ClearsSteamFlushAccum(t *testing.T) {
	fake := &fakeAdapter{}
	fake.setStatus(okStatus(t, `{}`, 130, 135, 1.5, 0, false, "Espresso", 1), nil)
	fake.setLive(&proto.SensorStateSnapshotDto{Temperature: 130, SteamActive: true}, nil)
	p, _ := newTestPoller(t, fake)

	p.startLivePolling() // stopLivePolling only resets accumulators when a ticker is active
	p.pollViaGaggiuinoStatus(context.Background())
	if !p.LiveData().IsSteaming {
		t.Fatal("precondition: expected a live steam session")
	}
	p.stopLivePolling()
	if p.LiveData().IsSteaming {
		t.Fatal("expected steam session cleared after stopLivePolling")
	}
}

// TestStopLivePolling_ForcesUnreachableFalse covers stopLivePolling's #655
// unconditional machineReachable=false flip.
func TestStopLivePolling_ForcesUnreachableFalse(t *testing.T) {
	fake := &fakeAdapter{}
	fake.setStatus(okStatus(t, `{}`, 93, 94, 9, 5, false, "Espresso", 1), nil)
	p, _ := newTestPoller(t, fake)

	p.pollViaGaggiuinoStatus(context.Background())
	if ld := p.LiveData(); ld.MachineReachable == nil || !*ld.MachineReachable {
		t.Fatalf("precondition failed: expected reachable=true, got %v", ld.MachineReachable)
	}

	p.stopLivePolling()
	ld := p.LiveData()
	if ld.MachineReachable == nil || *ld.MachineReachable {
		t.Fatalf("MachineReachable = %v, want false after stopLivePolling", ld.MachineReachable)
	}
}

// fakeLiveTransport is the #1447 regression seam: it records the
// isDefaultMachine argument each getter receives and echoes that argument back
// as the "MQTT is active" bool, so a poller that asks for MQTT on a
// non-Gaggiuino default is caught overriding that machine's own live data.
type fakeLiveTransport struct {
	mu      sync.Mutex
	snapArg []bool
	sysArg  []bool
}

func (f *fakeLiveTransport) SensorSnapshot(isDefaultMachine bool) (*proto.SensorStateSnapshotDto, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.snapArg = append(f.snapArg, isDefaultMachine)
	return &proto.SensorStateSnapshotDto{Temperature: 61.5, BrewActive: false}, isDefaultMachine
}

func (f *fakeLiveTransport) SystemState(isDefaultMachine bool) (*proto.SystemStateDto, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sysArg = append(f.sysArg, isDefaultMachine)
	return nil, isDefaultMachine
}

func (f *fakeLiveTransport) args() (snap, sys []bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]bool(nil), f.snapArg...), append([]bool(nil), f.sysArg...)
}

// TestPollViaGaggiuinoStatus_MQTTOnlyForGaggiuinoDefault is the #1447
// regression test: the MQTT live-data transport must only be consulted for a
// default Gaggiuino. A GaggiMate default reads its own adapter's live data
// (temperature 68.4, brewing) instead of the Gaggiuino MQTT snapshot (61.5,
// not brewing), while a Gaggiuino default still uses that snapshot.
func TestPollViaGaggiuinoStatus_MQTTOnlyForGaggiuinoDefault(t *testing.T) {
	cases := []struct {
		name        string
		machineType string
		wantMQTTArg bool
		wantLive    bool
		wantTemp    float64
	}{
		{
			name:        "gaggimate default reads its own adapter",
			machineType: "gaggimate",
			wantMQTTArg: false,
			wantLive:    true,
			wantTemp:    68.4,
		},
		{
			name:        "gaggiuino default uses the MQTT snapshot",
			machineType: "gaggiuino",
			wantMQTTArg: true,
			wantLive:    false,
			wantTemp:    61.5,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			fake := &fakeAdapter{}
			fake.setStatus(okStatus(t, `{}`, 68.4, 94, 9, 0, true, "x", 1), nil)
			p, sqlDB := newTestPoller(t, fake)

			registry := machines.NewRegistry(sqlDB)
			if _, err := registry.UpdateMachine(1, machines.MachineInput{Type: &tc.machineType}, nil); err != nil {
				t.Fatalf("UpdateMachine(type=%s): %v", tc.machineType, err)
			}
			lt := &fakeLiveTransport{}
			p.SetLiveTransport(lt)

			p.pollViaGaggiuinoStatus(context.Background())

			snapArgs, sysArgs := lt.args()
			if len(snapArgs) != 1 || snapArgs[0] != tc.wantMQTTArg {
				t.Fatalf("SensorSnapshot called with %v, want [%v]", snapArgs, tc.wantMQTTArg)
			}
			if len(sysArgs) != 1 || sysArgs[0] != tc.wantMQTTArg {
				t.Fatalf("SystemState called with %v, want [%v]", sysArgs, tc.wantMQTTArg)
			}
			ld := p.LiveData()
			if ld.IsLive != tc.wantLive {
				t.Errorf("IsLive = %v, want %v", ld.IsLive, tc.wantLive)
			}
			if ld.Temperature == nil || *ld.Temperature != tc.wantTemp {
				t.Errorf("Temperature = %v, want %v", ld.Temperature, tc.wantTemp)
			}
		})
	}
}

// TestPollViaGaggiuinoStatus_StandbySkipsPreheatSampling pins #1498's sampling
// guard: while the runtime is in standby the poll tick records no preheat
// samples, even if a run is somehow still open, so the history never absorbs
// the cold standby period.
func TestPollViaGaggiuinoStatus_StandbySkipsPreheatSampling(t *testing.T) {
	fake := &fakeAdapter{}
	p := newPreheatHistoryPoller(t, fake)

	// Deliberately open a run and flag standby without the transition's close,
	// so the sampling gate is what this test exercises (not the closed run).
	onAt := time.Now().UnixMilli() - 60_000
	p.openPreheatRun(onAt)
	p.runtime.SetStandby(true)

	st := okStatus(t, `{"waterLevel":80,"upTime":1234}`, 35.0, 0, 0, 0, false, "", 0)
	st.Standby = true
	fake.setStatus(st, nil)

	p.pollViaGaggiuinoStatus(context.Background())

	runs := p.PreheatHistory()
	if len(runs) == 0 {
		t.Fatal("expected the pre-opened run to still be present")
	}
	if n := len(runs[0].Samples); n != 0 {
		t.Errorf("preheat run has %d samples, want 0 while in standby", n)
	}
}

// TestPollViaGaggiuinoStatus_ErrorClearsStandby pins #1498's review fix: an
// unreachable machine is not in standby, so a poll error clears the runtime
// flag and /api/preheat then reports standby false.
func TestPollViaGaggiuinoStatus_ErrorClearsStandby(t *testing.T) {
	fake := &fakeAdapter{}
	p := newPreheatHistoryPoller(t, fake)

	p.runtime.SetStandby(true)
	fake.setStatus(machinesStatusZero(), errBoom)

	p.pollViaGaggiuinoStatus(context.Background())

	if p.runtime.Get().Standby {
		t.Error("Standby = true, want false after a poll error")
	}
	if p.PreheatStatus().Standby {
		t.Error("PreheatStatus().Standby = true, want false after a poll error")
	}
}

// TestPollViaGaggiuinoStatus_StandbyKeepsTempHistoryEmpty pins #1498's review
// fix: standby readings never enter the temp history, so the poll tick cannot
// accumulate cold standby samples towards a false stability.
func TestPollViaGaggiuinoStatus_StandbyKeepsTempHistoryEmpty(t *testing.T) {
	fake := &fakeAdapter{}
	p := newPreheatHistoryPoller(t, fake)

	p.runtime.SetStandby(true)
	st := okStatus(t, `{"waterLevel":80,"upTime":1234}`, 30.0, 90.0, 0, 0, false, "", 0)
	st.Standby = true
	fake.setStatus(st, nil)

	for i := 0; i < tempStableMin; i++ {
		p.pollViaGaggiuinoStatus(context.Background())
	}

	p.runtime.mu.Lock()
	n := len(p.runtime.tempHistory)
	p.runtime.mu.Unlock()
	if n != 0 {
		t.Errorf("temp history len = %d, want 0 across standby ticks", n)
	}
}

// TestPollViaGaggiuinoStatus_StandbyThenErrorKeepsNoStaleCountdown pins the
// #1498 follow-up: once a session ends in standby, a poll error clears the
// standby flag, but the switch-on time was dropped on the way into standby, so
// buildPreheatResponse (and PreheatInfo) must report a fresh, full countdown
// instead of resurrecting the ended session.
func TestPollViaGaggiuinoStatus_StandbyThenErrorKeepsNoStaleCountdown(t *testing.T) {
	fake := &fakeAdapter{}
	p := newPreheatHistoryPoller(t, fake)
	markLivePollingActive(t, p)

	now := time.Now().UnixMilli()
	p.runtime.SetStandby(true) // the machine was in standby
	p.applyStandbyTransition(now, false)
	if p.runtime.Get().SwitchOnAt == nil {
		t.Fatal("precondition: waking should stamp a switch-on time")
	}
	p.applyStandbyTransition(now+12_000, true) // 12s later the machine sleeps

	// Unreachable: pollViaGaggiuinoStatus's error path clears the standby flag.
	fake.setStatus(machinesStatusZero(), errBoom)
	p.pollViaGaggiuinoStatus(context.Background())

	status := p.PreheatStatus()
	if status.Ready {
		t.Error("Ready = true, want false after the session ended in standby")
	}
	if status.Elapsed != 0 {
		t.Errorf("Elapsed = %d, want 0", status.Elapsed)
	}
	wantRemaining := loadPreheatMinutes() * 60
	if status.Remaining != wantRemaining {
		t.Errorf("Remaining = %d, want the full %d", status.Remaining, wantRemaining)
	}
	if ready, mins := p.PreheatInfo(); ready || mins != loadPreheatMinutes() {
		t.Errorf("PreheatInfo() = (%v, %d), want (false, %d)", ready, mins, loadPreheatMinutes())
	}
}

// TestStopLivePolling_StillWarmRestartKeepsClock pins that the #1498 follow-up
// fix is scoped to the standby path: stopLivePolling must keep the switch-on
// time, so a still-warm restart resumes the same countdown rather than
// resetting it to a fresh preheat.
func TestStopLivePolling_StillWarmRestartKeepsClock(t *testing.T) {
	fake := &fakeAdapter{}
	p := newPreheatHistoryPoller(t, fake)
	t.Cleanup(p.stopLivePolling)

	hot := 90.0
	onAt := time.Now().UnixMilli() - 60_000
	p.runtime.SetCurrentTemps(&hot, nil)
	p.runtime.SetSwitchOnAt(&onAt)

	p.startLivePolling()
	p.stopLivePolling()
	if snap := p.runtime.Get(); snap.SwitchOnAt == nil || *snap.SwitchOnAt != onAt {
		t.Fatalf("SwitchOnAt = %v after stopLivePolling, want unchanged %d", snap.SwitchOnAt, onAt)
	}

	p.startLivePolling()
	if !p.runtime.IsStillWarm(time.Now().UnixMilli()) {
		t.Fatal("precondition: the boiler should read as still warm")
	}
	if snap := p.runtime.Get(); snap.SwitchOnAt == nil || *snap.SwitchOnAt != onAt {
		t.Fatalf("SwitchOnAt = %v after a still-warm restart, want the kept %d", snap.SwitchOnAt, onAt)
	}
}

// TestHandleDefaultMachineChange_StartsSessionWhenNewDefaultOn covers #1543:
// switching the default to an already-on machine while live polling runs must
// start a fresh preheat session (switch-on time present, countdown running)
// instead of leaving the countdown stuck at the full window forever.
func TestHandleDefaultMachineChange_StartsSessionWhenNewDefaultOn(t *testing.T) {
	fake := &fakeAdapter{}
	p, sqlDB := newTestPoller(t, fake)
	markLivePollingActive(t, p)

	// Machine B becomes the default while it is already switched on.
	registry := machines.NewRegistry(sqlDB)
	name, typ, host := "Machine B", "gaggiuino", "machine-b.invalid"
	b, err := registry.CreateMachine(machines.MachineInput{Name: &name, Type: &typ, Host: &host})
	if err != nil {
		t.Fatalf("CreateMachine: %v", err)
	}
	if _, err := registry.SetDefaultMachine(b.ID); err != nil {
		t.Fatalf("SetDefaultMachine: %v", err)
	}

	// The stuck state the issue describes: on, but no switch-on time.
	p.runtime.SetMachineOn(true)
	p.runtime.SetSwitchOnAt(nil)

	p.HandleDefaultMachineChange()

	snap := p.runtime.Get()
	if snap.SwitchOnAt == nil {
		t.Fatal("SwitchOnAt = nil after a default switch to an on machine, want a fresh session")
	}
	status := p.PreheatStatus()
	if status.StabilityReady == nil {
		t.Error("StabilityReady = nil, want present (a session is active)")
	}
	if status.Remaining <= 0 {
		t.Errorf("Remaining = %d, want a running countdown", status.Remaining)
	}
}

// TestHandleDefaultMachineChange_OffDefaultStartsSessionOnSwitchOn is the
// #1551 regression test: live polling and the on/standby flags of the previous
// default (a GaggiMate in standby, no switch entity) must not carry over to a
// new default whose HA switch is off. Polling stops, and the later switch-on
// is a real off->on transition that starts a fresh preheat session instead of
// leaving the countdown at the full window.
func TestHandleDefaultMachineChange_OffDefaultStartsSessionOnSwitchOn(t *testing.T) {
	var switchState atomic.Value
	switchState.Store("off")
	haClient := fakeHA(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/states/switch.machine" {
			_ = json.NewEncoder(w).Encode(map[string]string{"state": switchState.Load().(string)})
			return
		}
		t.Errorf("unexpected HA call: %s %s", r.Method, r.URL.Path)
	})
	fake := &fakeAdapter{}
	p := newTestPollerWithHA(t, fake, newTestDB(t), haClient, "switch.machine")
	var c syncCounter
	p.syncFn = c.fn
	markLivePollingActive(t, p)

	// The previous default's leftovers: polling running, on, in standby, an
	// old switch-on time.
	onAt := time.Now().UnixMilli() - 60_000
	p.runtime.SetMachineOn(true)
	p.runtime.SetStandby(true)
	p.runtime.SetSwitchOnAt(&onAt)

	p.HandleDefaultMachineChange()

	if p.livePollActive() {
		t.Fatal("live polling still active after a default switch to a machine whose switch is off")
	}
	if snap := p.runtime.Get(); snap.SwitchOnAt != nil || snap.MachineOn || snap.Standby {
		t.Fatalf("runtime after the switch = on %v, standby %v, switch-on %v; want all cleared", snap.MachineOn, snap.Standby, snap.SwitchOnAt)
	}

	switchState.Store("on")
	if err := p.checkAndApplyMachinePower(context.Background()); err != nil {
		t.Fatalf("checkAndApplyMachinePower: %v", err)
	}
	if !p.livePollActive() {
		t.Fatal("live polling not started after switching the new default on")
	}
	if snap := p.runtime.Get(); snap.SwitchOnAt == nil || *snap.SwitchOnAt == onAt {
		t.Fatalf("SwitchOnAt = %v after switch-on, want a fresh session", snap.SwitchOnAt)
	}
	if status := p.PreheatStatus(); status.Remaining <= 0 {
		t.Errorf("Remaining = %d, want a running countdown", status.Remaining)
	}
}

// TestHandleDefaultMachineChange_StartsPollingWithoutLivePolling pins that a
// default change also works when live polling was off before: a new default
// without a switch entity gets live polling and a fresh session right away.
func TestHandleDefaultMachineChange_StartsPollingWithoutLivePolling(t *testing.T) {
	fake := &fakeAdapter{}
	p, _ := newTestPoller(t, fake)
	t.Cleanup(p.stopLivePolling)

	p.HandleDefaultMachineChange()

	if !p.livePollActive() {
		t.Fatal("live polling not started for a new default without a switch entity")
	}
	if snap := p.runtime.Get(); snap.SwitchOnAt == nil {
		t.Fatal("SwitchOnAt = nil, want a fresh session")
	}
}

// TestMachineKnownOffline pins #1572's "known offline" predicate that lets the
// profiles and firmware-version handlers skip their fetch timeouts: an
// explicitly unreachable poll state, or the default machine with a configured
// switch that reads off. Everything else stays live, including standby (still
// reachable and answering) and unknown non-default machines.
func TestMachineKnownOffline(t *testing.T) {
	setReachable := func(p *Poller, id int64, v bool) {
		p.state.mu.Lock()
		p.state.machine(id).reachable = ptrBool(v)
		p.state.mu.Unlock()
	}
	setSwitch := func(t *testing.T, p *Poller, entity string) {
		t.Helper()
		if _, err := p.registry.UpdateMachine(1, machines.MachineInput{SwitchEntity: &entity}, nil); err != nil {
			t.Fatalf("UpdateMachine: %v", err)
		}
	}

	cases := []struct {
		name  string
		setup func(t *testing.T, p *Poller) int64
		want  bool
	}{
		{
			name:  "unreachable poll state",
			setup: func(t *testing.T, p *Poller) int64 {
				setReachable(p, 1, false)
				return 1
			},
			want:  true,
		},
		{
			name:  "default machine switch off",
			setup: func(t *testing.T, p *Poller) int64 {
				setSwitch(t, p, "switch.gaggia")
				p.runtime.SetMachineOn(false)
				return 1
			},
			want:  true,
		},
		{
			name:  "default machine switch off but no switch entity",
			setup: func(t *testing.T, p *Poller) int64 {
				p.runtime.SetMachineOn(false)
				return 1
			},
			want:  false,
		},
		{
			name:  "default machine standby with switch on",
			setup: func(t *testing.T, p *Poller) int64 {
				setSwitch(t, p, "switch.gaggia")
				p.runtime.SetMachineOn(true)
				p.runtime.SetStandby(true)
				return 1
			},
			want:  false,
		},
		{
			name:  "non-default machine unknown state",
			setup: func(t *testing.T, p *Poller) int64 {
				return addOtherMachine(t, p.registry, "Second", "gaggiuino", "machine2.test", true).ID
			},
			want:  false,
		},
		{
			name:  "reachable wins over switch off",
			setup: func(t *testing.T, p *Poller) int64 {
				setSwitch(t, p, "switch.gaggia")
				p.runtime.SetMachineOn(false)
				setReachable(p, 1, true)
				return 1
			},
			want:  false,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p, _ := newTestPoller(t, &fakeAdapter{})
			t.Cleanup(p.stopLivePolling)
			id := tc.setup(t, p)
			if got := p.MachineKnownOffline(id); got != tc.want {
				t.Errorf("MachineKnownOffline(%d) = %v, want %v", id, got, tc.want)
			}
		})
	}
}
