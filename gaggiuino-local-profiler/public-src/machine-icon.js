// Machine icon rendering (#594, redesigned in #811, static variant fixed in
// #822). Two renderers live in this file:
//   - machineIconSvg()/machineIconMiniSvg() (defined further down, right
//     after gaggimatePanelAndDisplay()): a static (non-animated) icon for
//     Settings → Machines (list rows, topbar switcher, add/edit preview).
//   - machineIconAnimatedSvg(): the live, state-driven "Instrument" icon
//     (#811) for the Live view.
// Both share one body silhouette (animBody()) and per-type front panel
// (gaggiuinoPanelAndDisplay()/gaggimatePanelAndDisplay()) — geometry and
// comments below are Max's approved Theme Lab / redesign-2026-08 mockup
// measurements, kept as-is; do not redesign.
//
// Body colour comes from the machine's theme (lib/machines/theme-presets.js
// resolveTheme()); the dark/chrome parts are fixed neutral greys (not pure
// black) by design, so the icon stays legible on both the app's light and
// dark backgrounds regardless of theme.
import { resolveTheme } from '../lib/machines/theme-presets.js';

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

// Multiple machines (list rows, switcher, ...) can render this icon in the
// same document at once — SVG gradient ids are global to the page, so a
// shared id across instances would make every icon pick up whichever
// gradient happened to be defined last. Give every call a fresh id.
let _instanceCounter = 0;
function nextGradientId() {
    _instanceCounter += 1;
    return `glp-machine-icon-${_instanceCounter}`;
}

// Falls back to the app's own accent gradient (see style.css [data-accent]
// vars) when the machine has no theme set — matches the app's existing
// default look rather than an arbitrary hardcoded colour.
function stopsFor(theme) {
    const resolved = resolveTheme(theme);
    if (resolved && HEX_RE.test(resolved.a) && HEX_RE.test(resolved.b)) return resolved;
    return { a: 'var(--accent-from)', b: 'var(--accent-to)' };
}

// ═══════════════════════════════════════════════════════════════════════
// Animated "Instrument" icon (#811) — ported from the approved prototype,
// redesign-2026-08/build-prototype.py's machine_anim(), and the geometry
// notes in redesign-2026-08/PLAN.md section 3. This is a second, richer
// icon: two machine types sharing one body (rectangular Gaggiuino display
// vs. round GaggiMate puck in a chrome housing), five live states
// (is-on/is-heating/is-hot/is-brewing/is-steaming), a brew scale, a milk
// jug, and a mini shot-curve baked into the on-machine display.
//
// machineIconSvg()/machineIconMiniSvg() (defined right after
// gaggimatePanelAndDisplay() below) reuse this same body/panel geometry for
// a static settings-screen preview, but without the live-state machinery —
// see the comment above machineIconStaticMarkup() for why.
//
// The state-driving CSS lives in style.css under `.machine-icon-live` —
// see MACHINE_ICON_LIVE_CLASS below for how a caller is expected to wire
// the two together.
//
// Lamp logic is deliberately counter-intuitive (see style.css's comment
// next to `.lamp`): the lamp on the brew switch is a temperature-READY
// indicator, lit when the heating element is OFF. Do not "fix" this.

// Colours for the mini shot-curve/display readout are the machine's own
// on-device palette (build-prototype.py's PRES/FLOW/TEMP/WGT/ORG) —
// intentionally distinct from the app's Okabe-Ito chart series
// (views/live.js's initLiveChart()), which stays accessibility-tuned for a
// full-size chart with a legend. This is a small illustrative readout, not
// a data-accurate chart.
const MINI_PRES = '#6aa9d8';
const MINI_FLOW = '#e8a33c';
const MINI_TEMP = '#e8452a';
const MINI_WGT  = '#5fd0a8';
const MINI_ORG  = '#e8622a';

const CUP_PATH  = 'M43.5 108 H58.5 L57 123.4 A2 2 0 0 1 55 125.2 H47 A2 2 0 0 1 45 123.4 Z';
const JUG_PATH  = 'M62.8 100.4 L84.4 100.4 L82.3 124 L64.9 124 Z';
const FOOT_PATH = 'M64.2 124 H83 L82.2 128.4 A1.8 1.8 0 0 1 80.4 130 H66.8 A1.8 1.8 0 0 1 65 128.4 Z';

// Rounds away binary-float noise (e.g. 41 - 9.9 === 31.099999999999998)
// from the arc coordinates computed below, without padding whole numbers
// with a trailing ".0".
function r(n) {
    return Math.round(n * 100) / 100;
}

