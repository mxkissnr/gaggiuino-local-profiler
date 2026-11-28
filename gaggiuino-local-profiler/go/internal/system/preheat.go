package system

import (
	"context"
	"encoding/json"
	"log"
	"math"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/sse"
)

// This file implements the preheat state machine. The barista "preheat
// ready" HA push notification (#145, restored in Go for #1671) is sent
// through the callback installed by SetPreheatReadyNotifier: reading the
// orders settings (Repository.GetSettings) from here would close a package
// cycle with internal/orders (which already depends on this package's
// runtime snapshot for its own shop-open/closed broadcast — see
// internal/orders/doc.go and handlers.go's SetPreheatInfoProvider), so
// cmd/server injects the callback instead. The ready-by auto turn-on,
// self-contained (only needs registry + ha.Client), IS implemented below.

// PreheatStatus is openapi.yaml's PreheatStatus schema — GET /api/preheat and
// POST /api/preheat/ready-by's shared response shape, built by the single
// buildPreheatResponse() below. StabilityReady is a pointer because the key is
// omitted entirely on the "machine off / never switched on" branch — see
// buildPreheatResponse below.
type PreheatStatus struct {
	Ready             bool     `json:"ready"`
	Standby           bool     `json:"standby"`
	Elapsed           int      `json:"elapsed"`
	Remaining         int      `json:"remaining"`
	Pct               float64  `json:"pct"`
	PreheatTime       int      `json:"preheatTime"`
	StabilityReady    *bool    `json:"stabilityReady,omitempty"`
	Temp              *float64 `json:"temp"`
	TargetTemp        *float64 `json:"targetTemp"`
	ReadyByTargetAt   *int64   `json:"readyByTargetAt"`
	PlannedSwitchOnAt *int64   `json:"plannedSwitchOnAt"`
	// #2247: the machine this status describes, always sent (see LiveData).
	MachineID int64 `json:"machineId"`
}

// PreheatStatus is the exported form of buildPreheatResponse, for cmd/server's
// SSE-priming wiring (main.go can't reach package system's unexported
// methods).
func (p *Poller) PreheatStatus() PreheatStatus { return p.buildPreheatResponse() }

// PreheatInfo reports whether the default machine is currently within its
// configured preheat window, and how many minutes remain if not. Exported for
// internal/orders' shop-open broadcast (see internal/orders/handlers.go's
// PreheatInfoFunc).
func (p *Poller) PreheatInfo() (ready bool, remainingMin int) {
	preheatMins := loadPreheatMinutes()
	preheatMs := int64(preheatMins) * 60_000
	snap := p.runtime.Get()
	machineOff := snap.Standby || (!snap.MachineOn && p.defaultSwitchEntity() != "")
	if machineOff || snap.SwitchOnAt == nil {
		return false, preheatMins
	}
	remainingMs := preheatMs - (time.Now().UnixMilli() - *snap.SwitchOnAt)
	if remainingMs < 0 {
		remainingMs = 0
	}
	remainingMinutes := int(math.Ceil(float64(remainingMs) / 60000))
	if remainingMinutes < 1 {
		remainingMinutes = 1
	}
	return remainingMs == 0, remainingMinutes
}

func (p *Poller) defaultSwitchEntity() string {
	machine, err := p.registry.GetDefaultMachine()
	if err != nil {
		return ""
	}
	return switchEntityOf(machine)
}

// buildPreheatResponse is shared by GET /api/preheat and
// POST /api/preheat/ready-by so both return the identical shape, and by every
// preheat-update SSE push.
func (p *Poller) buildPreheatResponse() PreheatStatus {
	return p.buildPreheatResponseFor(p.defaultTarget())
}

