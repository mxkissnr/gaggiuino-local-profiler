package shots

import (
	"bytes"
	"image/png"
	"net/http"
	"regexp"
	"testing"
)

func floatSeq(n int, fn func(i int) float64) []any {
	out := make([]any, n)
	for i := range out {
		out[i] = fn(i)
	}
	return out
}

// cardShotData builds a realistic datapoints/annotation blob for a shot
// row's `data` column.
func cardShotData() map[string]any {
	n := 200
	dp := map[string]any{
		"timeInShot": floatSeq(n, func(i int) float64 { return float64(i) }),
		"pressure": floatSeq(n, func(i int) float64 {
			if i < 40 {
				return float64(i) * 2
			}
			return 90
		}),
		"pumpFlow": floatSeq(n, func(i int) float64 { return 22 }),
		"weightFlow": floatSeq(n, func(i int) float64 {
			if i < 40 {
				return 0
			}
			return 18
		}),
		"shotWeight":        floatSeq(n, func(i int) float64 { return float64(i) * 2 }),
		"temperature":       floatSeq(n, func(i int) float64 { return 930 }),
		"targetPressure":    floatSeq(n, func(i int) float64 { return 90 }),
		"targetTemperature": floatSeq(n, func(i int) float64 { return 930 }),
	}
	return map[string]any{
		"datapoints": dp,
		"annotation": map[string]any{
			"coffee": "Colombia Huila", "dose": 18.0, "totalWeight": 40.0,
			"rating": 4.0, "machine": "Lelit Bianca",
		},
	}
}

func decodePNG(t *testing.T, b []byte) (int, int) {
	t.Helper()
	img, err := png.Decode(bytes.NewReader(b))
	if err != nil {
		t.Fatalf("decoding PNG (%d bytes): %v", len(b), err)
	}
	return img.Bounds().Dx(), img.Bounds().Dy()
}

func TestGetCard_ReturnsDecodablePNG(t *testing.T) {
	h, _, sqlDB := newTestHandlers(t)
	h.SetCardDeps(
		func() string { return InstallCodeFor("test-install") },
		func(coffee string) string { return "CO" },
	)
	mux := newMux(h)

	dur := int64(280)
	insertShot(t, sqlDB, 7, 1_700_000_000, &dur, "Turbo Shot", cardShotData(), nil)

	for _, tc := range []struct {
		query      string
		wantW      int
		wantH      int
		wantSuffix string
	}{
		{"", 1080, 1080, `-square\.png`},
		{"?format=story", 1080, 1920, `-story\.png`},
		{"?accent=ocean&theme=light", 1080, 1080, `-square\.png`},
	} {
		rec := doJSON(t, mux, http.MethodGet, "/api/shots/7/card"+tc.query, nil)
		if rec.Code != http.StatusOK {
			t.Fatalf("%q: status = %d, body=%s", tc.query, rec.Code, rec.Body.String())
		}
		if ct := rec.Header().Get("Content-Type"); ct != "image/png" {
			t.Errorf("%q: Content-Type = %q", tc.query, ct)
		}
		if cd := rec.Header().Get("Content-Disposition"); !regexp.MustCompile(`inline; filename="glp-shot-7` + tc.wantSuffix + `"`).MatchString(cd) {
			t.Errorf("%q: Content-Disposition = %q", tc.query, cd)
		}
		w, hgt := decodePNG(t, rec.Body.Bytes())
		if w != tc.wantW || hgt != tc.wantH {
			t.Errorf("%q: dimensions = %dx%d, want %dx%d", tc.query, w, hgt, tc.wantW, tc.wantH)
		}
	}
}

func TestGetCard_BadIDAndMissingShot(t *testing.T) {
	h, _, sqlDB := newTestHandlers(t)
	mux := newMux(h)
	dur := int64(280)
	insertShot(t, sqlDB, 1, 1_700_000_000, &dur, "V", cardShotData(), nil)

	rec := doJSON(t, mux, http.MethodGet, "/api/shots/abc/card", nil)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("bad id: status = %d, want 400", rec.Code)
	}
	rec = doJSON(t, mux, http.MethodGet, "/api/shots/999/card", nil)
	if rec.Code != http.StatusNotFound {
		t.Errorf("missing shot: status = %d, want 404", rec.Code)
	}
}

