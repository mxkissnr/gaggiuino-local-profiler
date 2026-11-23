package shots

import (
	"fmt"
	"math"
	"net/url"
	"strconv"
	"strings"
	"unicode"
)

// card_model.go holds the share card's data extraction (from the shot's
// datapoints/annotation) and its layout draw calls, emitted as SVG elements.
// See card.go for the overall approach and the list of deliberate deviations.

const cardPX = 52.0 // card design's base px unit

// cardAxisMaxTicks bounds the axis tick loops independently of the values
// driving them, so a shot with an implausible duration or temperature cannot
// emit unbounded SVG elements.
const cardAxisMaxTicks = 200

type cardModel struct {
	shot    Shot
	score   *int
	format  string
	lang    string
	pal     palette
	deps    cardDeps
	verdict cardVerdict // the shot page's verdict as the app passed it (#2166)

	w, h float64
}

// cardVerdict is the shot page's verdict, passed in by the app (#2166): the
// dial-in advice and the compared shot are computed in the frontend only, so
// the card draws what the page shows instead of computing it again. Every
// field is optional.
type cardVerdict struct {
	kind  string // "finer" or "coarser" (draws ↓ / ↑), else ""
	text  string // the verdict sentence
	delta *int   // score change against the compared shot
	vs    string // the line naming the compared shot
}

const (
	cardVerdictMaxRunes = 140
	cardVsMaxRunes      = 80
)

// parseCardVerdict reads the card's verdict query parameters. Text is
// trimmed, stripped of control characters and capped; delta must be an
// integer in -100..100; any other verdictType is ignored.
func parseCardVerdict(q url.Values) cardVerdict {
	v := cardVerdict{
		text: cardParamText(q.Get("verdict"), cardVerdictMaxRunes),
		vs:   cardParamText(q.Get("vs"), cardVsMaxRunes),
	}
	if k := q.Get("verdictType"); k == "finer" || k == "coarser" {
		v.kind = k
	}
	if d, err := strconv.Atoi(q.Get("delta")); err == nil && d >= -100 && d <= 100 {
		v.delta = &d
	}
	return v
}

// cardParamText trims s, drops control and replacement characters and cuts
// it to max runes, the last one an ellipsis.
func cardParamText(s string, max int) string {
	var b strings.Builder
	for _, r := range strings.TrimSpace(s) {
		if unicode.IsControl(r) || r == unicode.ReplacementChar {
			continue
		}
		b.WriteRune(r)
	}
	r := []rune(b.String())
	if len(r) > max {
		return string(r[:max-1]) + "…"
	}
	return string(r)
}

func newCardModel(shot Shot, score *int, format, accent, theme, lang string, deps cardDeps) *cardModel {
	c := &cardModel{
		shot:   shot,
		score:  score,
		format: format,
		lang:   normalizeCardLang(lang),
		pal:    buildPalette(accent, theme),
		deps:   deps,
		w:      1080,
	}
	c.h = 1080
	if format == "story" {
		c.h = 1920
	}
	return c
}

// cardLayout holds the sizes that differ between the square and the story
// card (#2166). The story keeps the same blocks; its extra height goes to a
// larger hero and verdict and to the figures, which become rows.
type cardLayout struct {
	headBase, headMax, headMin float64 // headline baseline and its font-size steps
	subSize                    float64 // profile / machine line
	scoreSize, verdictSize     float64 // score, verdict sentence
	chartMaxH                  float64 // chart block height cap
	figValSize, figLblSize     float64 // figure value and label
}

var (
	squareCardLayout = cardLayout{headBase: 130, headMax: 52, headMin: 36, subSize: 24, scoreSize: 96, verdictSize: 30, chartMaxH: 560, figValSize: 34, figLblSize: 16}
	storyCardLayout  = cardLayout{headBase: 150, headMax: 68, headMin: 44, subSize: 28, scoreSize: 132, verdictSize: 38, chartMaxH: 760, figValSize: 44, figLblSize: 26}
)

func (c *cardModel) layout() cardLayout {
	if c.format == "story" {
		return storyCardLayout
	}
	return squareCardLayout
}