// buildPreheatResponseFor is buildPreheatResponse for an already-resolved
// machine — the poll tick passes its own machine instead of re-querying the
// registry (#1616); #2247 builds it for any machine from that machine's own
// runtime, slots and switch entity ("" for none).
func (p *Poller) buildPreheatResponseFor(t liveTarget) PreheatStatus {
	preheatMins := loadPreheatMinutes()
	preheatMs := int64(preheatMins) * 60_000
	snap := p.runtimeFor(t).Get()

	p.state.mu.Lock()
	sl := p.state.slotsLocked(t)
	readyByTargetAt := sl.readyByTargetAt
	plannedSwitchOnAt := sl.plannedSwitchOnAt
	p.state.mu.Unlock()

	machineOff := snap.Standby || (!snap.MachineOn && t.switchEntity != "")
	if machineOff || snap.SwitchOnAt == nil {
		return PreheatStatus{
			Ready: false, Standby: snap.Standby, Elapsed: 0, Remaining: preheatMins * 60, Pct: 0,
			PreheatTime: preheatMins, Temp: snap.CurrentTemp, TargetTemp: snap.CurrentTargetTemp,
			ReadyByTargetAt: readyByTargetAt, PlannedSwitchOnAt: plannedSwitchOnAt, MachineID: t.id,
		}
	}

	elapsedMs := time.Now().UnixMilli() - *snap.SwitchOnAt
	elapsed := int(elapsedMs / 1000)
	remaining := int(math.Ceil(float64(preheatMs-elapsedMs) / 1000))
	if remaining < 0 {
		remaining = 0
	}
	pct := float64(elapsedMs) / float64(preheatMs)
	if pct > 1 {
		pct = 1
	}
	if pct < 0 {
		pct = 0
	}
	ready := remaining == 0
	stabilityReady := ready && snap.StabilityReady

	return PreheatStatus{
		Ready: ready, Standby: snap.Standby, Elapsed: elapsed, Remaining: remaining, Pct: pct, PreheatTime: preheatMins,
		StabilityReady: &stabilityReady, Temp: snap.CurrentTemp, TargetTemp: snap.CurrentTargetTemp,
		ReadyByTargetAt: readyByTargetAt, PlannedSwitchOnAt: plannedSwitchOnAt, MachineID: t.id,
	}
}

// publishPreheat pushes t's preheat status: to every subscriber for the
// default machine, only to the subscribers watching it otherwise (#2247).
func (p *Poller) publishPreheat(t liveTarget) {
	p.hub.Publish(sse.Event{Type: sse.EventPreheatUpdate, Data: p.buildPreheatResponseFor(t), MachineID: t.scope()})
}

// SetReadyByTarget backs POST /api/preheat/ready-by for machine t (#2247:
// every machine has its own target). targetAt == nil cancels a pending target.
func (p *Poller) SetReadyByTarget(t liveTarget, targetAt *int64) {
	p.state.mu.Lock()
	sl := p.state.slotsLocked(t)
	if targetAt == nil {
		sl.readyByTargetAt = nil
		sl.plannedSwitchOnAt = nil
	} else {
		preheatMs := int64(loadPreheatMinutes()) * 60_000
		sl.readyByTargetAt = targetAt
		planned := *targetAt - preheatMs
		sl.plannedSwitchOnAt = &planned
	}
	if t.isDefault {
		p.state.readyByFor = t.id
	}
	p.state.mu.Unlock()
	p.savePreheatState()
	p.publishPreheat(t)
}

// readyByExpired reports whether a ready-by target is more than readyByGrace
// in the past — i.e. so stale it must be dropped rather than acted on.
func readyByExpired(targetAt int64, now time.Time) bool {
	return now.UnixMilli() > targetAt+readyByGrace.Milliseconds()
}

// clearReadyByTarget drops t's pending ready-by pair, persists the cleared
// state and pushes the preheat update to open pages. Shared by the two places
// a target is consumed: after a switch-on, and when a target turns out stale.
func (p *Poller) clearReadyByTarget(t liveTarget) {
	p.state.mu.Lock()
	sl := p.state.slotsLocked(t)
	sl.readyByTargetAt = nil
	sl.plannedSwitchOnAt = nil
	p.state.mu.Unlock()
	p.savePreheatState()
	p.publishPreheat(t)
}

// checkReadyByPreheat runs the ready-by check for the default machine and for
// every other machine with a pending target (#2247).
func (p *Poller) checkReadyByPreheat(ctx context.Context) {
	for _, t := range p.readyByTargets() {
		p.checkReadyByPreheatFor(ctx, t)
	}
}

