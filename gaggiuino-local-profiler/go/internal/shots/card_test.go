package shots

import (
	"bytes"
	"image/png"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"golang.org/x/image/font/opentype"
	"golang.org/x/image/font/sfnt"
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

// cardSVGWith builds a card from cardShotData with the given duration and a
// constant temperature series, and renders it.
func cardSVGWith(duration any, temp float64) string {
	data := cardShotData()
	data["duration"] = duration
	data["datapoints"].(map[string]any)["temperature"] = floatSeq(200, func(int) float64 { return temp })
	return newCardModel(Shot(data), nil, "square", "", "dark", "en", cardDeps{}).svg()
}

func countXTicks(svg string) int {
	return strings.Count(svg, `stroke-dasharray="2,4"`)
}

// TestCardSVG_BoundsAxisTicks covers #1747: a shot whose duration or
// temperature is absurd must not turn the axis tick loops into unbounded SVG
// output. Ordinary shots keep exactly the same tick count as before.
func TestCardSVG_BoundsAxisTicks(t *testing.T) {
	const ordinaryXTicks = 6 // 28s shot, 5s tick step
	if got := countXTicks(cardSVGWith(int64(280), 930)); got != ordinaryXTicks {
		t.Fatalf("ordinary shot x ticks = %d, want %d", got, ordinaryXTicks)
	}

	for _, tc := range []struct {
		name     string
		duration any
		temp     float64
	}{
		{"huge duration", 1e15, 930},
		{"infinite duration", math.Inf(1), 930},
		{"NaN duration", math.NaN(), 930},
		{"huge temperature", int64(280), 1e300},
		{"infinite temperature", int64(280), math.Inf(1)},
		{"NaN temperature", int64(280), math.NaN()},
	} {
		svg := cardSVGWith(tc.duration, tc.temp)
		if got := countXTicks(svg); got > cardAxisMaxTicks {
			t.Errorf("%s: x ticks = %d, want <= %d", tc.name, got, cardAxisMaxTicks)
		}
		if got := strings.Count(svg, "<text"); got > 500 {
			t.Errorf("%s: text elements = %d, want a bounded count", tc.name, got)
		}
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
	// produce a valid card — the optional pieces are simply omitted.
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

// TestCardAndDetailShareYieldAndPhases pins the one rule the share card and
// ComputeShotMetrics share: for the same fixture shot both must report the
// same yield and the same preinfusion duration. It reads the card's own
// figures (what svg() draws from), so it fails again if the card ever
// re-derives yield or the phase split on its own.
func TestCardAndDetailShareYieldAndPhases(t *testing.T) {
	shot := Shot(cardShotData())
	m := ComputeShotMetrics(shot)
	fig := newCardModel(shot, nil, "square", "", "dark", "en", cardDeps{}).figures(
		DatapointsMap(shot))

	if !m.HasYield || !fig.hasYield {
		t.Fatalf("expected a yield from both card (%v) and detail (%v)", fig.hasYield, m.HasYield)
	}
	if fig.yield != m.YieldG {
		t.Errorf("yield: card = %v, detail = %v", fig.yield, m.YieldG)
	}
	if !m.HasPhases || !fig.hasPhases {
		t.Fatalf("expected phases from both card (%v) and detail (%v)", fig.hasPhases, m.HasPhases)
	}
	if fig.preinfusion != m.PreinfusionSecs {
		t.Errorf("preinfusion: card = %v, detail = %v", fig.preinfusion, m.PreinfusionSecs)
	}
}

// TestCard_MixedShotBeanLine pins #1837: the share card's bean line names every
// bean of a mixed shot ("A + B"), while a single-bean shot keeps the plain name.
func TestCard_MixedShotBeanLine(t *testing.T) {
	data := cardShotData()
	ann, _ := data["annotation"].(map[string]any)
	ann["beanMix"] = []any{
		map[string]any{"coffee": "Colombia", "grams": float64(10)},
		map[string]any{"coffee": "Kenya", "grams": float64(8)},
	}
	svg := newCardModel(Shot(data), nil, "square", "", "dark", "en", cardDeps{}).svg()
	if !strings.Contains(svg, "Colombia + Kenya") {
		t.Error("mixed shot card does not name both beans on the headline")
	}

	plain := newCardModel(Shot(cardShotData()), nil, "square", "", "dark", "en", cardDeps{}).svg()
	if !strings.Contains(plain, "Colombia Huila") || strings.Contains(plain, "Colombia Huila + ") {
		t.Error("single-bean card headline changed")
	}
}

// cardHeadlineText returns the share card's bean headline — its rendered font
// size and its text — located by the fixed HERO baseline.
func cardHeadlineText(t *testing.T, svg string) (float64, string) {
	t.Helper()
	re := regexp.MustCompile(`<text [^>]*y="130" [^>]*font-size="([0-9.]+)"[^>]*>([^<]*)</text>`)
	m := re.FindStringSubmatch(svg)
	if m == nil {
		t.Fatal("card SVG has no headline text element")
	}
	size, err := strconv.ParseFloat(m[1], 64)
	if err != nil {
		t.Fatalf("headline font-size %q: %v", m[1], err)
	}
	return size, m[2]
}

// cardSVGWithBeans renders a card for a shot pulled from the given beans; two
// or more make it a mixed shot, one leaves it a plain single-bean shot.
func cardSVGWithBeans(coffees ...string) string {
	data := cardShotData()
	ann := data["annotation"].(map[string]any)
	ann["coffee"] = coffees[0]
	if len(coffees) > 1 {
		parts := make([]any, len(coffees))
		for i, coffee := range coffees {
			parts[i] = map[string]any{"coffee": coffee, "grams": float64(9)}
		}
		ann["beanMix"] = parts
	}
	return newCardModel(Shot(data), nil, "square", "", "dark", "en", cardDeps{}).svg()
}

// TestCard_MixedHeadlineFitsBothBeans pins #1853: a mixed headline steps its
// font down instead of being cut, so both bean names stay complete.
func TestCard_MixedHeadlineFitsBothBeans(t *testing.T) {
	// The fixture carries no origin code, so the headline owns the full width.
	budget := 1080 - 2*cardPX - 20

	// Two ~20-character bean names: long enough that "A + B" overflows at the
	// full size, short enough to fit at the 36 minimum. Grown here rather than
	// hard-coded so the test tracks the card font's real metrics.
	first, second := "", ""
	for textWidth(first+" + "+second, 52, true) <= budget {
		first += "Ab"
		second += "Cd"
	}
	if textWidth(first+" + "+second, 36, true) > budget {
		t.Fatalf("%q does not fit the headline at the minimum size either", first+" + "+second)
	}
	size, headline := cardHeadlineText(t, cardSVGWithBeans(first, second))

	if want := first + " + " + second; headline != want {
		t.Errorf("headline = %q, want %q", headline, want)
	}
	if textWidth(headline, 52, true) <= budget {
		t.Fatalf("fixture headline %q already fits at 52; it must overflow to exercise the stepping", headline)
	}
	if size >= 52 || size < 36 {
		t.Errorf("mixed headline font-size = %v, want stepped down from 52 and at least 36", size)
	}
	if got := textWidth(headline, size, true); got > budget {
		t.Errorf("headline width at %v = %v, want it to fit in %v", size, got, budget)
	}
}

// TestCard_ShortHeadlineKeepsFullSize pins that a headline that already fits
// at the full size renders exactly as before.
func TestCard_ShortHeadlineKeepsFullSize(t *testing.T) {
	size, headline := cardHeadlineText(t, cardSVGWithBeans("Colombia Huila"))

	if size != 52 {
		t.Errorf("short headline font-size = %v, want 52", size)
	}
	if headline != "Colombia Huila" {
		t.Errorf("short headline = %q, want %q", headline, "Colombia Huila")
	}
}

// TestCard_LongHeadlineTruncatedAtMinSize pins that a headline too long even
// at the smallest step is truncated there with an ellipsis.
func TestCard_LongHeadlineTruncatedAtMinSize(t *testing.T) {
	name := strings.Repeat("Konga Blend ", 10)
	size, headline := cardHeadlineText(t, cardSVGWithBeans(name))

	if size != 36 {
		t.Errorf("overlong headline font-size = %v, want the 36 minimum", size)
	}
	if !strings.HasSuffix(headline, "…") {
		t.Errorf("overlong headline = %q, want a trailing ellipsis", headline)
	}
	if len(headline) >= len(name) {
		t.Errorf("overlong headline %q is not shorter than the name", headline)
	}
}

// TestTextWidth_ConcurrentUse exercises the shared face cache from many
// goroutines. The real check is the race detector in CI (#1915).
func TestTextWidth_ConcurrentUse(t *testing.T) {
	want := textWidth("Espresso 18.5 g → 38.1 g", 22, false)
	wantB := textWidth("Adaptive", 30, true)

	var mismatches atomic.Int32
	var wg sync.WaitGroup
	for range 16 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for range 200 {
				if got := textWidth("Espresso 18.5 g → 38.1 g", 22, false); got != want {
					mismatches.Add(1)
				}
				if got := textWidth("Adaptive", 30, true); got != wantB {
					mismatches.Add(1)
				}
			}
		}()
	}
	wg.Wait()

	if n := mismatches.Load(); n != 0 {
		t.Errorf("%d concurrent textWidth calls returned a different width", n)
	}
}

// TestCardFonts_EmbeddedFontsParse pins the two TTFs embedded from fonts/
// (#2166): each must parse, carry the family name resvg is asked for, and
// have a glyph for a digit the card draws.
func TestCardFonts_EmbeddedFontsParse(t *testing.T) {
	tests := []struct {
		name    string
		data    []byte
		wantPfx string
	}{
		{"figtree-400", figtreeRegularTTF, "Figtree Light"},
		{"figtree-600", figtreeSemiBoldTTF, "Figtree Light"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			f, err := opentype.Parse(tc.data)
			if err != nil {
				t.Fatalf("opentype.Parse: %v", err)
			}
			family, err := f.Name(nil, sfnt.NameIDFamily)
			if err != nil {
				t.Fatalf("Name(NameIDFamily): %v", err)
			}
			if !strings.HasPrefix(family, tc.wantPfx) {
				t.Errorf("family = %q, want prefix %q", family, tc.wantPfx)
			}
			if idx, err := f.GlyphIndex(nil, '8'); err != nil || idx == 0 {
				t.Errorf("GlyphIndex('8') = %d, %v; want a non-zero index", idx, err)
			}
		})
	}
}