// ── datapoint / annotation extraction ────────

func (c *cardModel) datapoints() map[string]any {
	return DatapointsMap(c.shot)
}

func (c *cardModel) annotation() map[string]any {
	if a, ok := c.shot["annotation"].(map[string]any); ok {
		return a
	}
	return map[string]any{}
}

// tenthsSeries reads dp[key] as a number array and divides each by 10 —
// reuses score.go's floatSlice/divAll.
func tenthsSeries(dp map[string]any, key string) []float64 {
	return divAll(floatSlice(dp[key]), 10)
}

// cardNum coerces a shot-map value to float64. score.go's toFloat only
// handles float64/int64; the share-card renderer's own tests build shots by
// hand and can pass plain int, so this widens that.
func cardNum(v any) float64 {
	switch n := v.(type) {
	case float64:
		return n
	case float32:
		return float64(n)
	case int:
		return float64(n)
	case int64:
		return float64(n)
	}
	return 0
}

func strField(m map[string]any, key string) string {
	s, _ := m[key].(string)
	return s
}

func numField(m map[string]any, key string) (float64, bool) {
	v, ok := m[key]
	if !ok || v == nil {
		return 0, false
	}
	switch v.(type) {
	case float64, float32, int, int64:
		return cardNum(v), true
	}
	return 0, false
}

// ── small numeric formatting ──────────────────────

// num1 renders x to at most one decimal, so 4.0 prints "4" and 4.5 prints
// "4.5".
func num1(x float64) string {
	r := math.Round(x*10) / 10
	s := strconv.FormatFloat(r, 'f', 1, 64)
	s = strings.TrimSuffix(s, ".0")
	return s
}

// fixed1 always keeps one decimal.
func fixed1(x float64) string {
	return strconv.FormatFloat(math.Round(x*10)/10, 'f', 1, 64)
}

func avgFiltered(vals []float64, keep func(float64) bool) (float64, bool) {
	sum, n := 0.0, 0
	for _, v := range vals {
		if keep(v) {
			sum += v
			n++
		}
	}
	if n == 0 {
		return 0, false
	}
	return sum / float64(n), true
}

// cardFigures is the share card's shot-derived summary — the figures it
// shares with the shot detail view. Resolving them through the same helpers
// (shotYield, detectPhases) is what keeps the two views from drifting: svg()
// draws from this struct and the card/detail parity test reads it directly.
type cardFigures struct {
	yield       float64
	hasYield    bool
	preinfusion float64
	preEndIdx   int
	hasPhases   bool
}

// figures resolves the yield and the preinfusion/extraction boundary from the
// shot's own datapoints/annotation. preEndIdx is a sample index into the
// pressure series — the card's x axis is index-based, so the tint and labels
// need the index, not the seconds.
func (c *cardModel) figures(dp map[string]any) cardFigures {
	var f cardFigures
	f.yield, f.hasYield = shotYield(c.shot)
	f.preinfusion, _, f.preEndIdx, f.hasPhases = detectPhases(
		tenthsSeries(dp, "timeInShot"), tenthsSeries(dp, "pressure"))
	return f
}

// ── the card itself ────────────────────────────────────────────────────