// The bunch of colored polylines standing in for "a shot" on the tiny
// on-machine display — same shapes build-prototype.py's curves() draws,
// scaled into whatever box (x0..x1, yt..yb) the caller hands it. This is a
// static illustration, not bound to real telemetry; wiring the live shot
// stream into it is future work for whichever view ends up hosting this
// icon live (see the round's report for why that's out of scope here).
function curveSeries(x0, x1, yb, yt, w = 1.4, live = true) {
    const sx = t => x0 + (x1 - x0) * t;
    const sy = v => yb - (yb - yt) * v;
    const poly = (pts, c, sw) => {
        const p = pts.map(([t, v]) => `${sx(t).toFixed(1)},${sy(v).toFixed(1)}`).join(' ');
        return `<polyline points="${p}" fill="none" stroke="${c}" stroke-width="${sw}" stroke-linejoin="round" stroke-linecap="round"/>`;
    };
    const pres = [[0, .02], [.08, .06], [.18, .62], [.3, .86], [.5, .88], [.75, .84], [1, .78]];
    const flow = [[0, .1], [.18, .12], [.28, .42], [.45, .46], [.7, .44], [1, .43]];
    const temp = [[0, .93], [.35, .95], [.7, .94], [1, .95]];
    const wgt  = [[0, 0], [.2, .02], [.45, .3], [.72, .56], [1, .8]];
    const areaPts = pres.map(([t, v]) => `${sx(t).toFixed(1)},${sy(v).toFixed(1)}`).join(' ');
    const area = `<polygon points="${sx(0).toFixed(1)},${yb.toFixed(1)} ${areaPts} ${sx(1).toFixed(1)},${yb.toFixed(1)}" fill="${MINI_PRES}" opacity=".16"/>`;
    let out = area + poly(temp, MINI_TEMP, w * .8) + poly(pres, MINI_PRES, w) + poly(flow, MINI_FLOW, w * .85);
    if (live) out += poly(wgt, MINI_WGT, w * .85);
    return out;
}