// TestCardSVG_TextUsesFigtree covers #2166: every text element asks for
// Figtree with Go kept after it as the fallback.
func TestCardSVG_TextUsesFigtree(t *testing.T) {
	svg := cardSVGWith(int64(280), 930)
	if !strings.Contains(svg, `font-family="'Figtree Light', Go"`) {
		t.Errorf("card SVG does not ask for the Figtree family with a Go fallback")
	}
	if strings.Contains(svg, `font-family="Go"`) {
		t.Errorf("card SVG still uses the Go family alone")
	}
}

// #2166: the app sends its active accent as a #rrggbb hex, so the palette
// must take it verbatim (the neutrals stay the theme's) and pick the text
// colour on the accent fill by luminance.
func TestBuildPalette_HexAccent(t *testing.T) {
	hex := buildPalette("#5B21B6", "dark")
	if hex.accentFrom != "#5b21b6" || hex.accentTo != "#5b21b6" {
		t.Errorf("accent = %q/%q, want #5b21b6 for both", hex.accentFrom, hex.accentTo)
	}
	if hex.accentText != "#ffffff" {
		t.Errorf("accentText = %q, want #ffffff on a dark accent", hex.accentText)
	}
	if amber := buildPalette("amber", "dark"); hex.bg != amber.bg {
		t.Errorf("hex accent bg = %q, want the theme's %q", hex.bg, amber.bg)
	}
	if got := buildPalette("#f59e0b", "light").accentText; got != "#000000" {
		t.Errorf("accentText = %q, want #000000 on a light accent", got)
	}
}