func (c *cardModel) svg() string {
	p := c.pal
	L := c.layout()
	dp := c.datapoints()
	ann := c.annotation()
	fig := c.figures(dp)

	pressure := tenthsSeries(dp, "pressure")
	flow := tenthsSeries(dp, "pumpFlow")
	weightFlow := tenthsSeries(dp, "weightFlow")
	weight := tenthsSeries(dp, "shotWeight")
	if len(weight) == 0 {
		weight = tenthsSeries(dp, "weight")
	}
	temp := tenthsSeries(dp, "temperature")
	tgtPress := tenthsSeries(dp, "targetPressure")
	tgtFlow := tenthsSeries(dp, "targetFlow")
	tgtTemp := tenthsSeries(dp, "targetTemperature")

	nPts := cardMaxInt(len(pressure), len(flow), len(temp), 1)
	hasDuration := cardNum(c.shot["duration"]) != 0
	totalSec := 30.0
	if hasDuration {
		totalSec = cardNum(c.shot["duration"]) / 10
	} else if ts := tenthsSeries(dp, "timeInShot"); len(ts) > 1 {
		// A shot without its own duration field still knows how long it ran
		// from its time series, so the figure is drawn rather than dropped.
		hasDuration = true
		totalSec = ts[len(ts)-1]
	}
	totalSec = clampCardRange(totalSec, 1, 3600)

	profileName := firstNonEmpty(
		mapString(c.shot["profile"], "name"),
		strField(c.shot, "profile_name"),
		strField(c.shot, "profileName"),
	)
	if profileName == "" {
		profileName = cardText(c.lang, "unknown")
	}
	// A mixed shot (#1837) names every bean in its dose: "A + B".
	bean := BeanLabel(ann)
	machine := firstNonEmpty(strField(ann, "machine"), strField(c.shot, "machine"))

	var dose, yieldG *float64
	if v, ok := numField(ann, "dose"); ok && v > 0 {
		r := math.Round(v*10) / 10
		dose = &r
	}
	if fig.hasYield && fig.yield > 0 {
		r := math.Round(fig.yield*10) / 10
		yieldG = &r
	}

	avgPres, hasAvgPres := avgFiltered(pressure, func(v float64) bool { return v > 1.5 })
	avgTemp, hasAvgTemp := avgFiltered(temp, func(v float64) bool { return v > 50 })

	var rating int
	if v, ok := numField(ann, "rating"); ok {
		rating = int(math.Round(v))
	}

	// The origin map is keyed by a single bean, so a mixed shot keeps the
	// primary bean for the origin chip while the headline shows every bean.
	primaryBean := strField(ann, "coffee")
	originCode := ""
	if c.deps.beanOriginCode != nil && primaryBean != "" {
		originCode = c.deps.beanOriginCode(primaryBean)
	}
	installCode := ""
	if c.deps.installCode != nil {
		installCode = c.deps.installCode()
	}

	preEnd, hasPre := fig.preEndIdx, fig.hasPhases

	// Figures (#2166): the shot page's order, one entry per value the shot
	// has; a missing value leaves its figure out, never an empty label.
	type cardFigure struct{ label, value string }
	var figs []cardFigure
	switch {
	case dose != nil && yieldG != nil:
		figs = append(figs, cardFigure{cardText(c.lang, "dose_yield"), num1(*dose) + " → " + num1(*yieldG) + " g"})
	case dose != nil:
		figs = append(figs, cardFigure{cardText(c.lang, "dose"), num1(*dose) + " g"})
	case yieldG != nil:
		figs = append(figs, cardFigure{cardText(c.lang, "yield"), num1(*yieldG) + " g"})
	}
	if dose != nil && yieldG != nil {
		figs = append(figs, cardFigure{cardText(c.lang, "ratio"), "1:" + fixed1(*yieldG / *dose)})
	}
	if hasDuration {
		figs = append(figs, cardFigure{cardText(c.lang, "duration"), cardDuration(totalSec)})
	}
	if hasAvgPres {
		figs = append(figs, cardFigure{cardText(c.lang, "pressure_avg"), num1(math.Round(avgPres*10)/10) + " bar"})
	}
	if hasAvgTemp {
		figs = append(figs, cardFigure{cardText(c.lang, "temperature_avg"), num1(math.Round(avgTemp*10)/10) + " °C"})
	}

	var s svgBuf
	s.printf(`<svg xmlns="http://www.w3.org/2000/svg" width="%s" height="%s" viewBox="0 0 %s %s">`,
		fnum(c.w), fnum(c.h), fnum(c.w), fnum(c.h))
	s.rect(0, 0, c.w, c.h, 0, p.bg, "", 0)

	// ── HEADER ── wordmark left, shot number and date right (both formats).
	const hh = 76.0
	s.text(cardPX, 50, 44, true, p.text, "", "GLP")
	shotID := ""
	if id := nativeShotID(c.shot); id != 0 {
		shotID = cardTextf(c.lang, "shot_id", id)
	}
	dateStr := ""
	if ts := cardNum(c.shot["timestamp"]); ts != 0 {
		dateStr = cardDate(c.lang, int64(ts))
	}
	if headerRight := strings.Join(nonEmpty(shotID, dateStr), "  ·  "); headerRight != "" {
		s.text(c.w-cardPX, 44, 20, false, p.textDim, "end", headerRight)
	}
	s.line(0, hh, c.w, hh, p.border, 1, "")

	// ── HERO ── the bean (or, without one, the profile) as the headline; the
	// line below never repeats the headline (#2166).
	headlineBaseline := L.headBase
	chipCY := headlineBaseline - L.headMax*0.3
	leadW := 0.0
	if originCode != "" {
		chipW := textWidth(originCode, 18, true) + 26
		chipH := 34.0
		s.rect(cardPX, chipCY-chipH/2, chipW, chipH, cardChipRadius, p.accentTint("0.14"), p.accentTint("0.35"), 1)
		s.text(cardPX+chipW/2, chipCY+6, 18, true, p.text, "middle", originCode)
		leadW = chipW + 14
	}
	headline := firstNonEmpty(bean, profileName)
	nameMaxW := c.w - 2*cardPX - 20
	// #1853: step the size down before truncating, so a mixed headline
	// ("Bean A + Bean B") keeps both names readable.
	headlineSize := L.headMax
	for headlineSize > L.headMin && textWidth(headline, headlineSize, true) > nameMaxW-leadW {
		headlineSize -= 4
	}
	headline = truncateToWidth(headline, nameMaxW-leadW, headlineSize, true)
	s.text(cardPX+leadW, headlineBaseline, headlineSize, true, p.text, "", headline)

	cursorY := headlineBaseline
	subParts := nonEmpty(machine)
	if bean != "" {
		subParts = nonEmpty(profileName, machine)
	}
	starR := L.subSize * 0.45
	const starGap = 8.0
	starsW := 0.0
	if rating > 0 {
		starsW = 10*starR + 4*starGap
	}
	if len(subParts) > 0 || rating > 0 {
		cursorY = headlineBaseline + L.subSize + 18
		if len(subParts) > 0 {
			line := truncateToWidth(strings.Join(subParts, "  ·  "), c.w-2*cardPX-starsW-24, L.subSize, false)
			s.text(cardPX, cursorY, L.subSize, false, p.textDim, "", line)
		}
		sx := c.w - cardPX - starsW + starR
		for i := 0; i < 5 && rating > 0; i++ {
			fill := p.starDim
			if i < rating {
				fill = p.star
			}
			s.raw(starPolygon(sx, cursorY-L.subSize*0.35, starR, fill))
			sx += starR*2 + starGap
		}
	}

	// ── VERDICT ── like the shot page: the score in Figtree SemiBold, the verdict
	// sentence (or the score phrase), the change against the compared shot.
	sentence := c.verdict.text
	if sentence == "" {
		sentence = scoreTierPhrase(c.score, c.lang)
	}
	blockTop := cursorY + 28
	blockBottom := cursorY
	textX := cardPX
	if c.score != nil {
		num := strconv.Itoa(*c.score)
		base := blockTop + L.scoreSize*0.8
		s.text(cardPX, base, L.scoreSize, true, scoreColor(c.score, p), "", num)
		textX = cardPX + textWidth(num, L.scoreSize, true) + 28
		blockBottom = base + 14
	}
	lineGap := L.verdictSize * 1.25
	rowY := blockTop + L.verdictSize + 6 // baseline of the next verdict line
	if sentence != "" {
		x := textX
		arrow := ""
		switch c.verdict.kind {
		case "coarser":
			arrow = "↑"
		case "finer":
			arrow = "↓"
		}
		if arrow != "" {
			s.text(x, rowY, L.verdictSize, true, p.accentFrom, "", arrow)
			x += textWidth(arrow+" ", L.verdictSize, true)
		}
		lines := wrapToWidth(sentence, c.w-cardPX-x, L.verdictSize, true, 2)
		for i, ln := range lines {
			s.text(x, rowY+float64(i)*lineGap, L.verdictSize, true, p.text, "", ln)
		}
		rowY += float64(len(lines)) * lineGap
		blockBottom = math.Max(blockBottom, rowY-lineGap+14)
	}
	if c.verdict.delta != nil {
		d := *c.verdict.delta
		col := p.textDim
		if d > 0 {
			col = p.ok
		} else if d < 0 {
			col = p.err
		}
		label := cardDelta(d)
		size := L.verdictSize * 0.7
		chipH := L.verdictSize * 1.1
		chipW := textWidth(label, size, true) + 24
		cr, cg, cb := hexToRGB(col)
		s.rect(textX, rowY-chipH*0.72, chipW, chipH, cardChipRadius, fmt.Sprintf("rgba(%d,%d,%d,0.16)", cr, cg, cb), "", 0)
		s.text(textX+chipW/2, rowY, size, true, col, "middle", label)
		if c.verdict.vs != "" {
			vsX := textX + chipW + 12
			vsSize := L.verdictSize * 0.65
			s.text(vsX, rowY, vsSize, false, p.textDim, "", truncateToWidth(c.verdict.vs, c.w-cardPX-vsX, vsSize, false))
		}
		blockBottom = math.Max(blockBottom, rowY+chipH*0.28+14)
	}

	sepY := blockBottom + 20
	s.printf(`<defs><linearGradient id="sep" x1="0" y1="0" x2="1" y2="0">`+
		`<stop offset="0" stop-color="%s" stop-opacity="0.5"/>`+
		`<stop offset="0.6" stop-color="%s" stop-opacity="0.15"/>`+
		`<stop offset="1" stop-color="%s" stop-opacity="0"/></linearGradient></defs>`,
		p.accentFrom, p.accentFrom, p.accentFrom)
	s.printf(`<line x1="%s" y1="%s" x2="%s" y2="%s" stroke="url(#sep)" stroke-width="1"/>`,
		fnum(cardPX), fnum(sepY), fnum(c.w-cardPX), fnum(sepY))

	// ── CHART ──
	const chartL, chartR, chartT, chartB, legendH = 44.0, 44.0, 10.0, 28.0, 50.0
	// The chart takes the room between the verdict and the figures, capped
	// per format (#2166: the story no longer stretches it over the page).
	footLine := c.h - 64
	figH := 0.0
	if len(figs) > 0 {
		figH = 120
		if c.format == "story" {
			figH = float64(len(figs)) * 96
		}
	}
	outerX := cardPX - 8
	outerY := sepY + 10
	outerW := c.w - 2*cardPX + 16
	outerH := clampCardRange(footLine-16-figH-12-outerY, 200, L.chartMaxH)
	plotX := outerX + chartL
	plotY := outerY + chartT
	plotW := outerW - chartL - chartR
	plotH := outerH - chartT - chartB - legendH

	leftMax := 12.0
	tempMax := clampCardRange(math.Ceil(cardMaxOr0(temp)+5), 1, 300)
	yLeft := func(v float64) float64 { return plotY + plotH - clamp01(v/leftMax)*plotH }
	yRight := func(v float64) float64 { return plotY + plotH - clamp01(v/tempMax)*plotH }
	xTime := func(i int) float64 { return plotX + (float64(i)/math.Max(float64(nPts-1), 1))*plotW }

	// grid — left axis 0/3/6/9/12
	for _, bar := range []float64{0, 3, 6, 9, 12} {
		gy := yLeft(bar)
		dash := "3,4"
		if bar == 0 {
			dash = ""
		}
		s.line(plotX, gy, plotX+plotW, gy, p.border, 1, dash)
		if bar > 0 {
			s.text(outerX+chartL-6, gy+5, 17, false, p.textMute, "end", num1(bar))
		}
	}
	// right axis ticks
	rightStep := cardRightStep(tempMax)
	for v, i := rightStep, 0; v < tempMax && i < cardAxisMaxTicks; v, i = v+rightStep, i+1 {
		gy := yRight(v)
		s.text(outerX+outerW-chartR+5, gy+5, 15, false, p.textMute, "", num1(v))
	}
	// x ticks
	xTickStep := cardTimeStep(totalSec)
	for t, i := 0.0, 0; t <= totalSec && i < cardAxisMaxTicks; t, i = t+xTickStep, i+1 {
		gx := plotX + (t/totalSec)*plotW
		s.line(gx, plotY, gx, plotY+plotH, p.border, 1, "2,4")
		s.text(gx, plotY+plotH+22, 16, false, p.textMute, "middle", cardTimeLabel(t))
	}

	// preinfusion tint (computed palette: preinfusion zone only, no divider)
	if hasPre && nPts > 0 {
		pxEnd := xTime(preEnd)
		s.rect(plotX, plotY, pxEnd-plotX, plotH, 0, "rgba(0,114,178,0.14)", "", 0)
	}

	// series
	drawSeries := func(vals []float64, yFn func(float64) float64, color string, width float64, dash string) {
		if d := seriesPath(vals, xTime, yFn); d != "" {
			da := ""
			if dash != "" {
				da = fmt.Sprintf(` stroke-dasharray="%s"`, dash)
			}
			s.printf(`<path d="%s" fill="none" stroke="%s" stroke-width="%s" stroke-linejoin="round" stroke-linecap="round"%s/>`,
				d, color, fnum(width), da)
		}
	}
	drawSeries(tgtPress, yLeft, p.cPressure, 1.5, "5,5")
	drawSeries(tgtFlow, yLeft, p.cFlow, 1.5, "5,5")
	drawSeries(tgtTemp, yRight, p.cTemp, 1.5, "5,5")
	drawSeries(weightFlow, yLeft, p.cWeightFlow, 2, "")
	drawSeries(flow, yLeft, p.cFlow, 2, "")
	drawSeries(weight, yRight, p.cWeight, 2, "")
	drawSeries(temp, yRight, p.cTemp, 2.5, "")
	drawSeries(pressure, yLeft, p.cPressure, 2.5, "")

	// phase labels (computed palette: plain coloured text inside the plot)
	if hasPre && nPts > 0 {
		pxEnd := xTime(preEnd)
		preWidth := pxEnd - plotX
		extWidth := plotX + plotW - pxEnd
		if preWidth > 90 {
			s.text(plotX+6, plotY+19, 13, true, p.cPressure, "", cardText(c.lang, "preinfusion"))
		}
		if extWidth > 90 {
			s.text(pxEnd+6, plotY+19, 13, true, p.cFlow, "", cardText(c.lang, "extraction"))
		}
	}

	// legend (computed palette: swatch + label, no box)
	type legendItem struct {
		color, label string
		dash         bool
	}
	var legend []legendItem
	if len(pressure) > 2 {
		legend = append(legend, legendItem{p.cPressure, cardText(c.lang, "pressure"), false})
	}
	if len(flow) > 2 {
		legend = append(legend, legendItem{p.cFlow, cardText(c.lang, "pump_flow"), false})
	}
	if len(weightFlow) > 2 {
		legend = append(legend, legendItem{p.cWeightFlow, cardText(c.lang, "weight_flow"), false})
	}
	if len(weight) > 2 {
		legend = append(legend, legendItem{p.cWeight, cardText(c.lang, "weight"), false})
	}
	if len(temp) > 2 {
		legend = append(legend, legendItem{p.cTemp, cardText(c.lang, "temperature"), false})
	}
	if len(tgtPress) > 2 {
		legend = append(legend, legendItem{p.cPressure, cardText(c.lang, "target_pressure"), true})
	}
	if len(tgtFlow) > 2 {
		legend = append(legend, legendItem{p.cFlow, cardText(c.lang, "target_flow"), true})
	}
	if len(tgtTemp) > 2 {
		legend = append(legend, legendItem{p.cTemp, cardText(c.lang, "target_temperature"), true})
	}
	if len(legend) > 0 {
		legY := outerY + outerH - legendH/2
		const swatchW, labelGap, itemGap = 10.0, 8.0, 20.0
		widths := make([]float64, len(legend))
		total := 0.0
		for i, it := range legend {
			widths[i] = swatchW + labelGap + textWidth(it.label, 15, false)
			total += widths[i]
			if i > 0 {
				total += itemGap
			}
		}
		lx := outerX + (outerW-total)/2
		for i, it := range legend {
			if it.dash {
				s.line(lx, legY, lx+swatchW, legY, it.color, 2, "3,2")
			} else {
				s.rect(lx, legY-1, swatchW, 2, 0, it.color, "", 0)
			}
			s.text(lx+swatchW+labelGap, legY+5, 15, false, p.textDim, "", it.label)
			lx += widths[i] + itemGap
		}
	}

	// ── FIGURES ── square: one row of cells; story: one row per figure.
	if len(figs) > 0 && c.format == "story" {
		top := outerY + outerH + 12
		rowH := math.Min(132, (footLine-16-top)/float64(len(figs)))
		figTop := footLine - 16 - rowH*float64(len(figs))
		for i, f := range figs {
			y := figTop + float64(i)*rowH
			s.line(outerX, y, outerX+outerW, y, p.border, 1, "")
			base := y + rowH/2 + L.figValSize*0.35
			s.text(cardPX, base, L.figLblSize, false, p.textDim, "", f.label)
			s.text(c.w-cardPX, base, L.figValSize, true, p.text, "end", f.value)
		}
	} else if len(figs) > 0 {
		figTop := footLine - 16 - figH
		s.line(outerX, figTop, outerX+outerW, figTop, p.border, 1, "")
		cellW := outerW / float64(len(figs))
		for i, f := range figs {
			cx := outerX + float64(i)*cellW + 8
			valY := figTop + 16 + L.figValSize
			s.text(cx, valY, L.figValSize, true, p.text, "", truncateToWidth(f.value, cellW-16, L.figValSize, true))
			s.text(cx, valY+L.figLblSize+12, L.figLblSize, false, p.textMute, "", truncateToWidth(f.label, cellW-16, L.figLblSize, false))
		}
	}

	// ── FOOTER ── app name and install code left, the badge in the accent right.
	s.line(0, footLine, c.w, footLine, p.border, 1, "")
	footBase := footLine + 38
	footerLeft := strings.Join(nonEmpty("Gaggiuino Local Profiler", installCode), "  ·  ")
	s.text(cardPX, footBase, 20, false, p.textMute, "", footerLeft)
	pillText := "Made with GLP"
	pillW := textWidth(pillText, 16, true) + 24
	const pillH = 32.0
	pillX := c.w - cardPX - pillW
	s.rect(pillX, footBase-6-pillH/2, pillW, pillH, cardChipRadius, p.accentFrom, "", 0)
	s.text(pillX+pillW/2, footBase, 16, true, p.accentText, "middle", pillText)

	s.raw(`</svg>`)
	return s.b.String()
}

