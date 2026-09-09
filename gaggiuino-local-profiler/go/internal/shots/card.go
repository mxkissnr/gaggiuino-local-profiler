package shots

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"math"
	"runtime"
	"strconv"
	"strings"
	"sync"

	resvg "github.com/kanrichan/resvg-go"
	"golang.org/x/image/font"
	"golang.org/x/image/font/gofont/gobold"
	"golang.org/x/image/font/gofont/goregular"
	"golang.org/x/image/font/opentype"
	"golang.org/x/image/math/fixed"
)

// card.go is the Go port of lib/card.js's GET /api/shots/:id/card
// share-card renderer (Phase 2f, issue #901). lib/card.js draws a PNG with
// @napi-rs/canvas; the maintainer's decision (see the round's plan) was to
// rebuild the card as an SVG we fully control and rasterise it with a
// pure-Go, cgo-free renderer so the single-static-binary goal survives.
//
// Pipeline:
//
//  1. buildCardSVG assembles the card as an SVG string via text/template-
//     free string building (we own every element, so there's nothing to
//     sanitise beyond XML-escaping user text — see esc). The
//     pressure/flow/temp curves are plain <path> elements built from the
//     shot's own datapoint series (the same series shot-chart.js feeds its
//     Chart.js chart — dp.pressure/pumpFlow/weightFlow/shotWeight|weight/
//     temperature and the dp.target* lines, all tenths, ÷10 here).
//  2. rasterise renders that SVG to PNG with github.com/kanrichan/resvg-go
//     (resvg 0.35 compiled to wasm, run on wazero — no cgo). Fonts are the
//     Go typeface (golang.org/x/image/font/gofont), whose .TTF bytes are
//     already compiled into those packages, so no separate //go:embed is
//     needed to get them into the static binary. lib/card.js registers
//     system Liberation/DejaVu Sans plus a bundled Fraunces woff2 for the
//     bean headline; fontdb in the resvg wasm build has no woff2 support,
//     so the headline uses bold Go sans here instead — lib/card.js's Fs()
//     itself falls back to sans when the serif fails to register, so this
//     is that same documented fallback, just always taken.
//
// Deviations from lib/card.js, all deliberate and all cosmetic:
//
//   - The frozen LEGACY_GLP layout (boxed header/footer/tiles, score ring)
//     for pre-#462 cached links is not reproduced — see card_palette.go.
//   - The shot photo "avatar" and the icon.png logo are not drawn; the
//     header shows the "GLP" wordmark lib/card.js falls back to when
//     icon.png is missing.
//   - Visual equivalence, not pixel parity: text metrics come from the Go
//     font, not @napi-rs/canvas, so wrap/centre positions differ slightly.
//
// lib/card.js's "canvas module not available" 503 branch (routes/shots.js)
// has no equivalent: the renderer is always compiled in. The frontend
// already treats 501/503 as "card unavailable", so a partial Go rollout
// stays safe regardless.

// cardDeps are the two cross-domain lookups lib/card.js does through a
// lazy require() and a try/catch (so a card never fails over them). Wired
// from cmd/server; either may be nil, in which case that piece is omitted
// exactly as lib/card.js omits it on a caught error.
type cardDeps struct {
	// installCode returns the install's short code (lib/card.js's
	// installCodeFor(getInstallId())) or "" if unavailable.
	installCode func() string
	// beanOriginCode ports resolveBeanOriginCode(coffeeName, library): the
	// origin chip's country code, or "" if none resolves.
	beanOriginCode func(coffeeName string) string
}

const installCodeAlphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"

// installCodeFor ports lib/card.js's installCodeFor: sha256 the UUID, take
// the first 8 bytes as a big-endian uint64, render 8 base-31 digits from
// the confusable-free alphabet, format as XXXX-XXXX. The algorithm is
// frozen (it's in screenshots people have posted) — must never change.
func InstallCodeFor(uuid string) string {
	sum := sha256.Sum256([]byte(uuid))
	n := binary.BigEndian.Uint64(sum[:8])
	chars := make([]byte, 8)
	for i := 7; i >= 0; i-- {
		chars[i] = installCodeAlphabet[n%uint64(len(installCodeAlphabet))]
		n /= uint64(len(installCodeAlphabet))
	}
	return string(chars[:4]) + "-" + string(chars[4:])
}