// #2166: the six legacy names keep their colours; anything else — a preset
// key, a malformed hex, an empty value, a script-looking string — is amber.
func TestBuildPalette_AccentFallbacks(t *testing.T) {
	if got := buildPalette("ocean", "dark").accentFrom; got != "#3b82f6" {
		t.Errorf("ocean accentFrom = %q, want #3b82f6", got)
	}
	for _, accent := range []string{"mulberry-mocha", "#12345", "", "javascript:x"} {
		if got := buildPalette(accent, "dark").accentFrom; got != "#f59e0b" {
			t.Errorf("%q accentFrom = %q, want the amber #f59e0b", accent, got)
		}
	}
}

func TestParseCardVerdict_Sanitises(t *testing.T) {
	v := parseCardVerdict(url.Values{
		"verdict":     {"  Shot ran long\n(55 s)\x00 "},
		"verdictType": {"coarser"},
		"delta":       {"-11"},
		"vs":          {"vs shot 306"},
	})
	if v.text != "Shot ran long(55 s)" {
		t.Errorf("text = %q, want the trimmed, control-free sentence", v.text)
	}
	if v.kind != "coarser" {
		t.Errorf("kind = %q, want coarser", v.kind)
	}
	if v.delta == nil || *v.delta != -11 {
		t.Errorf("delta = %v, want -11", v.delta)
	}
	if v.vs != "vs shot 306" {
		t.Errorf("vs = %q, want %q", v.vs, "vs shot 306")
	}
}