const cardChipRadius = 7.0 // RADIUS_SM_PX = round(4 * 1.75)

// ── geometry / misc helpers ────────────────────────────────────────────

// cardTimeStep is the x axis tick step in seconds for a shot of totalSec,
// shared by the share card and the chart PNG (#1851).
func cardTimeStep(totalSec float64) float64 {
	switch {
	case totalSec > 90:
		return 20
	case totalSec > 40:
		return 10
	}
	return 5
}

// cardRightStep is the tick step of the right (temperature/weight) axis up to max.
func cardRightStep(max float64) float64 {
	switch {
	case max <= 40:
		return 10
	case max <= 80:
		return 20
	}
	return 25
}

// cardTimeLabel formats an x tick: "25s", or "1:05" from one minute on.
func cardTimeLabel(t float64) string {
	m, sec := int(t)/60, int(t)%60
	if m > 0 {
		return fmt.Sprintf("%d:%02d", m, sec)
	}
	return fmt.Sprintf("%ds", sec)
}

// cardDuration formats the shot time like the shot page: "28 s", or "1:05"
// from one minute on.
func cardDuration(sec float64) string {
	s := int(math.Round(sec))
	if s < 60 {
		return fmt.Sprintf("%d s", s)
	}
	return fmt.Sprintf("%d:%02d", s/60, s%60)
}

