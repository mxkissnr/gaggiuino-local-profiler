package jsnum

import (
	"math"
	"testing"
)

func TestParseInt(t *testing.T) {
	cases := []struct {
		in   string
		want int64
		ok   bool
	}{
		{"  42abc", 42, true},
		{"-7", -7, true},
		{"abc", 0, false},
		{"", 0, false},
		{"+", 0, false},
	}
	for _, c := range cases {
		got, ok := ParseInt(c.in)
		if got != c.want || ok != c.ok {
			t.Errorf("ParseInt(%q) = (%d, %v), want (%d, %v)", c.in, got, ok, c.want, c.ok)
		}
	}
}

func TestParseIntAny(t *testing.T) {
	cases := []struct {
		in   any
		want int64
		ok   bool
	}{
		{nil, 0, false},
		{"", 0, false},
		{"12", 12, true},
		{" 12 ", 12, true},
		{float64(3.9), 3, true},
		{int64(5), 5, true},
		{int(6), 6, true},
		{true, 0, false},
	}
	for _, c := range cases {
		got, ok := ParseIntAny(c.in)
		if got != c.want || ok != c.ok {
			t.Errorf("ParseIntAny(%v) = (%d, %v), want (%d, %v)", c.in, got, ok, c.want, c.ok)
		}
	}
}

func TestParseFloat(t *testing.T) {
	cases := []struct {
		in   any
		want float64
		ok   bool
	}{
		{"12.5abc", 12.5, true},
		{" .5", 0.5, true},
		{"1e3", 1000, true},
		{"abc", 0, false},
		{math.NaN(), 0, false},
		{float64(2.5), 2.5, true},
		{int(4), 4, true},
		{nil, 0, false},
	}
	for _, c := range cases {
		got, ok := ParseFloat(c.in)
		if got != c.want || ok != c.ok {
			t.Errorf("ParseFloat(%v) = (%v, %v), want (%v, %v)", c.in, got, ok, c.want, c.ok)
		}
	}
}
