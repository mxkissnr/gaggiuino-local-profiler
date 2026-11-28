package shots

// #1622: the shot score is computed twice — here (CalcShotScoreDetail) and in
// TypeScript (public-src/shared/score.ts, calcShotScore). Nothing checked that
// the two agree, so they could drift silently. This test and its TypeScript
// twin (test/score-parity.test.ts) both load the same synthetic fixture
// (test/fixtures/score-parity.json) and assert the same expected total, so any
// divergence fails both CI jobs.

import (
	"encoding/json"
	"os"
	"testing"
)

type parityBean struct {
	BrewTempC *float64 `json:"brewTempC"`
	BrewRatio string   `json:"brewRatio"`
}

// parityTimeTarget is the fixture's case-level duration window (#1504).
type parityTimeTarget struct {
	MinS int `json:"minS"`
	MaxS int `json:"maxS"`
}

type parityCase struct {
	Name       string            `json:"name"`
	Shot       map[string]any    `json:"shot"`
	Bean       *parityBean       `json:"bean"`
	TimeTarget *parityTimeTarget `json:"timeTarget"`
	Expected   *int              `json:"expected"`
	// KnownDivergence is set only when the Go and TypeScript scorers genuinely
	// disagree on a case: "expected" is then the Go value and both tests skip
	// the case with the reason, keeping the divergence visible without failing
	// CI. Empty for every agreed case.
	KnownDivergence string `json:"knownDivergence"`
}

func loadScoreParityCases(t *testing.T) []parityCase {
	t.Helper()
	raw, err := os.ReadFile("../../../test/fixtures/score-parity.json")
	if err != nil {
		t.Fatalf("read score parity fixture: %v", err)
	}
	var cases []parityCase
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatalf("parse score parity fixture: %v", err)
	}
	if len(cases) == 0 {
		t.Fatal("score parity fixture has no cases")
	}
	return cases
}

// profileWindowParityCases are the #1504 cases that must exist in the shared
// fixture: a profile window (40-48 s) on target, fast and long, plus a control
// with no window that keeps the generic 25-35 band.
var profileWindowParityCases = []string{
	"profile window 40-48: 45 s is on target",
	"profile window 40-48: 29 s runs fast",
	"profile window 40-48: 70 s runs long",
	"no window: 29 s keeps the generic band",
}

// noWaterParityCases are the #2242 cases that must exist in the shared
// fixture: a shot in which the pump never ran (unscored), the same residual
// pressure with the pump running (still scored), and a shot with no pump-flow
// series at all (keeps its pre-#2242 score).
var noWaterParityCases = []string{
	"pump never ran (#2242)",
	"residual pressure but the pump ran (#2242)",
	"pump flow series missing keeps today's score (#2242)",
}

// TestScoreParityFixture scores every fixture case with the same expectations
// its TypeScript twin uses, including the per-profile time window (#1504).
func TestScoreParityFixture(t *testing.T) {
	cases := loadScoreParityCases(t)
	seen := make(map[string]bool, len(cases))
	for _, c := range cases {
		seen[c.Name] = true
	}
	for _, name := range profileWindowParityCases {
		if !seen[name] {
			t.Fatalf("score parity fixture is missing the #1504 case %q", name)
		}
	}
	for _, name := range noWaterParityCases {
		if !seen[name] {
			t.Fatalf("score parity fixture is missing the #2242 case %q", name)
		}
	}

	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			if c.KnownDivergence != "" {
				t.Skipf("known Go/TS score divergence: %s", c.KnownDivergence)
			}
			var bean *Bean
			if c.Bean != nil {
				bean = &Bean{BrewTempC: c.Bean.BrewTempC, BrewRatio: c.Bean.BrewRatio}
			}
			var tt *TimeTarget
			if c.TimeTarget != nil {
				tt = &TimeTarget{MinS: c.TimeTarget.MinS, MaxS: c.TimeTarget.MaxS}
			}
			detail := CalcShotScoreTargets(Shot(c.Shot), ScoreTargets{Bean: bean, Time: tt})
			switch {
			case c.Expected == nil:
				if detail.Score != nil {
					t.Errorf("score = %d, want null", *detail.Score)
				}
			case detail.Score == nil:
				t.Errorf("score = null, want %d", *c.Expected)
			case *detail.Score != *c.Expected:
				t.Errorf("score = %d, want %d", *detail.Score, *c.Expected)
			}
		})
	}
}
