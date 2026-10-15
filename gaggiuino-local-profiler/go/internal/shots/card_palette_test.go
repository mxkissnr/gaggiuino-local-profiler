package shots

import "testing"

func intPtr(v int) *int { return &v }

// #1622: the share card colours scores on the same five-step scale as the app
// (SCORE_STEPS in public-src/utils.ts): >=88 ok / >=75 good / >=60 warn /
// >=45 low / below err, and a nil score falls back to textMute.
func TestScoreColorFiveStepScale(t *testing.T) {
	p := palette{ok: "ok", good: "good", warn: "warn", low: "low", err: "err", textMute: "mute"}
	cases := []struct {
		name  string
		score *int
		want  string
	}{
		{"88 is ok", intPtr(88), "ok"},
		{"87 is good", intPtr(87), "good"},
		{"75 is good", intPtr(75), "good"},
		{"74 is warn", intPtr(74), "warn"},
		{"60 is warn", intPtr(60), "warn"},
		{"59 is low", intPtr(59), "low"},
		{"45 is low", intPtr(45), "low"},
		{"44 is err", intPtr(44), "err"},
		{"nil is textMute", nil, "mute"},
	}
	for _, c := range cases {
		if got := scoreColor(c.score, p); got != c.want {
			t.Errorf("%s: scoreColor = %q, want %q", c.name, got, c.want)
		}
	}
}