func TestParseCardVerdict_RejectsBadInput(t *testing.T) {
	for _, delta := range []string{"250", "abc"} {
		if v := parseCardVerdict(url.Values{"delta": {delta}}); v.delta != nil {
			t.Errorf("delta %q accepted as %v, want nil", delta, *v.delta)
		}
	}
	if v := parseCardVerdict(url.Values{"verdictType": {"sideways"}}); v.kind != "" {
		t.Errorf("kind = %q for an unknown type, want \"\"", v.kind)
	}
	long := strings.Repeat("é", 200)
	got := []rune(parseCardVerdict(url.Values{"verdict": {long}}).text)
	if len(got) != cardVerdictMaxRunes {
		t.Fatalf("capped verdict is %d runes, want %d", len(got), cardVerdictMaxRunes)
	}
	if !strings.HasSuffix(string(got), "…") {
		t.Errorf("capped verdict does not end in an ellipsis: %q", string(got))
	}
	if v := parseCardVerdict(url.Values{}); v != (cardVerdict{}) {
		t.Errorf("empty values gave %+v, want the zero value", v)
	}
}

// #2166: the endpoint accepts the verdict parameters and a hex accent, still
// answers with a decodable square PNG, and draws two hex accents differently.
func TestGetCard_AcceptsVerdictAndHexAccent(t *testing.T) {
	h, _, sqlDB := newTestHandlers(t)
	mux := newMux(h)
	dur := int64(280)
	insertShot(t, sqlDB, 3, 1_700_000_000, &dur, "V", cardShotData(), nil)

	q := "?accent=%235b21b6&theme=dark&verdict=Shot+ran+long&verdictType=coarser&delta=-11&vs=vs+shot+306"
	rec := doJSON(t, mux, http.MethodGet, "/api/shots/3/card"+q, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
	}
	a := rec.Body.Bytes()
	if w, hgt := decodePNG(t, a); w != 1080 || hgt != 1080 {
		t.Errorf("card = %dx%d", w, hgt)
	}
	b := doJSON(t, mux, http.MethodGet, "/api/shots/3/card?accent=%230f766e&theme=dark", nil).Body.Bytes()
	if bytes.Equal(a, b) {
		t.Error("expected two different hex accents to produce different card images")
	}
}

// TestCard_ProfileNameOnlyOnce covers #2166: a shot without a bean falls back
// to the profile name as the headline, and the line below never repeats it.
func TestCard_ProfileNameOnlyOnce(t *testing.T) {
	for _, format := range []string{"square", "story"} {
		data := cardShotData()
		delete(data["annotation"].(map[string]any), "coffee")
		data["profileName"] = "Leva mk 9 v0.9"
		svg := newCardModel(Shot(data), nil, format, "", "dark", "en", cardDeps{}).svg()
		if got := strings.Count(svg, "Leva mk 9 v0.9"); got != 1 {
			t.Errorf("%s: profile name appears %d times, want once", format, got)
		}
	}
}

// TestCard_BeanHeadlineKeepsProfileBelow pins #2166's hero: the bean is the
// headline, the profile moves to the line below it.
func TestCard_BeanHeadlineKeepsProfileBelow(t *testing.T) {
	data := cardShotData()
	data["profileName"] = "Leva"
	svg := newCardModel(Shot(data), nil, "square", "", "dark", "en", cardDeps{}).svg()
	if !strings.Contains(svg, "Colombia Huila") {
		t.Error("bean headline is missing")
	}
	if got := strings.Count(svg, "Leva"); got != 1 {
		t.Errorf("profile name appears %d times, want once", got)
	}
}