// Shared body — drip tray, portafilter, steam wand, control panel shell,
// steam knob. Drawn twice per icon (see machineIconAnimatedSvg): once in a
// fixed neutral-chrome gradient (always visible) and once in the machine's
// accent gradient, clipped to a rect that CSS animates upward as the
// machine heats (`--heat`, `.heat-rect`/`.heat-base` in style.css). Takes
// its two gradient ids as params rather than string-replacing placeholders
// (build-prototype.py's approach) — direct interpolation can't silently
// miss a token the way `str.replace` can (PLAN.md section 7).
//
// `mini` (#822) drops the button highlight strips and drip-tray ribs — the
// same category of small cosmetic accent the pre-#811 static icon's own
// mini variant used to drop — for the static settings-screen icon at
// <=24px; machineIconAnimatedSvg() never passes it, so the Live view's
// icon keeps full detail unchanged.
function animBody(gradId, steelId, mini = false) {
    return `
      <path d="M72.2 2.3 L100 11 L100 130 L88 153 L72.2 153 Z" fill="url(#${gradId})"/>
      <path d="M72.2 2.3 L100 11 L100 130 L88 153 L72.2 153 Z" fill="#000" opacity=".26"/>
      <path d="M93.2 8.6 L100 11 L100 130 L90 149 L93.2 142 Z" fill="#fff" opacity=".13"/>
      <path d="M13 2.4 L72.2 2.3 L72.2 71.9 L10.2 71.9 L10.2 5.2 A2.8 2.8 0 0 1 13 2.4 Z" fill="url(#${gradId})"/>
      <path d="M72.2 3 L72.2 71" stroke="#fff" opacity=".22" stroke-width="3"/>
      <path d="M13 2.4 L72.2 2.3 L72.2 8.2 L10.2 8.2 L10.2 5.2 A2.8 2.8 0 0 1 13 2.4 Z" fill="#000" opacity=".2"/>
      <rect x="15.5" y="3.4" width="52" height="3.6" rx="1.2" fill="#000" opacity=".32"/>
      <path d="M10.4 8.5 L72 8.5" stroke="#fff" opacity=".2" stroke-width="1.1"/>
      <path d="M72.2 2.3 L100 11 L100 15.6 L72.2 8.4 Z" fill="#000" opacity=".33"/>
      <rect x="22" y="17.5" width="11.4" height="10.6" rx="1.4" fill="#1e1e22"/>
      <rect x="35.5" y="17.5" width="11.4" height="10.6" rx="1.4" fill="#1e1e22"/>
      <rect x="49" y="17.5" width="11.4" height="10.6" rx="1.4" fill="#1e1e22"/>
      ${mini ? '' : `
      <rect x="23" y="18.5" width="9.4" height="3.6" rx="1" fill="#fff" opacity=".13"/>
      <rect x="36.5" y="18.5" width="9.4" height="3.6" rx="1" fill="#fff" opacity=".13"/>
      <rect x="50" y="18.5" width="9.4" height="3.6" rx="1" fill="#fff" opacity=".13"/>`}
      <path d="M20 72 L94 72 L94 122 L24 122 Z" fill="#2b2b31"/>
      <path d="M20 72 L94 72 L94 77 L20.6 77 Z" fill="#000" opacity=".3"/>
      <rect x="40.5" y="69.5" width="19" height="8.4" rx="1.6" fill="#c8ccd2"/>
      <rect x="40.5" y="69.5" width="19" height="2.6" rx="1.3" fill="#fff" opacity=".35"/>
      <ellipse cx="50" cy="78.4" rx="8.6" ry="2.1" fill="#8f959d"/>
      <path d="M21.4 72 C20.6 77 21 81 21.4 86" stroke="#26262c" stroke-width="4.6" stroke-linecap="round"/>
      <path d="M21.4 86 C21.6 97 21.4 108 21.6 117" stroke="#a3a9b1" stroke-width="2.4" stroke-linecap="round"/>
      <circle cx="21.6" cy="118.4" r="1.7" fill="#8f959d"/>
      <path d="M25.5 92.5 L42.5 81.5" stroke="#17171b" stroke-width="6.4" stroke-linecap="round"/>
      <circle cx="24.2" cy="93.4" r="3.9" fill="#17171b"/>
      <path d="M41.4 78.6 L58.6 78.6 L56.6 86.4 L43.4 86.4 Z" fill="#b9bec5"/>
      <path d="M41.4 78.6 L58.6 78.6 L58 80.9 L42 80.9 Z" fill="#fff" opacity=".28"/>
      <ellipse cx="50" cy="86.4" rx="6.7" ry="1.7" fill="#8f959d"/>
      <ellipse cx="50" cy="86.4" rx="5.5" ry="1.2" fill="#43301f"/>
      <path d="M84.2 72 C85.2 78 84.6 82 84 88" stroke="#26262c" stroke-width="5" stroke-linecap="round"/>
      <path d="M84 88 C83.7 94 83.5 99 83.4 103" stroke="#a3a9b1" stroke-width="2.6" stroke-linecap="round"/>
      <g class="wand-low">
        <path d="M83.4 103 C83.1 112 83 120 83.5 128" stroke="#a3a9b1" stroke-width="2.6" stroke-linecap="round"/>
        <circle cx="83.5" cy="129.4" r="1.9" fill="#8f959d"/>
      </g>
      <path d="M17 122 L93 122 L80 134 L0 134 Z" fill="#25252b"/>
      <path d="M20.5 123.4 L88.5 123.4 L77 132.6 L4 132.6 Z" fill="url(#${steelId})"/>
      ${mini ? '' : `
      <path d="M22.6 125.6 L86 125.6" stroke="#7d838a" stroke-width=".8" opacity=".8"/>
      <path d="M21.4 128.4 L83.6 128.4" stroke="#7d838a" stroke-width=".8" opacity=".8"/>
      <path d="M20.2 131.2 L81 131.2" stroke="#7d838a" stroke-width=".8" opacity=".8"/>`}
      <path d="M0 134 L80 134 L84 155 L0 155 Z" fill="#2b2b31"/>
      <path d="M0 134 L80 134 L80.8 138 L0 138 Z" fill="#fff" opacity=".07"/>
      <rect x="4.5" y="155" width="7.5" height="4.4" rx="1.5" fill="#26262c"/>
      <rect x="66" y="155" width="7.5" height="4.4" rx="1.5" fill="#26262c"/>
      <ellipse cx="82.6" cy="26.4" rx="2.6" ry="5.4" fill="#1f1f24"/>
      <path d="M82.6 21 H95.4 A3.4 5.4 0 0 1 95.4 31.8 H82.6 Z" fill="#b4b9c0"/>
      <ellipse cx="95.4" cy="26.4" rx="3.2" ry="5.4" fill="#d6dade"/>
      <ellipse cx="95.4" cy="26.4" rx="1.5" ry="2.6" fill="#9aa0a8"/>
      <path d="M84 22.6 H93.4" stroke="#fff" opacity=".55" stroke-width="1.4" stroke-linecap="round"/>
      <path d="M84 30 H93.4" stroke="#000" opacity=".22" stroke-width="1.2" stroke-linecap="round"/>`;
}

