package shots

// chart_png.go renders GET /api/shots/{id}/chart.png (#1851): a shot's
// pressure, pump flow, weight and temperature curves as a fixed 960x480 PNG,
// for Home Assistant notifications and dashboards.
//
// Pure Go raster, deliberately not the share card's resvg-wasm path: every
// warm pool slot costs tens of MB of RSS (see card.go's measurements), and an
// integration fetching a chart after every shot would keep slots warm
// permanently. Here the per-request cost is a fixed ~4 MB RGBA bitmap plus a
// short-lived face — no pool. There is no cache either: one render takes a
// few tens of milliseconds, and a cache would have to be invalidated on
// trash, delete, move, re-sync and restore. The chart draws only datapoints,
// which annotation edits never change, so rendering the current data on every
// request is both simpler and always fresh.
//
// Deliberate differences from the app chart:
//
//   - only the four series this route names — no weight-flow line and no
//     target lines;
//   - a GaggiMate volumetric weight estimate is drawn solid, not dashed;
//   - the x axis is index-based, like the share card's.

import (
	"bytes"
	"errors"
	"image"
	"image/color"
	"image/draw"
	"image/png"
	"math"

	"golang.org/x/image/font"
	"golang.org/x/image/font/opentype"
	"golang.org/x/image/math/fixed"
	"golang.org/x/image/vector"
)

// chartW x chartH is 2:1, the aspect phone notifications show.
const chartW, chartH = 960, 480

const chartPadL, chartPadR = 56.0, 56.0

const chartPadT, chartPadB = 36.0, 72.0

// chartLeftMax is the left axis ceiling: bar and ml/s, as on the share card.
const chartLeftMax = 12.0

// chartMaxPoints caps each series; longer ones are thinned.
const chartMaxPoints = 2000

const chartFontSize = 16.0

// errChartFace is returned when the embedded Go font cannot be parsed, which
// would only happen with a broken build.
var errChartFace = errors.New("chart: no font face")

