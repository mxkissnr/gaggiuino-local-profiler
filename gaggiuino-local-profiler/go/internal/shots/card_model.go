package shots

import (
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"
)

// card_model.go ports lib/card.js's generateShareCard body: the data
// extraction from the shot's datapoints/annotation, then the layout draw
// calls (as SVG elements). See card.go for the overall approach and the
// list of deliberate deviations.

const cardPX = 52.0 // lib/card.js's PX

type cardModel struct {
	shot   Shot
	score  *int
	format string
	pal    palette
	deps   cardDeps

	w, h  float64
	scale float64
}

func newCardModel(shot Shot, score *int, format, accent, theme string, deps cardDeps) *cardModel {
	c := &cardModel{
		shot:   shot,
		score:  score,
		format: format,
		pal:    buildPalette(accent, theme),
		deps:   deps,
		w:      1080,
	}
	if format == "story" {
		c.h, c.scale = 1920, 1.78
	} else {
		c.h, c.scale = 1080, 1.0
	}
	return c
}

// ── datapoint / annotation extraction (lib/card.js "── Data ──") ────────

func (c *cardModel) datapoints() map[string]any {
	return DatapointsMap(c.shot)
}

func (c *cardModel) annotation() map[string]any {
	if a, ok := c.shot["annotation"].(map[string]any); ok {
		return a
	}
	return map[string]any{}
}

// tenthsSeries reads dp[key] as a number array and divides each by 10
// (lib/card.js's `(dp.x || []).map(v => v / 10)`) — reuses score.go's
// floatSlice/divAll.
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

// ── small numeric formatting (lib/card.js parity) ──────────────────────

// num1 mirrors JS `+(+x).toFixed(1)` -> a number, so 4.0 prints "4", 4.5
// prints "4.5".
func num1(x float64) string {
	r := math.Round(x*10) / 10
	s := strconv.FormatFloat(r, 'f', 1, 64)
	s = strings.TrimSuffix(s, ".0")
	return s
}

// fixed1 always keeps one decimal (lib/card.js's ratio uses raw toFixed(1)).
func fixed1(x float64) string {
	return strconv.FormatFloat(math.Round(x*10)/10, 'f', 1, 64)
}

func fmtDur(dsRaw any) string {
	ds := cardNum(dsRaw)
	if ds == 0 {
		return ""
	}
	s := int(math.Round(ds / 10))
	m := s / 60
	r := s % 60
	if m > 0 {
		return fmt.Sprintf("%d:%02d", m, r)
	}
	return fmt.Sprintf("%ds", s)
}