// Gaggiuino: rectangular display module bolted to the front, overhanging,
// sitting low (nx 13.6..66.4, ny 38.6..64.2).
function gaggiuinoPanelAndDisplay() {
    const panel = `
      <path d="M14 63.5 H66 L64 68 H16 Z" fill="#000" opacity=".35"/>
      <rect x="13.6" y="38.6" width="52.8" height="25.6" rx="3" fill="#101012"/>
      <rect x="13.6" y="38.6" width="52.8" height="25.6" rx="3" fill="none" stroke="#2c2c30" stroke-width="1"/>
      <rect x="13.6" y="38.6" width="52.8" height="2.6" rx="1.3" fill="#fff" opacity=".07"/>
      <rect x="17.4" y="42.2" width="45.2" height="18.4" rx="1" fill="#0b0d12"/>`;
    const disp = `
      <g class="m-disp">
        <g class="d-heat">
          <text x="40" y="53.4" text-anchor="middle" font-size="10" font-weight="600" fill="#fff">18.0°</text>
          <rect x="23" y="56.4" width="34" height="2.4" rx="1.2" fill="${MINI_ORG}" opacity=".26"/>
          <rect x="23" y="56.4" width="8.5" height="2.4" rx="1.2" fill="${MINI_ORG}"/>
        </g>
        <g class="d-ready">
          ${curveSeries(19, 46, 58.8, 44.4, 1.3, false)}
          <text x="61" y="49" text-anchor="end" font-size="7" font-weight="600" fill="#fff">93.0°</text>
          <text x="61" y="53.6" text-anchor="end" font-size="3.2" font-weight="600" fill="${MINI_PRES}">READY</text>
          <text x="61" y="58.4" text-anchor="end" font-size="3" fill="#8a9099">last shot</text>
        </g>
        <g class="d-brew">
          ${curveSeries(19, 46, 58.8, 43.8, 1.5)}
          <text x="61" y="48.4" text-anchor="end" font-size="6.4" font-weight="600" fill="#fff">8.4</text>
          <text x="61" y="51.6" text-anchor="end" font-size="3" fill="${MINI_PRES}">bar</text>
          <text class="sc-g" x="61" y="56.4" text-anchor="end" font-size="5.4" font-weight="600" fill="${MINI_WGT}">0.0 g</text>
          <text class="sc-t" x="61" y="59.8" text-anchor="end" font-size="3.4" font-weight="600" fill="${MINI_ORG}">0:00</text>
        </g>
        <g class="d-steam">
          <text x="40" y="53.4" text-anchor="middle" font-size="10" font-weight="600" fill="#fff">145°</text>
          <rect x="31" y="56.2" width="18" height="3.6" rx="1.3" fill="${MINI_FLOW}"/>
          <text x="40" y="59" text-anchor="middle" font-size="2.8" font-weight="600" fill="#0b0d12">STEAM</text>
        </g>
      </g>`;
    return { panel, disp };
}

// GaggiMate: round puck on top, standing in a chrome housing so it reads
// against a dark background (a dark puck on a dark body would vanish).
// The housing extends above y=0, hence machineIconAnimatedSvg's taller
// viewBox for this kind.
function gaggimatePanelAndDisplay() {
    const cx = 41.0;
    const cy = -7.0;
    const panel = `
      <rect x="35.2" y="-3" width="11.6" height="9" rx="1.8" fill="#b4b9c0"/>
      <rect x="36.6" y="-3" width="3" height="9" fill="#fff" opacity=".35"/>
      <circle cx="${cx}" cy="${cy}" r="14" fill="#cfd4d9"/>
      <circle cx="${cx}" cy="${cy}" r="14" fill="none" stroke="#8f959d" stroke-width=".9"/>
      <path d="M${r(cx - 9.9)} ${r(cy - 9.9)} A14 14 0 0 1 ${r(cx + 4)} ${r(cy - 13.4)}" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" opacity=".65"/>
      <circle cx="${cx}" cy="${cy}" r="11.4" fill="#17171b"/>
      <circle cx="${cx}" cy="${cy}" r="10.2" fill="#0b0d12"/>
      <path d="M${r(cx - 7.6)} ${r(cy - 7.6)} A10.7 10.7 0 0 1 ${r(cx + 7.6)} ${r(cy - 7.6)}" fill="none" stroke="${MINI_TEMP}" stroke-width="1.3" stroke-linecap="round" opacity=".9"/>
      <path d="M${r(cx + 1.6)} ${r(cy - 10.6)} A10.7 10.7 0 0 1 ${r(cx + 7.6)} ${r(cy - 7.6)}" fill="none" stroke="${MINI_PRES}" stroke-width="1.3" stroke-linecap="round"/>`;
    const disp = `
      <g class="m-disp">
        <g class="d-heat">
          <text x="${cx}" y="${r(cy + 2.6)}" text-anchor="middle" font-size="7.4" font-weight="600" fill="#fff">18.0°</text>
          <path d="M${r(cx - 7)} ${r(cy + 6.6)} h14" stroke="${MINI_ORG}" stroke-width="1.8" stroke-linecap="round" opacity=".28"/>
          <path d="M${r(cx - 7)} ${r(cy + 6.6)} h3.5" stroke="${MINI_ORG}" stroke-width="1.8" stroke-linecap="round"/>
        </g>
        <g class="d-ready">
          ${curveSeries(r(cx - 8), r(cx + 8), r(cy + 7.4), r(cy - 3.4), 1.1, false)}
          <text x="${cx}" y="${r(cy + 9.6)}" text-anchor="middle" font-size="3.4" font-weight="600" fill="#fff">93.0° READY</text>
        </g>
        <g class="d-brew">
          ${curveSeries(r(cx - 8.4), r(cx + 8.4), r(cy + 6.4), r(cy - 6), 1.2)}
          <text class="sc-m" x="${cx}" y="${r(cy + 9.8)}" text-anchor="middle" font-size="3.4" font-weight="600" fill="${MINI_ORG}">8.4 bar · 0.0 g</text>
        </g>
        <g class="d-steam">
          <text x="${cx}" y="${r(cy + 2.6)}" text-anchor="middle" font-size="7.4" font-weight="600" fill="#fff">145°</text>
          <text x="${cx}" y="${r(cy + 8.4)}" text-anchor="middle" font-size="3.4" font-weight="600" fill="${MINI_FLOW}">STEAM</text>
        </g>
      </g>`;
    return { panel, disp };
}

