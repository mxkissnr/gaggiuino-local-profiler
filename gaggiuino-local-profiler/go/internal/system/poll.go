package system

import (
	"context"
	"encoding/json"
	"log"
	"math"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/ha"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/httputil"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines/proto"
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
// that starts/stops it. See doc.go for what is deliberately not implemented
// (the shot-sync triggers, connectivity-stats logging, MQTT transport).

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
	// preheatNotifySent is cleared here on machine-off. Nothing sets it true yet:
	// the preheat-ready notification (doc.go's "Deliberately not implemented,"
	// tracked as a follow-up) is not implemented, so this reset is currently a
	// no-op every time.
	preheatNotifySent bool
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

	// profilesRepo is the offline-profile-editor local cache/outbox, wired
	// via SetProfilesRepo (profile_sync.go) — same rationale as shots
	// above. nil until cmd/server sets it — every profile_sync.go function
	// no-ops then.
	profilesRepo *machines.ProfilesRepository

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
		p.state.preheatNotifySent = false
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

// pollViaGaggiuinoStatus is adapter-agnostic despite the name:
// adapter.GetStatus dispatches to the right machine adapter, and for a
// GaggiMate default that call reads the persistent evt:status cache
// (gaggimate_live.go, #952) rather than opening a fresh WebSocket every tick
// (PR #947's "GaggiMate WS hammer") —
// GetLiveSensorSnapshot/GetLiveSystemState return nil for GaggiMate, which
// deriveMachineState already tolerates. The #725 reachability-recovery catch-up
// sync and the brew-finished 3s pull are implemented (#953,
// sync_triggers.go); still not implemented (see doc.go) is recordConnectivity()'s
// debug-log summary.
func (p *Poller) pollViaGaggiuinoStatus(ctx context.Context) {
	machine, err := p.registry.GetDefaultMachine()
	if err != nil || machine == nil {
		return
	}
	// #718: no host configured anywhere -- skip cleanly, don't request against a
	// placeholder/fallback hostname, and don't touch machineReachable (nil stays
	// nil on this early-return path).
	if strings.TrimSpace(machine.Host) == "" {
		return
	}
	adapter, err := p.adapters.GetAdapter(machine)
	if err != nil {
		return
	}

	// The actual HTTP GET happens one layer down, inside the adapter
	// (internal/machines/gaggiuino_adapter.go for a Gaggiuino default), so this
	// traces the poll tick itself rather than the literal request line. Calling
	// debugLogf directly is safe here despite firing every single pollInterval
	// tick (1s): its isDebugLoggingEnabled() check goes through internal/config's
	// shared cache, which now carries its own TTL sized for exactly this hot path
	// (#977 follow-up code review, round 5 -- see
	// internal/config/debuglog.go's debugLoggingCache doc comment), so this no
	// longer needs its own throttling wrapper.
	debugLogf("poll: GET status from %s (%s)", machine.Host, machine.Type)
	status, err := adapter.GetStatus(ctx, machine)
	// The machine-traffic brewing flag is set here, once per poll tick, for every
	// adapter and fallback path: the host is normalized exactly as the counting
	// round tripper keys it, and a failed poll reports not brewing.
	brewingHost, _ := machines.NormalizeMachineHost(machine.Host)
	machines.SetMachineBrewing(brewingHost, err == nil && status.Brewing)
	if err != nil {
		p.state.mu.Lock()
		ms := p.state.machine(machine.ID)
		reachable := false
		ms.reachable = &reachable
		ms.wasReachable = &reachable
		msg := redactURLs(err.Error())
		ms.lastError = &msg
		// #1324: an unreachable machine has no machine-control snapshot.
		ms.control = nil
		p.state.mu.Unlock()
		// #1498: an unreachable machine is not in standby.
		p.runtime.SetStandby(false)
		log.Printf("system: live poll error: %v", err)
		p.emitLiveSnapshot()
		return
	}

	// #1498: reconcile the machine's own standby signal with the runtime
	// before anything below reads it. A standby GaggiMate is still reachable,
	// so live polling keeps running; without this the time-only preheat
	// countdown starts from startLivePolling and reports "ready" from a cold
	// boiler.
	p.applyStandbyTransition(time.Now().UnixMilli(), status.Standby)

	// #1324: refresh the opt-in machine-control snapshot. ControlStateFor
	// reads only the registry cache and one KV row (no network), so it runs
	// outside p.state.mu; a nil result (unsupported adapter, setting off or no
	// connected controller) simply stores null.
	ctrl, _ := machines.ControlStateFor(p.registry, adapter, machine)

	p.state.mu.Lock()
	ms := p.state.machine(machine.ID)
	ms.control = ctrl
	prevReachable := ms.wasReachable
	now := time.Now().UnixMilli()
	markReachableLocked(ms, now)
	reachable := true
	ms.wasReachable = &reachable
	if ms.version == nil {
		if ver := extractVersion(status.Raw); ver != "" {
			ms.version = &ver
			log.Printf("system: Gaggiuino firmware (from status): %s", ver)
		}
	}
	p.state.mu.Unlock()

	// #1454: one-off fetch of the machine's firmware-set name, gated to a
	// Gaggiuino (a GaggiMate reports no such setting) and to once per reachable
	// stretch. Runs after the reachability/version bookkeeping above so a
	// markReachableLocked reset is already applied.
	p.maybeFetchFirmwareName(ctx, machine, adapter)

	// #725: unreachable->reachable recovery with an outstanding sync — catch
	// up now instead of waiting for the next scheduled pull.
	p.maybeCatchUpAfterRecovery(prevReachable)

	// #608/#1447: MQTT for a Gaggiuino default machine when the Settings toggle
	// selects it, the adapter's WS session otherwise. The Gaggiuino firmware's
	// MQTT topics only ever describe a Gaggiuino, so any other machine type
	// (e.g. a GaggiMate default) reads live data from its own adapter instead
	// of being handed the Gaggiuino snapshot. When MQTT is the active transport
	// its getter is used even if it returns nil (a stale/empty MQTT cache),
	// never falling through to open a WS session.
	mqttEligible := machine.IsDefault && machine.Type == "gaggiuino"
	var sensorSnap *proto.SensorStateSnapshotDto
	var sysState *proto.SystemStateDto
	if p.liveTransport != nil {
		if snap, mqttActive := p.liveTransport.SensorSnapshot(mqttEligible); mqttActive {
			sensorSnap = snap
		} else {
			sensorSnap, _ = adapter.GetLiveSensorSnapshot(ctx, machine)
		}
		if sys, mqttActive := p.liveTransport.SystemState(mqttEligible); mqttActive {
			sysState = sys
		} else {
			sysState, _ = adapter.GetLiveSystemState(ctx, machine)
		}
	} else {
		sensorSnap, _ = adapter.GetLiveSensorSnapshot(ctx, machine)
		sysState, _ = adapter.GetLiveSystemState(ctx, machine)
	}

	rawStatus := rawStatusFrom(status, machine.HasWaterSensor)
	result := deriveMachineState(DeriveInput{
		Status:     rawStatus,
		Now:        now,
		SensorSnap: sensorSnap,
		SysState:   sysState,
	})
	derived := result.MachineStatus
	p.runtime.SetMachineStatus(&derived)
	p.runtime.SetCurrentTemps(zeroToNil(derived.Temperature), zeroToNil(derived.TargetTemperature))

	snap := p.runtime.Get()
	if derived.Temperature > 0 && !result.IsBrewing {
		// #1498: standby readings are cold/idle — never let them into the temp
		// history or the open run's samples.
		if !snap.Standby {
			p.runtime.PushTempHistory(derived.Temperature)
			p.recordPreheatSample(now, derived.Temperature, derived.TargetTemperature)
		}
		if !snap.Standby && snap.SwitchOnAt != nil && derived.TargetTemperature > 0 &&
			derived.Temperature >= derived.TargetTemperature-2 && p.runtime.IsTempStable() {
			preheatMs := int64(loadPreheatMinutes()) * 60_000
			if now-*snap.SwitchOnAt < preheatMs {
				// Record the real stabilisation time before backdating the
				// runtime's SwitchOnAt to "preheat complete".
				p.markPreheatStable(now)
				newOnAt := now - preheatMs
				p.runtime.SetSwitchOnAt(&newOnAt)
				p.runtime.SetStabilityReady(true)
				p.savePreheatState()
				log.Printf("system: temperature stable -- preheat marked complete")
				p.hub.Publish(sse.Event{Type: sse.EventPreheatUpdate, Data: p.buildPreheatResponse()})
			}
		}
	} else if result.IsBrewing {
		p.runtime.ClearTempHistory()
	}

	p.state.mu.Lock()
	if result.IsBrewing && p.state.liveAccum == nil {
		p.state.liveAccum = &liveAccumState{startTime: now, profileName: result.ProfileName, prevWeight: derived.Weight}
		log.Printf("system: brew started: profile %s", result.ProfileName)
		debugLogf("Brew started detail: brewSwitchState=%v sensorBrewActive=%v upTime=%d",
			rawStatus.Brewing, sensorSnap != nil && sensorSnap.BrewActive, rawStatus.UpTime)
	}
	brewJustFinished := false
	if !result.IsBrewing && p.state.liveAccum != nil {
		log.Printf("system: brew finished")
		debugLogf("Brew finished detail: brewSwitchState=%v sensorBrewActive=%v upTime=%d",
			rawStatus.Brewing, sensorSnap != nil && sensorSnap.BrewActive, rawStatus.UpTime)
		p.state.liveAccum = nil
		p.state.liveSeq++
		brewJustFinished = true
	}
	if result.IsBrewing && p.state.liveAccum != nil {
		acc := p.state.liveAccum
		elapsed := elapsedTenths(now, acc.startTime)
		weightFlow := derived.Weight - acc.prevWeight
		if weightFlow < 0 {
			weightFlow = 0
		}
		acc.prevWeight = derived.Weight
		acc.datapoints.TimeInShot = append(acc.datapoints.TimeInShot, elapsed)
		acc.datapoints.Pressure = append(acc.datapoints.Pressure, round10(derived.Pressure))
		acc.datapoints.Temperature = append(acc.datapoints.Temperature, round10(derived.Temperature))
		acc.datapoints.ShotWeight = append(acc.datapoints.ShotWeight, round10(derived.Weight))
		acc.datapoints.WeightFlow = append(acc.datapoints.WeightFlow, round10(weightFlow))
		acc.datapoints.PumpFlow = append(acc.datapoints.PumpFlow, round10(derefFloat(derived.PumpFlow)))
		acc.datapoints.TargetTemperature = append(acc.datapoints.TargetTemperature, round10(derived.TargetTemperature))
	}

	// #902: steam/flush live sessions -- same start/stop/accumulate shape
	// as the brew block above, with a simpler datapoint set
	// (timeInMode/pressure/temperature only). isBrewing/isSteaming/isFlushing
	// are NOT strictly mutually exclusive at the signal level: sensorSnap
	// .steamActive and sysState.operationMode are cached independently with
	// their own staleness windows, so a mode transition can transiently read
	// two of them true within the same tick. Guard with an explicit
	// priority instead of trusting exclusivity: brewing > steaming > flushing
	// > descaling (#983: descale added last, same lowest-priority reasoning
	// as flushing).
	effectiveSteaming := result.IsSteaming && !result.IsBrewing
	effectiveFlushing := result.IsFlushing && !result.IsBrewing && !result.IsSteaming
	effectiveDescaling := result.IsDescaling && !result.IsBrewing && !result.IsSteaming && !result.IsFlushing

	if effectiveSteaming && p.state.steamAccum == nil {
		p.state.steamAccum = &modeAccumState{startTime: now}
		log.Printf("system: steam started")
	}
	if !effectiveSteaming && p.state.steamAccum != nil {
		log.Printf("system: steam finished")
		p.state.steamAccum = nil
		p.state.steamSeq++
	}
	if effectiveSteaming && p.state.steamAccum != nil {
		acc := p.state.steamAccum
		acc.datapoints.TimeInMode = append(acc.datapoints.TimeInMode, elapsedTenths(now, acc.startTime))
		acc.datapoints.Pressure = append(acc.datapoints.Pressure, round10(derived.Pressure))
		acc.datapoints.Temperature = append(acc.datapoints.Temperature, round10(derived.Temperature))
	}

	if effectiveFlushing && p.state.flushAccum == nil {
		p.state.flushAccum = &modeAccumState{startTime: now}
		log.Printf("system: flush started")
	}
	if !effectiveFlushing && p.state.flushAccum != nil {
		log.Printf("system: flush finished")
		p.state.flushAccum = nil
		p.state.flushSeq++
	}
	if effectiveFlushing && p.state.flushAccum != nil {
		acc := p.state.flushAccum
		acc.datapoints.TimeInMode = append(acc.datapoints.TimeInMode, elapsedTenths(now, acc.startTime))
		acc.datapoints.Pressure = append(acc.datapoints.Pressure, round10(derived.Pressure))
		acc.datapoints.Temperature = append(acc.datapoints.Temperature, round10(derived.Temperature))
	}

	if effectiveDescaling && p.state.descaleAccum == nil {
		p.state.descaleAccum = &modeAccumState{startTime: now}
		log.Printf("system: descale started")
	}
	if !effectiveDescaling && p.state.descaleAccum != nil {
		log.Printf("system: descale finished")
		p.state.descaleAccum = nil
		p.state.descaleSeq++
	}
	if effectiveDescaling && p.state.descaleAccum != nil {
		acc := p.state.descaleAccum
		acc.datapoints.TimeInMode = append(acc.datapoints.TimeInMode, elapsedTenths(now, acc.startTime))
		acc.datapoints.Pressure = append(acc.datapoints.Pressure, round10(derived.Pressure))
		acc.datapoints.Temperature = append(acc.datapoints.Temperature, round10(derived.Temperature))
	}
	p.state.mu.Unlock()

	// #953: 3s after a brew ends, pull the shot the machine just wrote.
	if brewJustFinished {
		p.scheduleSyncAfterBrew()
	}

	p.emitLiveSnapshot()
}

func round10(v float64) int { return int(v*10 + 0.5) }

// elapsedTenths rounds to tenths-of-a-second precision for timeInShot
// datapoints. It uses math.Round rather than a bare `int(x/100)` truncation:
// truncation toward zero would produce a systematic off-by-one offset against
// shots already recorded with rounded values sharing the same DB (#901 code
// review: 950ms elapsed rounds to 10, truncates to 9).
func elapsedTenths(now, startTime int64) int {
	return int(math.Round(float64(now-startTime) / 100))
}

func zeroToNil(v float64) *float64 {
	if v == 0 {
		return nil
	}
	return &v
}

// statusObject returns the first element when the machine's status body is a
// JSON array (current Gaggiuino firmware), else the body itself so GaggiMate's
// object payload keeps working. An empty array falls through to the raw body,
// which then decodes to no fields.
func statusObject(raw json.RawMessage) json.RawMessage {
	var arr []json.RawMessage
	if err := json.Unmarshal(raw, &arr); err == nil && len(arr) > 0 {
		return arr[0]
	}
	return raw
}

// rawStatusFrom decodes the two fields machines.Status doesn't already
// carry (waterLevel/upTime) straight off its Raw JSON — the rest come from
// Status's own already-parsed fields. Current Gaggiuino firmware reports its
// status as a one-element JSON array whose values are strings, so the body is
// unwrapped before decoding and each field is read tolerantly (#1149).
// hasWaterSensor gates the GaggiMate-specific `wl` field: GaggiMate always
// sends wl=100 when no ALBA sensor is present, so we only read it when the user
// has explicitly flagged the machine as having one. Gaggiuino sends
// `waterLevel` (not `wl`) and has no such ambiguity, so that field is read
// unconditionally as a fallback.
func rawStatusFrom(s machines.Status, hasWaterSensor bool) RawStatus {
	var m map[string]any
	_ = json.Unmarshal(statusObject(s.Raw), &m)

	intField := func(key string) *int {
		v, ok := jsNumberToInt64(m[key])
		if !ok || v < math.MinInt32 || v > math.MaxInt32 {
			return nil
		}
		n := int(v)
		return &n
	}

	var waterLevel *int
	if hasWaterSensor {
		waterLevel = intField("wl")
	}
	if waterLevel == nil {
		waterLevel = intField("waterLevel")
	}

	upTime := 0
	if v := intField("upTime"); v != nil {
		upTime = *v
	}

	var steamOn bool
	if s.SteamOn != nil {
		steamOn = *s.SteamOn
	}
	return RawStatus{
		WaterLevel:        waterLevel,
		UpTime:            upTime,
		Brewing:           s.Brewing,
		FlushActive:       s.Flushing,
		Temperature:       s.Temperature,
		TargetTemperature: s.TargetTemperature,
		Pressure:          s.Pressure,
		Weight:            derefFloat(s.Weight),
		PumpFlow:          s.PumpFlow,
		ProfileID:         s.ProfileID,
		ProfileName:       s.ProfileName,
		SteamSwitchState:  steamOn,
		Warnings:          activeMachineWarnings(m["warn"]),
		UpdateAvailable:   m["up"] == true,
	}
}

// activeMachineWarnings extracts the active warning keys from a GaggiMate
// evt:status `warn` array. GaggiMate WebSocketHandler.cpp's addWarnings
// emits one {k, l, a} entry per WarningManager warning: k is the key, l its
// level (0 ignore / 1 warn / 2 error) and a whether it is currently active.
// Keep only entries that are active (a == true) and at least warn-level
// (l >= 1), preserving the firmware's order. A non-array value yields nil.
func activeMachineWarnings(v any) []string {
	arr, ok := v.([]any)
	if !ok {
		return nil
	}
	var out []string
	for _, e := range arr {
		entry, ok := e.(map[string]any)
		if !ok {
			continue
		}
		k, ok := entry["k"].(string)
		if !ok || k == "" {
			continue
		}
		a, _ := entry["a"].(bool)
		l, _ := entry["l"].(float64)
		if a && l >= 1 {
			out = append(out, k)
		}
	}
	return out
}

func derefFloat(v *float64) float64 {
	if v == nil {
		return 0
	}
	return *v
}

// extractVersion reads the machine's firmware version from the first present
// of softwareVersion/version/firmware/buildNumber/fw_version/buildDate.
func extractVersion(raw json.RawMessage) string {
	var obj struct {
		SoftwareVersion any `json:"softwareVersion"`
		Version         any `json:"version"`
		Firmware        any `json:"firmware"`
		BuildNumber     any `json:"buildNumber"`
		FwVersion       any `json:"fw_version"`
		BuildDate       any `json:"buildDate"`
	}
	if err := json.Unmarshal(statusObject(raw), &obj); err != nil {
		return ""
	}
	for _, v := range []any{obj.SoftwareVersion, obj.Version, obj.Firmware, obj.BuildNumber, obj.FwVersion, obj.BuildDate} {
		if s := anyToString(v); s != "" {
			return s
		}
	}
	return ""
}

func anyToString(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	default:
		return ""
	}
}

