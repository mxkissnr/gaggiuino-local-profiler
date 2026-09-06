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

// LiveTransport is the WS-vs-MQTT dispatch seam lib/live-transport.js
// implements (#608) — *mqtt.Transport satisfies it. Each method's second
// return is true when MQTT is the active transport for this machine (only
// ever the default machine, and only when the Settings toggle is on MQTT
// with a broker configured): the poller then uses the returned value
// (possibly nil, if the MQTT cache is stale/empty) instead of the adapter's
// WS session, exactly as Node's `if (useMqtt) return gaggiuinoMqtt...`. An
// interface (not a direct internal/mqtt import) keeps this central package
// decoupled from the transport implementation, the same pattern
// AdapterProvider already follows here.
type LiveTransport interface {
	SensorSnapshot(isDefaultMachine bool) (*proto.SensorStateSnapshotDto, bool)
	SystemState(isDefaultMachine bool) (*proto.SystemStateDto, bool)
}

// This file ports lib/poll.js: the 1s live-polling loop
// (startLivePolling/stopLivePolling/pollLive/pollViaGaggiuinoStatus) plus
// checkAndApplyMachinePower/backgroundHaCheck, the 30s HA-switch-state
// watcher that starts/stops it. See doc.go for what this phase
// deliberately does not port from lib/poll.js/lib/sync.js (the shot-sync
// triggers, connectivity-stats logging, MQTT transport).

// liveDatapoints mirrors the fixed set of per-tenth-second arrays
// state.liveAccum.datapoints accumulates during a brew — the exact shape
// GET /api/shots/:id already stores for a finished shot (lib/poll.js's
// liveAccum feeds ShotRepository on save), reused here unchanged for the
// in-progress GET /api/live/data / live-snapshot SSE payload.
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
// weight/flow (neither mode moves the scale). Field names match Node's
// state.steamAccum/flushAccum.datapoints.
type modeDatapoints struct {
	TimeInMode  []int `json:"timeInMode"`
	Pressure    []int `json:"pressure"`
	Temperature []int `json:"temperature"`
}

// modeAccumState mirrors state.steamAccum/state.flushAccum — the same
// start/accumulate/stop lifecycle as liveAccumState, minus the brew-only
// profileName/prevWeight.
type modeAccumState struct {
	startTime  int64
	datapoints modeDatapoints
}

// LiveData mirrors openapi.yaml's LiveData schema exactly — GET
// /api/live/data's response and the live-snapshot SSE event's payload,
// both built by buildLiveDataResponse() (#736: single source of truth for
// both, matching routes/sse.js/routes/system.js sharing the same Node
// function).
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
}

// pollGlobalState ports the subset of lib/state.js's module-level fields
// this package needs (as opposed to lib/machine-runtime-state.js's
// per-machine RuntimeState) — mutex-guarded for the same reason
// RuntimeState is (see its own header comment). See RuntimeState's doc
// comment for this struct's mu's fixed lock ordering relative to
// RuntimeState.mu (RuntimeState.mu first, this one second) — a #901
// code-review minimal fix, not a full consolidation.
type pollGlobalState struct {
	mu sync.Mutex

	machineReachable *bool // nil = never checked (#274)
	// lastMachineError/lastMachineSuccess mirror lib/state.js's fields of
	// the same name — openapi.yaml documents them as GET /api/status's
	// `lastMachineError`/`lastMachineSuccess` fields, read via StatusInfo()
	// (Phase 3b, #901) since that endpoint's own Go port.
	lastMachineError     *string
	lastMachineSuccess   *int64
	cachedMachineVersion *string
	isPollRunning        bool
	liveAccum            *liveAccumState
	liveSeq              int
	// #902: steam/flush live sessions, same hard-single-machine slot
	// pattern as liveAccum/liveSeq above.
	steamAccum *modeAccumState
	steamSeq   int
	flushAccum *modeAccumState
	flushSeq   int
	// #983: descale live sessions, same hard-single-machine slot pattern.
	descaleAccum *modeAccumState
	descaleSeq   int
	// wasReachable is #725's tri-state: nil = never polled (the very first
	// successful poll after a host is configured is NOT a "recovery" —
	// that path belongs to routes/machines.js's own save-triggered sync,
	// not ported here either, see doc.go). Unread until the reachability-
	// recovery catch-up sync itself (lib/sync.js, doc.go's "Deliberately
	// not ported" — "the shot-history sync engine is its own future
	// phase") exists to consume the false->true transition this captures.
	wasReachable *bool

	// Phase 2a (#901): manual-sync (POST /api/sync) progress. lastManualSync
	// backs the 30s cooldown; lastSyncTime/lastSyncError mirror
	// lib/state.js's fields of the same name and are now reported by GET
	// /api/status (before 2a they were permanently null — see doc.go).
	// defaultSyncInFlight is syncShots()'s #773 single-run guard.
	lastManualSync      time.Time
	lastSyncTime        *string
	lastSyncError       *string
	defaultSyncInFlight bool

	readyByTargetAt   *int64
	plannedSwitchOnAt *int64
	// preheatNotifySent mirrors lib/state.js's field of the same name,
	// cleared here on machine-off exactly like Node's stopLivePolling does.
	// Unread until _checkPreheatNotify (doc.go's "Deliberately not
	// ported," tracked as a follow-up) is itself ported — nothing sets it
	// true yet, so this reset is currently a no-op every time.
	preheatNotifySent bool
}