func fmtDurSec(s float64) string {
	sec := int(math.Round(s))
	return fmt.Sprintf("%02d:%02d", sec/60, sec%60)
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

func maxFiltered(vals []float64, keep func(float64) bool) (float64, bool) {
	m, found := 0.0, false
	for _, v := range vals {
		if keep(v) && (!found || v > m) {
			m, found = v, true
		}
	}
	return m, found
}

func cardStdDev(vals []float64, keep func(float64) bool) (float64, bool) {
	var f []float64
	for _, v := range vals {
		if keep(v) {
			f = append(f, v)
		}
	}
	if len(f) < 2 {
		return 0, false
	}
	mean := 0.0
	for _, v := range f {
		mean += v
	}
	mean /= float64(len(f))
	s := 0.0
	for _, v := range f {
		s += (v - mean) * (v - mean)
	}
	return math.Round(math.Sqrt(s/float64(len(f)))*10) / 10, true
}

func lastPositive(vals []float64) (float64, bool) {
	for i := len(vals) - 1; i >= 0; i-- {
		if vals[i] > 0 {
			return vals[i], true
		}
	}
	return 0, false
}

// detectPreinfusionEnd ports lib/card.js's detectPreinfusionEnd(pressure).
func detectPreinfusionEnd(pressure []float64) (int, bool) {
	if len(pressure) < 10 {
		return 0, false
	}
	for i := 5; i < len(pressure)-5; i++ {
		if pressure[i] >= 5.0 && pressure[i+1] >= 5.0 && pressure[i+2] >= 5.0 {
			return i, true
		}
	}
	return 0, false
}

// ── the card itself ────────────────────────────────────────────────────

func (c *cardModel) svg() string {
	p := c.pal
	dp := c.datapoints()
	ann := c.annotation()

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
	totalSec := 30.0
	if d := cardNum(c.shot["duration"]); d != 0 {
		totalSec = d / 10
	}

	profileName := firstNonEmpty(
		mapString(c.shot["profile"], "name"),
		strField(c.shot, "profile_name"),
		strField(c.shot, "profileName"),
	)
	if profileName == "" {
		profileName = "Unknown"
	}
	bean := strField(ann, "coffee")
	machine := firstNonEmpty(strField(ann, "machine"), strField(c.shot, "machine"))

	var dose *float64
	if v, ok := numField(ann, "dose"); ok {
		r := math.Round(v*10) / 10
		dose = &r
	}
	var yieldG *float64
	if v, ok := numField(ann, "totalWeight"); ok {
		r := math.Round(v*10) / 10
		yieldG = &r
	} else if v, ok := numField(ann, "yield"); ok {
		r := math.Round(v*10) / 10
		yieldG = &r
	} else if len(weight) > 0 {
		r := math.Round(weight[len(weight)-1]*10) / 10
		yieldG = &r
	}
	ratio := ""
	if dose != nil && *dose != 0 && yieldG != nil && *yieldG != 0 {
		ratio = "1:" + fixed1(*yieldG / *dose)
	}
	dur := fmtDur(c.shot["duration"])

	avgPres, hasAvgPres := avgFiltered(pressure, func(v float64) bool { return v > 1.5 })
	maxPres, hasMaxPres := maxFiltered(pressure, func(v float64) bool { return v > 0 })
	avgTemp, hasAvgTemp := avgFiltered(temp, func(v float64) bool { return v > 50 })
	avgFlow, hasAvgFlow := avgFiltered(flow, func(v float64) bool { return v > 0.3 })
	tempSD, hasTempSD := cardStdDev(temp, func(v float64) bool { return v > 50 })

	var rating int
	if v, ok := numField(ann, "rating"); ok {
		rating = int(math.Round(v))
	}

	tgtPressVal, hasTgtPress := lastPositive(tgtPress)
	tgtPressVal = math.Round(tgtPressVal*10) / 10

	originCode := ""
	if c.deps.beanOriginCode != nil && bean != "" {
		originCode = c.deps.beanOriginCode(bean)
	}
	installCode := ""
	if c.deps.installCode != nil {
		installCode = c.deps.installCode()
	}

	preEnd, hasPre := detectPreinfusionEnd(pressure)

	var s svgBuf
	s.printf(`<svg xmlns="http://www.w3.org/2000/svg" width="%s" height="%s" viewBox="0 0 %s %s">`,
		fnum(c.w), fnum(c.h), fnum(c.w), fnum(c.h))
	s.rect(0, 0, c.w, c.h, 0, p.bg, "", 0)

	// ── HEADER ──
	const hh = 76.0
	s.text(cardPX, 50, 44, true, p.text, "", "GLP")
	headerRight := ""
	if c.format != "story" {
		shotID := ""
		if id := c.shot.id(); id != 0 {
			shotID = fmt.Sprintf("Shot #%d", id)
		}
		dateStr := ""
		if ts := cardNum(c.shot["timestamp"]); ts != 0 {
			dateStr = germanDate(int64(ts))
		}
		headerRight = strings.TrimSpace(strings.Join(nonEmpty(shotID, dateStr), "  ·  "))
	}
	if headerRight != "" {
		s.text(c.w-cardPX, 44, 20, false, p.textDim, "end", headerRight)
	}
	s.line(0, hh, c.w, hh, p.border, 1, "")

	// ── HERO ──
	headlineBaseline := hh + 54
	chipCY := headlineBaseline - 16
	leadW := 0.0
	if originCode != "" {
		chipW := textWidth(originCode, 18, true) + 26
		chipH := 34.0
		s.rect(cardPX, chipCY-chipH/2, chipW, chipH, cardChipRadius, p.accentTint("0.14"), p.accentTint("0.35"), 1)
		s.text(cardPX+chipW/2, chipCY+6, 18, true, p.accentFrom, "middle", originCode)
		leadW = chipW + 14
	}
	headline := firstNonEmpty(bean, profileName)
	nameMaxW := c.w - 2*cardPX - 20
	headline = truncateToWidth(headline, nameMaxW-leadW, 52, true)
	s.text(cardPX+leadW, headlineBaseline, 52, true, p.text, "", headline)

	cursorY := headlineBaseline + 32
	phrase := scoreTierPhrase(c.score)
	if c.score != nil && phrase != "" {
		cursorY = headlineBaseline + 78
		vx := cardPX
		numText := strconv.Itoa(*c.score)
		s.text(vx, cursorY, 62, true, scoreColor(c.score, p), "", numText)
		vx += textWidth(numText, 62, true) + 14
		s.text(vx, cursorY, 24, false, p.textMute, "", "·")
		vx += textWidth("·", 24, false) + 14
		s.text(vx, cursorY, 24, false, p.textDim, "", phrase)
		cursorY += 30
	} else if phrase != "" {
		s.text(cardPX, cursorY, 24, false, p.textDim, "", phrase)
		cursorY += 34
	}

	if rating > 0 {
		starR := 11.0
		starGap := 8.0
		starsY := cursorY - 8
		sx := cardPX + starR
		for i := 0; i < 5; i++ {
			fill := p.starDim
			if i < rating {
				fill = p.star
			}
			s.raw(starPolygon(sx, starsY, starR, fill))
			sx += starR*2 + starGap
		}
		cursorY = starsY + starR + 24
	}

	subY := cursorY
	if parts := nonEmpty(profileName, machine); len(parts) > 0 {
		line := truncateToWidth(strings.Join(parts, "  ·  "), nameMaxW+140, 24, false)
		s.text(cardPX, cursorY, 24, false, p.textDim, "", line)
		subY = cursorY + 32
	}

	// Dosis → Ausbeute · Ratio · Dauer
	var doseParts []string
	if dose != nil && *dose != 0 {
		doseParts = append(doseParts, num1(*dose)+"g")
	}
	if yieldG != nil && *yieldG != 0 {
		doseParts = append(doseParts, "→ "+num1(*yieldG)+"g")
	}
	if ratio != "" {
		doseParts = append(doseParts, "· "+ratio)
	}
	if dur != "" {
		doseParts = append(doseParts, "· "+dur)
	}
	if len(doseParts) > 0 {
		doseY := subY + 14
		s.text(cardPX, doseY, 22, false, p.textMute, "", "Dosis")
		s.text(cardPX+78, doseY, 22, true, p.text, "", strings.Join(doseParts, "  "))
		subY = doseY
	}

	sepY := subY + 20
	s.printf(`<defs><linearGradient id="sep" x1="0" y1="0" x2="1" y2="0">`+
		`<stop offset="0" stop-color="%s" stop-opacity="0.5"/>`+
		`<stop offset="0.6" stop-color="%s" stop-opacity="0.15"/>`+
		`<stop offset="1" stop-color="%s" stop-opacity="0"/></linearGradient></defs>`,
		p.accentFrom, p.accentFrom, p.accentFrom)
	s.printf(`<line x1="%s" y1="%s" x2="%s" y2="%s" stroke="url(#sep)" stroke-width="1"/>`,
		fnum(cardPX), fnum(sepY), fnum(c.w-cardPX), fnum(sepY))

	// ── CHART ──
	const chartL, chartR, chartT, chartB, legendH = 44.0, 44.0, 10.0, 28.0, 50.0
	const statsH, footH = 200.0, 52.0
	outerX := cardPX - 8
	outerY := sepY + 10
	outerW := c.w - 2*cardPX + 16
	availH := c.h - outerY - statsH - 16 - footH
	outerH := math.Max(math.Round(240*c.scale), availH)
	plotX := outerX + chartL
	plotY := outerY + chartT
	plotW := outerW - chartL - chartR
	plotH := outerH - chartT - chartB - legendH

	leftMax := 12.0
	tempMax := math.Ceil(cardMaxOr0(temp) + 5)
	if tempMax == 0 {
		tempMax = 100
	}
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
	rightStep := 25.0
	switch {
	case tempMax <= 40:
		rightStep = 10
	case tempMax <= 80:
		rightStep = 20
	}
	for v := rightStep; v < tempMax; v += rightStep {
		gy := yRight(v)
		s.text(outerX+outerW-chartR+5, gy+5, 15, false, p.textMute, "", num1(v))
	}
	// x ticks
	xTickStep := 5.0
	switch {
	case totalSec > 90:
		xTickStep = 20
	case totalSec > 40:
		xTickStep = 10
	}
	for t := 0.0; t <= totalSec; t += xTickStep {
		gx := plotX + (t/totalSec)*plotW
		s.line(gx, plotY, gx, plotY+plotH, p.border, 1, "2,4")
		m := int(t) / 60
		sec := int(t) % 60
		label := fmt.Sprintf("%ds", sec)
		if m > 0 {
			label = fmt.Sprintf("%d:%02d", m, sec)
		}
		s.text(gx, plotY+plotH+22, 16, false, p.textMute, "middle", label)
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
			s.text(plotX+6, plotY+19, 13, true, p.cPressure, "", "Preinfusion")
		}
		if extWidth > 90 {
			s.text(pxEnd+6, plotY+19, 13, true, p.cFlow, "", "Extraktion")
		}
	}

	// legend (computed palette: swatch + label, no box)
	type legendItem struct {
		color, label string
		dash         bool
	}
	var legend []legendItem
	if len(pressure) > 2 {
		legend = append(legend, legendItem{p.cPressure, "Druck", false})
	}
	if len(flow) > 2 {
		legend = append(legend, legendItem{p.cFlow, "Pumpenfluss", false})
	}
	if len(weightFlow) > 2 {
		legend = append(legend, legendItem{p.cWeightFlow, "Gewichtsfluss", false})
	}
	if len(weight) > 2 {
		legend = append(legend, legendItem{p.cWeight, "Gewicht", false})
	}
	if len(temp) > 2 {
		legend = append(legend, legendItem{p.cTemp, "Temperatur", false})
	}
	if len(tgtPress) > 2 {
		legend = append(legend, legendItem{p.cPressure, "Ziel Druck", true})
	}
	if len(tgtFlow) > 2 {
		legend = append(legend, legendItem{p.cFlow, "Ziel Fluss", true})
	}
	if len(tgtTemp) > 2 {
		legend = append(legend, legendItem{p.cTemp, "Ziel Temperatur", true})
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

	// ── STATS BAND ──
	sX := cardPX - 8
	sW := c.w - 2*cardPX + 16
	statsY := outerY + outerH + 8

	pressQual := ""
	if hasTgtPress && tgtPressVal > 0 {
		pressQual = "Ziel " + num1(tgtPressVal)
	} else if hasMaxPres {
		pressQual = "max " + num1(math.Round(maxPres*10)/10)
	}

	type bandCell struct{ label, value string }

	var row1, row2 []*bandCell
	if dose != nil || yieldG != nil {
		v := ""
		if dose != nil && yieldG != nil {
			v = fmt.Sprintf("%s → %sg", num1(*dose), num1(*yieldG))
		} else if dose != nil {
			v = num1(*dose) + "g"
		} else {
			v = num1(*yieldG) + "g"
		}
		row1 = append(row1, &bandCell{"Dosis → Ausbeute", v})
	} else {
		row1 = append(row1, nil)
	}
	if ratio != "" {
		row1 = append(row1, &bandCell{"Ratio", ratio})
	} else {
		row1 = append(row1, nil)
	}
	row1 = append(row1, &bandCell{"Dauer", fmtDurSec(totalSec)})

	if hasAvgPres {
		lbl := "Druck Ø"
		if pressQual != "" {
			lbl = "Druck Ø · " + pressQual
		}
		row2 = append(row2, &bandCell{lbl, num1(math.Round(avgPres*10)/10) + " bar"})
	} else {
		row2 = append(row2, nil)
	}
	if hasAvgFlow {
		row2 = append(row2, &bandCell{"Pumpenfluss Ø", num1(math.Round(avgFlow*10)/10) + " ml/s"})
	} else {
		row2 = append(row2, nil)
	}
	if hasAvgTemp {
		lbl := "Temperatur Ø"
		if hasTempSD {
			lbl += " ±" + num1(tempSD)
		}
		row2 = append(row2, &bandCell{lbl, num1(math.Round(avgTemp*10)/10) + " °C"})
	} else {
		row2 = append(row2, nil)
	}

	bandColW := sW / 3
	bandRowH := statsH / 2
	drawBandRow := func(cells []*bandCell, rowY float64) {
		s.line(sX, rowY, sX+sW, rowY, p.border, 1, "")
		for i, cell := range cells {
			if cell == nil {
				continue
			}
			cx := sX + float64(i)*bandColW
			if i > 0 {
				cx += 16
			}
			s.text(cx, rowY+14+30, 30, true, p.text, "", cell.value)
			s.text(cx, rowY+14+54, 14, false, p.textMute, "", cell.label)
		}
	}
	drawBandRow(row1, statsY)
	drawBandRow(row2, statsY+bandRowH)

	// ── FOOTER ──
	footY := c.h - 38
	s.line(0, footY-12, c.w, footY-12, p.border, 1, "")
	footerLeft := strings.Join(nonEmpty("Gaggiuino Local Profiler", installCode), "  ·  ")
	s.text(cardPX, footY+6, 20, false, p.textMute, "", footerLeft)

	pillText := "Made with GLP"
	pillPad := 12.0
	pillW := textWidth(pillText, 16, true) + pillPad*2
	pillH := 30.0
	pillX := c.w - cardPX - pillW
	s.rect(pillX, footY+6-pillH/2, pillW, pillH, 5, "", p.accentFrom, 1)
	s.text(pillX+pillW/2, footY+12, 16, true, p.accentFrom, "middle", pillText)

	s.raw(`</svg>`)
	return s.b.String()
}

const cardChipRadius = 7.0 // RADIUS_SM_PX = round(4 * 1.75)

// ── geometry / misc helpers ────────────────────────────────────────────

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

// seriesPath ports lib/card.js's polyline(): an SVG path from a value
// array, skipping NaN gaps, nil if fewer than 2 usable points.
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

// germanDate ports lib/card.js's toLocaleDateString('de-DE', { day:'2-digit',
// month:'short', year:'numeric' }) — e.g. "16. Aug. 2026".
func germanDate(unixSec int64) string {
	t := time.Unix(unixSec, 0).UTC()
	months := []string{"Jan.", "Feb.", "März", "Apr.", "Mai", "Juni", "Juli", "Aug.", "Sept.", "Okt.", "Nov.", "Dez."}
	return fmt.Sprintf("%02d. %s %d", t.Day(), months[int(t.Month())-1], t.Year())
}
