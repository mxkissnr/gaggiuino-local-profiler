package mcp

import (
	"math"
	"testing"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// TestRatingValue is the table for the one rating parser (#1622 slice 12) the
// read tools (ratingOf) and the write tools (annotationRating) now share. Stored
// ratings are integers 1..5 (internal/shots rejects fractional ones), so a
// float64 3.5 is rejected rather than truncated to 3, and NaN is rejected with
// the rest.
func TestRatingValue(t *testing.T) {
	tests := []struct {
		name string
		in   any
		want int
		ok   bool
	}{
		{"float64 3.0", float64(3), 3, true},
		{"float64 3.5 rejected", float64(3.5), 0, false},
		{"float64 0 rejected", float64(0), 0, false},
		{"float64 6 rejected", float64(6), 0, false},
		{"float64 NaN rejected", math.NaN(), 0, false},
		{"int 4", 4, 4, true},
		{"int64 5", int64(5), 5, true},
		{"int 0 rejected", 0, 0, false},
		{"int64 6 rejected", int64(6), 0, false},
		{"string rejected", "4", 0, false},
		{"nil rejected", nil, 0, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, ok := ratingValue(tt.in)
			if ok != tt.ok || (ok && got != tt.want) {
				t.Fatalf("ratingValue(%v) = (%d, %v), want (%d, %v)", tt.in, got, ok, tt.want, tt.ok)
			}
		})
	}
}

// TestRatingWrappers_ShareRatingValue pins that both call sites route through
// ratingValue: the read tools used to truncate a fractional 3.5 to 3 while the
// write tools rejected it, and both now reject it alike.
func TestRatingWrappers_ShareRatingValue(t *testing.T) {
	if _, ok := ratingOf(shots.Shot{"annotation": map[string]any{"rating": float64(3.5)}}); ok {
		t.Error("ratingOf: fractional 3.5 must be rejected, not truncated")
	}
	if _, ok := annotationRating(map[string]any{"rating": float64(3.5)}); ok {
		t.Error("annotationRating: fractional 3.5 must be rejected")
	}
	if got, ok := ratingOf(shots.Shot{"annotation": map[string]any{"rating": float64(4)}}); !ok || got != 4 {
		t.Errorf("ratingOf: 4 = (%d, %v), want (4, true)", got, ok)
	}
	if got, ok := annotationRating(map[string]any{"rating": int64(5)}); !ok || got != 5 {
		t.Errorf("annotationRating: int64 5 = (%d, %v), want (5, true)", got, ok)
	}
}
