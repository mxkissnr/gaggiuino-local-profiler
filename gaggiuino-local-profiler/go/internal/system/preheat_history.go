package system

import (
	"encoding/json"
	"log"
	"os"
	"sync"
)

// This file records finished preheat runs so the MCP get_preheat_history tool
// (a later slice of #1196) has data to read. preheat.go only ever persisted
// the CURRENT preheat state (preheat_state.json); a finished run's timeline —
// when the machine really switched on, how the temperature climbed, when it
// stabilised against the target and when it switched off — was discarded.
// Closed runs are kept oldest-first on disk and served newest-first by
// PreheatHistory.

const (
	// preheatHistoryMaxRuns is how many finished runs are retained on disk.
	preheatHistoryMaxRuns = 30
	// preheatHistoryMaxSamples caps one run's stored samples. The 30s spacing
	// plus the 60-minute recording window already bound a run to ~121 samples;
	// this is the hard ceiling the tick enforces regardless.
	preheatHistoryMaxSamples = 180
	// preheatSampleIntervalMS is the minimum gap between two stored samples.
	preheatSampleIntervalMS = 30_000
	// preheatRunMaxAgeMS stops sampling a run older than 60 minutes (a run
	// that never stabilised and was never closed).
	preheatRunMaxAgeMS = 60 * 60 * 1000
	// lastReadyByAttachWindowMS is how soon after a ready-by run's planned
	// switch-on the run must open for the ready-by target to be attributed to
	// it.
	lastReadyByAttachWindowMS = 15 * 60 * 1000
)

// preheatHistoryFile mirrors PREHEAT_STATE_FILE's layout. A var, not a const,
// so tests can point it at a temp dir (same seam as defaultOptionsFile).
var preheatHistoryFile = "/data/preheat_history.json"

// PreheatSample is one temperature reading inside a run. TS is seconds since
// the run's real SwitchOnAt.
type PreheatSample struct {
	TS      float64 `json:"t_s"`
	TempC   float64 `json:"temp_c"`
	TargetC float64 `json:"target_c"`
}

// PreheatRun is one machine-on session recorded as a preheat. SwitchOnAt stays
// the real switch-on time even after the stability shortcut moves the
// runtime's own SwitchOnAt back to backdate "preheat complete".
type PreheatRun struct {
	SwitchOnAt        int64           `json:"switchOnAt"`
	SwitchOffAt       *int64          `json:"switchOffAt"`
	PreheatMinutes    int             `json:"preheatMinutes"`
	PredictedReadyAt  int64           `json:"predictedReadyAt"`
	StableAt          *int64          `json:"stableAt"`
	ReadyByTargetAt   *int64          `json:"readyByTargetAt"`
	PlannedSwitchOnAt *int64          `json:"plannedSwitchOnAt"`
	Samples           []PreheatSample `json:"samples"`
}

// readyByPair is the ready-by target captured at the moment
// checkReadyByPreheat turned the machine on, held until the run it started
// opens and can claim it.
type readyByPair struct {
	readyByTargetAt   int64
	plannedSwitchOnAt int64
}

// preheatHistoryStore holds the closed runs (oldest first), the single open
// run and the pending ready-by pair. It has its own mutex rather than reusing
// Poller.state's: every access here is self-contained (it never needs a
// Poller.state or RuntimeState field), so a separate lock avoids adding a third
// participant to the documented RuntimeState.mu -> state.mu ordering.
type preheatHistoryStore struct {
	mu          sync.Mutex
	loaded      bool
	runs        []PreheatRun
	open        *PreheatRun
	lastReadyBy *readyByPair
}

// ensureLoadedLocked reads preheatHistoryFile once. A missing file is a normal
// first run, not a failure; any other error leaves an empty history and is
// logged exactly once (loaded is set before the read so it never retries).
func (s *preheatHistoryStore) ensureLoadedLocked() {
	if s.loaded {
		return
	}
	s.loaded = true
	data, err := os.ReadFile(preheatHistoryFile)
	if err != nil {
		if !os.IsNotExist(err) {
			log.Printf("system: preheat history load failed: %v", err)
		}
		return
	}
	var runs []PreheatRun
	if err := json.Unmarshal(data, &runs); err != nil {
		log.Printf("system: preheat history parse failed: %v", err)
		return
	}
	s.runs = runs
}

// saveLocked writes the closed runs atomically (tmp + rename, like
// savePreheatState). Best-effort: callers have nothing useful to do on error.
func (s *preheatHistoryStore) saveLocked() {
	b, err := json.Marshal(s.runs)
	if err != nil {
		return
	}
	tmp := preheatHistoryFile + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return
	}
	_ = os.Rename(tmp, preheatHistoryFile)
}

// finalizeOpenRunLocked stamps the open run's switch-off, appends it to the
// history, trims the oldest runs and persists. No-op when nothing is open.
func (s *preheatHistoryStore) finalizeOpenRunLocked(now int64) {
	if s.open == nil {
		return
	}
	at := now
	s.open.SwitchOffAt = &at
	s.runs = append(s.runs, *s.open)
	s.open = nil
	if len(s.runs) > preheatHistoryMaxRuns {
		s.runs = s.runs[len(s.runs)-preheatHistoryMaxRuns:]
	}
	s.saveLocked()
}

