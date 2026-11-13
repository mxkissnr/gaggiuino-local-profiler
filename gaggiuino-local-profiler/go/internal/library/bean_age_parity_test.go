package library

import (
	"encoding/json"
	"os"
	"testing"
	"time"
	_ "time/tzdata" // the fixture's zone must load on hosts without a tz database
)

// #2025: the bean age is computed twice — here (RoastAgeDays,
// BeanAgeAtShot, BeanAgeForAnnotation) and in TypeScript (public-src/utils.ts,
// public-src/views/shots/utils.ts). This test and its TypeScript twin
// (test/bean-age-parity.test.ts) load the same fixture
// (test/fixtures/bean-age-parity.json) and assert the same expected age, so
// any drift fails both CI jobs. The fixture's local wall-clock timestamps are
// converted in its own zone, so local-midnight and daylight-saving cases
// really bite.

type beanAgeParityCase struct {
	Name       string         `json:"name"`
	Bean       map[string]any `json:"bean"`
	Annotation map[string]any `json:"annotation"`
	ShotLocal  string         `json:"shotLocal"`
	Expected   *int           `json:"expected"`
}

type beanAgeParityFixture struct {
	TimeZone string              `json:"timeZone"`
	Cases    []beanAgeParityCase `json:"cases"`
}

func loadBeanAgeParityFixture(t *testing.T) beanAgeParityFixture {
	t.Helper()
	raw, err := os.ReadFile("../../../test/fixtures/bean-age-parity.json")
	if err != nil {
		t.Fatalf("read bean age parity fixture: %v", err)
	}
	var f beanAgeParityFixture
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("parse bean age parity fixture: %v", err)
	}
	if len(f.Cases) == 0 {
		t.Fatal("bean age parity fixture has no cases")
	}
	return f
}

// localMs parses a fixture wall-clock stamp ("YYYY-MM-DDTHH:MM") in loc.
func localMs(t *testing.T, loc *time.Location, name, s string) int64 {
	t.Helper()
	at, err := time.ParseInLocation("2006-01-02T15:04", s, loc)
	if err != nil {
		t.Fatalf("%s: parse %q: %v", name, s, err)
	}
	return at.UnixMilli()
}

// withLocalStamp converts the fixture's *Local keys inside e (and any nested
// bags/frozen portions) into the epoch-millisecond numeric keys the readers
// expect.
func withLocalStamp(t *testing.T, loc *time.Location, name string, e map[string]any) {
	t.Helper()
	if v, ok := e["openedAtLocal"].(string); ok {
		e["openedAt"] = float64(localMs(t, loc, name, v))
		delete(e, "openedAtLocal")
	}
	if v, ok := e["frozenAtLocal"].(string); ok {
		e["frozenAt"] = float64(localMs(t, loc, name, v))
		delete(e, "frozenAtLocal")
	}
	if v, ok := e["thawedAtLocal"].(string); ok {
		e["thawedAt"] = float64(localMs(t, loc, name, v))
		delete(e, "thawedAtLocal")
	}
	if frozenPortions, ok := e["frozenPortions"].([]any); ok {
		for _, p := range frozenPortions {
			if portion, ok := p.(map[string]any); ok {
				withLocalStamp(t, loc, name, portion)
			}
		}
	}
	if bags, ok := e["bags"].([]any); ok {
		for _, b := range bags {
			if bag, ok := b.(map[string]any); ok {
				withLocalStamp(t, loc, name, bag)
			}
		}
	}
}

func TestBeanAgeParityFixture(t *testing.T) {
	fixture := loadBeanAgeParityFixture(t)
	loc, err := time.LoadLocation(fixture.TimeZone)
	if err != nil {
		t.Fatalf("LoadLocation(%q): %v", fixture.TimeZone, err)
	}
	prev := time.Local
	time.Local = loc
	t.Cleanup(func() { time.Local = prev })

	for _, c := range fixture.Cases {
		t.Run(c.Name, func(t *testing.T) {
			bean := Entity(c.Bean)
			withLocalStamp(t, loc, c.Name, bean)
			shotSec := localMs(t, loc, c.Name, c.ShotLocal) / 1000
			got, ok := BeanAgeForAnnotation([]Entity{bean}, c.Annotation, shotSec)
			if c.Expected == nil {
				if ok {
					t.Fatalf("got age %d, want no age", got)
				}
				return
			}
			if !ok {
				t.Fatalf("got no age, want %d", *c.Expected)
			}
			if got != *c.Expected {
				t.Errorf("age = %d, want %d", got, *c.Expected)
			}
		})
	}
}

// TestRoastAgeDays_LocalCalendarDates pins the two cases a UTC-midnight rule
// gets wrong: a shot just after local midnight in Europe/Berlin (UTC is still
// the previous day, which the old server rule read as one day less) and a shot
// late on the roast day itself.
func TestRoastAgeDays_LocalCalendarDates(t *testing.T) {
	loc, err := time.LoadLocation("Europe/Berlin")
	if err != nil {
		t.Fatalf("LoadLocation: %v", err)
	}
	prev := time.Local
	time.Local = loc
	t.Cleanup(func() { time.Local = prev })

	justAfterMidnight, err := time.ParseInLocation("2006-01-02T15:04", "2026-07-19T00:30", loc)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if got, ok := RoastAgeDays("2026-07-09", justAfterMidnight); !ok || got != 10 {
		t.Errorf("2026-07-09 at 2026-07-19 00:30 Berlin = %d (ok=%v), want 10", got, ok)
	}

	lateOnRoastDay, err := time.ParseInLocation("2006-01-02T15:04", "2026-07-09T23:59", loc)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if got, ok := RoastAgeDays("2026-07-09", lateOnRoastDay); !ok || got != 0 {
		t.Errorf("2026-07-09 at 2026-07-09 23:59 Berlin = %d (ok=%v), want 0", got, ok)
	}
}