// TestCard_NoDoseShowsYieldOnly covers #2166: without a dose the card draws a
// Yield figure, never an empty label or a bare arrow.
func TestCard_NoDoseShowsYieldOnly(t *testing.T) {
	data := cardShotData()
	delete(data["annotation"].(map[string]any), "dose")
	svg := newCardModel(Shot(data), nil, "square", "", "dark", "en", cardDeps{}).svg()
	for _, want := range []string{">Yield<", " g<"} {
		if !strings.Contains(svg, want) {
			t.Errorf("card is missing %q", want)
		}
	}
	for _, unwanted := range []string{"Dose → Yield", ">Dose<", ">Ratio<"} {
		if strings.Contains(svg, unwanted) {
			t.Errorf("card still draws %q without a dose", unwanted)
		}
	}
}

// TestCard_NoEmptyTextElements pins #2166's "no empty labels": neither a full
// shot, a shot without dose and bean, nor a bare shot row emits an empty text.
func TestCard_NoEmptyTextElements(t *testing.T) {
	emptyText := regexp.MustCompile(`<text[^>]*></text>`)

	noDoseBean := cardShotData()
	noDoseBeanAnn := noDoseBean["annotation"].(map[string]any)
	delete(noDoseBeanAnn, "dose")
	delete(noDoseBeanAnn, "coffee")

	cases := map[string]Shot{
		"full shot":        Shot(cardShotData()),
		"no dose, no bean": Shot(noDoseBean),
		"bare shot":        Shot{"id": int64(1)},
	}
	for name, shot := range cases {
		for _, format := range []string{"square", "story"} {
			svg := newCardModel(shot, nil, format, "", "dark", "en", cardDeps{}).svg()
			if m := emptyText.FindString(svg); m != "" {
				t.Errorf("%s (%s): empty text element %q", name, format, m)
			}
			if name == "bare shot" {
				for _, unwanted := range []string{">Duration<", ">Pressure Ø<"} {
					if strings.Contains(svg, unwanted) {
						t.Errorf("%s (%s): card draws %q for a shot without data", name, format, unwanted)
					}
				}
			}
		}
	}
}

// TestCard_VerdictSentenceDeltaAndScore covers #2166's verdict block: the
// score, the sentence with its arrow, the delta chip and the compared shot,
// and no tier phrase next to a passed sentence.
func TestCard_VerdictSentenceDeltaAndScore(t *testing.T) {
	score := 89
	d := -11
	m := newCardModel(Shot(cardShotData()), &score, "square", "", "dark", "en", cardDeps{})
	m.verdict = cardVerdict{kind: "coarser", text: "Shot ran long (55 s) – grind coarser", delta: &d, vs: "vs shot 306"}
	svg := m.svg()

	for _, want := range []string{
		">89</text>", ">↑</text>", "Shot ran long (55 s)",
		">−11</text>", ">vs shot 306</text>",
	} {
		if !strings.Contains(svg, want) {
			t.Errorf("card is missing %q", want)
		}
	}
	if strings.Contains(svg, "Really dialed in") {
		t.Error("card draws the tier phrase next to a passed verdict sentence")
	}
}

// TestCard_ScoreInFigtreeSemiBold covers #2191: the score is set in the card's
// Figtree SemiBold at the layout's score size, no Fraunces is asked for, and
// the verdict arrow and the delta chip start 28 px after the score measured in
// that same face.
func TestCard_ScoreInFigtreeSemiBold(t *testing.T) {
	for _, format := range []string{"square", "story"} {
		t.Run(format, func(t *testing.T) {
			score := 89
			d := -11
			m := newCardModel(Shot(cardShotData()), &score, format, "", "dark", "en", cardDeps{})
			m.verdict = cardVerdict{kind: "coarser", text: "Shot ran long (55 s) – grind coarser", delta: &d, vs: "vs shot 306"}
			svg := m.svg()
			L := m.layout()

			scoreRe := regexp.MustCompile(`<text x="` + regexp.QuoteMeta(fnum(cardPX)) + `" y="[0-9.]+" font-family="'Figtree Light', Go" font-size="` +
				regexp.QuoteMeta(fnum(L.scoreSize)) + `" font-weight="600" fill="[^"]+">89</text>`)
			if !scoreRe.MatchString(svg) {
				t.Errorf("score is not drawn in Figtree SemiBold at size %s", fnum(L.scoreSize))
			}
			if strings.Contains(svg, "Fraunces") {
				t.Error("card still asks for Fraunces")
			}

			textX := regexp.QuoteMeta(fnum(cardPX + textWidth("89", L.scoreSize, true) + 28))
			if !regexp.MustCompile(`<text x="` + textX + `"[^>]*>↑</text>`).MatchString(svg) {
				t.Errorf("verdict arrow does not start 28 px after the Figtree score (x=%s)", textX)
			}
			if !regexp.MustCompile(`<rect x="` + textX + `" `).MatchString(svg) {
				t.Errorf("delta chip does not start 28 px after the Figtree score (x=%s)", textX)
			}
		})
	}
}