// readyByTargets is the default machine plus every other registered machine
// whose slots hold a ready-by target.
func (p *Poller) readyByTargets() []liveTarget {
	def := p.defaultTarget()
	var ids []int64
	p.state.mu.Lock()
	for id, o := range p.state.others {
		if id != def.id && o.readyByTargetAt != nil {
			ids = append(ids, id)
		}
	}
	p.state.mu.Unlock()
	out := []liveTarget{def}
	for _, id := range ids {
		m, err := p.registry.ResolveMachine(&id)
		if err != nil || m == nil || m.IsDefault {
			continue
		}
		out = append(out, targetOf(m))
	}
	return out
}

// checkReadyByPreheatFor is one-shot: it fires t's own switch on once the
// planned time is reached, then clears the target so it never re-fires,
// cleared regardless of whether the HA call succeeds (a persistently
// unreachable HA instance shouldn't be hammered every 30s tick). A target that
// went stale while the app was running is cleared without switching on.
func (p *Poller) checkReadyByPreheatFor(ctx context.Context, t liveTarget) {
	p.state.mu.Lock()
	sl := p.state.slotsLocked(t)
	readyByTargetAt := sl.readyByTargetAt
	plannedSwitchOnAt := sl.plannedSwitchOnAt
	p.state.mu.Unlock()
	if readyByTargetAt == nil || plannedSwitchOnAt == nil {
		return
	}
	if p.runtimeFor(t).Get().MachineOn {
		return
	}
	now := time.Now()
	if now.UnixMilli() < *plannedSwitchOnAt {
		return
	}
	if readyByExpired(*readyByTargetAt, now) {
		log.Printf("system: discarded stale ready-by target from %s", time.UnixMilli(*readyByTargetAt).Format(time.RFC3339))
		p.clearReadyByTarget(t)
		return
	}
	if entity := t.switchEntity; entity != "" {
		if err := p.ha.CallHaService(ctx, "switch", "turn_on", map[string]any{"entity_id": entity}); err != nil {
			log.Printf("system: ready-by preheat switch-on failed: %v", err)
		} else {
			log.Printf("system: ready-by preheat: switch %s -> turn_on", entity)
		}
	}
	// Remember the pair right before clearing it, so the run this turn-on is
	// about to start can attribute the ready-by target to itself
	// (preheat_history.go's lastReadyBy).
	p.rememberLastReadyBy(t.id, readyByTargetAt, plannedSwitchOnAt)
	p.clearReadyByTarget(t)
}

// preheatReadyNotifier is the process-wide callback that delivers the
// preheat-ready push (#1671), installed by cmd/server through
// SetPreheatReadyNotifier. A package-level pointer (the same pattern as
// internal/shots' annotation hooks) keeps internal/system free of an
// internal/orders import; there is one Poller per process, so a single slot
// is enough.
var preheatReadyNotifier atomic.Pointer[func(ctx context.Context) bool]

// SetPreheatReadyNotifier installs the preheat-ready notification callback.
// Passing nil removes it. The callback returns whether the push was
// delivered; preheatWatchTick latches the one-per-run flag only when it
// returns true, so a failed push is retried on the next tick.
func (p *Poller) SetPreheatReadyNotifier(fn func(ctx context.Context) bool) {
	if fn == nil {
		preheatReadyNotifier.Store(nil)
		return
	}
	preheatReadyNotifier.Store(&fn)
}

// preheatWatchTick is the 30s interval body: the ready-by auto turn-on, the
// one-time preheat-ready notification, then the preheat-update SSE push.
func (p *Poller) preheatWatchTick(ctx context.Context) {
	p.checkReadyByPreheat(ctx)
	p.maybePreheatReadyNotify(ctx)
	p.hub.Publish(sse.Event{Type: sse.EventPreheatUpdate, Data: p.buildPreheatResponse()})
	// #2247: every polled other machine's countdown reaches its watchers too.
	// The barista push above stays default-machine only.
	p.liveMu.Lock()
	ids := make([]int64, 0, len(p.otherLoops))
	for id := range p.otherLoops {
		ids = append(ids, id)
	}
	p.liveMu.Unlock()
	for _, id := range ids {
		m, err := p.registry.ResolveMachine(&id)
		if err != nil || m == nil || m.IsDefault {
			continue
		}
		p.publishPreheat(targetOf(m))
	}
}