// Static (non-animated) icon (#822) — Settings → Machines (list rows, topbar
// switcher, add/edit preview). Reuses the exact #811 body/panel geometry
// (animBody() + gaggiuinoPanelAndDisplay()/gaggimatePanelAndDisplay()) so
// Gaggiuino and GaggiMate machines are visually distinguishable here too,
// which the old single-body machineBody()/machineIconMarkup() (removed in
// #822) could never do — but deliberately without any of the live-state
// machinery machineIconAnimatedSvg() adds on top of that same geometry:
//   - only one body layer (the machine's own gradient), not the
//     cold-body-plus-clipped-hot-body pair `--heat` animates between
//   - only `panel` (the physical display bezel/puck shell), never `disp`
//     (the `.m-disp` state readouts) — those groups have no default opacity
//     of their own, only CSS rules scoped under `.machine-icon-live`, so
//     rendering them without that wrapper class would stack every state's
//     text on top of every other state's rather than show one plausible
//     idle look
//   - no lamps/cup/jug/steam/pour groups — Live-view-only extras that were
//     never part of the pre-#811 static icon either
function machineIconStaticMarkup(theme, kind, mini) {
    const mate = kind === 'gaggimate';
    const id = nextGradientId();
    const { a, b } = stopsFor(theme);
    const vb = mate ? '0 -21 100 183' : '0 0 100 162';
    const { panel } = mate ? gaggimatePanelAndDisplay() : gaggiuinoPanelAndDisplay();
    return `
    <svg viewBox="${vb}" fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="${id}" x1="6" y1="0" x2="92" y2="145" gradientUnits="userSpaceOnUse">
          <stop offset="0" stop-color="${a}"/>
          <stop offset="1" stop-color="${b}"/>
        </linearGradient>
        <linearGradient id="${id}-steel" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#c8ccd2"/>
          <stop offset="1" stop-color="#8f959d"/>
        </linearGradient>
      </defs>
      ${animBody(id, `${id}-steel`, mini)}
      ${panel}
    </svg>`;
}

// Detail variant — full geometry, for anywhere the icon renders at a
// reasonable size (machine form, larger list rows). `kind` is
// 'gaggiuino' (default) or 'gaggimate', same convention as
// machineIconAnimatedSvg(theme, kind) below.
export function machineIconSvg(theme, kind = 'gaggiuino') {
    return machineIconStaticMarkup(theme, kind, false);
}

// Mini variant — drops sub-2px detail (button highlights, drip tray ribs;
// see animBody()'s `mini` param). Use at <=24px.
export function machineIconMiniSvg(theme, kind = 'gaggiuino') {
    return machineIconStaticMarkup(theme, kind, true);
}

let _animInstanceCounter = 0;
// Independent counter/prefix from nextGradientId() above — different
// namespace, so there's no chance of an animated-icon id colliding with a
// static-icon id even if both render on the same page (e.g. a settings
// preview open next to a live dashboard tile).
function nextAnimId() {
    _animInstanceCounter += 1;
    return `glp-mi-${_animInstanceCounter}`;
}