// cardDelta formats a score change like the shot page: "+5", "−11" (a real
// minus sign) or "±0".
func cardDelta(d int) string {
	switch {
	case d > 0:
		return fmt.Sprintf("+%d", d)
	case d < 0:
		return fmt.Sprintf("−%d", -d)
	}
	return "±0"
}

// wrapToWidth breaks s at spaces into at most maxLines lines that fit maxW;
// the last line takes the rest and is truncated with an ellipsis.
func wrapToWidth(s string, maxW, size float64, bold bool, maxLines int) []string {
	words := strings.Fields(s)
	var lines []string
	cur := ""
	for i, w := range words {
		next := w
		if cur != "" {
			next = cur + " " + w
		}
		if cur == "" || textWidth(next, size, bold) <= maxW {
			cur = next
			continue
		}
		if len(lines) == maxLines-1 {
			cur = strings.Join(append([]string{cur}, words[i:]...), " ")
			break
		}
		lines = append(lines, truncateToWidth(cur, maxW, size, bold))
		cur = w
	}
	if cur != "" {
		lines = append(lines, truncateToWidth(cur, maxW, size, bold))
	}
	return lines
}

func starPolygon(cx, cy, outerR float64, fill string) string {
	innerR := outerR * 0.42
	spikes := 5
	step := math.Pi / float64(spikes)
	rot := -math.Pi / 2
	var pts []string
	pts = append(pts, fmt.Sprintf("%s,%s", fnum(cx+math.Cos(rot)*outerR), fnum(cy+math.Sin(rot)*outerR)))
	for i := 0; i < spikes; i++ {
		rot += step
		pts = append(pts, fmt.Sprintf("%s,%s", fnum(cx+math.Cos(rot)*innerR), fnum(cy+math.Sin(rot)*innerR)))
		rot += step
		pts = append(pts, fmt.Sprintf("%s,%s", fnum(cx+math.Cos(rot)*outerR), fnum(cy+math.Sin(rot)*outerR)))
	}
	return fmt.Sprintf(`<polygon points="%s" fill="%s"/>`, strings.Join(pts, " "), fill)
}

