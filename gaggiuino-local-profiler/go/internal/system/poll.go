package system

import (
	"context"
	"encoding/json"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/ha"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/httputil"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines/proto"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/maintenance"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/sse"
)

// LiveTransport is the WS-vs-MQTT dispatch seam (#608) — *mqtt.Transport
// satisfies it. Each method's second return is true when MQTT is the active
// transport for this machine (only ever a default Gaggiuino machine, #1447,
// and only when the Settings toggle is on MQTT with a broker configured): the
// poller then uses the returned value (possibly nil, if the MQTT cache is
// stale/empty) instead of the adapter's WS session. An interface (not a
// direct internal/mqtt import) keeps this central package decoupled from the
// transport implementation, the same pattern AdapterProvider already
// follows here.
type LiveTransport interface {
	SensorSnapshot(isDefaultMachine bool) (*proto.SensorStateSnapshotDto, bool)
	SystemState(isDefaultMachine bool) (*proto.SystemStateDto, bool)
}

// This file implements the 1s live-polling loop plus
// checkAndApplyMachinePower/backgroundHaCheck, the 30s HA-switch-state watcher
// that starts/stops it. The shot-sync triggers are in sync_triggers.go.

// liveDatapoints is the fixed set of per-tenth-second arrays the brew
// accumulator fills during a brew — the exact shape GET /api/shots/:id already
// stores for a finished shot, reused here unchanged for the in-progress
// GET /api/live/data / live-snapshot SSE payload.
type liveDatapoints struct {
	TimeInShot        []int `json:"timeInShot"`
	Pressure          []int `json:"pressure"`
	Temperature       []int `json:"temperature"`
	ShotWeight        []int `json:"shotWeight"`
	WeightFlow        []int `json:"weightFlow"`
	PumpFlow          []int `json:"pumpFlow"`
	TargetTemperature []int `json:"targetTemperature"`
}

type liveAccumState struct {
	startTime   int64
	profileName string
	prevWeight  float64
	datapoints  liveDatapoints
}

// modeDatapoints is the simpler per-tick datapoint set #902's steam/flush
// live sessions accumulate — timeInMode/pressure/temperature only, no
// weight/flow (neither mode moves the scale).
type modeDatapoints struct {
	TimeInMode  []int `json:"timeInMode"`
	Pressure    []int `json:"pressure"`
	Temperature []int `json:"temperature"`
}

// modeAccumState is the same start/accumulate/stop lifecycle as
// liveAccumState, minus the brew-only profileName/prevWeight.
type modeAccumState struct {
	startTime  int64
	datapoints modeDatapoints
}

// LiveData is openapi.yaml's LiveData schema exactly — GET /api/live/data's
// response and the live-snapshot SSE event's payload, both built by
// buildLiveDataResponse() (#736: single source of truth for both).
type LiveData struct {
	IsLive           bool            `json:"isLive"`
	ProfileName      string          `json:"profileName"`
	Datapoints       *liveDatapoints `json:"datapoints"`
	Seq              int             `json:"seq"`
	MachineReachable *bool           `json:"machineReachable"`

	// #902: steam/flush live sessions — same shape as the brew fields
	// above, kept separate from isLive/datapoints since isLive's meaning
	// (brew-only) is relied on by the frontend's post-brew shot-list reload
	// and must not fire on steam/flush end.
	IsSteaming      bool            `json:"isSteaming"`
	SteamSeq        int             `json:"steamSeq"`
	SteamDatapoints *modeDatapoints `json:"steamDatapoints"`
	IsFlushing      bool            `json:"isFlushing"`
	FlushSeq        int             `json:"flushSeq"`
	FlushDatapoints *modeDatapoints `json:"flushDatapoints"`
	// #983: descale live sessions, same shape as steam/flush above.
	IsDescaling       bool            `json:"isDescaling"`
	DescaleSeq        int             `json:"descaleSeq"`
	DescaleDatapoints *modeDatapoints `json:"descaleDatapoints"`

	// #902: idle stats — always present (not gated behind isLive), so the
	// Live tab can show current readings while nothing is running. Sourced
	// from the already-populated per-tick machineStatus, no extra sensor
	// calls. null (nil) until the first successful poll populates it.
	Temperature       *float64 `json:"temperature"`
	TargetTemperature *float64 `json:"targetTemperature"`
	Pressure          *float64 `json:"pressure"`
	WaterLevel        *int     `json:"waterLevel"`
	// #1409: GaggiMate active warnings and firmware-update flag, carried
	// from the merged evt:status via MachineStatus. machineWarnings is
	// always a JSON array (empty for Gaggiuino, which reports neither).
	MachineWarnings        []string `json:"machineWarnings"`
	MachineUpdateAvailable bool     `json:"machineUpdateAvailable"`
	// #1324: opt-in machine-control snapshot for the default machine, null
	// when machine control is unsupported, its setting is off, or the machine
	// is unreachable.
	MachineControl *machines.ControlState `json:"machineControl"`
}

