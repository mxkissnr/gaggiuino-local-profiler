package shots

// #1718: the score cache is keyed on scoreVersion, not on the scorer's code,
// so a scoring change that forgets to bump it leaves GET /api/shots serving
// stale cached scores. This test pins a digest of the parity fixture's
// expected scores together with scoreVersion: changing the expected scores
// without bumping scoreVersion fails here.

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"regexp"
	"testing"
)

const (
	// pinnedScoreVersion and pinnedParityDigest are updated together, and
	// only together with a scoreVersion bump when an expected score changed.
	pinnedScoreVersion = "v3"
	pinnedParityDigest = "81214ed4f6be277f4f159a0bd14a31d022507f256f050bd91b7372cfc9a7c28c"
)

// parityExpectedDigest hashes the fixture's case names and expected scores
// only — not the shot inputs or the file's formatting — so it moves exactly
// when an expected score is added, removed or changed.
func parityExpectedDigest(t *testing.T) string {
	t.Helper()
	type pair struct {
		Name     string `json:"name"`
		Expected *int   `json:"expected"`
	}
	cases := loadScoreParityCases(t)
	pairs := make([]pair, len(cases))
	for i, c := range cases {
		pairs[i] = pair{Name: c.Name, Expected: c.Expected}
	}
	raw, err := json.Marshal(pairs)
	if err != nil {
		t.Fatalf("marshal parity pairs: %v", err)
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

func TestScoreVersionPinsParityFixture(t *testing.T) {
	got := parityExpectedDigest(t)
	switch {
	case got != pinnedParityDigest && scoreVersion == pinnedScoreVersion:
		t.Fatalf("test/fixtures/score-parity.json's expected scores changed but scoreVersion is still %q.\n"+
			"If a shot's score changed, bump scoreVersion in score.go so cached scores are recomputed, "+
			"then set pinnedScoreVersion to the new value and pinnedParityDigest to %q.\n"+
			"If only cases were added or renamed and no existing score changed, update pinnedParityDigest alone.",
			scoreVersion, got)
	case got != pinnedParityDigest:
		t.Fatalf("scoreVersion was bumped to %q: set pinnedScoreVersion = %q and pinnedParityDigest = %q",
			scoreVersion, scoreVersion, got)
	case scoreVersion != pinnedScoreVersion:
		t.Fatalf("scoreVersion was bumped to %q without a fixture change: set pinnedScoreVersion = %q",
			scoreVersion, scoreVersion)
	}
}

// TestScoreVersionIsSQLSafe guards the splice into pageColumns' SQL literal.
func TestScoreVersionIsSQLSafe(t *testing.T) {
	if !regexp.MustCompile(`^[a-z0-9]+$`).MatchString(scoreVersion) {
		t.Fatalf("scoreVersion %q must match [a-z0-9]+ (it is spliced into a SQL string literal)", scoreVersion)
	}
}
