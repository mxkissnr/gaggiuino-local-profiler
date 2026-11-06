package shots

import (
	"bytes"
	"image/png"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"testing"
)

// gaggimateShotData is a GaggiMate-shaped shot: same datapoint keys, all
// tenths, weightFlow always 0 and no target series.
func gaggimateShotData() map[string]any {
	const n = 150
	return map[string]any{
		"datapoints": map[string]any{
			"timeInShot":   floatSeq(n, func(i int) float64 { return float64(i) * 18 }),
			"pressure":    floatSeq(n, func(i int) float64 { return math.Min(float64(i)*3, 90) }),
			"temperature": floatSeq(n, func(int) float64 { return 930 }),
			"shotWeight":  floatSeq(n, func(i int) float64 { return float64(i) * 380 / float64(n-1) }),
			"weightFlow":  floatSeq(n, func(int) float64 { return 0 }),
			"pumpFlow":    floatSeq(n, func(int) float64 { return 20 }),
		},
		"annotation": map[string]any{"dose": 18.0, "totalWeight": 38.0},
	}
}

// plotPixels decodes body and counts pixels exactly matching hex inside the
// plot rect — the legend swatches sit outside it.
func plotPixels(t *testing.T, body []byte, hex string) int {
	t.Helper()
	img, err := png.Decode(bytes.NewReader(body))
	if err != nil {
		t.Fatalf("decoding PNG: %v", err)
	}
	r, g, b := hexToRGB(hex)
	want := [3]uint8{uint8(r), uint8(g), uint8(b)}
	n := 0
	for y := int(chartPadT); y < chartH-int(chartPadB); y++ {
		for x := int(chartPadL); x < chartW-int(chartPadR); x++ {
			cr, cg, cb, _ := img.At(x, y).RGBA()
			if cr>>8 == uint32(want[0]) && cg>>8 == uint32(want[1]) && cb>>8 == uint32(want[2]) {
				n++
			}
		}
	}
	return n
}

func TestGetChartPNG_GaggiuinoAndGaggiMate(t *testing.T) {
	h, _, sqlDB := newTestHandlers(t)
	mux := newMux(h)

	dur := int64(280)
	insertShot(t, sqlDB, 7, 1_700_000_000, &dur, "Turbo Shot", cardShotData(), nil)
	insertShot(t, sqlDB, 8, 1_700_000_100, &dur, "GaggiMate", gaggimateShotData(), nil)

	outDir := os.Getenv("GLP_CHART_OUT")
	cases := []struct {
		id   int
		name string
	}{
		{7, "chart-gaggiuino.png"},
		{8, "chart-gaggimate.png"},
	}
	for _, tc := range cases {
		rec := doJSON(t, mux, http.MethodGet, "/api/shots/"+strconv.Itoa(tc.id)+"/chart.png", nil)
		if rec.Code != http.StatusOK {
			t.Fatalf("shot %d: status = %d, body=%s", tc.id, rec.Code, rec.Body.String())
		}
		if ct := rec.Header().Get("Content-Type"); ct != "image/png" {
			t.Errorf("shot %d: Content-Type = %q", tc.id, ct)
		}
		body := rec.Body.Bytes()
		if w, hgt := decodePNG(t, body); w != chartW || hgt != chartH {
			t.Errorf("shot %d: dimensions = %dx%d, want %dx%d", tc.id, w, hgt, chartW, chartH)
		}
		img, err := png.Decode(bytes.NewReader(body))
		if err != nil {
			t.Fatalf("shot %d: decoding PNG: %v", tc.id, err)
		}
		pr, pg, pb, _ := img.At(1, 1).RGBA()
		if pr>>8 != 0xff || pg>>8 != 0xff || pb>>8 != 0xff {
			t.Errorf("shot %d: background = #%02x%02x%02x, want #ffffff", tc.id, pr>>8, pg>>8, pb>>8)
		}
		for _, hex := range []string{"#3498db", "#f39c12", "#2ecc71", "#e74c3c"} {
			if n := plotPixels(t, body, hex); n < 200 {
				t.Errorf("shot %d: %s pixels = %d, want >= 200", tc.id, hex, n)
			}
		}
		if outDir != "" {
			if err := os.WriteFile(filepath.Join(outDir, tc.name), body, 0o644); err != nil {
				t.Fatalf("writing %s: %v", tc.name, err)
			}
		}
	}
}

