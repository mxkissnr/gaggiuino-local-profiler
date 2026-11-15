package achievements

import (
	"testing"
	"time"
	_ "time/tzdata" // Europe/Berlin must load on hosts without a tz database

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/library"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// TestBagFirstUseAgesDays_SharedBeanAge is the #2025 slice-3 outcome: the
// "patient"/"rested" badges already grouped shots per bag, but computed the
// age themselves as a fractional UTC-midnight difference, so a bag first used
// at 00:30 local ten days after roasting counted as 9.9 days and missed the
// 10-day "rested" window, a German-format roast date was skipped entirely and
// a frozen portion aged at the full rate. The age is now the same whole-day
// bean age the shot badge shows for that first shot.
func TestBagFirstUseAgesDays_SharedBeanAge(t *testing.T) {
	prev := time.Local
	loc, err := time.LoadLocation("Europe/Berlin")
	if err != nil {
		t.Fatalf("LoadLocation(Europe/Berlin): %v", err)
	}
	time.Local = loc
	t.Cleanup(func() { time.Local = prev })

	at := func(y int, mo time.Month, d, h, mi int) int64 {
		return time.Date(y, mo, d, h, mi, 0, 0, time.Local).Unix()
	}
	bagOf := func(roastDate string) library.Entity {
		return library.Entity{"id": int64(1), "roastDate": roastDate}
	}
	beanWithBag := func(roastDate string, bag library.Entity) library.Entity {
		return library.Entity{"id": int64(1), "name": "Alpha", "roastDate": roastDate, "bags": []any{bag}}
	}
	single := func(name string, bean library.Entity, ts int64, ann map[string]any, want float64) {
		t.Helper()
		t.Run(name, func(t *testing.T) {
			shotList := []shots.Shot{{"id": int64(1), "timestamp": ts, "annotation": ann}}
			got := bagFirstUseAgesDays(shotList, []library.Entity{bean})
			if len(got) != 1 || got[0] != want {
				t.Fatalf("ages = %v, want [%v]", got, want)
			}
		})
	}

	plainAnn := map[string]any{"coffee": "Alpha"}

	// 00:30 local ten calendar days after roasting: the old rule gave 9.9, so
	// the 10-day "rested" window was missed.
	single("local midnight boundary", beanWithBag("2026-07-09", bagOf("2026-07-09")),
		at(2026, time.July, 19, 0, 30), plainAnn, 10)

	// 21 whole days, not the old fractional 21.8 that fell outside the window.
	single("whole day count", beanWithBag("2026-07-09", bagOf("2026-07-09")),
		at(2026, time.July, 30, 22, 0), plainAnn, 21)

	// A German-format roast date used to be unparseable and the bag was skipped.
	single("german roast date", beanWithBag("09.07.2026", bagOf("09.07.2026")),
		at(2026, time.July, 19, 12, 0), plainAnn, 10)

	frozenBag := bagOf("2026-07-09")
	frozenBag["frozenPortions"] = []any{
		library.Entity{"id": int64(100), "frozenAt": float64(at(2026, time.July, 23, 12, 0) * 1000)},
	}
	portionAnn := map[string]any{"coffee": "Alpha", "frozenPortionId": float64(100)}

	// A frozen portion ages at frozenAgeFactor: the plain age up to the freeze,
	// then the frozen stretch at 5% -> 19 whole days on 2026-11-03.
	single("frozen portion", beanWithBag("2026-07-09", frozenBag),
		at(2026, time.November, 3, 8, 0), portionAnn, 19)

	// A bean mix never takes a portion's age (#1953), so it falls back to the
	// bag's plain age: 117 whole days.
	mixAnn := map[string]any{"coffee": "Alpha", "frozenPortionId": float64(100)}
	mixAnn["beanMix"] = []any{
		map[string]any{"coffee": "Alpha", "grams": float64(9)},
		map[string]any{"coffee": "Beta", "grams": float64(9)},
	}
	single("bean mix ignores portion", beanWithBag("2026-07-09", frozenBag),
		at(2026, time.November, 3, 8, 0), mixAnn, 117)

	// The earliest shot of the bag sets the age; a later one never replaces it.
	t.Run("earliest shot wins", func(t *testing.T) {
		bean := beanWithBag("2026-07-09", bagOf("2026-07-09"))
		shotList := []shots.Shot{
			{"id": int64(2), "timestamp": at(2026, time.August, 30, 12, 0), "annotation": plainAnn},
			{"id": int64(1), "timestamp": at(2026, time.July, 19, 12, 0), "annotation": plainAnn},
		}
		got := bagFirstUseAgesDays(shotList, []library.Entity{bean})
		if len(got) != 1 || got[0] != 10 {
			t.Fatalf("ages = %v, want [10]", got)
		}
	})
}
