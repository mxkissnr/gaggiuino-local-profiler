package system

import (
	"context"
	"encoding/json"
	"log"
	"math"
	"os"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/sse"
)

// This file ports lib/preheat.js. Deliberately NOT ported: _checkPreheatNotify
// (the barista "preheat ready" HA push notification, gated by orders
// settings' notify_preheat_ready/baristaNotifyService and
// lib/notify-i18n.js's localized text) — wiring it would need a read
// dependency on internal/orders' settings (Repository.GetSettings), and
// internal/orders already depends on this package's runtime snapshot for
// its own shop-open/closed broadcast (see internal/orders/doc.go and
// handlers.go's SetPreheatInfoProvider). Importing internal/orders from
// here would close that into a package cycle; the orders->system direction
// is wired via a callback specifically to avoid it, and doing the same
// symmetrically for this one extra notification is left as a follow-up
// rather than adding a second callback plumbing pass in this already-large
// phase. _checkReadyByPreheat (the ready-by auto turn-on, self-contained —
// only needs registry + ha.Client) IS ported below.

// PreheatStatus mirrors openapi.yaml's PreheatStatus schema — GET
// /api/preheat and POST /api/preheat/ready-by's shared response shape
// (buildPreheatResponse() in Node is the single source of truth for both,
// same pattern this port follows). StabilityReady is a pointer because
// Node's object literal omits the key entirely on the "machine off / never
// switched on" branch — see buildPreheatResponse below.
type PreheatStatus struct {
	Ready             bool     `json:"ready"`
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

// PreheatInfo ports routes/orders.js's _getPreheatInfo(): whether the
// default machine is currently within its configured preheat window, and
// how many minutes remain if not. Exported for internal/orders' shop-open
// broadcast (see internal/orders/handlers.go's PreheatInfoFunc) — the one
// piece of that domain's own deferral this phase closes.
func (p *Poller) PreheatInfo() (ready bool, remainingMin int) {
	preheatMins := loadPreheatMinutes()
	preheatMs := int64(preheatMins) * 60_000
	snap := p.runtime.Get()
	machineOff := !snap.MachineOn && p.defaultSwitchEntity() != ""
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

// buildPreheatResponse ports buildPreheatResponse(runtime) — shared by GET
// /api/preheat and POST /api/preheat/ready-by so both return the identical
// shape, and by every preheat-update SSE push.
func (p *Poller) buildPreheatResponse() PreheatStatus {
	preheatMins := loadPreheatMinutes()
	preheatMs := int64(preheatMins) * 60_000
	snap := p.runtime.Get()

	p.state.mu.Lock()
	readyByTargetAt := p.state.readyByTargetAt
	plannedSwitchOnAt := p.state.plannedSwitchOnAt
	p.state.mu.Unlock()

	machineOff := !snap.MachineOn && p.defaultSwitchEntity() != ""
	if machineOff || snap.SwitchOnAt == nil {
		return PreheatStatus{
			Ready: false, Elapsed: 0, Remaining: preheatMins * 60, Pct: 0,
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
		Ready: ready, Elapsed: elapsed, Remaining: remaining, Pct: pct, PreheatTime: preheatMins,
		StabilityReady: &stabilityReady, Temp: snap.CurrentTemp, TargetTemp: snap.CurrentTargetTemp,
		ReadyByTargetAt: readyByTargetAt, PlannedSwitchOnAt: plannedSwitchOnAt,
	}
}

// SetReadyByTarget ports setReadyByTarget(targetAt, runtime): backs POST
// /api/preheat/ready-by. targetAt == nil cancels a pending target.
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

// checkReadyByPreheat ports _checkReadyByPreheat(runtime): one-shot —
// fires the switch on once the planned time is reached, then clears the
// target so it never re-fires, cleared regardless of whether the HA call
// succeeds (a persistently unreachable HA instance shouldn't be hammered
// every 30s tick).
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
	if time.Now().UnixMilli() < *plannedSwitchOnAt {
		return
	}
	if entity := p.defaultSwitchEntity(); entity != "" {
		if err := p.ha.CallHaService(ctx, "switch", "turn_on", map[string]any{"entity_id": entity}); err != nil {
			log.Printf("system: ready-by preheat switch-on failed: %v", err)
		} else {
			log.Printf("system: ready-by preheat: switch %s -> turn_on", entity)
		}
	}
	p.state.mu.Lock()
	p.state.readyByTargetAt = nil
	p.state.plannedSwitchOnAt = nil
	p.state.mu.Unlock()
	p.savePreheatState()
	p.hub.Publish(sse.Event{Type: sse.EventPreheatUpdate, Data: p.buildPreheatResponse()})
}

// preheatWatchTick ports startPreheatWatcher's 30s interval body, minus
// _checkPreheatNotify (see this file's header comment).
func (p *Poller) preheatWatchTick(ctx context.Context) {
	p.checkReadyByPreheat(ctx)
	p.hub.Publish(sse.Event{Type: sse.EventPreheatUpdate, Data: p.buildPreheatResponse()})
}

// preheatStateFileShape mirrors the exact JSON preheat_state.json holds —
// read/written verbatim so a Node-written file stays loadable by this
// binary and vice versa (both share /data).
type preheatStateFileShape struct {
	SwitchOnAt        *int64 `json:"switchOnAt"`
	SwitchOffAt       *int64 `json:"switchOffAt"`
	ReadyByTargetAt   *int64 `json:"readyByTargetAt"`
	PlannedSwitchOnAt *int64 `json:"plannedSwitchOnAt"`
}

// savePreheatState ports savePreheatState(runtime): writeFileSafe's
// write-to-.tmp-then-rename pattern, best-effort (errors are swallowed,
// matching Node's bare `catch { /* ignore */ }`).
func (p *Poller) savePreheatState() {
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
		return
	}
	tmp := preheatStateFile + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return
	}
	_ = os.Rename(tmp, preheatStateFile)
}

// loadPreheatState ports loadPreheatState(runtime), called once from
// Start(): restores switchOnAt/switchOffAt (only if within
// preheatStateTTL of now — no reviving a preheat session from days ago)
// and any pending ready-by target.
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
		p.state.mu.Lock()
		p.state.readyByTargetAt = s.ReadyByTargetAt
		p.state.plannedSwitchOnAt = s.PlannedSwitchOnAt
		p.state.mu.Unlock()
	}
	if snap := p.runtime.Get(); snap.SwitchOnAt != nil {
		log.Printf("system: preheat state restored: started %d min ago", (now-*snap.SwitchOnAt)/60000)
	}
}
