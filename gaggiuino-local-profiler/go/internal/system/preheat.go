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
	if err != nil || machine == nil || machine.SwitchEntity == nil {
		return ""
	}
	return *machine.SwitchEntity
}

// buildPreheatResponse is shared by GET /api/preheat and
// POST /api/preheat/ready-by so both return the identical shape, and by every
// preheat-update SSE push.
func (p *Poller) buildPreheatResponse() PreheatStatus {
	preheatMins := loadPreheatMinutes()
	preheatMs := int64(preheatMins) * 60_000
	snap := p.runtime.Get()

	p.state.mu.Lock()
	readyByTargetAt := p.state.readyByTargetAt
	plannedSwitchOnAt := p.state.plannedSwitchOnAt
	p.state.mu.Unlock()

	machineOff := snap.Standby || (!snap.MachineOn && p.defaultSwitchEntity() != "")
	if machineOff || snap.SwitchOnAt == nil {
		return PreheatStatus{
			Ready: false, Standby: snap.Standby, Elapsed: 0, Remaining: preheatMins * 60, Pct: 0,
			PreheatTime: preheatMins, Temp: snap.CurrentTemp, TargetTemp: snap.CurrentTargetTemp,
			ReadyByTargetAt: readyByTargetAt, PlannedSwitchOnAt: plannedSwitchOnAt,
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
		ReadyByTargetAt: readyByTargetAt, PlannedSwitchOnAt: plannedSwitchOnAt,
	}
}

// SetReadyByTarget backs POST /api/preheat/ready-by. targetAt == nil cancels a
// pending target.
func (p *Poller) SetReadyByTarget(targetAt *int64) {
	p.state.mu.Lock()
	if targetAt == nil {
		p.state.readyByTargetAt = nil
		p.state.plannedSwitchOnAt = nil
	} else {
		preheatMs := int64(loadPreheatMinutes()) * 60_000
		p.state.readyByTargetAt = targetAt
		planned := *targetAt - preheatMs
		p.state.plannedSwitchOnAt = &planned
	}
	p.state.mu.Unlock()
	p.savePreheatState()
	p.hub.Publish(sse.Event{Type: sse.EventPreheatUpdate, Data: p.buildPreheatResponse()})
}

// readyByExpired reports whether a ready-by target is more than readyByGrace
// in the past — i.e. so stale it must be dropped rather than acted on.
func readyByExpired(targetAt int64, now time.Time) bool {
	return now.UnixMilli() > targetAt+readyByGrace.Milliseconds()
}

// clearReadyByTarget drops a pending ready-by pair, persists the cleared state
// and pushes the preheat update to open pages. Shared by the two places a
// target is consumed: after a switch-on, and when a target turns out stale.
func (p *Poller) clearReadyByTarget() {
	p.state.mu.Lock()
	p.state.readyByTargetAt = nil
	p.state.plannedSwitchOnAt = nil
	p.state.mu.Unlock()
	p.savePreheatState()
	p.hub.Publish(sse.Event{Type: sse.EventPreheatUpdate, Data: p.buildPreheatResponse()})
}

// checkReadyByPreheat is one-shot: it fires the switch on once the planned
// time is reached, then clears the target so it never re-fires, cleared
// regardless of whether the HA call succeeds (a persistently unreachable HA
// instance shouldn't be hammered every 30s tick). A target that went stale
// while the app was running is cleared without switching on.
func (p *Poller) checkReadyByPreheat(ctx context.Context) {
	p.state.mu.Lock()
	readyByTargetAt := p.state.readyByTargetAt
	plannedSwitchOnAt := p.state.plannedSwitchOnAt
	p.state.mu.Unlock()
	if readyByTargetAt == nil || plannedSwitchOnAt == nil {
		return
	}
	if p.runtime.Get().MachineOn {
		return
	}
	now := time.Now()
	if now.UnixMilli() < *plannedSwitchOnAt {
		return
	}
	if readyByExpired(*readyByTargetAt, now) {
		log.Printf("system: discarded stale ready-by target from %s", time.UnixMilli(*readyByTargetAt).Format(time.RFC3339))
		p.clearReadyByTarget()
		return
	}
	if entity := p.defaultSwitchEntity(); entity != "" {
		if err := p.ha.CallHaService(ctx, "switch", "turn_on", map[string]any{"entity_id": entity}); err != nil {
			log.Printf("system: ready-by preheat switch-on failed: %v", err)
		} else {
			log.Printf("system: ready-by preheat: switch %s -> turn_on", entity)
		}
	}
	// Remember the pair right before clearing it, so the run this turn-on is
	// about to start can attribute the ready-by target to itself
	// (preheat_history.go's lastReadyBy).
	p.rememberLastReadyBy(readyByTargetAt, plannedSwitchOnAt)
	p.clearReadyByTarget()
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
			p.state.mu.Lock()
			p.state.readyByTargetAt = s.ReadyByTargetAt
			p.state.plannedSwitchOnAt = s.PlannedSwitchOnAt
			p.state.mu.Unlock()
		}
	}
	if snap := p.runtime.Get(); snap.SwitchOnAt != nil {
		log.Printf("system: preheat state restored: started %d min ago", (now-*snap.SwitchOnAt)/60000)
	}
}
