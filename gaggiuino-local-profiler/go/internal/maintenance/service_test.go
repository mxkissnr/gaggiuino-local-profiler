package maintenance

import (
	"testing"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// TestJsFloorDivDays_NegativeDelta_FloorsNotTruncates (#901 code review):
// Go's integer division truncates toward zero; JS's Math.floor always
// rounds toward -infinity. 1.5 days in the future (lastTs > now, e.g. clock
// skew or a hand-edited/restored backup) must floor to -2, not truncate
// to -1.
func TestJsFloorDivDays_NegativeDelta_FloorsNotTruncates(t *testing.T) {
	const dayMs = 86400000
	cases := []struct {
		name    string
		deltaMs int64
		want    int64
	}{
		{"1.5 days in the future", -(dayMs + dayMs/2), -2},
		{"exactly 2 days in the future (no remainder)", -2 * dayMs, -2},
		{"1.5 days in the past", dayMs + dayMs/2, 1},
		{"exactly 1 day in the past", dayMs, 1},
		{"zero delta", 0, 0},
	}
	for _, c := range cases {
		if got := jsFloorDivDays(c.deltaMs); got != c.want {
			t.Errorf("%s: jsFloorDivDays(%d) = %d, want %d", c.name, c.deltaMs, got, c.want)
		}
	}
}

// TestComputeMaintenanceStats_FutureLastDate_DaysSinceIsMinusTwo exercises
// the same fix through the real call path: a task's lastDate 1.5 days in
// the future must produce daysSince = -2 in the computed stat, matching
// Node's `Math.floor((now - lastTs) / 86400000)` exactly.
func TestComputeMaintenanceStats_FutureLastDate_DaysSinceIsMinusTwo(t *testing.T) {
	_, _, _, sqlDB := newTestHandlers(t)
	shotsRepo := shots.NewRepository(sqlDB)

	future := time.Now().Add(36 * time.Hour) // 1.5 days from now
	maint := map[string]Task{
		"descaling": {
			"lastDate":        future.UTC().Format("2006-01-02T15:04:05.000Z"),
			"threshold_shots": float64(200), "threshold_days": float64(60),
		},
	}

	stats, err := ComputeMaintenanceStats(shotsRepo, maint, 1)
	if err != nil {
		t.Fatalf("ComputeMaintenanceStats: %v", err)
	}
	daysSince, ok := stats["descaling"]["daysSince"].(int64)
	if !ok {
		t.Fatalf("daysSince = %#v (%T), want an int64", stats["descaling"]["daysSince"], stats["descaling"]["daysSince"])
	}
	if daysSince != -2 {
		t.Errorf("daysSince = %d, want -2 (Math.floor(-1.5), not Go's truncating -1)", daysSince)
	}
}