// seriesPath builds an SVG path from a value array, skipping NaN gaps; empty
// if fewer than 2 usable points.
func seriesPath(vals []float64, xFn func(int) float64, yFn func(float64) float64) string {
	if len(vals) < 2 {
		return ""
	}
	var b strings.Builder
	started := false
	for i, v := range vals {
		if math.IsNaN(v) {
			continue
		}
		px := xFn(i)
		py := yFn(v)
		if !started {
			fmt.Fprintf(&b, "M%s %s", fnum(px), fnum(py))
			started = true
		} else {
			fmt.Fprintf(&b, "L%s %s", fnum(px), fnum(py))
		}
	}
	if !started {
		return ""
	}
	return b.String()
}

func clamp01(v float64) float64 {
	if v < 0 {
		return 0
	}
	if v > 1 {
		return 1
	}
	return v
}

// clampCardRange bounds v to [lo, hi]; NaN and infinities count as out of
// range, so a malformed shot value falls back to the nearest bound.
func clampCardRange(v, lo, hi float64) float64 {
	if math.IsNaN(v) || v < lo {
		return lo
	}
	if math.IsInf(v, 1) || v > hi {
		return hi
	}
	return v
}

func cardMaxInt(vals ...int) int {
	m := vals[0]
	for _, v := range vals[1:] {
		if v > m {
			m = v
		}
	}
	return m
}

func cardMaxOr0(vals []float64) float64 {
	m := 0.0
	for _, v := range vals {
		if v > m {
			m = v
		}
	}
	return m
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

func nonEmpty(vals ...string) []string {
	var out []string
	for _, v := range vals {
		if v != "" {
			out = append(out, v)
		}
	}
	return out
}

func mapString(v any, key string) string {
	if m, ok := v.(map[string]any); ok {
		if s, ok := m[key].(string); ok {
			return s
		}
	}
	return ""
}

// nativeShotID returns the machine's own shot number when the shot carries
// one, else the globally unique id.
func nativeShotID(shot Shot) int64 {
	switch v := shot["nativeId"].(type) {
	case int64:
		if v > 0 {
			return v
		}
	case int:
		if v > 0 {
			return int64(v)
		}
	}
	return shot.id()
}