// ── rasterisation ──────────────────────────────────────────────────────

// A resvg.Context is a wazero runtime with one instantiated wasm module
// and one linear memory; every render does malloc→write→call→read→free
// against that shared memory, so a single Context can only serve one
// render at a time. The first cut kept one Context behind a global mutex
// and rebuilt the Renderer (and re-parsed both Go font faces) on every
// call — GET /api/shots/{id}/card p50 was 1127 ms at c=10, fully
// serialised (#951).
//
// Instead this is a small pool of independent Contexts, each with its own
// wazero runtime/memory (so N renders really do run in parallel) and a
// long-lived Renderer whose fontdb + font-family are loaded once at slot
// warm-up rather than per request. The fonts and family are constant for
// every card this package renders, so a warm Renderer is fully reusable.
// Slots are built lazily on first use — the first resvgPoolSize card
// requests each pay the ~1-2 s wasm instantiation, everything after is
// warm. A render that returns a wasm-level error drops its slot so the
// next user rebuilds it rather than inheriting a wedged module.
//
// #956 fixed the pool at 2 (down from 3) purely for warm RSS: each slot
// holds an independent wazero runtime + linear memory, and that
// re-verification only checked DB-endpoint latency and RSS, never
// concurrent card-render latency. #980 found the gap: against a real
// 2000-shot install, GET /api/shots/{id}/card at --concurrency 10 was 4.1x
// slower than Node's (p50 1271 ms vs 308 ms).
//
// Two things were verified, not assumed:
//
//  1. It's pool-queue wait, not a per-render slowdown. BenchmarkCardRenderWarm
//     (one render, no contention) is flat at ~130 ms regardless of pool
//     size; only BenchmarkCardRenderConcurrent's per-op time moves with it,
//     because c=10 requests funnel through however many slots exist.
//  2. That ~130 ms/render isn't Go doing unnecessary work. A CPU profile of
//     a warm render (enough iterations to amortise the one-time wazero JIT
//     cost) puts ~88% of the time in the compiled wasm itself — actual
//     resvg parse+layout+rasterise work — not in this package's SVG string
//     building or in repeat JIT compilation. There's no cheap win here
//     short of replacing the cgo-free wasm renderer with a native one,
//     which would give up the single-static-binary goal #901 chose it for.
//
// So the only lever available without redesigning the renderer is pool
// size — trading RSS for less queueing. Rather than pick a new fixed
// number, resvgPoolSize scales with GOMAXPROCS: each render is CPU-bound,
// so a slot beyond the host's core count adds RSS without adding
// throughput, and a host's core count is exactly the resource #956 was
// budgeting against. Floored at 2 — today's default, so a 1-2 core host
// (what #956 was optimising RSS for) sees no change at all — and capped at
// 4, since typical add-on hardware (RPi4-class SBCs, small NUCs) tops out
// there and a busier host's RSS budget usually scales with its core count
// too.
//
// Measured locally with a real HTTP server against a 2000-shot DB
// (--concurrency 10, --requests 200, 2-physical-core/4-thread dev box —
// itself a worse case than the non-SMT SBCs this mostly targets, so real
// gains on target hardware should be at least this good):
//
//	pool  p50      warm RSS  RSS after burst
//	2     1579 ms   116 MB    121 MB   (today's default, matches the live
//	                                    #980 finding of p50 1271-1579 ms)
//	3     1493 ms   145 MB    166 MB
//	4     1416 ms   180 MB    206 MB   (this change's default on this box)
//
// This narrows, not closes, the gap to Node — the ~130 ms/render wasm cost
// is the real floor per the profile above, and no pool size removes it.
// It's still a straight improvement with no regression on the RSS-tightest
// hosts, and it lets a host with real spare cores actually use them.
func defaultResvgPoolSize() int {
	n := runtime.GOMAXPROCS(0)
	if n < 2 {
		return 2
	}
	if n > 4 {
		return 4
	}
	return n
}

