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

type parityCase struct {
	Name     string         `json:"name"`
	Shot     map[string]any `json:"shot"`
	Bean     *parityBean    `json:"bean"`
	Expected *int           `json:"expected"`
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

func TestScoreParityFixture(t *testing.T) {
	for _, c := range loadScoreParityCases(t) {
		t.Run(c.Name, func(t *testing.T) {
			if c.KnownDivergence != "" {
				t.Skipf("known Go/TS score divergence: %s", c.KnownDivergence)
			}
			var bean *Bean
			if c.Bean != nil {
				bean = &Bean{BrewTempC: c.Bean.BrewTempC, BrewRatio: c.Bean.BrewRatio}
			}
			detail := CalcShotScoreDetail(Shot(c.Shot), bean)
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