// redactURLs replaces any URL in an error message with "[url]" --
// lastMachineError must never leak the configured machine host to a client.
func redactURLs(msg string) string {
	for {
		idx := strings.Index(msg, "http://")
		if idx == -1 {
			idx = strings.Index(msg, "https://")
		}
		if idx == -1 {
			return msg
		}
		end := idx
		for end < len(msg) && msg[end] != ' ' && msg[end] != '\t' && msg[end] != '\n' {
			end++
		}
		msg = msg[:idx] + "[url]" + msg[end:]
	}
}

// buildLiveDataResponse is the single source of truth for GET /api/live/data
// and the live-snapshot SSE payload. Must
// return a value wholly independent of p.state.liveAccum once unlocked: a
// caller (emitLiveSnapshot -> Hub.Publish -> a per-subscriber buffered
// channel, see internal/sse) can hold onto this LiveData and json.Marshal
// it arbitrarily long after this call returns, concurrently with pollTick
// appending to the very same datapoints slices under its own lock (#901
// code review — a `go test -race` reproduction: returning a pointer into
// the locked struct here, as this used to, is a data race between that
// later Marshal and the next tick's writes). copyDatapoints below takes a
// deep copy of the slices while still holding the lock, exactly the
// "copy under lock, then hand out lock-free" pattern
// internal/machines/live.go's GetLiveSensorSnapshot/GetLiveSystemState
// follow for their own cached values (those are safe returning a bare
// pointer instead, since a fresh poll replaces sensorSnap/sysState
// wholesale rather than mutating the previous value in place — this
// package's own RuntimeState.SetMachineStatus relies on the same
// never-mutated-after-set invariant, see its doc comment).
func (p *Poller) buildLiveDataResponse() LiveData {
	defaultID, _ := p.defaultMachineID()
	// #902 idle stats: read the per-tick machineStatus (RuntimeState.mu
	// first, then p.state.mu — the fixed lock ordering, see RuntimeState's
	// doc comment). Get() releases before p.state.mu is taken below.
	rt := p.runtime.Get()
	var temp, targetTemp, pressure *float64
	var waterLevel *int
	// #1409: never nil, so machineWarnings is always a JSON array.
	warnings := []string{}
	var updateAvailable bool
	if rt.MachineStatus != nil {
		t := rt.MachineStatus.Temperature
		tt := rt.MachineStatus.TargetTemperature
		pr := rt.MachineStatus.Pressure
		temp, targetTemp, pressure = &t, &tt, &pr
		waterLevel = rt.MachineStatus.WaterLevel // already *int, nil when HasWaterSensor=false (wl field not parsed)
		warnings = append([]string{}, rt.MachineStatus.Warnings...)
		updateAvailable = rt.MachineStatus.UpdateAvailable
	}

	p.state.mu.Lock()
	defer p.state.mu.Unlock()
	var dp *liveDatapoints
	profileName := ""
	isLive := p.state.liveAccum != nil
	if p.state.liveAccum != nil {
		dp = copyDatapoints(&p.state.liveAccum.datapoints)
		profileName = p.state.liveAccum.profileName
	}
	var steamDP, flushDP, descaleDP *modeDatapoints
	if p.state.steamAccum != nil {
		steamDP = copyModeDatapoints(&p.state.steamAccum.datapoints)
	}
	if p.state.flushAccum != nil {
		flushDP = copyModeDatapoints(&p.state.flushAccum.datapoints)
	}
	if p.state.descaleAccum != nil {
		descaleDP = copyModeDatapoints(&p.state.descaleAccum.datapoints)
	}
	var machineReachable *bool
	// #1324: copy the control snapshot (including its slice) under the lock,
	// same copy-under-lock-then-hand-out-lock-free reasoning as copyDatapoints
	// above — the JSON for this LiveData may be marshalled after this returns.
	var machineControl *machines.ControlState
	if ms := p.state.machines[defaultID]; ms != nil {
		machineReachable = ms.reachable
		if ms.control != nil {
			ctrl := *ms.control
			ctrl.BrewConfirm = append([]string(nil), ms.control.BrewConfirm...)
			machineControl = &ctrl
		}
	}
	return LiveData{
		IsLive:           isLive,
		ProfileName:      profileName,
		Datapoints:       dp,
		Seq:              p.state.liveSeq,
		MachineReachable: machineReachable,

		IsSteaming:      p.state.steamAccum != nil,
		SteamSeq:        p.state.steamSeq,
		SteamDatapoints: steamDP,
		IsFlushing:      p.state.flushAccum != nil,
		FlushSeq:        p.state.flushSeq,
		FlushDatapoints: flushDP,

		IsDescaling:       p.state.descaleAccum != nil,
		DescaleSeq:        p.state.descaleSeq,
		DescaleDatapoints: descaleDP,

		Temperature:       temp,
		TargetTemperature: targetTemp,
		Pressure:          pressure,
		WaterLevel:        waterLevel,

		MachineWarnings:        warnings,
		MachineUpdateAvailable: updateAvailable,

		MachineControl: machineControl,
	}
}