// pollGlobalState holds package-level polling state (as opposed to the
// per-machine RuntimeState) — mutex-guarded for the same reason RuntimeState
// is (see its own header comment). See RuntimeState's doc comment for this
// struct's mu's fixed lock ordering relative to RuntimeState.mu
// (RuntimeState.mu first, this one second).
type pollGlobalState struct {
	mu sync.Mutex

	// machines holds the former default-only poll scalars (#1201) keyed by
	// machine id, so every machine reports its own reachability, last error
	// and cached firmware version. Lazily populated by machine().
	machines      map[int64]*machinePollState
	isPollRunning bool
	liveAccum     *liveAccumState
	liveSeq       int
	// #902: steam/flush live sessions, same hard-single-machine slot
	// pattern as liveAccum/liveSeq above.
	steamAccum *modeAccumState
	steamSeq   int
	flushAccum *modeAccumState
	flushSeq   int
	// #983: descale live sessions, same hard-single-machine slot pattern.
	descaleAccum *modeAccumState
	descaleSeq   int

	// Manual-sync (POST /api/sync) progress. lastManualSync backs the 30s
	// cooldown; lastSyncTime/lastSyncError are reported by GET /api/status.
	// defaultSyncInFlight is the #773 single-run guard.
	lastManualSync      time.Time
	lastSyncTime        *string
	lastSyncError       *string
	defaultSyncInFlight bool
	// defaultSyncRerun is set when a trigger arrives while a default sync is
	// already running (#1409): the run does one more pass afterwards instead of
	// the trigger being dropped. Read and cleared by syncDefaultMachineShots,
	// guarded by mu like defaultSyncInFlight.
	defaultSyncRerun bool
	// otherSyncInFlight is the #773 per-machine single-run guard for non-default
	// machines (syncOtherMachines, #1146), keyed by machine id — one slot per
	// machine, so a slow backfill on one machine never blocks another's.
	// Lazy-initialized: nil until the first sync.
	otherSyncInFlight map[int64]bool

	readyByTargetAt   *int64
	plannedSwitchOnAt *int64
	// preheatNotifiedFor is the switch-on time (unix ms, 0 = none) the
	// preheat-ready push (#1671) was delivered for. Compared against the current
	// SwitchOnAt so a standby wake-up of the same run is not announced twice,
	// while a fresh switch-on re-arms it. Cleared on machine-off, like the run
	// it identifies.
	preheatNotifiedFor int64
}