// openPreheatRun starts recording a run at the real switch-on time now.
func (p *Poller) openPreheatRun(now int64) {
	p.preheatHist.mu.Lock()
	defer p.preheatHist.mu.Unlock()
	s := &p.preheatHist
	s.ensureLoadedLocked()
	// At most one open run: a leftover one is finalised rather than dropped.
	s.finalizeOpenRunLocked(now)
	minutes := loadPreheatMinutes()
	run := PreheatRun{
		SwitchOnAt:       now,
		PreheatMinutes:   minutes,
		PredictedReadyAt: now + int64(minutes)*60_000,
		Samples:          []PreheatSample{},
	}
	if lr := s.lastReadyBy; lr != nil {
		s.lastReadyBy = nil
		diff := now - lr.plannedSwitchOnAt
		if diff < 0 {
			diff = -diff
		}
		if diff <= lastReadyByAttachWindowMS {
			ready := lr.readyByTargetAt
			planned := lr.plannedSwitchOnAt
			run.ReadyByTargetAt = &ready
			run.PlannedSwitchOnAt = &planned
		}
	}
	s.open = &run
}

// recordPreheatSample appends one sample to the open run, at most every 30s,
// only before it stabilises and only while it is younger than 60 minutes.
func (p *Poller) recordPreheatSample(now int64, temp, target float64) {
	if temp == 0 {
		return
	}
	p.preheatHist.mu.Lock()
	defer p.preheatHist.mu.Unlock()
	run := p.preheatHist.open
	if run == nil || run.StableAt != nil {
		return
	}
	if now-run.SwitchOnAt >= preheatRunMaxAgeMS {
		return
	}
	if len(run.Samples) >= preheatHistoryMaxSamples {
		return
	}
	ts := float64(now-run.SwitchOnAt) / 1000
	if n := len(run.Samples); n > 0 && ts-run.Samples[n-1].TS < float64(preheatSampleIntervalMS)/1000 {
		return
	}
	run.Samples = append(run.Samples, PreheatSample{TS: ts, TempC: temp, TargetC: target})
}

// markPreheatStable stamps the open run's stability time. Callers must do this
// BEFORE moving the runtime's SwitchOnAt backwards; the run's own SwitchOnAt
// deliberately stays the real switch-on time.
func (p *Poller) markPreheatStable(now int64) {
	p.preheatHist.mu.Lock()
	defer p.preheatHist.mu.Unlock()
	if run := p.preheatHist.open; run != nil && run.StableAt == nil {
		at := now
		run.StableAt = &at
	}
}

// closePreheatRun finalises and persists the open run at switch-off.
func (p *Poller) closePreheatRun(now int64) {
	p.preheatHist.mu.Lock()
	defer p.preheatHist.mu.Unlock()
	p.preheatHist.ensureLoadedLocked()
	p.preheatHist.finalizeOpenRunLocked(now)
}

// rememberLastReadyBy captures the ready-by pair just before
// checkReadyByPreheat clears it, for the run that turn-on is about to start.
func (p *Poller) rememberLastReadyBy(readyByTargetAt, plannedSwitchOnAt *int64) {
	if readyByTargetAt == nil || plannedSwitchOnAt == nil {
		return
	}
	p.preheatHist.mu.Lock()
	defer p.preheatHist.mu.Unlock()
	p.preheatHist.lastReadyBy = &readyByPair{
		readyByTargetAt:   *readyByTargetAt,
		plannedSwitchOnAt: *plannedSwitchOnAt,
	}
}

// PreheatHistory returns a deep copy of the recorded runs, newest first, with
// the currently open run (SwitchOffAt == nil) as the first element when one
// exists. The MCP get_preheat_history tool reads through this.
func (p *Poller) PreheatHistory() []PreheatRun {
	p.preheatHist.mu.Lock()
	defer p.preheatHist.mu.Unlock()
	p.preheatHist.ensureLoadedLocked()
	out := make([]PreheatRun, 0, len(p.preheatHist.runs)+1)
	if p.preheatHist.open != nil {
		out = append(out, copyPreheatRun(*p.preheatHist.open))
	}
	for i := len(p.preheatHist.runs) - 1; i >= 0; i-- {
		out = append(out, copyPreheatRun(p.preheatHist.runs[i]))
	}
	return out
}

func copyPreheatRun(r PreheatRun) PreheatRun {
	out := r
	out.SwitchOffAt = copyInt64Ptr(r.SwitchOffAt)
	out.StableAt = copyInt64Ptr(r.StableAt)
	out.ReadyByTargetAt = copyInt64Ptr(r.ReadyByTargetAt)
	out.PlannedSwitchOnAt = copyInt64Ptr(r.PlannedSwitchOnAt)
	if r.Samples != nil {
		out.Samples = make([]PreheatSample, len(r.Samples))
		copy(out.Samples, r.Samples)
	}
	return out
}

func copyInt64Ptr(v *int64) *int64 {
	if v == nil {
		return nil
	}
	c := *v
	return &c
}