// TestCard_TierPhraseWithoutVerdict pins the fallback: with no verdict the
// score's tier phrase stands in, and no delta chip is drawn.
func TestCard_TierPhraseWithoutVerdict(t *testing.T) {
	score := 92
	svg := newCardModel(Shot(cardShotData()), &score, "square", "", "dark", "en", cardDeps{}).svg()
	if !strings.Contains(svg, "Outstanding shot") {
		t.Error("card is missing the tier phrase")
	}
	for _, unwanted := range []string{">+", ">−", ">±"} {
		if strings.Contains(svg, unwanted) {
			t.Errorf("card draws a delta chip %q without a verdict", unwanted)
		}
	}
}

// TestCard_StoryHeaderHasDate covers #2166: the story header carries the shot
// number and the date, like the square one.
func TestCard_StoryHeaderHasDate(t *testing.T) {
	data := cardShotData()
	data["timestamp"] = 1_700_000_000
	data["id"] = int64(7)
	svg := newCardModel(Shot(data), nil, "story", "", "dark", "en", cardDeps{}).svg()
	for _, want := range []string{"Shot #7", cardDate("en", 1_700_000_000)} {
		if !strings.Contains(svg, want) {
			t.Errorf("story header is missing %q", want)
		}
	}
}

// TestCard_BadgeFollowsAccent covers #2166: the badge is filled with the
// accent, its text in the palette's accent text colour.
func TestCard_BadgeFollowsAccent(t *testing.T) {
	svg := newCardModel(Shot(cardShotData()), nil, "square", "#5b21b6", "dark", "en", cardDeps{}).svg()
	if !regexp.MustCompile(`<rect[^>]*fill="#5b21b6"`).MatchString(svg) {
		t.Error("no rect is filled with the accent")
	}
	if !regexp.MustCompile(`<text[^>]*fill="#ffffff"[^>]*>Made with GLP</text>`).MatchString(svg) {
		t.Error("the badge text is not in the accent text colour")
	}
}

// TestCardDurationAndDelta pins the figure and chip formatting (#2166).
func TestCardDurationAndDelta(t *testing.T) {
	for _, tc := range []struct {
		sec  float64
		want string
	}{{28, "28 s"}, {65, "1:05"}} {
		if got := cardDuration(tc.sec); got != tc.want {
			t.Errorf("cardDuration(%v) = %q, want %q", tc.sec, got, tc.want)
		}
	}
	for _, tc := range []struct {
		d    int
		want string
	}{{5, "+5"}, {-11, "−11"}, {0, "±0"}} {
		if got := cardDelta(tc.d); got != tc.want {
			t.Errorf("cardDelta(%d) = %q, want %q", tc.d, got, tc.want)
		}
	}
}

// TestWrapToWidth_TwoLinesMax covers the verdict sentence's wrap: at most two
// lines, the last one truncated with an ellipsis.
func TestWrapToWidth_TwoLinesMax(t *testing.T) {
	words := make([]string, 30)
	for i := range words {
		words[i] = "word" + strconv.Itoa(i)
	}
	lines := wrapToWidth(strings.Join(words, " "), 600, 30, true, 2)
	if len(lines) != 2 {
		t.Fatalf("wrapToWidth gave %d lines, want 2", len(lines))
	}
	for i, ln := range lines {
		if w := textWidth(ln, 30, true); w > 600 {
			t.Errorf("line %d is %v wide, want <= 600", i, w)
		}
	}
	if !strings.HasSuffix(lines[1], "…") {
		t.Errorf("last line = %q, want a trailing ellipsis", lines[1])
	}
	if got := wrapToWidth("Short verdict", 600, 30, true, 2); len(got) != 1 || got[0] != "Short verdict" {
		t.Errorf("short sentence wrapped to %q, want one unchanged line", got)
	}
}