// Wrapper class every state rule in style.css is scoped under
// (`.machine-icon-live.is-heating .d-heat`, etc.) — short class names like
// `.is-hot` would otherwise be free to collide with an unrelated `.is-*`
// state class anywhere else in the app (PLAN.md section 7's id/class
// collision lesson).
export const MACHINE_ICON_LIVE_CLASS = 'machine-icon-live';

// The five states from the spec compose into four states a real machine
// visits (an "on but neither heating nor hot" machine doesn't occur — it's
// always heating right after power-on) plus fully off. Mirrors
// build-prototype.py's interactive-demo MODES table.
export const MACHINE_ICON_MODES = Object.freeze({
    off:      Object.freeze([]),
    heating:  Object.freeze(['is-on', 'is-heating']),
    hot:      Object.freeze(['is-on', 'is-hot']),
    brewing:  Object.freeze(['is-on', 'is-hot', 'is-brewing']),
    steaming: Object.freeze(['is-on', 'is-hot', 'is-steaming']),
});

/**
 * Renders the animated icon's inner <svg> markup for one machine. Caller
 * owns the wrapper element (class MACHINE_ICON_LIVE_CLASS, one instance
 * per machine so the two machine types documented in the PLAN can render
 * side by side without id collisions — every gradient/clipPath id here is
 * suffixed per call, same convention as machineIconSvg() above) and drives
 * its state with setMachineIconMode()/updateMachineIconBrewReadout():
 *
 *   const el = document.createElement('div');
 *   el.className = MACHINE_ICON_LIVE_CLASS;
 *   el.innerHTML = machineIconAnimatedSvg(machine.theme, machine.type);
 *   setMachineIconMode(el, 'hot');
 */
