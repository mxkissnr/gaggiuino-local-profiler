package shots

import (
	"fmt"
	"math"
	"strconv"
	"strings"
)

// This file ports lib/card.js's colour layer: buildPalette(accent, theme)
// and everything it composes (ACCENTS, the per-theme gray scales, the
// semantic ok/warn/err sets, and the WCAG-1.4.11 line-contrast lift).
//
// One deliberate deviation from lib/card.js, documented in card.go's header
// too: buildPalette("", "") does NOT return the frozen LEGACY_GLP snapshot
// here. The Go renderer always draws the current "Instrument" design, so a
// bare /card call with neither ?accent= nor ?theme= is treated as
// amber/dark (the palette the frontend always sends anyway). The legacy
// boxed/ring layout for pre-#462 cached links is not reproduced — a
// cosmetic regression on years-old bookmarks, deemed acceptable for the
// migration (see card.go).

type palette struct {
	bg, bgCard, bgChart           string
	text, textDim, textMute       string
	border, borderDim             string
	cPressure, cFlow, cWeightFlow string
	cWeight, cTemp                string
	accentFrom, accentTo          string
	accentTintRGB                 string // "r,g,b" — wrap as rgba(<rgb>,<a>)
	star, starDim                 string
	ok, warn, err                 string
}

func (p palette) accentTint(alpha string) string {
	return fmt.Sprintf("rgba(%s,%s)", p.accentTintRGB, alpha)
}

// accentPair mirrors lib/card.js's ACCENTS: accent-from/accent-to per
// accent and theme (public-src/style.css [data-accent] blocks). Only amber
// and crema define a light-specific override.
var accentPairs = map[string]map[string][2]string{
	"amber":  {"dark": {"#f59e0b", "#f97316"}, "light": {"#d97706", "#ea580c"}},
	"ocean":  {"dark": {"#3b82f6", "#06b6d4"}, "light": {"#3b82f6", "#06b6d4"}},
	"aurora": {"dark": {"#6366f1", "#a855f7"}, "light": {"#6366f1", "#a855f7"}},
	"ember":  {"dark": {"#ef4444", "#f97316"}, "light": {"#ef4444", "#f97316"}},
	"forest": {"dark": {"#22c55e", "#10b981"}, "light": {"#22c55e", "#10b981"}},
	"crema":  {"dark": {"#d4a24c", "#b8823a"}, "light": {"#8b5e34", "#6b3f1d"}},
}

// grayScales mirrors CARD_TOKENS.gray: the gray roles this card reads,
// keyed by theme (and by accent for crema, the only accent that warms the
// neutral scale). Roles: 200 text / 400 soft / 500 muted / 700 line / 800
// card-chart surface / 900 card surface / 950 page background.
var grayScales = map[string]map[int]string{
	"dark":        {200: "#eceded", 400: "#b6babd", 500: "#a4a9ad", 700: "#2b2f33", 800: "#1a1c1f", 900: "#131416", 950: "#0d0e10"},
	"dark-crema":  {200: "#f2e6d8", 400: "#c9b8a4", 500: "#b0a08d", 700: "#4e3a2b", 800: "#2e2118", 900: "#1e1611", 950: "#14100c"},
	"light":       {200: "#1b1d1f", 400: "#4a4e52", 500: "#585d61", 700: "#dcdcd8", 800: "#eeeeec", 900: "#f7f7f6", 950: "#ffffff"},
	"light-crema": {200: "#2a1b0f", 400: "#55442f", 500: "#5f4c38", 700: "#d4b48c", 800: "#ead5b5", 900: "#f3e4ce", 950: "#fbf3e7"},
}

// semanticColors mirrors CARD_TOKENS.semantic (--ok/--warn/--err).
var semanticColors = map[string]map[string]string{
	"dark":        {"ok": "#5cb98a", "warn": "#d3a03f", "err": "#e0705f"},
	"dark-crema":  {"ok": "#5cb98a", "warn": "#d3a03f", "err": "#e17363"},
	"light":       {"ok": "#2f7350", "warn": "#7d5510", "err": "#a83526"},
	"light-crema": {"ok": "#0d622c", "warn": "#7a4a05", "err": "#a71b1b"},
}

func hexToRGB(hex string) (r, g, b int) {
	n, _ := strconv.ParseInt(strings.TrimPrefix(hex, "#"), 16, 64)
	return int((n >> 16) & 255), int((n >> 8) & 255), int(n & 255)
}

func rgbToHex(r, g, b float64) string {
	cl := func(v float64) int {
		i := int(math.Round(v))
		if i < 0 {
			return 0
		}
		if i > 255 {
			return 255
		}
		return i
	}
	return fmt.Sprintf("#%02x%02x%02x", cl(r), cl(g), cl(b))
}