// maybePreheatReadyNotify sends the preheat-ready push once per preheat run.
// The run is identified by the SwitchOnAt value it belongs to
// (pollGlobalState.preheatNotifiedFor): a standby wake-up that keeps the same
// switch-on is not announced twice, while a fresh switch-on re-arms the push.
// The run is remembered only after the notifier reports delivery, so a failed
// push retries on the next tick. Not-ready ticks leave the remembered run
// untouched.
func (p *Poller) maybePreheatReadyNotify(ctx context.Context) {
	h := preheatReadyNotifier.Load()
	if h == nil {
		return
	}
	if ready, _ := p.PreheatInfo(); !ready {
		return
	}
	snap := p.runtime.Get()
	if snap.SwitchOnAt == nil {
		return
	}
	p.state.mu.Lock()
	notifiedFor := p.state.preheatNotifiedFor
	p.state.mu.Unlock()
	if notifiedFor == *snap.SwitchOnAt {
		return
	}
	if (*h)(ctx) {
		p.state.mu.Lock()
		p.state.preheatNotifiedFor = *snap.SwitchOnAt
		p.state.mu.Unlock()
	}
}

// preheatStateFileShape is the exact JSON preheat_state.json holds —
// read/written verbatim so an older file stays loadable by this binary and
// vice versa (both share /data).
type preheatStateFileShape struct {
	SwitchOnAt        *int64 `json:"switchOnAt"`
	SwitchOffAt       *int64 `json:"switchOffAt"`
	ReadyByTargetAt   *int64 `json:"readyByTargetAt"`
	PlannedSwitchOnAt *int64 `json:"plannedSwitchOnAt"`
	// Machines holds every other machine's session and ready-by target
	// (#2247), keyed by machine id; the four fields above stay the default
	// machine's, so an older binary still reads the file.
	Machines map[int64]preheatStateFileShape `json:"machines,omitempty"`
}

// preheatSaveMu serializes savePreheatState so two callers can't interleave
// their temp-file write and rename (an older snapshot renamed last).
var preheatSaveMu sync.Mutex

// savePreheatState persists the current preheat state. The write goes through
// a fresh temp file renamed over the target, so a concurrent reader never sees
// a half-written file; failures are logged rather than swallowed.
func (p *Poller) savePreheatState() {
	// Held across the snapshot too: the last writer must write the newest
	// state, not a stale read taken before an earlier caller's rename.
	preheatSaveMu.Lock()
	defer preheatSaveMu.Unlock()

	snap := p.runtime.Get()
	p.state.mu.Lock()
	readyByTargetAt := p.state.readyByTargetAt
	plannedSwitchOnAt := p.state.plannedSwitchOnAt
	p.state.mu.Unlock()

	b, err := json.Marshal(preheatStateFileShape{
		SwitchOnAt: snap.SwitchOnAt, SwitchOffAt: snap.SwitchOffAt,
		ReadyByTargetAt: readyByTargetAt, PlannedSwitchOnAt: plannedSwitchOnAt,
		Machines: p.otherPreheatStates(),
	})
	if err != nil {
		log.Printf("system: saving preheat state: %v", err)
		return
	}
	f, err := os.CreateTemp(filepath.Dir(preheatStateFile), "preheat_state-*.tmp")
	if err != nil {
		log.Printf("system: saving preheat state: %v", err)
		return
	}
	tmp := f.Name()
	if _, err := f.Write(b); err != nil {
		f.Close()
		os.Remove(tmp)
		log.Printf("system: saving preheat state: %v", err)
		return
	}
	if err := f.Close(); err != nil {
		os.Remove(tmp)
		log.Printf("system: saving preheat state: %v", err)
		return
	}
	if err := os.Rename(tmp, preheatStateFile); err != nil {
		os.Remove(tmp)
		log.Printf("system: saving preheat state: %v", err)
		return
	}
}

