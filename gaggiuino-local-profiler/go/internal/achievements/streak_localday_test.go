package achievements

import (
	"testing"
	"time"
	_ "time/tzdata" // the zones below must load on hosts without a tz database

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// #1727: day streaks bucket shots by the server's local calendar day
// (time.Local, the same day the shot list's today-count uses), not UTC. Each
// case runs under several non-UTC zones on both sides of UTC; every shot near
// local midnight lands in a different UTC day than its local one, so a UTC
// bucketing would give a different streak.

var streakZones = []string{"America/Los_Angeles", "Asia/Tokyo", "Pacific/Auckland"}

// withLocal runs fn with time.Local set to the named zone.
func withLocal(t *testing.T, name string, fn func(t *testing.T)) {
	t.Helper()
	loc, err := time.LoadLocation(name)
	if err != nil {
		t.Fatalf("LoadLocation(%q): %v", name, err)
	}
	t.Run(name, func(t *testing.T) {
		prev := time.Local
		time.Local = loc
		t.Cleanup(func() { time.Local = prev })
		fn(t)
	})
}

func streakShots(ts ...int64) []shots.Shot {
	out := make([]shots.Shot, len(ts))
	for i, v := range ts {
		out[i] = shots.Shot{"id": int64(i + 1), "timestamp": v}
	}
	return out
}

func streakAt(shotList []shots.Shot, now int64) int {
	return currentDayStreak(shotDaySet(shotList), now*1000)
}

func TestDayStreak_LocalMidnight(t *testing.T) {
	for _, zone := range streakZones {
		withLocal(t, zone, func(t *testing.T) {
			// Just before and just after local midnight: two local days.
			before := localUnix(2026, time.June, 9, 23, 50)
			after := localUnix(2026, time.June, 10, 0, 10)
			if got := streakAt(streakShots(before, after), localUnix(2026, time.June, 10, 8, 0)); got != 2 {
				t.Errorf("23:50 + 00:10 the next day: streak = %d, want 2", got)
			}

			// Only a shot at 23:59 yesterday, checked at 00:01 today: the
			// streak still runs (it may end yesterday).
			if got := streakAt(streakShots(localUnix(2026, time.June, 9, 23, 59)), localUnix(2026, time.June, 10, 0, 1)); got != 1 {
				t.Errorf("23:59 yesterday at 00:01 today: streak = %d, want 1", got)
			}

			// A shot at 00:01 two days ago and none since: broken.
			if got := streakAt(streakShots(localUnix(2026, time.June, 8, 0, 1)), localUnix(2026, time.June, 10, 23, 59)); got != 0 {
				t.Errorf("00:01 two days ago: streak = %d, want 0", got)
			}

			// 23:59 two days ago and 00:01 today, nothing on the local day in
			// between: the run is one day, even though the two shots are
			// only 24h02m apart.
			gap := streakShots(localUnix(2026, time.June, 8, 23, 59), localUnix(2026, time.June, 10, 0, 1))
			if got := streakAt(gap, localUnix(2026, time.June, 10, 12, 0)); got != 1 {
				t.Errorf("missing local day in between: streak = %d, want 1", got)
			}
		})
	}
}

func TestDayStreak_AcrossDSTChange(t *testing.T) {
	for _, zone := range streakZones {
		withLocal(t, zone, func(t *testing.T) {
			// One shot a day at 00:30 local through both 2026 DST changes of
			// either hemisphere (Mar/Apr and Sep-Nov windows).
			for _, start := range []time.Month{time.March, time.September} {
				var ts []int64
				for d := 1; d <= 70; d++ {
					ts = append(ts, time.Date(2026, start, d, 0, 30, 0, 0, time.Local).Unix())
				}
				now := time.Date(2026, start, 70, 21, 0, 0, 0, time.Local).Unix()
				if got := streakAt(streakShots(ts...), now); got != 70 {
					t.Errorf("70 consecutive local days from %s: streak = %d, want 70", start, got)
				}
			}
		})
	}
}

// The streak badges read the local day through the registry wiring too.
func TestDayStreak_BadgeProgressUsesLocalDay(t *testing.T) {
	for _, zone := range streakZones {
		withLocal(t, zone, func(t *testing.T) {
			var ts []int64
			for d := 1; d <= 7; d++ {
				ts = append(ts, localUnix(2026, time.June, d, 23, 55)) // late-evening shots
			}
			c := &Context{Shots: streakShots(ts...), Now: localUnix(2026, time.June, 7, 23, 58) * 1000}
			if got := progressValue(t, "streak_7", c); got != 7 {
				t.Errorf("streak_7 progress = %d, want 7", got)
			}
			if !unlockCheck(t, "streak_7", c) {
				t.Error("streak_7 not unlocked after 7 consecutive local days")
			}
		})
	}
}