// machinePollState is one machine's slice of the former default-only poll
// scalars (#1201): its reachability, last error/success and cached firmware
// version. Guarded by pollGlobalState.mu, the same lock ordering documented
// on RuntimeState.
type machinePollState struct {
	reachable    *bool   // nil = never checked (#274)
	wasReachable *bool   // #725's tri-state: nil = never polled
	lastError    *string // last poll/sync error, redacted
	lastSuccess  *int64
	version      *string // cached firmware version, nil = not sniffed yet
	// #1454: firmwareName is the name the machine reports in its own settings
	// (GET /api/settings/system's "machineName"), nil when the firmware does
	// not report one. firmwareNameFetched records that the one-off fetch
	// finished (with a name or with none), so it is not repeated every tick;
	// firmwareNameAttempt (unix ms) throttles the retry after a failed fetch.
	// Both reset on an unreachable->reachable transition (markReachableLocked)
	// so a rename while the machine was away is picked up.
	firmwareName        *string
	firmwareNameFetched bool
	firmwareNameAttempt int64
	// control is the #1324 opt-in machine-control snapshot for this machine,
	// refreshed on every successful status poll and cleared on a failed poll
	// or when live polling stops. nil when the machine has no machine control,
	// the opt-in setting is off, or it is unreachable.
	control *machines.ControlState
}

// machine returns id's poll state, creating it on demand. Caller holds
// p.state.mu.
func (s *pollGlobalState) machine(id int64) *machinePollState {
	if s.machines == nil {
		s.machines = map[int64]*machinePollState{}
	}
	m := s.machines[id]
	if m == nil {
		m = &machinePollState{}
		s.machines[id] = m
	}
	return m
}

// markReachableLocked records a successful contact with one machine. An
// unreachable->reachable transition clears the machine's cached firmware
// version (#1197 point 3, #1201) so a version that changed while it was away
// is re-sniffed from the next status poll or shot, and re-arms the #1454
// firmware-name fetch so a rename made while the machine was away is picked
// up. Caller holds p.state.mu.
func markReachableLocked(m *machinePollState, now int64) {
	wasDown := (m.reachable != nil && !*m.reachable) || (m.wasReachable != nil && !*m.wasReachable)
	if wasDown {
		m.version = nil
		m.firmwareNameFetched = false
		m.firmwareNameAttempt = 0
	}
	reachable := true
	m.reachable = &reachable
	m.lastError = nil
	m.lastSuccess = &now
}