// TestGetCard_RateLimited proves the dedicated card:<ip> feature limit
// (#999 / security audit #977 round 3 finding 3.2, cardRateLimitPerMin).
// The limiter runs before id-parsing/render, so this drives it with
// missing-shot requests (404) and never pays a real resvg render: the
// first cardRateLimitPerMin requests pass the limiter, the next one 429s.
// Every httptest.NewRequest shares one RemoteAddr, so they share one
// bucket.
func TestGetCard_RateLimited(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)

	for i := 0; i < cardRateLimitPerMin; i++ {
		rec := doJSON(t, mux, http.MethodGet, "/api/shots/999/card", nil)
		if rec.Code != http.StatusNotFound {
			t.Fatalf("request %d: status = %d, want 404 (limiter not yet tripped)", i, rec.Code)
		}
	}
	rec := doJSON(t, mux, http.MethodGet, "/api/shots/999/card", nil)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("request %d: status = %d, want 429", cardRateLimitPerMin, rec.Code)
	}

	// A fresh limiter (new Handlers = new bucket) is not tripped — proves
	// the 429 above is the per-key window, not a global latch.
	h2, _, _ := newTestHandlers(t)
	if rec := doJSON(t, newMux(h2), http.MethodGet, "/api/shots/999/card", nil); rec.Code != http.StatusNotFound {
		t.Fatalf("fresh limiter: status = %d, want 404", rec.Code)
	}
}

func TestGetCard_HonorsAccent(t *testing.T) {
	h, _, sqlDB := newTestHandlers(t)
	mux := newMux(h)
	dur := int64(280)
	insertShot(t, sqlDB, 3, 1_700_000_000, &dur, "V", cardShotData(), nil)

	a := doJSON(t, mux, http.MethodGet, "/api/shots/3/card?accent=ocean&theme=dark", nil).Body.Bytes()
	b := doJSON(t, mux, http.MethodGet, "/api/shots/3/card?accent=forest&theme=dark", nil).Body.Bytes()
	if bytes.Equal(a, b) {
		t.Error("expected the ?accent= change to produce a different card image")
	}
	// Both still valid PNGs of the right size.
	if w, hgt := decodePNG(t, a); w != 1080 || hgt != 1080 {
		t.Errorf("ocean card = %dx%d", w, hgt)
	}
	if w, hgt := decodePNG(t, b); w != 1080 || hgt != 1080 {
		t.Errorf("forest card = %dx%d", w, hgt)
	}
}

func TestGetCard_RendersWithoutDeps(t *testing.T) {
	// Unwired cardDeps (no install code, no origin resolver) must still
	// produce a valid card — lib/card.js's try/catch omits those pieces.
	h, _, sqlDB := newTestHandlers(t)
	mux := newMux(h)
	dur := int64(280)
	insertShot(t, sqlDB, 5, 1_700_000_000, &dur, "V", cardShotData(), nil)

	rec := doJSON(t, mux, http.MethodGet, "/api/shots/5/card", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
	}
	if w, hgt := decodePNG(t, rec.Body.Bytes()); w != 1080 || hgt != 1080 {
		t.Errorf("card = %dx%d", w, hgt)
	}
}

func TestInstallCodeFor_StableAndWellFormed(t *testing.T) {
	got := InstallCodeFor("11111111-2222-3333-4444-555555555555")
	if got != InstallCodeFor("11111111-2222-3333-4444-555555555555") {
		t.Fatal("InstallCodeFor is not deterministic")
	}
	if !regexp.MustCompile(`^[` + installCodeAlphabet + `]{4}-[` + installCodeAlphabet + `]{4}$`).MatchString(got) {
		t.Errorf("InstallCodeFor = %q, want XXXX-XXXX over the confusable-free alphabet", got)
	}
	if InstallCodeFor("a") == InstallCodeFor("b") {
		t.Error("distinct UUIDs collided")
	}
}