export function machineIconAnimatedSvg(theme, kind = 'gaggiuino') {
    const mate = kind === 'gaggimate';
    const idBase = nextAnimId();
    const { a, b } = stopsFor(theme);
    const coldGradId = `${idBase}-c`;
    const hotGradId  = `${idBase}-a`;
    const steelId    = `${idBase}-steel`;
    const heatClipId = `${idBase}-heatclip`;
    const cupClipId  = `${idBase}-cupclip`;
    const jugClipId  = `${idBase}-jugclip`;

    const vb = mate ? '0 -21 100 183' : '0 0 100 162';
    const { panel, disp } = mate ? gaggimatePanelAndDisplay() : gaggiuinoPanelAndDisplay();

    return `
    <svg viewBox="${vb}" class="m-svg" aria-hidden="true">
      <defs>
        <linearGradient id="${hotGradId}" x1="6" y1="0" x2="92" y2="145" gradientUnits="userSpaceOnUse">
          <stop offset="0" stop-color="${a}"/>
          <stop offset="1" stop-color="${b}"/>
        </linearGradient>
        <linearGradient id="${coldGradId}" x1="6" y1="0" x2="92" y2="145" gradientUnits="userSpaceOnUse">
          <stop offset="0" stop-color="#6a6f74"/>
          <stop offset="1" stop-color="#4a4e53"/>
        </linearGradient>
        <linearGradient id="${steelId}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#c8ccd2"/>
          <stop offset="1" stop-color="#8f959d"/>
        </linearGradient>
        <clipPath id="${heatClipId}">
          <rect class="heat-rect" x="0" y="2" width="100" height="70"/>
          <rect class="heat-base" x="0" y="72" width="100" height="90"/>
        </clipPath>
        <clipPath id="${cupClipId}"><rect class="cup-rect" x="43" y="107" width="16" height="19"/></clipPath>
        <clipPath id="${jugClipId}"><rect class="jug-rect" x="71" y="106" width="18" height="19"/></clipPath>
      </defs>
      ${animBody(coldGradId, steelId)}
      <g class="hot" clip-path="url(#${heatClipId})">${animBody(hotGradId, steelId)}</g>
      ${panel}
      ${disp}
      <rect class="lamp lamp-pwr" x="26" y="31.4" width="3.4" height="2.6" rx=".9" fill="#e8452a"/>
      <rect class="lamp lamp-tmp" x="39.5" y="31.4" width="3.4" height="2.6" rx=".9" fill="#e8452a"/>
      <rect class="lamp lamp-stm" x="53" y="31.4" width="3.4" height="2.6" rx=".9" fill="#e8452a"/>
      <g class="m-cup">
        <ellipse cx="50" cy="131.4" rx="19" ry="3" fill="#000" opacity=".38"/>
        <path d="M34 127.5 L66 127.5 L66 131 L34 131 Z" fill="#101014"/>
        <path d="M40 122 L72 122 L66 127.5 L34 127.5 Z" fill="#1e1e23"/>
        <path d="M40 122 L72 122 L70.8 123.1 L38.8 123.1 Z" fill="#fff" opacity=".1"/>
        <path d="M34 127.5 L66 127.5 L66 128.2 L34 128.2 Z" fill="#fff" opacity=".08"/>
        <rect x="35.6" y="124.4" width="9.2" height="2.8" rx=".7" fill="#08080a"/>
        <text class="sc-w" x="40.2" y="126.6" text-anchor="middle" font-size="2.4" font-weight="600" fill="#dfe4e8">0.0</text>
        <rect x="55.4" y="124.4" width="9.2" height="2.8" rx=".7" fill="#08080a"/>
        <text class="sc-t" x="60" y="126.6" text-anchor="middle" font-size="2.4" font-weight="600" fill="#dfe4e8">0:00</text>
        <ellipse cx="51" cy="124.9" rx="7.2" ry="1.3" fill="#000" opacity=".4"/>
        <path d="${CUP_PATH}" fill="#e6e1d6"/>
        <g clip-path="url(#${cupClipId})">
          <path d="${CUP_PATH}" fill="#5a3418"/>
          <rect class="crema" x="43" y="109.5" width="16" height="7" fill="#b07a41"/>
        </g>
        <path d="M58.6 111.5 A4.2 4.2 0 0 1 58.2 120" stroke="#e6e1d6" stroke-width="1.7" fill="none" stroke-linecap="round"/>
        <path d="M45.6 109.4 L46.6 122.6" stroke="#fff" stroke-width=".9" opacity=".5" stroke-linecap="round"/>
      </g>
      <g class="m-jug">
        <path d="M84 99.8 L92.4 95.2 L90.4 102.4 L83.6 104 Z" fill="#aeb4bb"/>
        <path d="M84 99.8 L92.4 95.2 L89 99 L83.8 101.2 Z" fill="#e4e8ec"/>
        <path d="${JUG_PATH}" fill="#9aa0a8"/>
        <path d="${FOOT_PATH}" fill="#7f858d"/>
        <path d="M67 100.8 L70.8 100.8 L69.8 124 L66.2 124 Z" fill="#fff" opacity=".42"/>
        <path d="M72.6 100.8 L74.3 100.8 L73.7 124 L72 124 Z" fill="#fff" opacity=".2"/>
        <path d="M78.2 100.8 L81.6 100.8 L80.2 124 L77.2 124 Z" fill="#3d434a" opacity=".45"/>
        <path d="M64.8 125.6 H82.5 L82.3 127.4 H65 Z" fill="#000" opacity=".3"/>
        <ellipse cx="73.6" cy="100.4" rx="10.9" ry="3.5" fill="#c2c8ce"/>
        <ellipse cx="73.6" cy="100.8" rx="9.4" ry="2.7" fill="#5f666e"/>
        <ellipse class="milk-top" cx="73.6" cy="101.4" rx="8.7" ry="2.3" fill="#f7f5f0"/>
        <g class="swirl-wrap"><g class="swirl">
          <path d="M-7 0 A7 7 0 0 1 3.2 -6.2" fill="none" stroke="#ddd6c8" stroke-width="1.7" stroke-linecap="round"/>
          <path d="M7 0 A7 7 0 0 1 -3.2 6.2" fill="none" stroke="#ddd6c8" stroke-width="1.7" stroke-linecap="round"/>
          <path d="M-3.7 0 A3.7 3.7 0 0 1 1.7 -3.3" fill="none" stroke="#cfc6b4" stroke-width="1.4" stroke-linecap="round"/>
        </g></g>
        <path d="M62.7 100.4 A10.9 3.5 0 0 0 84.5 100.4" fill="none" stroke="#e8ecef" stroke-width="1.4"/>
        <path d="M62.9 104 H54.4 V114.6 H58.2 V119.4 H64 " fill="none" stroke="#c2c8ce" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round"/>
        <path d="M55.8 105.4 V113.2" stroke="#fff" stroke-width=".8" opacity=".6" stroke-linecap="round"/>
      </g>
      <g class="m-steam">
        <path d="M81.6 97 C78.6 90 84.6 86 81.6 79" stroke="#cfd4d9" stroke-width="2.4" fill="none" stroke-linecap="round" opacity=".75"/>
        <path d="M86.4 99 C83.9 93 88.4 89 86.4 83" stroke="#cfd4d9" stroke-width="2" fill="none" stroke-linecap="round" opacity=".55" style="animation-delay:.5s"/>
        <path d="M84 96 C81.5 89 86 85 84 78" stroke="#cfd4d9" stroke-width="1.7" fill="none" stroke-linecap="round" opacity=".45" style="animation-delay:.9s"/>
      </g>
      <g class="m-pour">
        <path d="M44.8 86.9 C46.4 90.4 48.6 92.6 49.3 94.6 L50.7 94.6 C51.4 92.6 53.6 90.4 55.2 86.9 Z" fill="#6b3d1c" opacity=".92"/>
        <path d="M46.6 87 C47.8 90 49.2 92 49.7 94 L50.3 94 C50.8 92 52.2 90 53.4 87 Z" fill="#a9713f" opacity=".55"/>
        <path d="M50 94.4 C50 99 50.2 104 50.1 111" stroke="#7a4a22" stroke-width="1.7" stroke-linecap="round" fill="none"/>
        <path d="M50 94.4 C50 99 50.2 104 50.1 111" stroke="#a9713f" stroke-width=".7" stroke-linecap="round" fill="none" opacity=".8"/>
      </g>
    </svg>`;
}

