package library

import (
	"encoding/json"
	"math"
	"os"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"
	_ "time/tzdata" // the fixture's zone must load on hosts without a tz database

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// #2025: the bean age is defined once. The definition, its TypeScript twins
// (public-src/utils.ts's roastAgeDays and frozenPortionAgeDays, and
// public-src/views/shots/utils.ts's calcBeanAgeAtShot) and the shared parity
// fixture test/fixtures/bean-age-parity.json must change together.
//
// The reference implementation below is TEST-ONLY on purpose. CI's blocking
// deadcode gate (.github/workflows/test.yaml, reachability from ./cmd/...) fails
// on any function no production path reaches, and the consumers of this rule --
// MCP's list_beans and the freshness achievements -- move over in slices 2 and
// 3. Landing it as production code now would turn that gate red, the same trade
// #1922 and #1961 made for their caller-less groundwork. The names below are the
// planned production names, so the consuming slice moves this block into
// bean_age.go unchanged.
//
// The rule itself:
//
//   - A bean's plain age is the number of whole LOCAL CALENDAR DAYS from its
//     roast date to the reference moment's local date. That equals "days since
//     local midnight of the roast day, rounded down", but counted on calendar
//     dates so a daylight-saving switch never takes a day off. Unparseable
//     dates, dates after the reference moment and ages over 730 days give no
//     age.
//   - A frozen portion (#1953) keeps its own rule: plain age at the freeze
//     moment, plus the frozen stretch at frozenAgeFactor and thawed time at
//     full rate, floored once at the end.
//   - A shot's age is the frozen-portion age when the annotation names a
//     frozen portion and is not a bean mix; otherwise the plain age of the bag
//     that was open at the shot, falling back to the bean's own roast date.
//
// This test and its TypeScript twin (test/bean-age-parity.test.ts) load the
// same fixture and assert the same expected age, so any drift fails both CI
// jobs. The fixture's local wall-clock timestamps are converted in its own
// zone, so local-midnight and daylight-saving cases really bite.

const (
	// frozenAgeFactor is the rate frozen time ages coffee at: twenty frozen
	// days count as one.
	frozenAgeFactor = 0.05
	// maxRoastAgeDays caps a plausible roast age at roughly two years.
	maxRoastAgeDays = 730
)

var (
	roastDateDMYRe = regexp.MustCompile(`^(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{2,4})$`)
	roastDateISORe = regexp.MustCompile(`^(\d{4})-(\d{2})-(\d{2})`)
)

// parseRoastDate reads either roast-date shape the browser accepts: DMY
// ("D.M.YY" / "DD.MM.YYYY" with ".", "-" or "/" separators, a two-digit year
// meaning 20YY) or an ISO "YYYY-MM-DD" prefix, so a trailing time part is
// allowed. The parts are normalised through time.Date in UTC, so an
// overflowing day rolls over exactly like JavaScript's new Date(y, m, d).
func parseRoastDate(s string) (year int, month time.Month, day int, ok bool) {
	str := strings.TrimSpace(s)
	if m := roastDateDMYRe.FindStringSubmatch(str); m != nil {
		dd, _ := strconv.Atoi(m[1])
		mm, _ := strconv.Atoi(m[2])
		yy, _ := strconv.Atoi(m[3])
		if len(m[3]) == 2 {
			yy += 2000
		}
		t := time.Date(yy, time.Month(mm), dd, 0, 0, 0, 0, time.UTC)
		return t.Year(), t.Month(), t.Day(), true
	}
	if m := roastDateISORe.FindStringSubmatch(str); m != nil {
		yy, _ := strconv.Atoi(m[1])
		mm, _ := strconv.Atoi(m[2])
		dd, _ := strconv.Atoi(m[3])
		t := time.Date(yy, time.Month(mm), dd, 0, 0, 0, 0, time.UTC)
		return t.Year(), t.Month(), t.Day(), true
	}
	return 0, 0, 0, false
}

// RoastAgeDays returns the whole local calendar days from roastDate to at's
// local date. No age is returned for an unparseable date, a roast date after
// the reference moment, or an age over maxRoastAgeDays.
func RoastAgeDays(roastDate string, at time.Time) (int, bool) {
	year, month, day, ok := parseRoastDate(roastDate)
	if !ok {
		return 0, false
	}
	local := at.In(time.Local)
	ref := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, time.UTC)
	roast := time.Date(year, month, day, 0, 0, 0, 0, time.UTC)
	days := int64(ref.Sub(roast) / (24 * time.Hour))
	if days < 0 || days > maxRoastAgeDays {
		return 0, false
	}
	return int(days), true
}