var resvgPoolSize = defaultResvgPoolSize()

type resvgSlot struct {
	ctx *resvg.Context
	r   *resvg.Renderer
}

func (s *resvgSlot) warm() error {
	ctx, err := resvg.NewContext(context.Background())
	if err != nil {
		return fmt.Errorf("resvg context: %w", err)
	}
	r, err := ctx.NewRenderer()
	if err != nil {
		ctx.Close()
		return fmt.Errorf("resvg renderer: %w", err)
	}
	if err := r.LoadFontData(goregular.TTF); err != nil {
		r.Close()
		ctx.Close()
		return fmt.Errorf("resvg load regular font: %w", err)
	}
	if err := r.LoadFontData(gobold.TTF); err != nil {
		r.Close()
		ctx.Close()
		return fmt.Errorf("resvg load bold font: %w", err)
	}
	if err := r.SetFontFamily(cardFontFamily); err != nil {
		r.Close()
		ctx.Close()
		return fmt.Errorf("resvg font family: %w", err)
	}
	s.ctx, s.r = ctx, r
	return nil
}

func (s *resvgSlot) drop() {
	if s.r != nil {
		s.r.Close()
	}
	if s.ctx != nil {
		s.ctx.Close()
	}
	s.ctx, s.r = nil, nil
}

type resvgPool struct{ free chan *resvgSlot }

func newResvgPool(n int) *resvgPool {
	p := &resvgPool{free: make(chan *resvgSlot, n)}
	for i := 0; i < n; i++ {
		p.free <- &resvgSlot{}
	}
	return p
}

func (p *resvgPool) render(svg []byte, w, h uint32) ([]byte, error) {
	slot := <-p.free
	defer func() { p.free <- slot }()

	if slot.r == nil {
		if err := slot.warm(); err != nil {
			slot.drop()
			return nil, err
		}
	}

	png, err := slot.r.RenderWithSize(svg, w, h)
	if err == nil && len(png) == 0 {
		// resvg ran but produced no image — an SVG it can't rasterise for
		// this input (unexpected for this package's fixed-canvas, escaped,
		// truncated template, but not impossible). The wasm module is
		// intact: keep the warm slot, only this one request fails. Do NOT
		// drop() here — that would make one bad card cost an unrelated
		// later request the ~1-2s wasm re-init.
		return nil, fmt.Errorf("resvg render: empty output for shot card SVG")
	}
	if err != nil {
		// A RenderWithSize error is a wasm-runtime failure (a guest trap, a
		// missing export, an allocation the module refused). One retry on
		// the same slot rides out a transient hiccup; a genuinely wedged
		// module fails again and only then is retired so the next caller
		// rebuilds it rather than inheriting the broken one.
		if png, err = slot.r.RenderWithSize(svg, w, h); err != nil {
			slot.drop()
			return nil, fmt.Errorf("resvg render: %w", err)
		}
		if len(png) == 0 {
			return nil, fmt.Errorf("resvg render: empty output for shot card SVG")
		}
	}
	return png, nil
}

var cardPool = newResvgPool(resvgPoolSize)

func rasterise(svg []byte, w, h uint32) ([]byte, error) {
	return cardPool.render(svg, w, h)
}

// renderShareCard is the package entry point routes/shots.js's getCard
// calls. score is the shot's computed score (may be nil).
func renderShareCard(shot Shot, score *int, format, accent, theme string, deps cardDeps) ([]byte, error) {
	c := newCardModel(shot, score, format, accent, theme, deps)
	svg := c.svg()
	return rasterise([]byte(svg), uint32(c.w), uint32(c.h))
}

// ── font metrics ───────────────────────────────────────────────────────

const cardFontFamily = "Go"

var (
	fontOnce          sync.Once
	regularSF, boldSF *opentype.Font
	faceMu            sync.Mutex
	faceCache         = map[string]font.Face{}
)