// Applies one of MACHINE_ICON_MODES to the wrapper element (see
// machineIconAnimatedSvg's doc comment). `heatFraction` (0..1) only matters
// in 'heating' mode, driving the --heat custom property that .heat-rect's
// clip reads (style.css); the other modes have a fixed heat level — 0 when
// off, 1 once hot/brewing/steaming (heating up is the only state where the
// body fills gradually rather than snapping to full/empty).
export function setMachineIconMode(rootEl, mode, heatFraction = 0) {
    const classes = MACHINE_ICON_MODES[mode];
    if (!classes) throw new Error(`machine-icon: unknown mode "${mode}"`);
    // Only touch the classes this function owns. Assigning className wholesale
    // silently dropped whatever the caller had put there for layout — the Live
    // view's own `idle-icon` positioning class disappeared on the first state
    // change, which is invisible until you notice the icon has moved.
    rootEl.classList.add(MACHINE_ICON_LIVE_CLASS);
    for (const list of Object.values(MACHINE_ICON_MODES)) rootEl.classList.remove(...list);
    if (classes.length) rootEl.classList.add(...classes);
    const svg = rootEl.querySelector('.m-svg');
    if (!svg) return;
    const heat = mode === 'off' ? 0 : mode === 'heating' ? Math.max(0, Math.min(1, heatFraction)) : 1;
    svg.style.setProperty('--heat', String(heat));
}

// Maps what the backend actually reports onto one of MACHINE_ICON_MODES.
// Pure -- same {mode, heatFraction} for the same (msg, preheat) pair, no
// DOM/state access -- so every caller that drives an animated icon instance
// shares one translation instead of copy-pasting it: views/live.js's own
// #liveMachineIcon and the topbar's always-visible ambient widget
// (components/topbar-machine-icon.js, #837) both call this, then hand the
// result straight to setMachineIconMode().
//
// NOTE ON STEAM: there is deliberately no 'steaming' case. Nothing in the
// poll payload distinguishes steaming from heating — lib/machine-state.js
// derives isBrewing from brewSwitchState and carries no steam-switch
// equivalent — and showing a steam state on a guess would be worse than not
// showing it, since it would be wrong exactly when the user is watching.
// The icon supports the state; wiring it needs a signal that does not exist
// yet.
export function resolveMachineIconState(msg, preheat) {
    if (msg?.machineReachable === false) return { mode: 'off', heatFraction: 0 };
    if (msg?.isLive)                     return { mode: 'brewing', heatFraction: 1 };
    if (preheat && !preheat.ready && preheat.remaining > 0) {
        return { mode: 'heating', heatFraction: Math.max(0, Math.min(1, preheat.pct || 0)) };
    }
    return { mode: 'hot', heatFraction: 1 };
}

function formatBrewTime(sec) {
    const whole = Math.max(0, Math.floor(sec));
    return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

// Live brew readout — the scale's own weight/time digits and the display's
// bar/g summary line (.sc-w/.sc-t/.sc-g/.sc-m in the markup above). Takes
// real telemetry; there's no artificial "weight lags time" lag to
// reproduce here the way the prototype's demo timer simulated one — that's
// simply how the real weight sensor behaves against the real clock.
export function updateMachineIconBrewReadout(rootEl, { weightG = 0, elapsedSec = 0, pressureBar = null } = {}) {
    const w = weightG.toFixed(1);
    const time = formatBrewTime(elapsedSec);
    rootEl.querySelectorAll('.sc-w').forEach(el => { el.textContent = w; });
    rootEl.querySelectorAll('.sc-t').forEach(el => { el.textContent = time; });
    rootEl.querySelectorAll('.sc-g').forEach(el => { el.textContent = `${w} g`; });
    if (pressureBar != null) {
        const bar = pressureBar.toFixed(1);
        rootEl.querySelectorAll('.sc-m').forEach(el => { el.textContent = `${bar} bar · ${w} g`; });
    }
}