// frozenPortionAgeDays mirrors the browser's frozenPortionAgeDays: full
// calendar age up to frozenAt, the frozen stretch at frozenAgeFactor and any
// thawed time at full rate, floored once at the end.
func frozenPortionAgeDays(roastDate string, portion Entity, atMs int64) (int, bool) {
	frozenAt, ok := msOf(portion, "frozenAt")
	if !ok || frozenAt <= 0 {
		return 0, false
	}
	if atMs < frozenAt {
		return RoastAgeDays(roastDate, time.UnixMilli(atMs))
	}
	ageAtFreeze, ok := RoastAgeDays(roastDate, time.UnixMilli(frozenAt))
	if !ok {
		return 0, false
	}
	at := float64(atMs)
	frozen := float64(frozenAt)
	frozenEnd := at
	if thawedAt := msOr0(portion, "thawedAt"); thawedAt > frozenAt && thawedAt < atMs {
		frozenEnd = float64(thawedAt)
	}
	elapsed := (frozenEnd-frozen)*frozenAgeFactor + (at - frozenEnd)
	extra := math.Floor(elapsed / 86_400_000)
	if extra > math.MaxInt32 || extra < math.MinInt32 {
		return 0, false
	}
	return ageAtFreeze + int(extra), true
}

// BeanAgeAtShot gives a shot's bean age: the named frozen portion's own
// effective age, or the plain age of the bag that was open at the shot (the
// latest openedAt at or before the shot, a missing openedAt counting as 0, the
// first bag winning on ties), falling back to the bean's roast date.
func BeanAgeAtShot(bean Entity, shotSec, frozenPortionID int64) (int, bool) {
	// The bound keeps the millisecond conversion below in range for a corrupt
	// stored timestamp; no real shot comes anywhere near it.
	if bean == nil || shotSec <= 0 || shotSec > math.MaxInt64/1000 {
		return 0, false
	}
	shotMs := shotSec * 1000
	if frozenPortionID != 0 {
		for _, rawBag := range bagsOf(bean) {
			bag, _ := rawBag.(Entity)
			if bag == nil {
				continue
			}
			portions, _ := bag["frozenPortions"].([]any)
			for _, rawPortion := range portions {
				portion, _ := rawPortion.(Entity)
				if portion == nil {
					continue
				}
				if id, ok := idOf(portion, "id"); !ok || id != frozenPortionID {
					continue
				}
				roastDate, _ := bag["roastDate"].(string)
				if roastDate == "" {
					roastDate, _ = bean["roastDate"].(string)
				}
				return frozenPortionAgeDays(roastDate, portion, shotMs)
			}
		}
		return 0, false
	}
	roastDate, _ := bean["roastDate"].(string)
	var winner Entity
	var bestOpened int64
	for _, rawBag := range bagsOf(bean) {
		bag, _ := rawBag.(Entity)
		if bag == nil {
			continue
		}
		openedAt := msOr0(bag, "openedAt")
		if openedAt > shotMs || (winner != nil && openedAt <= bestOpened) {
			continue
		}
		bestOpened = openedAt
		winner = bag
	}
	if winner != nil {
		if rd, _ := winner["roastDate"].(string); rd != "" {
			roastDate = rd
		}
	}
	return RoastAgeDays(roastDate, time.Unix(shotSec, 0))
}

// AnnotationFrozenPortionID reads the frozen portion an annotation names. A
// mixed shot never takes a portion's age (#1953).
func AnnotationFrozenPortionID(ann map[string]any) int64 {
	if shots.IsBeanMix(ann) {
		return 0
	}
	return annotationID(ann["frozenPortionId"])
}

// BeanAgeForAnnotation resolves the annotation's library bean and returns the
// shot's bean age under the shared rule.
func BeanAgeForAnnotation(beans []Entity, ann map[string]any, shotSec int64) (int, bool) {
	bean := ResolveBeanForShot(shots.Shot{"annotation": ann}, beans)
	if bean == nil {
		return 0, false
	}
	return BeanAgeAtShot(bean, shotSec, AnnotationFrozenPortionID(ann))
}

// msOf reads a millisecond timestamp field, whether it arrived via
// encoding/json (float64) or was built by a handler in this request (int64).
// The float value is bounded before narrowing, so a corrupt timestamp cannot
// overflow the conversion.
func msOf(e Entity, key string) (int64, bool) {
	var v float64
	switch t := e[key].(type) {
	case float64:
		v = t
	case int64:
		return t, true
	case int:
		return int64(t), true
	default:
		return 0, false
	}
	if math.IsNaN(v) || v >= float64(math.MaxInt64) || v <= float64(math.MinInt64) {
		return 0, false
	}
	return int64(v), true
}

// msOr0 is msOf with a missing or non-numeric value reading as 0, the way the
// browser's `openedAt ?? 0` / `thawedAt ?? 0` do.
func msOr0(e Entity, key string) int64 {
	v, _ := msOf(e, key)
	return v
}

// The fixture reader and the parity test itself.

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