// AdapterProvider is the subset of *machines.Handlers this package
// depends on — an interface (not *machines.Handlers directly) so tests can
// supply a fake Adapter without constructing the machines package's full
// HTTP surface (registry, both concrete adapters, firmware checker, ...).
type AdapterProvider interface {
	GetAdapter(m *machines.Machine) (machines.Adapter, error)
}

// Poller ports lib/poll.js's module-level polling loop as a struct so
// cmd/server can own one instance instead of relying on Node's
// module-singleton pattern (same rationale as machines.gaggiuinoLiveClient,
// Phase 1e).
type Poller struct {
	registry *machines.Registry
	adapters AdapterProvider
	hub      *sse.Hub
	ha       *ha.Client

	runtime *RuntimeState
	state   pollGlobalState

	// shots is the sync-target Repository, wired via SetShotsRepo (sync.go)
	// rather than NewPoller so the existing NewPoller call sites stay
	// unchanged. nil until cmd/server sets it — RunManualSync no-ops then.
	shots *shots.Repository

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

// NewPoller wires registry (the default machine's host/switch-entity
// source of truth) + adapters (machines.Handlers.GetAdapter) + hub
// (live-snapshot/preheat-update SSE producer) + haClient (switch-state
// reads, the ready-by auto turn-on call) into one Poller, matching
// lib/poll.js's own module-level dependencies (lib/machines/registry.js,
// lib/ha.js, lib/events.js's bus).
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

// StatusInfo is the subset of pollGlobalState GET /api/status reports —
// see that struct's own field comments (lastMachineError/lastMachineSuccess
// were kept, unread, specifically for this endpoint back in Phase 1g).
type StatusInfo struct {
	MachineReachable     *bool
	LastMachineError     *string
	LastMachineSuccess   *int64
	CachedMachineVersion *string
}

// StatusInfo snapshots pollGlobalState's fields GET /api/status needs.
func (p *Poller) StatusInfo() StatusInfo {
	p.state.mu.Lock()
	defer p.state.mu.Unlock()
	return StatusInfo{
		MachineReachable:     p.state.machineReachable,
		LastMachineError:     p.state.lastMachineError,
		LastMachineSuccess:   p.state.lastMachineSuccess,
		CachedMachineVersion: p.state.cachedMachineVersion,
	}
}

// Start ports server.js's startup sequence for this domain: load any
// persisted preheat session, run one unconditional checkAndApplyMachinePower
// (the call that actually starts live polling on a fresh boot for the
// common no-HA-switch-control install, see checkAndApplyMachinePower's own
// comment), then launch the 30s HA-check and 30s preheat-watch tickers.
// ctx bounds both tickers' lifetime — cancelling it stops this Poller,
// though it does NOT stop an already-running live-poll ticker (that one's
// own lifecycle is startLivePolling/stopLivePolling-driven, exactly like
// Node's livePollTimer).
func (p *Poller) Start(ctx context.Context) {
	p.lifeCtx = ctx
	p.loadPreheatState()
	if err := p.checkAndApplyMachinePower(ctx); err != nil {
		log.Printf("system: machine power check failed on startup: %v", err)
	}
	// #953: the periodic shot-history pull (lib/sync.js's scheduleNextSync).
	// A no-op until SetShotsRepo has been called (cmd/server does; tests
	// generally don't).
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
	// ctx cancellation also tears the live-poll ticker down (its goroutine
	// is otherwise only stopped by stopLivePolling on a machine-off
	// transition). Node's process just exits; this gives the Go binary —
	// and, load-bearing here, cmd/server's smoke test — a clean shutdown
	// with no leaked poll goroutine.
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

// checkAndApplyMachinePower ports checkAndApplyMachinePower(runtime).
// Node's early-exit branch — `if (!entity || !HA_TOKEN)` (lib/poll.js) —
// fires on EITHER no switch entity configured OR no HA integration at all
// (a switch entity configured but no token to read it with is just as
// unable to tell GLP the machine's power state), and always just ensures
// live polling is running, treating the machine as permanently "on" since
// nothing in this install can tell GLP otherwise. That branch is also what
// Start() above relies on to begin polling on a fresh boot for the common
// case (no HA switch-control configured): calling this repeatedly on that
// path is a harmless no-op once live polling is already active, so
// backgroundHaCheck's own Node-side `if (!HA_TOKEN) return` gate has no Go
// equivalent here — this function is safe to call unconditionally on every
// 30s tick. #901 code review: this used to check only `entity == ""` and
// fall through to GetSwitchState otherwise, which always returns nil when
// no token is configured (ha/client.go's `!c.enabled()` guard) — live
// polling then never started for an entity-configured-but-tokenless
// install, for the entire process lifetime.
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

// startLivePolling ports startLivePolling(runtime).
func (p *Poller) startLivePolling() {
	p.liveMu.Lock()
	if p.liveTicker != nil {
		p.liveMu.Unlock()
		return
	}
	now := time.Now().UnixMilli()
	snap := p.runtime.Get()
	if snap.SwitchOnAt == nil || !p.runtime.IsStillWarm(now) {
		p.runtime.SetSwitchOnAt(&now)
		p.savePreheatState()
	}
	p.runtime.ClearTempHistory()
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

// stopLivePolling ports stopLivePolling(runtime): the #655 machineReachable
// flip is unconditional, applied even when there was no active live-poll
// ticker to stop, matching Node's own reasoning (see lib/poll.js's comment)
// — nothing else can ever flip this back to false on its own once a
// runtime never reaches startLivePolling.
func (p *Poller) stopLivePolling() {
	reachable := false
	p.state.mu.Lock()
	p.state.machineReachable = &reachable
	p.state.mu.Unlock()

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
		p.state.mu.Unlock()
		now := time.Now().UnixMilli()
		p.runtime.SetSwitchOffAt(&now)
		p.runtime.SetStabilityReady(false)
		p.runtime.ClearTempHistory()
		p.savePreheatState()
		log.Printf("system: live polling stopped")
	}
	p.liveMu.Unlock()

	p.hub.Publish(sse.Event{Type: sse.EventPreheatUpdate, Data: p.buildPreheatResponse()})
	p.emitLiveSnapshot()
}

// pollTick ports pollLive(runtime): the isPollRunning mutex guard around
// one pollViaGaggiuinoStatus call, so a slow poll (e.g. a machine taking
// >1s to answer) can never overlap with the next tick.
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

// pollViaGaggiuinoStatus ports pollViaGaggiuinoStatus(runtime). Despite the
// name it is adapter-agnostic: adapter.GetStatus dispatches to the right
// machine adapter, and for a GaggiMate default that call now reads the
// persistent evt:status cache (gaggimate_live.go, #952) rather than opening
// a fresh WebSocket every tick (PR #947's "GaggiMate WS hammer") —
// GetLiveSensorSnapshot/GetLiveSystemState return nil for GaggiMate, which
// deriveMachineState already tolerates. The #725 reachability-recovery
// catch-up sync and the brew-finished setTimeout(syncAfterBrew, 3000) are
// ported (#953, sync_triggers.go); still not ported (see doc.go) is
// recordConnectivity()'s debug-log summary.
func (p *Poller) pollViaGaggiuinoStatus(ctx context.Context) {
	machine, err := p.registry.GetDefaultMachine()
	if err != nil || machine == nil {
		return
	}
	// #718: no host configured anywhere -- skip cleanly, don't request
	// against a placeholder/fallback hostname, and don't touch
	// machineReachable (nil stays nil, exactly like Node never assigning
	// state.machineReachable on this early-return path).
	if strings.TrimSpace(machine.Host) == "" {
		return
	}
	adapter, err := p.adapters.GetAdapter(machine)
	if err != nil {
		return
	}

	status, err := adapter.GetStatus(ctx, machine)
	if err != nil {
		p.state.mu.Lock()
		reachable := false
		p.state.machineReachable = &reachable
		p.state.wasReachable = &reachable
		msg := redactURLs(err.Error())
		p.state.lastMachineError = &msg
		p.state.mu.Unlock()
		log.Printf("system: live poll error: %v", err)
		p.emitLiveSnapshot()
		return
	}

	p.state.mu.Lock()
	prevReachable := p.state.wasReachable
	reachable := true
	p.state.machineReachable = &reachable
	p.state.lastMachineError = nil
	now := time.Now().UnixMilli()
	p.state.lastMachineSuccess = &now
	p.state.wasReachable = &reachable
	if p.state.cachedMachineVersion == nil {
		if ver := extractVersion(status.Raw); ver != "" {
			p.state.cachedMachineVersion = &ver
			log.Printf("system: Gaggiuino firmware (from status): %s", ver)
		}
	}
	p.state.mu.Unlock()

	// #725: unreachable->reachable recovery with an outstanding sync — catch
	// up now instead of waiting for the next scheduled pull.
	p.maybeCatchUpAfterRecovery(prevReachable)

	// #608: lib/live-transport.js's dispatch — MQTT for the default machine
	// when the Settings toggle selects it, the adapter's WS session
	// otherwise. When MQTT is the active transport its getter is used even
	// if it returns nil (a stale/empty MQTT cache), never falling through to
	// open a WS session, matching Node's `if (useMqtt) return`.
	var sensorSnap *proto.SensorStateSnapshotDto
	var sysState *proto.SystemStateDto
	if p.liveTransport != nil {
		if snap, mqttActive := p.liveTransport.SensorSnapshot(machine.IsDefault); mqttActive {
			sensorSnap = snap
		} else {
			sensorSnap, _ = adapter.GetLiveSensorSnapshot(ctx, machine)
		}
		if sys, mqttActive := p.liveTransport.SystemState(machine.IsDefault); mqttActive {
			sysState = sys
		} else {
			sysState, _ = adapter.GetLiveSystemState(ctx, machine)
		}
	} else {
		sensorSnap, _ = adapter.GetLiveSensorSnapshot(ctx, machine)
		sysState, _ = adapter.GetLiveSystemState(ctx, machine)
	}

	result := deriveMachineState(DeriveInput{
		Status:     rawStatusFrom(status, machine.HasWaterSensor),
		Now:        now,
		SensorSnap: sensorSnap,
		SysState:   sysState,
	})
	ms := result.MachineStatus
	p.runtime.SetMachineStatus(&ms)
	p.runtime.SetCurrentTemps(zeroToNil(ms.Temperature), zeroToNil(ms.TargetTemperature))

	snap := p.runtime.Get()
	if ms.Temperature > 0 && !result.IsBrewing {
		p.runtime.PushTempHistory(ms.Temperature)
		if snap.SwitchOnAt != nil && ms.TargetTemperature > 0 &&
			ms.Temperature >= ms.TargetTemperature-2 && p.runtime.IsTempStable() {
			preheatMs := int64(loadPreheatMinutes()) * 60_000
			if now-*snap.SwitchOnAt < preheatMs {
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
		p.state.liveAccum = &liveAccumState{startTime: now, profileName: result.ProfileName, prevWeight: ms.Weight}
		log.Printf("system: brew started: profile %s", result.ProfileName)
	}
	brewJustFinished := false
	if !result.IsBrewing && p.state.liveAccum != nil {
		log.Printf("system: brew finished")
		p.state.liveAccum = nil
		p.state.liveSeq++
		brewJustFinished = true
	}
	if result.IsBrewing && p.state.liveAccum != nil {
		acc := p.state.liveAccum
		elapsed := elapsedTenths(now, acc.startTime)
		weightFlow := ms.Weight - acc.prevWeight
		if weightFlow < 0 {
			weightFlow = 0
		}
		acc.prevWeight = ms.Weight
		acc.datapoints.TimeInShot = append(acc.datapoints.TimeInShot, elapsed)
		acc.datapoints.Pressure = append(acc.datapoints.Pressure, round10(ms.Pressure))
		acc.datapoints.Temperature = append(acc.datapoints.Temperature, round10(ms.Temperature))
		acc.datapoints.ShotWeight = append(acc.datapoints.ShotWeight, round10(ms.Weight))
		acc.datapoints.WeightFlow = append(acc.datapoints.WeightFlow, round10(weightFlow))
		acc.datapoints.PumpFlow = append(acc.datapoints.PumpFlow, round10(derefFloat(ms.PumpFlow)))
		acc.datapoints.TargetTemperature = append(acc.datapoints.TargetTemperature, round10(ms.TargetTemperature))
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
		acc.datapoints.Pressure = append(acc.datapoints.Pressure, round10(ms.Pressure))
		acc.datapoints.Temperature = append(acc.datapoints.Temperature, round10(ms.Temperature))
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
		acc.datapoints.Pressure = append(acc.datapoints.Pressure, round10(ms.Pressure))
		acc.datapoints.Temperature = append(acc.datapoints.Temperature, round10(ms.Temperature))
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
		acc.datapoints.Pressure = append(acc.datapoints.Pressure, round10(ms.Pressure))
		acc.datapoints.Temperature = append(acc.datapoints.Temperature, round10(ms.Temperature))
	}
	p.state.mu.Unlock()

	// #953: 3s after a brew ends, pull the shot the machine just wrote
	// (lib/poll.js's setTimeout(syncAfterBrew, 3000)).
	if brewJustFinished {
		p.scheduleSyncAfterBrew()
	}

	p.emitLiveSnapshot()
}

func round10(v float64) int { return int(v*10 + 0.5) }

// elapsedTenths ports lib/poll.js:287's `Math.round((now - startTime) /
// 100)` (tenths-of-a-second precision timeInShot datapoints) — Node rounds,
// a bare Go `int(x/100)` truncates toward zero, which produces a
// systematic off-by-one offset against Node-recorded shots sharing the same
// DB (#901 code review: 950ms elapsed rounds to 10 in Node, truncated to 9).
func elapsedTenths(now, startTime int64) int {
	return int(math.Round(float64(now-startTime) / 100))
}

func zeroToNil(v float64) *float64 {
	if v == 0 {
		return nil
	}
	return &v
}

// rawStatusFrom decodes the two fields machines.Status doesn't already
// carry (waterLevel/upTime) straight off its Raw JSON — the rest come from
// Status's own already-parsed fields. hasWaterSensor gates the GaggiMate-
// specific `wl` field: GaggiMate always sends wl=100 when no ALBA sensor is
// present, so we only read it when the user has explicitly flagged the machine
// as having one. Gaggiuino sends `waterLevel` (not `wl`) and has no such
// ambiguity, so that field is read unconditionally as a fallback.
func rawStatusFrom(s machines.Status, hasWaterSensor bool) RawStatus {
	var extra struct {
		WL         json.RawMessage `json:"wl"`
		WaterLevel json.RawMessage `json:"waterLevel"`
		UpTime     json.Number     `json:"upTime"`
	}
	_ = json.Unmarshal(s.Raw, &extra)
	upTime, _ := extra.UpTime.Int64()

	parseRawInt := func(raw json.RawMessage) *int {
		if len(raw) == 0 || string(raw) == "null" {
			return nil
		}
		var n int64
		if json.Unmarshal(raw, &n) != nil {
			return nil
		}
		v := int(n)
		return &v
	}

	var waterLevel *int
	if hasWaterSensor {
		waterLevel = parseRawInt(extra.WL)
	}
	if waterLevel == nil {
		waterLevel = parseRawInt(extra.WaterLevel)
	}

	var steamOn bool
	if s.SteamOn != nil {
		steamOn = *s.SteamOn
	}
	return RawStatus{
		WaterLevel:        waterLevel,
		UpTime:            int(upTime),
		Brewing:           s.Brewing,
		Temperature:       s.Temperature,
		TargetTemperature: s.TargetTemperature,
		Pressure:          s.Pressure,
		Weight:            derefFloat(s.Weight),
		PumpFlow:          s.PumpFlow,
		ProfileID:         s.ProfileID,
		ProfileName:       s.ProfileName,
		SteamSwitchState:  steamOn,
	}
}

func derefFloat(v *float64) float64 {
	if v == nil {
		return 0
	}
	return *v
}

// extractVersion ports pollViaGaggiuinoStatus's inline
// `status.softwareVersion || status.version || status.firmware ||
// status.buildNumber || status.fw_version || status.buildDate || null`.
func extractVersion(raw json.RawMessage) string {
	var obj struct {
		SoftwareVersion any `json:"softwareVersion"`
		Version         any `json:"version"`
		Firmware        any `json:"firmware"`
		BuildNumber     any `json:"buildNumber"`
		FwVersion       any `json:"fw_version"`
		BuildDate       any `json:"buildDate"`
	}
	if err := json.Unmarshal(raw, &obj); err != nil {
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

// redactURLs ports lib/poll.js's `err.message.replace(/https?:\/\/\S+/g,
// '[url]')` -- lastMachineError must never leak the configured machine
// host to a client.
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

// buildLiveDataResponse ports buildLiveDataResponse(): the single source
// of truth for GET /api/live/data and the live-snapshot SSE payload. Must
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
	// #902 idle stats: read the per-tick machineStatus (RuntimeState.mu
	// first, then p.state.mu — the fixed lock ordering, see RuntimeState's
	// doc comment). Get() releases before p.state.mu is taken below.
	rt := p.runtime.Get()
	var temp, targetTemp, pressure *float64
	var waterLevel *int
	if rt.MachineStatus != nil {
		t := rt.MachineStatus.Temperature
		tt := rt.MachineStatus.TargetTemperature
		pr := rt.MachineStatus.Pressure
		temp, targetTemp, pressure = &t, &tt, &pr
		waterLevel = rt.MachineStatus.WaterLevel // already *int, nil when HasWaterSensor=false (wl field not parsed)
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
	return LiveData{
		IsLive:           isLive,
		ProfileName:      profileName,
		Datapoints:       dp,
		Seq:              p.state.liveSeq,
		MachineReachable: p.state.machineReachable,

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

// emitLiveSnapshot publishes the current buildLiveDataResponse() onto the
// SSE hub as EventLiveSnapshot. This is this package's sole producer of
// that event (see doc.go's "Reconciling with Phase 1e's live.go" section):
// machines/live.go's own WS session cache no longer publishes directly,
// since its raw {machineHost, sensorSnap}/{machineHost, sysState} shape
// doesn't match openapi.yaml's LiveData schema this endpoint/event are
// bound to. Deliberately simpler than Node's #708 optimization (an
// immediate push the instant a fresh WS/MQTT sample arrives, on top of the
// 1s tick) — every push here is tick-driven only; see doc.go.
func (p *Poller) emitLiveSnapshot() {
	p.hub.Publish(sse.Event{Type: sse.EventLiveSnapshot, Data: p.buildLiveDataResponse()})
}
