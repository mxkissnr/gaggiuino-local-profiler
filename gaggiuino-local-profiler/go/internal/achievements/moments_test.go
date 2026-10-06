package achievements

import (
	"testing"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// Tests for the moments card and the new endurance stamps. Each badge is
// exercised through the registry's own Check/Progress so the wiring (id, card,
// stamp, threshold) is covered, not just a helper in isolation.

// localUnix is the Unix-seconds timestamp of a wall-clock time in the server's
// local zone, so localParts() reads back exactly those parts.
func localUnix(y int, mo time.Month, d, h, mi int) int64 {
	return time.Date(y, mo, d, h, mi, 0, 0, time.Local).Unix()
}

func ctxWith(shs ...shots.Shot) *Context { return &Context{Shots: shs} }

// newShot builds a shot with an injected score, as buildContext does.
func newShot(id, ts, machineID int64, score int) shots.Shot {
	sc := score
	return shots.Shot{
		"id":        id,
		"timestamp": ts,
		"machineId": machineID,
		"score":     &sc,
	}
}

// withYield attaches a shotWeight datapoint series so finalWeightG reads back
// the given grams.
func withYield(s shots.Shot, grams float64) shots.Shot {
	s["datapoints"] = map[string]any{"shotWeight": []any{grams * 10}}
	return s
}

func findBadge(t *testing.T, id string) badge {
	t.Helper()
	for _, b := range badges() {
		if b.ID == id {
			return b
		}
	}
	t.Fatalf("badge %q not found in registry", id)
	return badge{}
}

func unlockCheck(t *testing.T, id string, c *Context) bool {
	t.Helper()
	return findBadge(t, id).Check(c)
}

func progressValue(t *testing.T, id string, c *Context) int {
	t.Helper()
	b := findBadge(t, id)
	if b.Progress == nil {
		t.Fatalf("badge %q has no progress function", id)
	}
	return b.Progress(c)
}

func TestMoments_MidnightRound(t *testing.T) {
	cases := []struct {
		name string
		shs  []shots.Shot
		want bool
	}{
		{"three across midnight", []shots.Shot{
			newShot(1, localUnix(2026, time.May, 1, 23, 30), 1, 90),
			newShot(2, localUnix(2026, time.May, 2, 0, 20), 1, 90),
			newShot(3, localUnix(2026, time.May, 2, 2, 50), 1, 90),
		}, true},
		{"only two at night", []shots.Shot{
			newShot(1, localUnix(2026, time.May, 1, 23, 30), 1, 90),
			newShot(2, localUnix(2026, time.May, 2, 0, 20), 1, 90),
		}, false},
		{"03:10 falls outside the night", []shots.Shot{
			newShot(1, localUnix(2026, time.May, 1, 23, 30), 1, 90),
			newShot(2, localUnix(2026, time.May, 2, 0, 20), 1, 90),
			newShot(3, localUnix(2026, time.May, 2, 3, 10), 1, 90),
		}, false},
		{"02:50 and 03:10 do not group", []shots.Shot{
			newShot(1, localUnix(2026, time.May, 2, 2, 50), 1, 90),
			newShot(2, localUnix(2026, time.May, 2, 3, 10), 1, 90),
		}, false},
		{"22:00 is not yet night", []shots.Shot{
			newShot(1, localUnix(2026, time.May, 1, 22, 0), 1, 90),
			newShot(2, localUnix(2026, time.May, 1, 23, 30), 1, 90),
			newShot(3, localUnix(2026, time.May, 2, 0, 20), 1, 90),
		}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := unlockCheck(t, "midnight_round", ctxWith(tc.shs...)); got != tc.want {
				t.Errorf("midnight_round = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestMoments_FiveHundreds(t *testing.T) {
	hundreds := func(machine int64, n int) []shots.Shot {
		out := make([]shots.Shot, 0, n)
		for i := 0; i < n; i++ {
			out = append(out, newShot(int64(100+i), int64(1000+i), machine, 100))
		}
		return out
	}
	cases := []struct {
		name string
		shs  []shots.Shot
		want bool
	}{
		{"five in a row", hundreds(1, 5), true},
		{"only four in a row", hundreds(1, 4), false},
		{"a non-100 breaks the run", []shots.Shot{
			newShot(1, 1, 1, 100), newShot(2, 2, 1, 100), newShot(3, 3, 1, 42),
			newShot(4, 4, 1, 100), newShot(5, 5, 1, 100), newShot(6, 6, 1, 100),
		}, false},
		{"five 100s split across machines", []shots.Shot{
			newShot(1, 1, 1, 100), newShot(2, 2, 2, 100), newShot(3, 3, 1, 100),
			newShot(4, 4, 2, 100), newShot(5, 5, 1, 100),
		}, false},
		{"another machine between shots does not break the run", []shots.Shot{
			newShot(1, 1, 1, 100), newShot(9, 2, 2, 40), newShot(2, 3, 1, 100),
			newShot(10, 4, 2, 40), newShot(3, 5, 1, 100), newShot(4, 6, 1, 100),
			newShot(5, 7, 1, 100),
		}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := unlockCheck(t, "five_hundreds", ctxWith(tc.shs...)); got != tc.want {
				t.Errorf("five_hundreds = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestMoments_Litres10(t *testing.T) {
	if unlockCheck(t, "litres_10", ctxWith(withYield(newShot(1, 1, 1, 90), 9900))) {
		t.Error("litres_10 unlocked at 9.9 l, want locked")
	}
	if !unlockCheck(t, "litres_10", ctxWith(withYield(newShot(1, 1, 1, 90), 10000))) {
		t.Error("litres_10 locked at 10 l, want unlocked")
	}

	for _, tc := range []struct {
		grams float64
		want  int
	}{
		{9500, 9},
		{9900, 9},
		{10000, 10},
		{25000, 10}, // capped
	} {
		if got := progressValue(t, "litres_10", ctxWith(withYield(newShot(1, 1, 1, 90), tc.grams))); got != tc.want {
			t.Errorf("litres_10 progress at %.0f g = %d, want %d", tc.grams, got, tc.want)
		}
	}
}

func TestEndurance_Litres50(t *testing.T) {
	if unlockCheck(t, "litres_50", ctxWith(withYield(newShot(1, 1, 1, 90), 49000))) {
		t.Error("litres_50 unlocked at 49 l, want locked")
	}
	if !unlockCheck(t, "litres_50", ctxWith(withYield(newShot(1, 1, 1, 90), 50000))) {
		t.Error("litres_50 locked at 50 l, want unlocked")
	}
	if got := progressValue(t, "litres_50", ctxWith(withYield(newShot(1, 1, 1, 90), 49500))); got != 49 {
		t.Errorf("litres_50 progress at 49.5 l = %d, want 49", got)
	}
}

func TestEndurance_Shots2500(t *testing.T) {
	below := make([]shots.Shot, 2499)
	for i := range below {
		below[i] = newShot(int64(i+1), int64(i+1), 1, 90)
	}
	if unlockCheck(t, "shots_2500", ctxWith(below...)) {
		t.Error("shots_2500 unlocked at 2499 shots, want locked")
	}

	at := make([]shots.Shot, 2500)
	for i := range at {
		at[i] = newShot(int64(i+1), int64(i+1), 1, 90)
	}
	if !unlockCheck(t, "shots_2500", ctxWith(at...)) {
		t.Error("shots_2500 locked at 2500 shots, want unlocked")
	}
	if got := progressValue(t, "shots_2500", ctxWith(at...)); got != 2500 {
		t.Errorf("shots_2500 progress = %d, want 2500", got)
	}
}

func TestMoments_Comeback(t *testing.T) {
	const day = int64(86_400)
	cases := []struct {
		name string
		gap  int64
		last int // score of the second shot
		want bool
	}{
		{"five-day break then 95", 5 * day, 95, true},
		{"four-day break then 95", 4 * day, 95, false},
		{"five-day break then 94", 5 * day, 94, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			shs := []shots.Shot{
				newShot(1, 1_000_000, 1, 90),
				newShot(2, 1_000_000+tc.gap, 1, tc.last),
			}
			if got := unlockCheck(t, "comeback", ctxWith(shs...)); got != tc.want {
				t.Errorf("comeback = %v, want %v", got, tc.want)
			}
		})
	}
	if unlockCheck(t, "comeback", ctxWith(newShot(1, 1_000_000, 1, 100))) {
		t.Error("comeback unlocked with a single shot, want locked")
	}
}

func TestMoments_SecondHelping(t *testing.T) {
	cases := []struct {
		name string
		gap  int64
		want bool
	}{
		{"30 seconds", 30, true},
		{"10 seconds", 10, true},
		{"60 seconds", 60, true},
		{"61 seconds", 61, false},
		{"5 seconds", 5, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			shs := []shots.Shot{
				newShot(1, 1_000_000, 1, 90),
				newShot(2, 1_000_000+tc.gap, 1, 90),
			}
			if got := unlockCheck(t, "second_helping", ctxWith(shs...)); got != tc.want {
				t.Errorf("second_helping = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestEndurance_YearRound(t *testing.T) {
	const msPerDay = int64(86_400_000)
	now := int64(1_700_000_000_000)
	cases := []struct {
		name string
		days int64
		want bool
	}{
		{"364 days", 364, false},
		{"365 days", 365, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ts := now/1000 - tc.days*86_400
			c := ctxWith(newShot(1, ts, 1, 90))
			c.Now = now
			if got := unlockCheck(t, "year_round", c); got != tc.want {
				t.Errorf("year_round = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestSecret_WishOnlyAt1111(t *testing.T) {
	at1111 := ctxWith(newShot(1, localUnix(2026, time.May, 1, 11, 11), 1, 90))
	if !unlockCheck(t, "secret_wish", at1111) {
		t.Error("secret_wish should unlock at 11:11")
	}
	at1112 := ctxWith(newShot(1, localUnix(2026, time.May, 1, 11, 12), 1, 90))
	if unlockCheck(t, "secret_wish", at1112) {
		t.Error("secret_wish should stay locked at 11:12")
	}
}