func TestGetChartPNG_BadIDAndMissingShot(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)

	rec := doJSON(t, mux, http.MethodGet, "/api/shots/abc/chart.png", nil)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("bad id: status = %d, want 400", rec.Code)
	}
	requireStringField(t, decodeBody(t, rec.Body.Bytes()), "error")

	rec = doJSON(t, mux, http.MethodGet, "/api/shots/999/chart.png", nil)
	if rec.Code != http.StatusNotFound {
		t.Errorf("missing shot: status = %d, want 404", rec.Code)
	}
	requireStringField(t, decodeBody(t, rec.Body.Bytes()), "error")
}

// TestGetChartPNG_RateLimited proves chart:<ip> is its own bucket: the first
// cardRateLimitPerMin requests pass the limiter, the next 429s, and the card
// route from the same address still answers.
func TestGetChartPNG_RateLimited(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)

	for i := 0; i < cardRateLimitPerMin; i++ {
		if rec := doJSON(t, mux, http.MethodGet, "/api/shots/999/chart.png", nil); rec.Code != http.StatusNotFound {
			t.Fatalf("request %d: status = %d, want 404", i+1, rec.Code)
		}
	}
	if rec := doJSON(t, mux, http.MethodGet, "/api/shots/999/chart.png", nil); rec.Code != http.StatusTooManyRequests {
		t.Errorf("request %d: status = %d, want 429", cardRateLimitPerMin+1, rec.Code)
	}
	if rec := doJSON(t, mux, http.MethodGet, "/api/shots/999/card", nil); rec.Code != http.StatusNotFound {
		t.Errorf("card after chart limit: status = %d, want 404 (separate bucket)", rec.Code)
	}
}

// TestRenderShotChart_Bounds covers the pathological shots: nothing may panic
// and every result must still be a decodable 960x480 PNG.
func TestRenderShotChart_Bounds(t *testing.T) {
	bad := []any{math.NaN(), math.Inf(1), 1e300}
	cases := []struct {
		name string
		shot Shot
		want int
	}{
		{"empty", Shot{}, 0},
		{
			"absurd values",
			Shot{
				"duration": 1e15,
				"datapoints": map[string]any{
					"pressure":    []any{bad[0], 90.0, bad[1], bad[2], 90.0},
					"pumpFlow":    []any{bad[1], 20.0, bad[0], 20.0, bad[2]},
					"shotWeight":  []any{bad[2], 380.0, 380.0, bad[0], bad[1]},
					"temperature": []any{bad[0], bad[1], bad[2], 930.0, 930.0},
				},
			},
			-1,
		},
		{
			"200k samples",
			Shot{
				"duration": 280,
				"datapoints": map[string]any{
					"pressure":    bigSeq(200_000, 90),
					"pumpFlow":    bigSeq(200_000, 20),
					"shotWeight":  bigSeq(200_000, 380),
					"temperature": bigSeq(200_000, 930),
				},
			},
			-1,
		},
	}
	for _, tc := range cases {
		body, err := renderShotChart(tc.shot, "en")
		if err != nil {
			t.Fatalf("%s: renderShotChart: %v", tc.name, err)
		}
		if w, hgt := decodePNG(t, body); w != chartW || hgt != chartH {
			t.Errorf("%s: dimensions = %dx%d, want %dx%d", tc.name, w, hgt, chartW, chartH)
		}
		if tc.want >= 0 {
			if n := plotPixels(t, body, "#3498db"); n != tc.want {
				t.Errorf("%s: pressure pixels = %d, want %d", tc.name, n, tc.want)
			}
		}
	}
}

func TestRenderShotChart_LegendLanguage(t *testing.T) {
	shot := Shot(cardShotData())
	en, err := renderShotChart(shot, "en")
	if err != nil {
		t.Fatal(err)
	}
	de, err := renderShotChart(shot, "de")
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(en, de) {
		t.Error("de and en charts are byte-identical, want different legend text")
	}
	xx, err := renderShotChart(shot, "xx")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(en, xx) {
		t.Error("unknown language differs from en, want the en fallback")
	}
}

func BenchmarkRenderShotChart(b *testing.B) {
	shot := Shot(cardShotData())
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		if _, err := renderShotChart(shot, "en"); err != nil {
			b.Fatal(err)
		}
	}
}

// bigSeq is floatSeq for series too long to build inline in a test literal.
func bigSeq(n int, v float64) []any {
	out := make([]any, n)
	for i := range out {
		out[i] = v
	}
	return out
}