// maybeFetchFirmwareName reads a Gaggiuino's user-chosen machine name from its
// firmware settings once per reachable stretch (#1454). The GET runs outside
// p.state.mu because it is a network call; a failure leaves firmwareNameFetched
// false so the next poll retries, throttled by firmwareNameRetryInterval so a
// persistently erroring settings endpoint never costs one extra request per 1s
// tick. A GaggiMate reports no such name, so it is skipped entirely.
func (p *Poller) maybeFetchFirmwareName(ctx context.Context, machine *machines.Machine, adapter machines.Adapter) {
	if machine.Type != "gaggiuino" {
		return
	}
	now := time.Now().UnixMilli()
	p.state.mu.Lock()
	ms := p.state.machine(machine.ID)
	if ms.firmwareNameFetched ||
		(ms.firmwareNameAttempt != 0 && now-ms.firmwareNameAttempt < firmwareNameRetryInterval.Milliseconds()) {
		p.state.mu.Unlock()
		return
	}
	ms.firmwareNameAttempt = now
	p.state.mu.Unlock()

	fctx, cancel := context.WithTimeout(ctx, firmwareNameFetchTimeout)
	defer cancel()
	raw, err := adapter.GetSettings(fctx, machine, "system")
	if err != nil {
		debugLogf("system: firmware name fetch failed for machine %d: %v", machine.ID, err)
		return
	}
	var parsed struct {
		MachineName *string `json:"machineName"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		debugLogf("system: firmware name settings unmarshal failed for machine %d: %v", machine.ID, err)
		return
	}
	var name *string
	if parsed.MachineName != nil {
		if trimmed := strings.TrimSpace(*parsed.MachineName); trimmed != "" {
			name = &trimmed
		}
	}

	p.state.mu.Lock()
	ms = p.state.machine(machine.ID)
	ms.firmwareNameFetched = true
	ms.firmwareName = name
	p.state.mu.Unlock()
}

// AdapterProvider is the subset of *machines.Handlers this package
// depends on — an interface (not *machines.Handlers directly) so tests can
// supply a fake Adapter without constructing the machines package's full
// HTTP surface (registry, both concrete adapters, firmware checker, ...).
type AdapterProvider interface {
	GetAdapter(m *machines.Machine) (machines.Adapter, error)
}

// Poller is the module-level polling loop as a struct so cmd/server can own
// one instance instead of a module singleton (same rationale as
// machines.gaggiuinoLiveClient).
type Poller struct {
	registry *machines.Registry
	adapters AdapterProvider
	hub      *sse.Hub
	ha       *ha.Client

	runtime *RuntimeState
	state   pollGlobalState
	// preheatHist records finished preheat runs (preheat_history.go) — its own
	// lock, see preheatHistoryStore's doc comment.
	preheatHist preheatHistoryStore

	// shots is the sync-target Repository, wired via SetShotsRepo (sync.go)
	// rather than NewPoller so the existing NewPoller call sites stay
	// unchanged. nil until cmd/server sets it — RunManualSync no-ops then.
	shots *shots.Repository

	// maintenance is the maintenance Repository the machine-native service-log
	// sync writes into, wired via SetMaintenanceRepo
	// (maintenance_sync.go) — same rationale as shots above. nil until
	// cmd/server sets it — syncNativeMaintenance no-ops then.
	maintenance *maintenance.Repository

	// serviceLogUnsupportedLogged holds the machine IDs whose "firmware has no
	// service log" case (ErrServiceLogUnsupported, a 404 on older Gaggiuino
	// firmware) has already been logged, so the per-sync failure isn't logged
	// on every cycle. sync.Map because several machines sync concurrently
	// (sync_triggers.go); see syncNativeMaintenance (maintenance_sync.go).
	serviceLogUnsupportedLogged sync.Map

	// profilesRepo is the offline-profile-editor local cache/outbox, wired
	// via SetProfilesRepo (profile_sync.go) — same rationale as shots
	// above. nil until cmd/server sets it — every profile_sync.go function
	// no-ops then.
	profilesRepo *machines.ProfilesRepository

	// onProfilesChanged, when set, runs once after a sweep changed profile rows (see profile_sync.go); nil is a no-op.
	onProfilesChanged func()

	// liveTransport is the optional MQTT live-data override (#608), wired via
	// SetLiveTransport. nil in tests and when MQTT support isn't compiled in
	// — the poller then always reads live data through the adapter's WS path,
	// exactly as before this hook existed.
	liveTransport LiveTransport

	liveMu     sync.Mutex
	liveTicker *time.Ticker
	liveStop   chan struct{}

	// lifeCtx is Start()'s context — the parent for every auto-sync
	// goroutine (sync_triggers.go) so they die with the poller. nil until
	// Start runs; syncCtx() falls back to context.Background() for unit
	// tests that drive a trigger directly.
	lifeCtx context.Context
	// syncIntervalOverride, when > 0, replaces loadSyncIntervalMinutes()
	// for the periodic scheduler — tests only.
	syncIntervalOverride time.Duration
	// syncFn, when set, replaces syncDefaultMachineShots for the automatic
	// triggers (sync_triggers.go) — tests only, so a trigger's behavior can
	// be observed without a live machine.
	syncFn func(context.Context) error

	// bg tracks the fire-and-forget sync goroutines the trigger methods start
	// (sync_triggers.go), so a test can join them before its DB/temp dirs are
	// torn down (#1599). Production never waits on it: each goroutine is bounded
	// by its own delay and the poller-lifetime context.
	bg sync.WaitGroup
}

// NewPoller wires registry (the default machine's host/switch-entity source of
// truth) + adapters (machines.Handlers.GetAdapter) + hub (live-snapshot/
// preheat-update SSE producer) + haClient (switch-state reads, the ready-by
// auto turn-on call) into one Poller.
func NewPoller(registry *machines.Registry, adapters AdapterProvider, hub *sse.Hub, haClient *ha.Client) *Poller {
	return &Poller{registry: registry, adapters: adapters, hub: hub, ha: haClient, runtime: NewRuntimeState()}
}

// Runtime exposes the default machine's RuntimeState to handlers.go
// (GET /api/machine/status) and preheat.go.
func (p *Poller) Runtime() *RuntimeState { return p.runtime }

// SetLiveTransport wires the #608 MQTT live-data override — cmd/server calls
// this with *mqtt.Transport after NewPoller, the same post-construction
// pattern as SetShotsRepo. nil-safe: never set in tests.
func (p *Poller) SetLiveTransport(lt LiveTransport) { p.liveTransport = lt }

// StatusInfo is the subset of the default machine's poll state GET
// /api/status reports. Its top-level fields stay default-machine aliases
// (#1201) — glp-integration and the machine cards read them.
type StatusInfo struct {
	MachineReachable     *bool
	LastMachineError     *string
	LastMachineSuccess   *int64
	CachedMachineVersion *string
}

// MachinePollStatus is one machine's poll state, reported per entry in GET
// /api/status's machines[] array (#1201).
type MachinePollStatus struct {
	Reachable       *bool
	LastError       *string
	FirmwareVersion *string
	FirmwareName    *string
}

// defaultMachineID resolves the configured default machine's id, or 0 when
// none exists.
func (p *Poller) defaultMachineID() (int64, bool) {
	m, err := p.registry.GetDefaultMachine()
	if err != nil || m == nil {
		return 0, false
	}
	return m.ID, true
}

// StatusInfo snapshots the default machine's poll state.
func (p *Poller) StatusInfo() StatusInfo {
	id, _ := p.defaultMachineID()
	p.state.mu.Lock()
	defer p.state.mu.Unlock()
	ms := p.state.machines[id]
	if ms == nil {
		return StatusInfo{}
	}
	return StatusInfo{
		MachineReachable:     ms.reachable,
		LastMachineError:     ms.lastError,
		LastMachineSuccess:   ms.lastSuccess,
		CachedMachineVersion: ms.version,
	}
}

// MachineStatus returns machine id's own poll state (#1201), with zero-value
// fields when nothing has been observed for it yet.
func (p *Poller) MachineStatus(id int64) MachinePollStatus {
	p.state.mu.Lock()
	defer p.state.mu.Unlock()
	ms := p.state.machines[id]
	if ms == nil {
		return MachinePollStatus{}
	}
	return MachinePollStatus{Reachable: ms.reachable, LastError: ms.lastError, FirmwareVersion: ms.version, FirmwareName: ms.firmwareName}
}

// MachineKnownOffline reports whether machine id can be treated as known
// offline without a live probe (#1572), so the profiles and firmware-version
// handlers can skip their fetch timeouts.
//
// A definite unreachability answer wins: Reachable set and false is offline,
// Reachable set and true is not (a machine that answers is never offline, even
// if its switch reads off). Only when reachability is still unknown (nil) does
// the default machine's switch decide — a configured switch that reads off
// means live polling never started, so the machine is offline. That is exactly
// the machine-off condition the preheat logic uses (preheat.go); a machine
// reporting its own standby is still reachable and is NOT offline. Every other
// case (non-default machine with no poll state, no switch configured, switch
// on) stays false so the live path runs unchanged.
func (p *Poller) MachineKnownOffline(id int64) bool {
	if st := p.MachineStatus(id); st.Reachable != nil {
		return !*st.Reachable
	}
	defID, ok := p.defaultMachineID()
	if !ok || id != defID {
		return false
	}
	return p.defaultSwitchEntity() != "" && !p.runtime.Get().MachineOn
}

// Start runs this domain's startup sequence: load any persisted preheat
// session, run one unconditional checkAndApplyMachinePower (the call that
// actually starts live polling on a fresh boot for the common
// no-HA-switch-control install, see checkAndApplyMachinePower's own comment),
// then launch the 30s HA-check and 30s preheat-watch tickers. ctx bounds both
// tickers' lifetime — cancelling it stops this Poller, though it does NOT stop
// an already-running live-poll ticker (that one's own lifecycle is
// startLivePolling/stopLivePolling-driven).
func (p *Poller) Start(ctx context.Context) {
	p.lifeCtx = ctx
	p.loadPreheatState()
	if err := p.checkAndApplyMachinePower(ctx); err != nil {
		log.Printf("system: machine power check failed on startup: %v", err)
	}
	// #953: the periodic shot-history pull. A no-op until SetShotsRepo has been
	// called (cmd/server does; tests generally don't).
	httputil.SafeGo("system: scheduled sync", func() { p.runScheduledSync(ctx) })
	httputil.SafeGo("system: background HA check", func() {
		p.runTicker(ctx, backgroundHaCheckInterval, func() {
			if err := p.checkAndApplyMachinePower(ctx); err != nil {
				log.Printf("system: background HA check failed: %v", err)
			}
		})
	})
	httputil.SafeGo("system: preheat watch", func() {
		p.runTicker(ctx, preheatWatchInterval, func() { p.preheatWatchTick(ctx) })
	})
	// #profile-sync: catches every machine besides the default one —
	// maybeCatchUpAfterRecovery/scheduleSyncAfterBrew (sync_triggers.go)
	// only ever run for the default machine, so a second registered machine
	// with pending offline profile edits has no other trigger to reach it.
	httputil.SafeGo("system: profile sync sweep", func() {
		p.runTicker(ctx, profilesSyncInterval, func() { p.runProfileSyncSweep(ctx) })
	})
	// ctx cancellation also tears the live-poll ticker down (its goroutine is
	// otherwise only stopped by stopLivePolling on a machine-off transition).
	// This gives the binary — and, load-bearing here, cmd/server's smoke test
	// — a clean shutdown with no leaked poll goroutine.
	httputil.SafeGo("system: live poll shutdown watcher", func() {
		<-ctx.Done()
		p.stopLivePolling()
	})
}

func (p *Poller) runTicker(ctx context.Context, interval time.Duration, fn func()) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			fn()
		}
	}
}

// checkAndApplyMachinePower's early-exit branch fires on EITHER no switch
// entity configured OR no HA integration at all (a switch entity configured
// but no token to read it with is just as unable to tell GLP the machine's
// power state), and always just ensures live polling is running, treating the
// machine as permanently "on" since nothing in this install can tell GLP
// otherwise. That branch is also what Start() above relies on to begin polling
// on a fresh boot for the common case (no HA switch-control configured):
// calling this repeatedly on that path is a harmless no-op once live polling
// is already active, so the HA-token gate has no separate equivalent here —
// this function is safe to call unconditionally on every 30s tick. #901 code
// review: this used to check only `entity == ""` and fall through to
// GetSwitchState otherwise, which always returns nil when no token is
// configured (ha/client.go's `!c.enabled()` guard) — live polling then never
// started for an entity-configured-but-tokenless install, for the entire
// process lifetime.
func (p *Poller) checkAndApplyMachinePower(ctx context.Context) error {
	machine, err := p.registry.GetDefaultMachine()
	if err != nil {
		return err
	}
	var entity string
	if machine != nil && machine.SwitchEntity != nil {
		entity = *machine.SwitchEntity
	}
	if entity == "" || !p.ha.Enabled() {
		if !p.livePollActive() {
			p.startLivePolling()
		}
		return nil
	}
	isOn := p.ha.GetSwitchState(ctx, entity)
	if isOn == nil {
		return nil
	}
	snap := p.runtime.Get()
	if *isOn == snap.MachineOn {
		return nil
	}
	p.runtime.SetMachineOn(*isOn)
	if *isOn {
		log.Printf("system: machine on -- live polling resumed")
		p.startLivePolling()
		// #1153: pull right after the machine comes on instead of waiting for the
		// next interval.
		p.scheduleSyncSoonAfterPowerOn()
	} else {
		log.Printf("system: machine off -- live polling paused")
		p.stopLivePolling()
		p.state.mu.Lock()
		p.state.preheatNotifiedFor = 0
		p.state.mu.Unlock()
	}
	return nil
}

func (p *Poller) livePollActive() bool {
	p.liveMu.Lock()
	defer p.liveMu.Unlock()
	return p.liveTicker != nil
}

// endPreheatSession ends the current preheat session: stamps the switch-off
// time, closes the open preheat run, clears the stability flag and the temp
// history, then persists. Shared by stopLivePolling and applyStandbyTransition
// so both end a session the same way.
func (p *Poller) endPreheatSession(now int64) {
	p.runtime.SetSwitchOffAt(&now)
	p.closePreheatRun(now)
	p.runtime.SetStabilityReady(false)
	p.runtime.ClearTempHistory()
	p.savePreheatState()
}

// beginPreheatSession starts a fresh preheat session at now: stamps the
// switch-on time, opens a new preheat run, clears the temp history and
// persists. Shared by startLivePolling and applyStandbyTransition's
// leave-standby path.
func (p *Poller) beginPreheatSession(now int64) {
	p.runtime.SetSwitchOnAt(&now)
	p.openPreheatRun(now)
	p.runtime.ClearTempHistory()
	p.savePreheatState()
}

// startLivePolling starts the 1s live-poll ticker.
func (p *Poller) startLivePolling() {
	p.liveMu.Lock()
	if p.liveTicker != nil {
		p.liveMu.Unlock()
		return
	}
	now := time.Now().UnixMilli()
	snap := p.runtime.Get()
	if snap.SwitchOnAt == nil || !p.runtime.IsStillWarm(now) {
		p.beginPreheatSession(now)
	} else {
		p.runtime.ClearTempHistory()
	}
	log.Printf("system: live polling started")
	ticker := time.NewTicker(pollInterval)
	stop := make(chan struct{})
	p.liveTicker = ticker
	p.liveStop = stop
	p.liveMu.Unlock()

	httputil.SafeGo("system: live poll loop", func() {
		for {
			select {
			case <-ticker.C:
				p.pollTick()
			case <-stop:
				return
			}
		}
	})

	p.hub.Publish(sse.Event{Type: sse.EventPreheatUpdate, Data: p.buildPreheatResponse()})
}

// stopLivePolling stops the 1s live-poll ticker: the #655 machineReachable
// flip is unconditional, applied even when there was no active live-poll ticker
// to stop — nothing else can ever flip this back to false on its own once a
// runtime never reaches startLivePolling.
func (p *Poller) stopLivePolling() {
	defaultID, hasDefault := p.defaultMachineID()
	if hasDefault {
		reachable := false
		p.state.mu.Lock()
		p.state.machine(defaultID).reachable = &reachable
		p.state.mu.Unlock()
	}

	p.liveMu.Lock()
	if p.liveTicker != nil {
		p.liveTicker.Stop()
		close(p.liveStop)
		p.liveTicker = nil
		p.state.mu.Lock()
		p.state.liveAccum = nil
		// #902/#983: a powered-off machine can't be mid-steam/flush/descale
		// either.
		p.state.steamAccum = nil
		p.state.flushAccum = nil
		p.state.descaleAccum = nil
		// #1324: neither can it report a machine-control snapshot.
		if hasDefault {
			p.state.machine(defaultID).control = nil
		}
		p.state.mu.Unlock()
		// #1498: a switched-off machine is not in standby.
		p.runtime.SetStandby(false)
		p.endPreheatSession(time.Now().UnixMilli())
		log.Printf("system: live polling stopped")
	}
	p.liveMu.Unlock()

	p.hub.Publish(sse.Event{Type: sse.EventPreheatUpdate, Data: p.buildPreheatResponse()})
	p.emitLiveSnapshot()
}

// applyStandbyTransition reconciles the runtime's standby flag with the
// adapter's latest status (#1498). GaggiMate reports m == 0 (standby) while
// still reachable, so live polling keeps running in standby; this flag is what
// tells buildPreheatResponse the machine is off and restarts the preheat clock
// when it wakes. Entering standby ends the session exactly like
// stopLivePolling; leaving it always starts a fresh session — GaggiMate turns
// its heater off in standby, so the old clock must never be kept (the temp
// stability check marks preheat complete quickly if the boiler is still hot).
//
// The bookkeeping runs under liveMu and is skipped when live polling is not
// active, so a late transition cannot open a run after stopLivePolling ended
// the session. The SSE event is published after releasing the lock.
func (p *Poller) applyStandbyTransition(now int64, standby bool) {
	p.liveMu.Lock()
	if p.liveTicker == nil {
		p.liveMu.Unlock()
		return
	}
	snap := p.runtime.Get()
	if standby == snap.Standby {
		p.liveMu.Unlock()
		return
	}
	p.runtime.SetStandby(standby)
	if standby {
		// End the running preheat, drop the stale stability flag and the temp
		// window, so a later wake-up cannot report stabilityReady from the
		// pre-standby session and cold standby readings never land in the open
		// run's samples.
		// A session opened while the machine was already in standby has no
		// samples yet; drop it rather than finalising an empty one-second run.
		p.discardEmptyPreheatRun()
		p.endPreheatSession(now)
		// The session is over and the machine is off, so drop the switch-on time
		// too: a later poll error clears the standby flag, and without this
		// buildPreheatResponse would count down the ended session's stale clock.
		p.runtime.SetSwitchOnAt(nil)
		p.savePreheatState()
		log.Printf("system: machine standby -- preheat clock held")
	} else {
		p.beginPreheatSession(now)
		log.Printf("system: machine left standby -- preheat session started")
	}
	p.liveMu.Unlock()
	p.hub.Publish(sse.Event{Type: sse.EventPreheatUpdate, Data: p.buildPreheatResponse()})
}

// HandleDefaultMachineChange drops the previous default's live state when the
// configured default machine changes (#1543, #1551) and re-evaluates the new
// default from scratch: live polling is stopped (ending the session), the
// switch-on time and the on/standby flags are cleared, then the power check
// runs at once. It starts live polling and a fresh preheat session when the
// new default is on or has no switch entity, and leaves polling stopped when
// its switch is off, so the next switch-on is a real off->on transition.
// Carrying the old flags over left the countdown stuck at the full window:
// polling kept running for an off machine, so its later switch-on found the
// ticker already running and never started a session. Wired from the
// set-default handler through machines.Handlers.SetOnDefaultChanged.
func (p *Poller) HandleDefaultMachineChange() {
	p.stopLivePolling()
	p.runtime.SetSwitchOnAt(nil)
	p.runtime.SetMachineOn(false)
	p.runtime.SetStandby(false)
	p.savePreheatState()
	if err := p.checkAndApplyMachinePower(p.syncCtx()); err != nil {
		log.Printf("system: machine power check after default change failed: %v", err)
	}
	p.hub.Publish(sse.Event{Type: sse.EventPreheatUpdate, Data: p.buildPreheatResponse()})
}

// pollTick is the isPollRunning mutex guard around one pollViaGaggiuinoStatus
// call, so a slow poll (e.g. a machine taking >1s to answer) can never overlap
// with the next tick.
func (p *Poller) pollTick() {
	p.state.mu.Lock()
	if p.state.isPollRunning {
		p.state.mu.Unlock()
		return
	}
	p.state.isPollRunning = true
	p.state.mu.Unlock()

	defer func() {
		p.state.mu.Lock()
		p.state.isPollRunning = false
		p.state.mu.Unlock()
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	p.pollViaGaggiuinoStatus(ctx)
}