func initFonts() {
	fontOnce.Do(func() {
		regularSF, _ = opentype.Parse(goregular.TTF)
		boldSF, _ = opentype.Parse(gobold.TTF)
	})
}

func faceFor(size float64, bold bool) font.Face {
	initFonts()
	key := fmt.Sprintf("%v-%.2f", bold, size)
	faceMu.Lock()
	defer faceMu.Unlock()
	if fc, ok := faceCache[key]; ok {
		return fc
	}
	src := regularSF
	if bold {
		src = boldSF
	}
	fc, err := opentype.NewFace(src, &opentype.FaceOptions{Size: size, DPI: 72})
	if err != nil {
		return nil
	}
	faceCache[key] = fc
	return fc
}

// textWidth measures s in the Go font at the given px size. Used for
// truncation and centring — the equivalent of ctx.measureText().width.
func textWidth(s string, size float64, bold bool) float64 {
	fc := faceFor(size, bold)
	if fc == nil {
		return float64(len([]rune(s))) * size * 0.55
	}
	return float64(font.MeasureString(fc, s)) / 64.0
}

var _ = fixed.I // keep the math/fixed import meaningful across Go versions

// truncateToWidth ports lib/card.js's truncateText: drop 4 runes at a time
// (plus an ellipsis) until it fits.
func truncateToWidth(s string, maxWidth, size float64, bold bool) string {
	r := []rune(s)
	for textWidth(string(r), size, bold) > maxWidth && len(r) > 4 {
		r = append(r[:len(r)-4], '…')
	}
	return string(r)
}

// ── SVG helpers ────────────────────────────────────────────────────────

func esc(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch r {
		case '&':
			b.WriteString("&amp;")
		case '<':
			b.WriteString("&lt;")
		case '>':
			b.WriteString("&gt;")
		case '"':
			b.WriteString("&quot;")
		case '\'':
			b.WriteString("&apos;")
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}

type svgBuf struct{ b strings.Builder }

func (s *svgBuf) raw(str string)                 { s.b.WriteString(str) }
func (s *svgBuf) printf(format string, a ...any) { fmt.Fprintf(&s.b, format, a...) }

// text emits a <text> at (x, baselineY). anchor is "", "middle" or "end".
func (s *svgBuf) text(x, y, size float64, bold bool, fill, anchor, content string) {
	weight := ""
	if bold {
		weight = ` font-weight="bold"`
	}
	a := ""
	if anchor != "" {
		a = fmt.Sprintf(` text-anchor="%s"`, anchor)
	}
	s.printf(`<text x="%s" y="%s" font-family="%s" font-size="%s"%s fill="%s"%s>%s</text>`,
		fnum(x), fnum(y), cardFontFamily, fnum(size), weight, fill, a, esc(content))
}

func (s *svgBuf) line(x1, y1, x2, y2 float64, stroke string, width float64, dash string) {
	d := ""
	if dash != "" {
		d = fmt.Sprintf(` stroke-dasharray="%s"`, dash)
	}
	s.printf(`<line x1="%s" y1="%s" x2="%s" y2="%s" stroke="%s" stroke-width="%s"%s/>`,
		fnum(x1), fnum(y1), fnum(x2), fnum(y2), stroke, fnum(width), d)
}

func (s *svgBuf) rect(x, y, w, h, rx float64, fill, stroke string, strokeW float64) {
	attrs := fmt.Sprintf(`x="%s" y="%s" width="%s" height="%s"`, fnum(x), fnum(y), fnum(w), fnum(h))
	if rx > 0 {
		attrs += fmt.Sprintf(` rx="%s"`, fnum(rx))
	}
	if fill != "" {
		attrs += fmt.Sprintf(` fill="%s"`, fill)
	} else {
		attrs += ` fill="none"`
	}
	if stroke != "" {
		attrs += fmt.Sprintf(` stroke="%s" stroke-width="%s"`, stroke, fnum(strokeW))
	}
	s.printf(`<rect %s/>`, attrs)
}

func fnum(v float64) string {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return "0"
	}
	return strconv.FormatFloat(math.Round(v*100)/100, 'f', -1, 64)
}