// otherPreheatStates snapshots every other machine's persisted preheat fields
// (#2247), leaving out machines with nothing to persist; nil when none has
// any. Takes p.state.mu and each RuntimeState.mu one after the other, never
// nested.
func (p *Poller) otherPreheatStates() map[int64]preheatStateFileShape {
	type entry struct {
		id                         int64
		rt                         *RuntimeState
		readyByTargetAt, plannedAt *int64
	}
	var entries []entry
	p.state.mu.Lock()
	for id, o := range p.state.others {
		entries = append(entries, entry{id, o.runtime, o.readyByTargetAt, o.plannedSwitchOnAt})
	}
	p.state.mu.Unlock()
	var out map[int64]preheatStateFileShape
	for _, e := range entries {
		snap := e.rt.Get()
		if snap.SwitchOnAt == nil && snap.SwitchOffAt == nil && e.readyByTargetAt == nil {
			continue
		}
		if out == nil {
			out = map[int64]preheatStateFileShape{}
		}
		out[e.id] = preheatStateFileShape{
			SwitchOnAt: snap.SwitchOnAt, SwitchOffAt: snap.SwitchOffAt,
			ReadyByTargetAt: e.readyByTargetAt, PlannedSwitchOnAt: e.plannedAt,
		}
	}
	return out
}

// restoreOtherPreheatState restores one other machine's persisted session
// and ready-by target with the same TTL and staleness rules loadPreheatState
// applies to the default machine.
func (p *Poller) restoreOtherPreheatState(id int64, s preheatStateFileShape, now time.Time) {
	nowMs := now.UnixMilli()
	ttl := preheatStateTTL.Milliseconds()
	p.state.mu.Lock()
	o := p.state.otherLocked(id)
	if s.ReadyByTargetAt != nil && s.PlannedSwitchOnAt != nil && !readyByExpired(*s.ReadyByTargetAt, now) {
		o.readyByTargetAt = s.ReadyByTargetAt
		o.plannedSwitchOnAt = s.PlannedSwitchOnAt
	}
	rt := o.runtime
	p.state.mu.Unlock()
	if s.SwitchOnAt != nil && nowMs-*s.SwitchOnAt < ttl {
		rt.SetSwitchOnAt(s.SwitchOnAt)
	}
	if s.SwitchOffAt != nil && nowMs-*s.SwitchOffAt < ttl {
		rt.SetSwitchOffAt(s.SwitchOffAt)
	}
}

// loadPreheatState, called once from Start(): restores switchOnAt/switchOffAt
// (only if within preheatStateTTL of now — no reviving a preheat session from
// days ago) and any pending ready-by target, dropping a target that is already
// stale so an app that was down across the target time never switches the
// machine on late.
func (p *Poller) loadPreheatState() {
	data, err := os.ReadFile(preheatStateFile)
	if err != nil {
		return
	}
	var s preheatStateFileShape
	if err := json.Unmarshal(data, &s); err != nil {
		return
	}
	for id, ms := range s.Machines {
		p.restoreOtherPreheatState(id, ms, time.Now())
	}
	now := time.Now().UnixMilli()
	ttl := preheatStateTTL.Milliseconds()
	if s.SwitchOnAt != nil && now-*s.SwitchOnAt < ttl {
		p.runtime.SetSwitchOnAt(s.SwitchOnAt)
	}
	if s.SwitchOffAt != nil && now-*s.SwitchOffAt < ttl {
		p.runtime.SetSwitchOffAt(s.SwitchOffAt)
	}
	if s.ReadyByTargetAt != nil && s.PlannedSwitchOnAt != nil {
		if readyByExpired(*s.ReadyByTargetAt, time.Now()) {
			log.Printf("system: discarded stale ready-by target from %s", time.UnixMilli(*s.ReadyByTargetAt).Format(time.RFC3339))
			// The in-memory pair is left nil; persist that so the stale target
			// is not reconsidered on the next restart.
			p.savePreheatState()
		} else {
			def := p.defaultTarget()
			p.state.mu.Lock()
			p.state.readyByTargetAt = s.ReadyByTargetAt
			p.state.plannedSwitchOnAt = s.PlannedSwitchOnAt
			p.state.readyByFor = def.id
			p.state.mu.Unlock()
		}
	}
	if snap := p.runtime.Get(); snap.SwitchOnAt != nil {
		log.Printf("system: preheat state restored: started %d min ago", (now-*snap.SwitchOnAt)/60000)
	}
}