func renderShotChart(shot Shot, lang string) ([]byte, error) {
	p := buildPalette("", "light")
	dp := DatapointsMap(shot)

	pressure := tenthsSeries(dp, "pressure")
	flow := tenthsSeries(dp, "pumpFlow")
	weight := tenthsSeries(dp, "shotWeight")
	if len(weight) == 0 {
		weight = tenthsSeries(dp, "weight")
	}
	temp := tenthsSeries(dp, "temperature")

	nPts := cardMaxInt(len(pressure), len(flow), len(weight), len(temp), 1)
	totalSec := 30.0
	if d := cardNum(shot["duration"]); d != 0 {
		totalSec = d / 10
	}
	totalSec = clampCardRange(totalSec, 1, 3600)

	// Weight shares the right axis with temperature, as in the app's y1.
	rightMax := clampCardRange(math.Ceil(math.Max(cardMaxOr0(temp), cardMaxOr0(weight))+5), 1, 300)

	plotX, plotY := float64(chartPadL), float64(chartPadT)
	plotW := float64(chartW) - chartPadL - chartPadR
	plotH := float64(chartH) - chartPadT - chartPadB

	xIdx := func(i int) float64 { return plotX + float64(i)/math.Max(float64(nPts-1), 1)*plotW }
	yLeft := func(v float64) float64 { return plotY + plotH - clamp01(v/chartLeftMax)*plotH }
	yRight := func(v float64) float64 { return plotY + plotH - clamp01(v/rightMax)*plotH }

	img := image.NewRGBA(image.Rect(0, 0, chartW, chartH))
	draw.Draw(img, img.Bounds(), chartInk(p.bg), image.Point{}, draw.Src)

	// fill paints a pixel-aligned rect in ink.
	fill := func(x, y, w, h float64, ink image.Image) {
		x0, y0 := int(math.Round(x)), int(math.Round(y))
		draw.Draw(img, image.Rect(x0, y0, x0+int(math.Round(w)), y0+int(math.Round(h))), ink, image.Point{}, draw.Src)
	}
	grid := chartInk(grayScales["light"][700])
	for _, bar := range []float64{3, 6, 9, 12} {
		fill(plotX, yLeft(bar), plotW, 1, grid)
	}
	fill(plotX, yLeft(0), plotW, 1, chartInk(p.border))

	r := vector.NewRasterizer(chartW, chartH)
	stroke := func(vals []float64, y func(float64) float64, hex string, w float64) {
		if len(vals) == 0 {
			return
		}
		r.Reset(chartW, chartH)
		strokeSeries(r, vals, xIdx, y, w)
		r.Draw(img, img.Bounds(), chartInk(hex), image.Point{})
	}
	// Pressure last, so it draws on top.
	stroke(flow, yLeft, p.cFlow, 2.5)
	stroke(weight, yRight, p.cWeight, 2.5)
	stroke(temp, yRight, p.cTemp, 3)
	stroke(pressure, yLeft, p.cPressure, 3)

	face, ok := chartFace()
	if !ok {
		return nil, errChartFace
	}
	defer face.Close()
	d := &font.Drawer{Dst: img, Face: face, Src: chartInk(p.textMute)}

	for _, bar := range []float64{3, 6, 9, 12} {
		chartLabel(d, num1(bar), plotX-8, yLeft(bar)+5, 2)
	}
	rightStep := cardRightStep(rightMax)
	for v, i := rightStep, 0; v < rightMax && i < cardAxisMaxTicks; v, i = v+rightStep, i+1 {
		chartLabel(d, num1(v), plotX+plotW+8, yRight(v)+5, 0)
	}
	xStep := cardTimeStep(totalSec)
	for t, i := 0.0, 0; t <= totalSec && i < cardAxisMaxTicks; t, i = t+xStep, i+1 {
		chartLabel(d, cardTimeLabel(t), plotX+t/totalSec*plotW, plotY+plotH+24, 1)
	}

	chartLabel(d, "bar · ml/s", 8, 22, 0)
	chartLabel(d, "°C · g", float64(chartW)-8, 22, 2)

	labels := [4]string{
		cardText(lang, "pressure"), cardText(lang, "pump_flow"),
		cardText(lang, "weight"), cardText(lang, "temperature"),
	}
	colors := [4]string{p.cPressure, p.cFlow, p.cWeight, p.cTemp}
	counts := [4]int{len(pressure), len(flow), len(weight), len(temp)}

	const swatchW, labelGap, itemGap = 18.0, 6.0, 28.0
	var widths []float64
	var shown []int
	total := 0.0
	for i := range labels {
		if counts[i] <= 2 {
			continue
		}
		w := swatchW + labelGap + chartTextWidth(face, labels[i])
		widths = append(widths, w)
		total += w
		if len(shown) > 0 {
			total += itemGap
		}
		shown = append(shown, i)
	}
	legY := float64(chartH) - 20
	lx := (float64(chartW) - total) / 2
	for k, i := range shown {
		fill(lx, legY-7, swatchW, 3, chartInk(colors[i]))
		d.Src = chartInk(p.textDim)
		chartLabel(d, labels[i], lx+swatchW+labelGap, legY, 0)
		lx += widths[k] + itemGap
	}

	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// strokeSeries adds an antialiased polyline of width w through vals to r. A
// NaN or infinite value ends the current run (the card's gap rule). A series
// longer than chartMaxPoints is thinned to every k-th sample, so the work per
// request stays bounded whatever the stored shot holds.
func strokeSeries(r *vector.Rasterizer, vals []float64, x func(int) float64, y func(float64) float64, w float64) {
	step := 1 + len(vals)/chartMaxPoints
	var px, py float64
	have := false
	for i := 0; i < len(vals); i += step {
		v := vals[i]
		if math.IsNaN(v) || math.IsInf(v, 0) {
			have = false
			continue
		}
		cx, cy := x(i), y(v)
		if have {
			strokeSegment(r, px, py, cx, cy, w/2)
		}
		px, py, have = cx, cy, true
	}
}

// strokeSegment adds one segment as a quad of half-width half, extended by
// half at both ends so consecutive segments overlap at the joints. The quad is
// emitted in a fixed orientation whichever way the segment runs, so overlaps
// between neighbours add up instead of cancelling.
func strokeSegment(r *vector.Rasterizer, ax, ay, bx, by, half float64) {
	dx, dy := bx-ax, by-ay
	l := math.Hypot(dx, dy)
	if l == 0 {
		return
	}
	ux, uy := dx/l*half, dy/l*half
	nx, ny := -uy, ux
	ax, ay, bx, by = ax-ux, ay-uy, bx+ux, by+uy
	pts := [4][2]float64{
		{ax + nx, ay + ny},
		{bx + nx, by + ny},
		{bx - nx, by - ny},
		{ax - nx, ay - ny},
	}
	area := 0.0
	for i := range pts {
		j := (i + 1) % len(pts)
		area += pts[i][0]*pts[j][1] - pts[j][0]*pts[i][1]
	}
	if area < 0 {
		for i, j := 0, len(pts)-1; i < j; i, j = i+1, j-1 {
			pts[i], pts[j] = pts[j], pts[i]
		}
	}
	r.MoveTo(float32(pts[0][0]), float32(pts[0][1]))
	for _, p := range pts[1:] {
		r.LineTo(float32(p[0]), float32(p[1]))
	}
	r.ClosePath()
}

// chartFace returns a fresh Go regular face. Deliberately not card.go's shared
// font face cache: an opentype face is not safe for concurrent use, and chart
// requests run in parallel.
func chartFace() (font.Face, bool) {
	initFonts()
	if regularSF == nil {
		return nil, false
	}
	fc, err := opentype.NewFace(regularSF, &opentype.FaceOptions{Size: chartFontSize, DPI: 72, Hinting: font.HintingFull})
	if err != nil {
		return nil, false
	}
	return fc, true
}

// chartInk wraps a palette hex colour as a draw source.
func chartInk(hex string) image.Image {
	r, g, b := hexToRGB(hex)
	return image.NewUniform(color.RGBA{R: chartChan(r), G: chartChan(g), B: chartChan(b), A: 0xff})
}

// chartChan bounds a channel value that came from a hex string.
func chartChan(v int) uint8 {
	switch {
	case v < 0:
		return 0
	case v > 255:
		return 255
	}
	return uint8(v)
}

// chartTextWidth measures s with face, in px.
func chartTextWidth(face font.Face, s string) float64 {
	return float64(font.MeasureString(face, s)) / 64
}

// chartLabel draws s with d's current Src, aligned at x: 0 starts there,
// 1 centres on it, 2 ends there. y is the baseline.
func chartLabel(d *font.Drawer, s string, x, y float64, align int) {
	w := float64(d.MeasureString(s)) / 64
	d.Dot = fixed.P(int(math.Round(x-w*float64(align)/2)), int(math.Round(y)))
	d.DrawString(s)
}
