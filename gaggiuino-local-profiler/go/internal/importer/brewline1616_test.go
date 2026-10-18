package importer

import "testing"

// TestBrewLineValue1616 pins brewLineValue for every key the brew-guide
// parser asks for, captured before #1616 precompiled its per-key regexps.
func TestBrewLineValue1616(t *testing.T) {
	lines := []string{
		"Recipe details",
		"in: 18 g",
		"IN : 19 g",
		"Out:36g",
		"  Time: 25-30 s",
		"Time: first anchored match",
		"Ratio :1:2",
		"temp: 92–94 °C",
		"Temperature: not the temp key",
		"Timer: not the time key",
		"Out:",
		"Ratio:   ",
	}
	cases := []struct{ key, want string }{
		{"In", "18 g"},
		{"Out", "36g"},
		{"Time", "first anchored match"}, // the indented line above does not match
		{"Ratio", "1:2"},
		{"Temp", "92–94 °C"},
	}
	for _, c := range cases {
		if got := brewLineValue(lines, c.key); got != c.want {
			t.Errorf("brewLineValue(%q) = %q, want %q", c.key, got, c.want)
		}
	}
	if got := brewLineValue([]string{"time:  27 s "}, "Time"); got != "27 s" {
		t.Errorf("brewLineValue(Time) = %q, want %q", got, "27 s")
	}
	if got := brewLineValue(nil, "In"); got != "" {
		t.Errorf("brewLineValue(nil) = %q, want empty", got)
	}
}