func relLuminance(r, g, b float64) float64 {
	lin := func(c float64) float64 {
		c /= 255
		if c <= 0.04045 {
			return c / 12.92
		}
		return math.Pow((c+0.055)/1.055, 2.4)
	}
	return 0.2126*lin(r) + 0.7152*lin(g) + 0.0722*lin(b)
}

func contrastRatio(r1, g1, b1, r2, g2, b2 float64) float64 {
	a := relLuminance(r1, g1, b1)
	b := relLuminance(r2, g2, b2)
	if a < b {
		a, b = b, a
	}
	return (a + 0.05) / (b + 0.05)
}

// liftLineTowardText ports lib/card.js's liftLineTowardText: blend a line
// colour toward the text colour in 5% steps until it clears 3:1 against
// the worse of the two surfaces it's drawn on.
func liftLineTowardText(lineHex, worstBgHex, textHex string) string {
	lr, lg, lb := hexToRGB(lineHex)
	br, bg, bb := hexToRGB(worstBgHex)
	tr, tg, tb := hexToRGB(textHex)
	lrf, lgf, lbf := float64(lr), float64(lg), float64(lb)
	brf, bgf, bbf := float64(br), float64(bg), float64(bb)
	trf, tgf, tbf := float64(tr), float64(tg), float64(tb)
	if contrastRatio(lrf, lgf, lbf, brf, bgf, bbf) >= 3 {
		return lineHex
	}
	or, og, ob := lrf, lgf, lbf
	for t := 0.05; t <= 1.0001; t += 0.05 {
		or = lrf + (trf-lrf)*t
		og = lgf + (tgf-lgf)*t
		ob = lbf + (tbf-lbf)*t
		if contrastRatio(or, og, ob, brf, bgf, bbf) >= 3 {
			break
		}
	}
	return rgbToHex(or, og, ob)
}

// lineColorFor ports LINE_COLORS[key]: per theme, pick the worse of
// gray[700]-on-gray[800] / gray[700]-on-gray[900] and lift toward gray[200].
func lineColorFor(key string) string {
	g := grayScales[key]
	r7, g7, b7 := hexToRGB(g[700])
	r8, g8, b8 := hexToRGB(g[800])
	r9, g9, b9 := hexToRGB(g[900])
	worst := g[800]
	if contrastRatio(i2f(r7), i2f(g7), i2f(b7), i2f(r8), i2f(g8), i2f(b8)) > contrastRatio(i2f(r7), i2f(g7), i2f(b7), i2f(r9), i2f(g9), i2f(b9)) {
		worst = g[900]
	}
	return liftLineTowardText(g[700], worst, g[200])
}

func i2f(i int) float64 { return float64(i) }

// buildPalette ports lib/card.js's buildPalette(accent, theme) — the
// computed (non-legacy) path only. An unknown/empty accent falls back to
// "amber"; any theme other than "light" is "dark".
func buildPalette(accent, theme string) palette {
	a := accent
	if _, ok := accentPairs[a]; !ok {
		a = "amber"
	}
	th := "dark"
	if theme == "light" {
		th = "light"
	}
	key := th
	if a == "crema" {
		key = th + "-crema"
	}
	gray := grayScales[key]
	line := lineColorFor(key)
	sem := semanticColors[key]
	pair := accentPairs[a][th]
	ar, ag, ab := hexToRGB(pair[0])

	return palette{
		bg: gray[950], bgCard: gray[900], bgChart: gray[800],
		text: gray[200], textDim: gray[400], textMute: gray[500],
		border: line, borderDim: line,
		cPressure: "#3498db", cFlow: "#f39c12", cWeightFlow: "#9b59b6",
		cWeight: "#2ecc71", cTemp: "#e74c3c",
		accentFrom:    pair[0],
		accentTo:      pair[1],
		accentTintRGB: fmt.Sprintf("%d,%d,%d", ar, ag, ab),
		star:          pair[0],
		starDim:       gray[700],
		ok:            sem["ok"], warn: sem["warn"], err: sem["err"],
	}
}

// scoreColor ports lib/card.js's scoreColor for the computed palette:
// ok >=90 / warn >=70 / err below. A nil score is textMute.
func scoreColor(score *int, p palette) string {
	if score == nil {
		return p.textMute
	}
	switch {
	case *score >= 90:
		return p.ok
	case *score >= 70:
		return p.warn
	default:
		return p.err
	}
}

// scoreTierPhrase ports lib/card.js's scoreTierPhrase (German, unchanged).
func scoreTierPhrase(score *int) string {
	if score == nil {
		return ""
	}
	switch {
	case *score >= 90:
		return "Herausragender Shot"
	case *score >= 80:
		return "Richtig gut getroffen"
	case *score >= 60:
		return "Solider Shot"
	default:
		return "Dial-in lohnt sich noch"
	}
}
