package perfstats

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"
)

var counterStart = time.Date(2026, 1, 2, 3, 4, 0, 0, time.UTC)

func resolveMap(pairs map[string]int64) func(string) (int64, bool) {
	return func(host string) (int64, bool) {
		id, ok := pairs[host]
		return id, ok
	}
}

func findMachine(t *testing.T, out []MachineTrafficSnapshot, id int64) MachineTrafficSnapshot {
	t.Helper()
	for _, m := range out {
		if m.MachineID == id {
			return m
		}
	}
	t.Fatalf("machine %d missing from %+v", id, out)
	return MachineTrafficSnapshot{}
}

// Two hosts must never share counts, even when they hit the same counter.
func TestMachineCounterKeepsHostsSeparate(t *testing.T) {
	c := newMachineCounterAt(counterStart)
	c.countRequestAt("alpha", false, counterStart)
	c.countRequestAt("alpha", false, counterStart)
	c.countRequestAt("beta", false, counterStart)

	out := c.Snapshot(counterStart, resolveMap(map[string]int64{"alpha": 1, "beta": 2}))
	a := findMachine(t, out, 1)
	b := findMachine(t, out, 2)
	if got := a.RequestsPerMinIdle; got != 2 {
		t.Errorf("alpha idle rate = %v, want 2", got)
	}
	if got := b.RequestsPerMinIdle; got != 1 {
		t.Errorf("beta idle rate = %v, want 1", got)
	}
}

// Requests must split on the brew flag in effect when they arrive.
func TestMachineCounterSplitsIdleAndBrewing(t *testing.T) {
	c := newMachineCounterAt(counterStart)
	for i := 0; i < 3; i++ {
		c.countRequestAt("alpha", false, counterStart)
	}
	c.SetBrewing("alpha", true)
	for i := 0; i < 6; i++ {
		c.countRequestAt("alpha", false, counterStart)
	}

	m := findMachine(t, c.Snapshot(counterStart, resolveMap(map[string]int64{"alpha": 1})), 1)
	if m.RequestsPerMinIdle != 3 {
		t.Errorf("idle rate = %v, want 3", m.RequestsPerMinIdle)
	}
	if m.RequestsPerMinBrewing != 6 {
		t.Errorf("brewing rate = %v, want 6", m.RequestsPerMinBrewing)
	}
}

// WebSocket messages and failed requests are counted separately from HTTP
// requests, and a failed 5xx round trip lands in errors_last_15min.
func TestMachineCounterCountsWebSocketAndErrors(t *testing.T) {
	c := newMachineCounterAt(counterStart)
	c.countWSMessageAt("alpha", counterStart)
	c.countWSMessageAt("alpha", counterStart)
	c.countRequestAt("alpha", true, counterStart)

	m := findMachine(t, c.Snapshot(counterStart, resolveMap(map[string]int64{"alpha": 1})), 1)
	if m.WSMessagesPerMin != 2 {
		t.Errorf("ws rate = %v, want 2", m.WSMessagesPerMin)
	}
	if m.ErrorsLast15Min != 1 {
		t.Errorf("errors = %d, want 1", m.ErrorsLast15Min)
	}
}

// Traffic older than the 15-minute window rolls out of the snapshot.
func TestMachineCounterWindowExpires(t *testing.T) {
	c := newMachineCounterAt(counterStart)
	for i := 0; i < 5; i++ {
		c.countRequestAt("alpha", false, counterStart)
	}
	if got := len(c.Snapshot(counterStart, resolveMap(map[string]int64{"alpha": 1}))); got != 1 {
		t.Fatalf("fresh traffic = %d entries, want 1", got)
	}
	later := counterStart.Add(16 * time.Minute)
	if got := len(c.Snapshot(later, resolveMap(map[string]int64{"alpha": 1}))); got != 0 {
		t.Fatalf("expired traffic = %d entries, want 0", got)
	}
}

// A host must never appear in a snapshot: only machine ids, or the aggregate
// unknown entry.
func TestMachineCounterNeverReturnsHost(t *testing.T) {
	c := newMachineCounterAt(counterStart)
	c.countRequestAt("192.168.1.50", false, counterStart)
	c.countWSMessageAt("machine.local:8080", counterStart)

	out := c.Snapshot(counterStart, resolveMap(map[string]int64{"192.168.1.50": 7}))
	blob, err := json.Marshal(out)
	if err != nil {
		t.Fatalf("marshal snapshot: %v", err)
	}
	for _, host := range []string{"192.168.1.50", "machine.local", "8080"} {
		if strings.Contains(string(blob), host) {
			t.Fatalf("snapshot exposed host %q: %s", host, blob)
		}
	}
	m := findMachine(t, out, 7)
	if m.Unknown {
		t.Errorf("resolved host marked unknown")
	}
}

// Hosts that do not resolve fold into one aggregate entry, and that entry's
// counts combine every such host.
func TestMachineCounterAggregatesUnknownHosts(t *testing.T) {
	c := newMachineCounterAt(counterStart)
	c.countRequestAt("alpha", false, counterStart)
	c.countRequestAt("beta", false, counterStart)
	c.countRequestAt("beta", false, counterStart)

	out := c.Snapshot(counterStart, resolveMap(map[string]int64{"alpha": 1}))
	if len(out) != 2 {
		t.Fatalf("entries = %+v, want one machine plus unknown", out)
	}
	unknown := out[len(out)-1]
	if !unknown.Unknown || unknown.MachineID != 0 {
		t.Fatalf("last entry = %+v, want unknown aggregate", unknown)
	}
	if unknown.RequestsPerMinIdle != 2 {
		t.Errorf("unknown idle rate = %v, want 2", unknown.RequestsPerMinIdle)
	}
	// A nil resolver treats every host as unknown.
	if got := len(c.Snapshot(counterStart, nil)); got != 1 {
		t.Errorf("nil resolver entries = %d, want 1", got)
	}
}

// The per-host map is capped; extra hosts fold into "other".
func TestMachineCounterBoundsTrackedHosts(t *testing.T) {
	c := newMachineCounterAt(counterStart)
	for i := 0; i < 200; i++ {
		c.countRequestAt(fmt.Sprintf("host-%d", i), false, counterStart)
	}
	if got := len(c.hosts); got > maxTrackedHosts {
		t.Fatalf("tracked hosts = %d, want at most %d", got, maxTrackedHosts)
	}
}

// A steady 60 requests/min host must read 60 ± 1 when snapshotted at an
// arbitrary second inside the minute: the divisor is the window span actually
// covered (14 full minutes plus the elapsed fraction), not a flat 15.
func TestMachineCounterRateTracksElapsedWindow(t *testing.T) {
	c := newMachineCounterAt(counterStart)
	// One request per second from the start until just before the snapshot,
	// which is a steady 60 requests/min.
	const elapsed = 15*time.Minute + 37*time.Second
	for i := 0; i < int(elapsed/time.Second); i++ {
		c.countRequestAt("alpha", false, counterStart.Add(time.Duration(i)*time.Second))
	}

	now := counterStart.Add(elapsed)
	m := findMachine(t, c.Snapshot(now, resolveMap(map[string]int64{"alpha": 1})), 1)
	if m.RequestsPerMinIdle < 59 || m.RequestsPerMinIdle > 61 {
		t.Fatalf("idle rate = %v, want 60 ± 1", m.RequestsPerMinIdle)
	}
}