// copyModeDatapoints deep-copies src's slices — same race reasoning as
// copyDatapoints (see buildLiveDataResponse's doc comment).
func copyModeDatapoints(src *modeDatapoints) *modeDatapoints {
	return &modeDatapoints{
		TimeInMode:  append([]int(nil), src.TimeInMode...),
		Pressure:    append([]int(nil), src.Pressure...),
		Temperature: append([]int(nil), src.Temperature...),
	}
}

// copyDatapoints deep-copies src's slices — see buildLiveDataResponse's doc
// comment for why a shallow copy (or no copy at all) isn't safe here.
func copyDatapoints(src *liveDatapoints) *liveDatapoints {
	return &liveDatapoints{
		TimeInShot:        append([]int(nil), src.TimeInShot...),
		Pressure:          append([]int(nil), src.Pressure...),
		Temperature:       append([]int(nil), src.Temperature...),
		ShotWeight:        append([]int(nil), src.ShotWeight...),
		WeightFlow:        append([]int(nil), src.WeightFlow...),
		PumpFlow:          append([]int(nil), src.PumpFlow...),
		TargetTemperature: append([]int(nil), src.TargetTemperature...),
	}
}

// LiveData is the exported form of buildLiveDataResponse, for cmd/server's
// SSE-priming wiring.
func (p *Poller) LiveData() LiveData { return p.buildLiveDataResponse() }

// emitLiveSnapshot publishes the current buildLiveDataResponse() onto the SSE
// hub as EventLiveSnapshot. This is this package's sole producer of that event
// (see doc.go's "Live-snapshot production" section): machines/live.go's own WS
// session cache no longer publishes directly, since its raw
// {machineHost, sensorSnap}/{machineHost, sysState} shape doesn't match
// openapi.yaml's LiveData schema this endpoint/event are bound to. Deliberately
// simpler than #708's optimization (an immediate push the instant a fresh
// WS/MQTT sample arrives, on top of the 1s tick) — every push here is
// tick-driven only; see doc.go.
func (p *Poller) emitLiveSnapshot() {
	p.hub.Publish(sse.Event{Type: sse.EventLiveSnapshot, Data: p.buildLiveDataResponse()})
}
