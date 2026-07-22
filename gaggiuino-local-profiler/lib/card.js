'use strict';

const fs   = require('fs');
const path = require('path');
const { COFFEE_COUNTRY_CODES } = require('./coffee-countries');
const { imagePath } = require('./services/ImageService');

let createCanvas = null;
let GlobalFonts  = null;
let loadImage    = null;

// Cache the GLP logo once loaded
let _glpIconPromise = null;
function getGlpIcon() {
    if (!loadImage) return Promise.resolve(null);
    if (!_glpIconPromise) {
        const iconPath = path.join(__dirname, '..', 'icon.png');
        _glpIconPromise = fs.existsSync(iconPath)
            ? loadImage(fs.readFileSync(iconPath)).catch(() => null)
            : Promise.resolve(null);
    }
    return _glpIconPromise;
}

// Loads the shot's uploaded photo (if any), same defensive pattern as
// getGlpIcon() — a missing/corrupt file must never break card generation.
// Not cached (unlike the logo) since it varies per shot.
function getShotPhoto(shot) {
    if (!loadImage || !shot?.id || !shot?.image) return Promise.resolve(null);
    const photoPath = imagePath(shot.id, shot.image, 'shot-');
    return fs.existsSync(photoPath)
        ? loadImage(fs.readFileSync(photoPath)).catch(() => null)
        : Promise.resolve(null);
}

try {
    ({ createCanvas, GlobalFonts, loadImage } = require('@napi-rs/canvas'));
    const FONT_CANDIDATES = [
        '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
        '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
        '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
        '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
        '/usr/share/fonts/TTF/DejaVuSans.ttf',
        '/usr/share/fonts/TTF/DejaVuSans-Bold.ttf',
    ];
    for (const fp of FONT_CANDIDATES) {
        if (fs.existsSync(fp)) GlobalFonts.registerFromPath(fp);
    }
    // #404: bundled locally (same file the frontend's @font-face uses, see
    // public-src/style.css) — the share card's bean-name headline is the
    // only place on the card that gets the serif treatment.
    const serifFontPath = path.join(__dirname, '..', 'public-src', 'fonts', 'fraunces-600-latin.woff2');
    if (fs.existsSync(serifFontPath) && GlobalFonts.registerFromPath(serifFontPath, 'Fraunces')) {
        globalThis._glpCardSerifFont = 'Fraunces';
    }
    let families = [];
    if (GlobalFonts.getFamilies) {
        try {
            const raw = GlobalFonts.getFamilies();
            const parsed = JSON.parse(Buffer.isBuffer(raw) ? raw.toString() : JSON.stringify(raw));
            families = Array.isArray(parsed) ? parsed.map(f => f.family || f) : [];
        } catch { /* ignore */ }
    }
    globalThis._glpCardFont = families.includes('Liberation Sans') ? 'Liberation Sans'
        : families.includes('DejaVu Sans') ? 'DejaVu Sans'
        : 'sans-serif';
} catch {
    createCanvas = null;
}

// Card color palette — mirrors the app's own CSS tokens (public-src/style.css
// :root, [data-accent=...], [data-theme="light"]) so the shared card looks
// like the theme the user was actually looking at, not an invented separate
// brand. #462.
//
// Legacy default snapshot — kept byte-for-byte as it always was (including
// the pre-#397 --gray-500 value, since raised to #9a9aa3 in the live CSS) so
// old cached/bookmarked card links (generated before the frontend started
// passing accent/theme) keep looking exactly the way they always did.
const LEGACY_GLP = {
    bg:        '#09090b',   // --gray-950
    bgCard:    '#18181b',   // --gray-900
    bgChart:   '#27272a',   // --gray-800
    text:      '#e4e4e7',   // --gray-200
    textDim:   '#a1a1aa',   // --gray-400
    textMute:  '#71717a',   // --gray-500 (pre-#397)
    border:    '#3f3f46',   // --gray-700
    borderDim: '#27272a',   // --gray-800
    cPressure: '#3498db', cFlow: '#f39c12', cWeightFlow: '#9b59b6', cWeight: '#2ecc71', cTemp: '#e74c3c',
    accentFrom: '#f59e0b', accentTo: '#f97316',
    accentTint: 'rgba(245,158,11,',  // e.g. GLP.accentTint + '0.12)' for chip backgrounds
    star: '#f59e0b', starDim: '#3f3f46',
};

// Gray scales, keyed by theme (and by accent for crema, the only theme that
// also warms the neutral scale — public-src/style.css [data-accent="crema"]
// / [data-theme="light"][data-accent="crema"]).
const GRAY_SCALES = {
    dark:        { 200: '#e4e4e7', 400: '#a1a1aa', 500: '#9a9aa3', 700: '#3f3f46', 800: '#27272a', 900: '#18181b', 950: '#09090b' },
    'dark-crema':  { 200: '#f2e6d8', 400: '#c9b8a4', 500: '#b0a08d', 700: '#4e3a2b', 800: '#2e2118', 900: '#1e1611', 950: '#14100c' },
    light:       { 200: '#18181b', 400: '#3f3f46', 500: '#52525b', 700: '#d4d4d8', 800: '#f4f4f5', 900: '#fafafa', 950: '#ffffff' },
    'light-crema': { 200: '#2a1b0f', 400: '#55442f', 500: '#5f4c38', 700: '#d4b48c', 800: '#ead5b5', 900: '#f3e4ce', 950: '#fbf3e7' },
};

// accent-from/accent-to per accent + theme (public-src/style.css
// [data-accent=...] and [data-theme="light"][data-accent=...] blocks) — only
// amber and crema define a light-specific override, the other four accents
// keep the same gradient in both themes.
const ACCENTS = {
    amber:  { dark: ['#f59e0b', '#f97316'], light: ['#d97706', '#ea580c'] },
    ocean:  { dark: ['#3b82f6', '#06b6d4'], light: ['#3b82f6', '#06b6d4'] },
    aurora: { dark: ['#6366f1', '#a855f7'], light: ['#6366f1', '#a855f7'] },
    ember:  { dark: ['#ef4444', '#f97316'], light: ['#ef4444', '#f97316'] },
    forest: { dark: ['#22c55e', '#10b981'], light: ['#22c55e', '#10b981'] },
    crema:  { dark: ['#d4a24c', '#b8823a'], light: ['#8b5e34', '#6b3f1d'] },
};

function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
}

// Builds the card's color palette for a given accent/theme pair. No
// arguments at all reproduces the historic hardcoded snapshot exactly (see
// LEGACY_GLP above); any explicit accent/theme (including 'amber'/'dark',
// what the frontend now always sends) computes fresh from the current CSS
// tokens instead.
function buildPalette(accent, theme) {
    if (!accent && !theme) return { ...LEGACY_GLP };
    const a  = ACCENTS[accent] ? accent : 'amber';
    const th = theme === 'light' ? 'light' : 'dark';
    const gray = GRAY_SCALES[a === 'crema' ? `${th}-crema` : th];
    const [accentFrom, accentTo] = ACCENTS[a][th];
    return {
        bg: gray[950], bgCard: gray[900], bgChart: gray[800],
        text: gray[200], textDim: gray[400], textMute: gray[500],
        border: gray[700], borderDim: gray[800],
        // Chart series colors are fixed across all themes/accents in the
        // live app too (public-src/views/shots/index.js dataset borderColor
        // values) — not derived from the accent.
        cPressure: '#3498db', cFlow: '#f39c12', cWeightFlow: '#9b59b6', cWeight: '#2ecc71', cTemp: '#e74c3c',
        accentFrom, accentTo,
        accentTint: `rgba(${hexToRgb(accentFrom)},`,
        star: accentFrom, starDim: gray[700],
    };
}

const W = 1080, H = 1080, PX = 52;

function F(size, bold = false) {
    const fam = globalThis._glpCardFont || 'sans-serif';
    return `${bold ? 'bold ' : ''}${size}px ${fam}`;
}

// #404: serif variant for the card's bean-name headline only — every other
// text on the card (scores, chips, chart labels, the footer) stays on F()'s
// sans-serif family. Falls back to F() itself when the bundled font failed
// to register (e.g. file missing), so a share card never errors over a font.
function Fs(size, bold = false) {
    const fam = globalThis._glpCardSerifFont;
    return fam ? `${bold ? 'bold ' : ''}${size}px ${fam}` : F(size, bold);
}

function scoreColor(s, GLP) {
    if (s == null) return GLP.textMute;
    if (s >= 80)   return GLP.accentFrom;
    if (s >= 60)   return GLP.textDim;
    return GLP.textMute;
}

// score >= 90 → outstanding, >= 80 → nailed it, >= 60 → solid, else → still
// dialing in. Returns null when there's no score to react to (test/empty shots).
function scoreTierPhrase(score) {
    if (score == null) return null;
    if (score >= 90) return 'Herausragender Shot';
    if (score >= 80) return 'Richtig gut getroffen';
    if (score >= 60) return 'Solider Shot';
    return 'Dial-in lohnt sich noch';
}

function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
}

// Looks up a bean's first resolvable coffee-growing-country code by exact
// (case-insensitive) name match against the library, the same matching
// convention buildWorldMap() uses in public-src/views/analytics.js. `library`
// is injected so this stays testable without requiring the live DB-backed
// LibraryService.
function resolveBeanOriginCode(coffeeName, library) {
    if (!coffeeName || !library) return null;
    const name = String(coffeeName).trim().toLowerCase();
    if (!name) return null;
    const bean = (library.beans || []).find(b => String(b.name || '').toLowerCase() === name);
    if (!bean) return null;
    const origins = Array.isArray(bean.origins) && bean.origins.length
        ? bean.origins
        : (bean.origin ? [{ code: bean.origin }] : []);
    const code = origins[0]?.code;
    return code && COFFEE_COUNTRY_CODES.includes(code) ? code : null;
}

// Points of a standard 5-point star, alternating outer/inner radius, starting
// at the top and going clockwise. Pure geometry so the shape can be verified
// without a canvas.
function starPoints(cx, cy, outerR, innerR = outerR * 0.42, spikes = 5) {
    const pts  = [];
    const step = Math.PI / spikes;
    let rot = -Math.PI / 2;
    pts.push({ x: cx + Math.cos(rot) * outerR, y: cy + Math.sin(rot) * outerR });
    for (let i = 0; i < spikes; i++) {
        rot += step;
        pts.push({ x: cx + Math.cos(rot) * innerR, y: cy + Math.sin(rot) * innerR });
        rot += step;
        pts.push({ x: cx + Math.cos(rot) * outerR, y: cy + Math.sin(rot) * outerR });
    }
    return pts;
}

function drawStar(ctx, cx, cy, r, filled, color, dimColor) {
    const pts = starPoints(cx, cy, r);
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.fillStyle = filled ? color : dimColor;
    ctx.fill();
}

function avg(arr) {
    if (!arr || !arr.length) return null;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function fmtDurSec(s) {
    const sec = Math.round(s);
    return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
}

function fmtDur(ds) {
    if (!ds) return null;
    const s = Math.round(ds / 10);
    const m = Math.floor(s / 60);
    const r = s % 60;
    return m > 0 ? `${m}:${String(r).padStart(2, '0')}` : `${s}s`;
}

function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
}

// Draw a polyline from a value array onto the chart canvas coordinate system
// yScale: function(val) → canvas Y
// xScale: function(index) → canvas X
function polyline(ctx, vals, xScale, yScale) {
    if (!vals || vals.length < 2) return false;
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < vals.length; i++) {
        if (vals[i] == null || isNaN(vals[i])) continue;
        const px = xScale(i);
        const py = yScale(vals[i]);
        if (!started) { ctx.moveTo(px, py); started = true; }
        else           ctx.lineTo(px, py);
    }
    return started;
}

function detectPreinfusionEnd(pressure) {
    if (!pressure || pressure.length < 10) return null;
    for (let i = 5; i < pressure.length - 5; i++) {
        if (pressure[i] >= 5.0 && pressure[i + 1] >= 5.0 && pressure[i + 2] >= 5.0)
            return i;
    }
    return null;
}

async function generateShareCard(shot, score, format = 'square', accent, theme) {
    if (!createCanvas) throw new Error('canvas module not available');
    const GLP        = buildPalette(accent, theme);
    const glpIcon    = await getGlpIcon();
    const shotPhoto  = await getShotPhoto(shot);
    // Lazily required: LibraryService touches the DB at require-time in some
    // environments, and card generation shouldn't depend on that succeeding.
    let library = null;
    try { library = require('./services/LibraryService').getLibrary(); } catch { library = null; }

    const W = 1080;
    const H = format === 'story' ? 1920 : 1080;
    const SCALE = format === 'story' ? 1.78 : 1;   // vertical scale factor

    const canvas = createCanvas(W, H);
    const ctx    = canvas.getContext('2d');

    // ── Data ───────────────────────────────────────────────────────────────
    const dp  = shot.datapoints || {};
    const ann = shot.annotation || {};

    const pressure    = (dp.pressure          || []).map(v => v / 10);
    const flow        = (dp.pumpFlow          || []).map(v => v / 10);
    const weightFlow  = (dp.weightFlow        || []).map(v => v / 10);
    const weight      = (dp.shotWeight ?? dp.weight ? (dp.shotWeight || dp.weight).map(v => v / 10) : []);
    const temp        = (dp.temperature       || []).map(v => v / 10);
    const tgtPress    = (dp.targetPressure    || []).map(v => v / 10);
    const tgtFlow     = (dp.targetFlow        || []).map(v => v / 10);
    const tgtTemp     = (dp.targetTemperature || []).map(v => v / 10);
    const timesRaw    = (dp.timeInShot        || []).map(v => v / 10);   // → seconds

    const nPts     = Math.max(pressure.length, flow.length, temp.length, 1);
    const totalSec = shot.duration ? shot.duration / 10 : (timesRaw.length ? timesRaw[timesRaw.length - 1] : 30);
    const times    = timesRaw.length === nPts
        ? timesRaw
        : Array.from({ length: nPts }, (_, i) => (i / (nPts - 1)) * totalSec);

    const profileName = shot.profile?.name || shot.profile_name || shot.profileName || 'Unknown';
    const bean        = ann.coffee  || '';
    const dose        = ann.dose   != null ? +(+ann.dose).toFixed(1)  : null;
    const wt          = ann.totalWeight ?? ann.yield
        ?? (weight.length ? weight[weight.length - 1] : null);
    const yieldG      = wt != null ? +(+wt).toFixed(1) : null;
    const ratio       = dose && yieldG ? `1:${(yieldG / dose).toFixed(1)}` : null;
    const dur         = fmtDur(shot.duration);
    const avgPres     = pressure.length   ? +(avg(pressure.filter(v => v > 1.5))).toFixed(1)   : null;
    const maxPres     = pressure.length   ? +(Math.max(...pressure.filter(v => v > 0))).toFixed(1) : null;
    const avgTemp     = temp.length       ? +(avg(temp.filter(v => v > 50))).toFixed(1)        : null;
    const finalWeight = weight.length     ? +(weight[weight.length - 1]).toFixed(1)            : null;
    const avgFlow     = flow.length       ? +(avg(flow.filter(v => v > 0.3))).toFixed(1)       : null;
    // weightFlow is all-zero for GaggiMate shots (#388 — no scale-derived flow
    // available), so the >0.2/>0 filters below can legitimately empty out;
    // guard against Math.max(...[]) (-Infinity) and avg([]) (null) instead of
    // letting +(-Infinity/null).toFixed(1) throw.
    const wfAboveNoise = weightFlow.filter(v => v > 0.2);
    const wfPositive   = weightFlow.filter(v => v > 0);
    const avgWF        = wfAboveNoise.length ? +(avg(wfAboveNoise)).toFixed(1) : null;
    const maxWF        = wfPositive.length   ? +(Math.max(...wfPositive)).toFixed(1) : null;
    const machine     = ann.machine || shot.machine || '';
    const rating      = ann.rating != null ? Math.round(ann.rating) : null;
    const originCode  = resolveBeanOriginCode(bean, library);

    const tgtPressVal = tgtPress.length ? +(tgtPress.filter(v => v > 0).slice(-1)[0] ?? 0).toFixed(1) : null;
    const tgtFlowVal  = tgtFlow.length  ? +(tgtFlow.filter(v => v > 0).slice(-1)[0] ?? 0).toFixed(1)  : null;
    const tgtTempVal  = tgtTemp.length  ? +(tgtTemp.filter(v => v > 0).slice(-1)[0] ?? 0).toFixed(1)  : null;

    function tSD(arr) {
        if (!arr || arr.length < 2) return null;
        const m = arr.reduce((a, b) => a + b, 0) / arr.length;
        return +(Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length)).toFixed(1);
    }
    const tempSD = temp.length ? tSD(temp.filter(v => v > 50)) : null;

    const dateStr = shot.timestamp
        ? new Date(shot.timestamp * 1000).toLocaleDateString('de-DE', { day: '2-digit', month: 'short', year: 'numeric' })
        : '';
    const shotId  = shot.id ? `Shot #${shot.id}` : '';
    const sColor       = scoreColor(score, GLP);
    const preEnd       = detectPreinfusionEnd(pressure);
    const preinfEndSec = preEnd !== null && times.length > preEnd ? times[preEnd] : (preEnd !== null ? preEnd / Math.max(nPts - 1, 1) * totalSec : null);
    const extDurSec    = preinfEndSec !== null ? Math.max(0, totalSec - preinfEndSec) : null;

    // ── BACKGROUND ─────────────────────────────────────────────────────────
    ctx.fillStyle = GLP.bg;
    ctx.fillRect(0, 0, W, H);

    // ── ACCENT BAR + HEADER ────────────────────────────────────────────────
    const BAR_H = 4;
    const barGrad = ctx.createLinearGradient(0, 0, W, 0);
    barGrad.addColorStop(0, GLP.accentFrom);
    barGrad.addColorStop(1, GLP.accentTo);
    ctx.fillStyle = barGrad;
    ctx.fillRect(0, 0, W, BAR_H);

    const HH       = 76;
    const headerY  = BAR_H;
    ctx.fillStyle = GLP.bgCard;
    ctx.fillRect(0, headerY, W, HH);
    ctx.strokeStyle = GLP.border;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, headerY + HH); ctx.lineTo(W, headerY + HH); ctx.stroke();
    const headerBottom = headerY + HH;

    // GLP logo (icon.png) — or fallback to bold text
    const iconSize = Math.round(HH * 0.72);
    const iconY    = headerY + (HH - iconSize) / 2;
    if (glpIcon) {
        ctx.drawImage(glpIcon, PX, iconY, iconSize, iconSize);
    } else {
        ctx.fillStyle = GLP.text;
        ctx.font = F(44, true);
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        ctx.fillText('GLP', PX, headerY + HH / 2);
    }

    // Shot number + date top-right
    const headerRight = [shotId, dateStr].filter(Boolean).join('  ·  ');
    ctx.fillStyle = GLP.textDim;
    ctx.font = F(20);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(headerRight, W - PX, headerY + HH / 2);
    ctx.textAlign = 'left';

    // ── SCORE BADGE ────────────────────────────────────────────────────────
    const scoreR = 74;
    const scx = W - PX - 88, scy = headerBottom + 90;
    if (score != null) {
        // Background disc
        ctx.beginPath();
        ctx.arc(scx, scy, scoreR, 0, Math.PI * 2);
        ctx.fillStyle = GLP.bgCard;
        ctx.fill();
        // Ring — progress arc proportional to score/100 (linear gradient once
        // the shot is actually dialed in, flat scoreColor() otherwise), plus a
        // dim track for the remainder. No shadow/glow — the app never uses that.
        // (createConicGradient rendered near-invisible on @napi-rs/canvas —
        // stick to the linear-gradient technique proven in the approved mockup.)
        const frac = Math.max(0, Math.min(1, score / 100));
        ctx.beginPath();
        ctx.arc(scx, scy, scoreR, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
        if (score >= 80) {
            const ring = ctx.createLinearGradient(scx - scoreR, scy - scoreR, scx + scoreR, scy + scoreR);
            ring.addColorStop(0, GLP.accentFrom);
            ring.addColorStop(1, GLP.accentTo);
            ctx.strokeStyle = ring;
        } else {
            ctx.strokeStyle = sColor;
        }
        ctx.lineWidth = 5;
        ctx.lineCap = 'round';
        ctx.stroke();
        // Dim track for the remainder of the ring
        ctx.beginPath();
        ctx.arc(scx, scy, scoreR, -Math.PI / 2 + frac * Math.PI * 2, 1.5 * Math.PI);
        ctx.strokeStyle = GLP.border;
        ctx.lineWidth = 5;
        ctx.stroke();
        // Number
        ctx.fillStyle = GLP.text;
        ctx.font = F(56, true);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(score), scx, scy - 8);
        // Label
        ctx.font = F(15);
        ctx.fillStyle = GLP.textMute;
        ctx.fillText('SCORE', scx, scy + 28);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
    }

    // ── HERO: bean name, origin stamp, score-tier phrase, rating, profile ──
    const nameMaxW = W - 2 * PX - (score != null ? scoreR * 2 + 40 : 20);
    ctx.textBaseline = 'alphabetic';

    const headlineBaseline = headerBottom + 54;
    const chipCY = headlineBaseline - 16;

    // Photo "avatar" — small circular shot photo leading into the bean name,
    // present only when the shot has one (no reserved space otherwise).
    const PHOTO_D   = 60, PHOTO_R = PHOTO_D / 2;
    const photoLead = shotPhoto ? PHOTO_D + 14 : 0;
    if (shotPhoto) {
        const pcx = PX + PHOTO_R, pcy = chipCY;
        ctx.save();
        ctx.beginPath();
        ctx.arc(pcx, pcy, PHOTO_R, 0, Math.PI * 2);
        ctx.closePath();
        ctx.clip();
        ctx.drawImage(shotPhoto, pcx - PHOTO_R, pcy - PHOTO_R, PHOTO_D, PHOTO_D);
        ctx.restore();
        ctx.beginPath();
        ctx.arc(pcx, pcy, PHOTO_R, 0, Math.PI * 2);
        ctx.strokeStyle = GLP.border;
        ctx.lineWidth = 2;
        ctx.stroke();
    }

    let chipW = 0;
    if (originCode) {
        ctx.font = F(18, true);
        chipW = ctx.measureText(originCode).width + 26;
    }
    const leadW         = photoLead + (originCode ? chipW + 14 : 0);
    const headlineX     = PX + leadW;
    const headlineMaxW  = nameMaxW - leadW;

    let headline = bean || profileName;
    ctx.font = Fs(52, true);
    while (ctx.measureText(headline).width > headlineMaxW && headline.length > 4)
        headline = headline.slice(0, -4) + '…';

    if (originCode) {
        const chipH = 34;
        const chipX = PX + photoLead;
        roundRect(ctx, chipX, chipCY - chipH / 2, chipW, chipH, chipH / 2);
        ctx.fillStyle = GLP.accentTint + '0.14)';
        ctx.fill();
        ctx.strokeStyle = GLP.accentTint + '0.35)';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = GLP.accentFrom;
        ctx.font = F(18, true);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(originCode, chipX + chipW / 2, chipCY);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
    }

    ctx.fillStyle = GLP.text;
    ctx.font = Fs(52, true);
    ctx.fillText(headline, headlineX, headlineBaseline);

    let cursorY = headlineBaseline + 32;

    const phrase = scoreTierPhrase(score);
    if (phrase) {
        ctx.fillStyle = GLP.textDim;
        ctx.font = F(24);
        ctx.fillText(phrase, PX, cursorY);
        cursorY += 34;
    }

    if (rating) {
        const starR = 11, starGap = 8;
        const starsY = cursorY - 8;
        let sx = PX + starR;
        for (let i = 0; i < 5; i++) {
            drawStar(ctx, sx, starsY, starR, i < rating, GLP.star, GLP.starDim);
            sx += starR * 2 + starGap;
        }
        cursorY = starsY + starR + 24;
    }

    const secondParts = [profileName, machine].filter(Boolean);
    let subY = cursorY;
    if (secondParts.length) {
        ctx.fillStyle = GLP.textDim;
        ctx.font = F(24);
        let secondLine = secondParts.join('  ·  ');
        while (ctx.measureText(secondLine).width > nameMaxW + 140 && secondLine.length > 4)
            secondLine = secondLine.slice(0, -4) + '…';
        ctx.fillText(secondLine, PX, cursorY);
        subY = cursorY + 32;
    }

    // Dose → Yield · Ratio · Dur line
    const doseParts = [];
    if (dose)   doseParts.push(`${dose}g`);
    if (yieldG) doseParts.push(`→ ${yieldG}g`);
    if (ratio)  doseParts.push(`· ${ratio}`);
    if (dur)    doseParts.push(`· ${dur}`);

    if (doseParts.length) {
        const doseY = subY + 14;
        ctx.fillStyle = GLP.textMute;
        ctx.font = F(22);
        ctx.fillText('DOSIS', PX, doseY);
        ctx.fillStyle = GLP.text;
        ctx.font = F(22, true);
        ctx.fillText(doseParts.join('  '), PX + 78, doseY);
        subY = doseY;
    }

    // Separator — thin accent line fading right
    const sepY = subY + 20;
    const sg = ctx.createLinearGradient(PX, 0, W - PX, 0);
    sg.addColorStop(0,   GLP.accentTint + '0.5)');
    sg.addColorStop(0.6, GLP.accentTint + '0.15)');
    sg.addColorStop(1,   GLP.accentTint + '0)');
    ctx.strokeStyle = sg;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(PX, sepY); ctx.lineTo(W - PX, sepY); ctx.stroke();

    // ── CHART ──────────────────────────────────────────────────────────────
    // Chart coordinate system with margins for axes + legend
    const CHART_L  = 44;   // left margin (Y axis labels)
    const CHART_R  = 44;   // right margin (right Y axis)
    const CHART_T  = 26;   // top margin (phase label chips)
    const CHART_B  = 28;   // bottom margin (X axis)
    const LEGEND_H = 50;

    const outerX    = PX - 8;
    let outerY       = sepY + 10;
    const outerW    = W - 2 * PX + 16;
    const STATS_H   = 200;
    const FOOT_H    = 52;
    // Chart fills remaining space so the card has no empty area — except in
    // story format, where filling all the way down stretches the chart into
    // a tall, distorted shape. There it's capped near-square (like the shot
    // graph reads everywhere else in the app) and the freed vertical space is
    // split evenly above/below the chart+stats block instead of left as one
    // gap.
    const availH = H - outerY - STATS_H - 16 - FOOT_H;
    let outerH = Math.max(Math.round(240 * SCALE), availH);
    if (format === 'story') {
        const capped = Math.min(outerH, outerW);
        const freed  = Math.max(0, outerH - capped);
        outerH = capped;
        outerY += freed / 2;
    }

    const plotX  = outerX + CHART_L;
    const plotY  = outerY + CHART_T;
    const plotW  = outerW - CHART_L - CHART_R;
    const plotH  = outerH - CHART_T - CHART_B - LEGEND_H;

    // Chart card background
    roundRect(ctx, outerX, outerY, outerW, outerH, 8);
    ctx.fillStyle = GLP.bgChart;
    ctx.fill();
    ctx.strokeStyle = GLP.border;
    ctx.lineWidth = 1;
    ctx.stroke();

    // Y axis scales — pressure/flow keep a fixed 0-12 bar/(ml/s) scale on the
    // left axis. Weight and temperature share one right axis, 0..tempMaxScale
    // — same formula the live chart uses for its y1 axis (#462;
    // public-src/views/shots/index.js, tempMaxScale), just for this single
    // shot's own temperature readings instead of an A/B max.
    const LEFT_MAX     = 12;   // bar / (ml/s)
    const tempMaxScale = Math.ceil(Math.max(0, ...temp) + 5) || 100;

    const yLeft   = v => plotY + plotH - Math.max(0, Math.min(v / LEFT_MAX, 1)) * plotH;
    const yRight  = v => plotY + plotH - clamp(v / tempMaxScale, 0, 1) * plotH;
    const xTime   = i => plotX + (i / Math.max(nPts - 1, 1)) * plotW;

    // Grid lines (horizontal, at 0 3 6 9 12 on left axis)
    [0, 3, 6, 9, 12].forEach(bar => {
        const gy = yLeft(bar);
        ctx.strokeStyle = GLP.border;
        ctx.lineWidth = 1;
        ctx.setLineDash(bar === 0 ? [] : [3, 4]);
        ctx.beginPath(); ctx.moveTo(plotX, gy); ctx.lineTo(plotX + plotW, gy); ctx.stroke();
        ctx.setLineDash([]);
        if (bar > 0) {
            ctx.fillStyle = GLP.textMute;
            ctx.font = F(17);
            ctx.textAlign = 'right';
            ctx.textBaseline = 'middle';
            ctx.fillText(String(bar), outerX + CHART_L - 6, gy);
        }
    });
    ctx.textAlign = 'left';

    // Right Y axis ticks — shared weight/temperature scale, step size scaled
    // to the range. Unitless, mirroring the live chart's y1 axis (Chart.js
    // auto-ticks with no unit suffix — weight and temperature share the same
    // numbers there too).
    const rightStep = tempMaxScale <= 40 ? 10 : tempMaxScale <= 80 ? 20 : 25;
    for (let v = rightStep; v < tempMaxScale; v += rightStep) {
        const gy = yRight(v);
        ctx.fillStyle = GLP.textMute;
        ctx.font = F(15);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(v), outerX + outerW - CHART_R + 5, gy);
    }

    // X axis — time ticks every 5s
    const xTickStep = totalSec <= 40 ? 5 : totalSec <= 90 ? 10 : 20;
    for (let t = 0; t <= totalSec; t += xTickStep) {
        const gx = plotX + (t / totalSec) * plotW;
        ctx.strokeStyle = GLP.border;
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 4]);
        ctx.beginPath(); ctx.moveTo(gx, plotY); ctx.lineTo(gx, plotY + plotH); ctx.stroke();
        ctx.setLineDash([]);
        const m = Math.floor(t / 60), s = t % 60;
        const label = m > 0 ? `${m}:${String(s).padStart(2,'0')}` : `${s}s`;
        ctx.fillStyle = GLP.textMute;
        ctx.font = F(16);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText(label, gx, plotY + plotH + 6);
    }

    // Clip to plot area for actual data drawing
    ctx.save();
    roundRect(ctx, plotX, plotY, plotW, plotH, 0);
    ctx.clip();

    // Phase backgrounds + divider (inside clip)
    if (preEnd !== null && nPts > 0) {
        const pxEnd = xTime(preEnd);
        ctx.fillStyle = 'rgba(52,152,219,0.08)';
        ctx.fillRect(plotX, plotY, pxEnd - plotX, plotH);
        ctx.fillStyle = 'rgba(243,156,18,0.06)';
        ctx.fillRect(pxEnd, plotY, plotX + plotW - pxEnd, plotH);
        ctx.strokeStyle = 'rgba(200,200,200,0.2)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.moveTo(pxEnd, plotY); ctx.lineTo(pxEnd, plotY + plotH); ctx.stroke();
        ctx.setLineDash([]);
    }

    // Helper to draw one series
    function drawSeries(vals, yFn, color, width, dash) {
        if (!vals || vals.length < 2) return false;
        if (dash) ctx.setLineDash(dash);
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        const drawn = polyline(ctx, vals, xTime, yFn);
        if (drawn) ctx.stroke();
        ctx.setLineDash([]);
        return drawn;
    }

    // Draw target lines (dashed, behind main lines)
    drawSeries(tgtPress,  yLeft,  GLP.cPressure,   1.5, [5, 5]);
    drawSeries(tgtFlow,   yLeft,  GLP.cFlow,        1.5, [5, 5]);
    drawSeries(tgtTemp,   yRight, GLP.cTemp,        1.5, [5, 5]);

    // Draw main lines (solid, GLP colors, no glow)
    drawSeries(weightFlow, yLeft,  GLP.cWeightFlow, 2,   null);
    drawSeries(flow,       yLeft,  GLP.cFlow,       2,   null);
    drawSeries(weight,     yRight, GLP.cWeight,     2,   null);
    drawSeries(temp,       yRight, GLP.cTemp,       2.5, null);
    drawSeries(pressure,   yLeft,  GLP.cPressure,   2.5, null);

    ctx.restore();

    // Phase label chips in the chart top margin (above the plot area)
    if (preEnd !== null && nPts > 0) {
        const pxEnd    = xTime(preEnd);
        const preWidth = pxEnd - plotX;
        const extWidth = plotX + plotW - pxEnd;
        const chipH    = 18, chipPad = 7;
        const chipY    = outerY + (CHART_T - chipH) / 2;
        ctx.font = F(12);
        ctx.textBaseline = 'middle';
        ctx.textAlign    = 'left';

        if (preWidth > 90) {
            const lw = ctx.measureText('Preinfusion').width + chipPad * 2;
            roundRect(ctx, plotX + 4, chipY, lw, chipH, 3);
            ctx.fillStyle = 'rgba(52,152,219,0.2)';
            ctx.fill();
            ctx.fillStyle = 'rgba(52,152,219,0.9)';
            ctx.fillText('Preinfusion', plotX + 4 + chipPad, chipY + chipH / 2);
        }
        if (extWidth > 90) {
            const lw = ctx.measureText('Extraktion').width + chipPad * 2;
            roundRect(ctx, pxEnd + 4, chipY, lw, chipH, 3);
            ctx.fillStyle = 'rgba(243,156,18,0.2)';
            ctx.fill();
            ctx.fillStyle = 'rgba(243,156,18,0.9)';
            ctx.fillText('Extraktion', pxEnd + 4 + chipPad, chipY + chipH / 2);
        }
    }

    // ── LEGEND ─────────────────────────────────────────────────────────────
    const legendItems = [];
    if (pressure.length   > 2) legendItems.push({ color: GLP.cPressure,   label: 'Druck',        dash: false });
    if (flow.length       > 2) legendItems.push({ color: GLP.cFlow,       label: 'Pumpenfluss',  dash: false });
    if (weightFlow.length > 2) legendItems.push({ color: GLP.cWeightFlow, label: 'Gewichtsfluss',dash: false });
    if (weight.length     > 2) legendItems.push({ color: GLP.cWeight,     label: 'Gewicht',      dash: false });
    if (temp.length       > 2) legendItems.push({ color: GLP.cTemp,       label: 'Temperatur',   dash: false });
    if (tgtPress.length   > 2) legendItems.push({ color: GLP.cPressure,   label: 'Ziel Druck',   dash: true });
    if (tgtFlow.length    > 2) legendItems.push({ color: GLP.cFlow,       label: 'Ziel Fluss',    dash: true });
    if (tgtTemp.length    > 2) legendItems.push({ color: GLP.cTemp,       label: 'Ziel Temperatur', dash: true });

    if (legendItems.length) {
        const legY    = outerY + outerH - LEGEND_H / 2;
        const chipH   = 26, chipPad = 10, dotR = 5, gap = 10;
        ctx.font = F(15);
        ctx.textBaseline = 'middle';
        const chipWidths = legendItems.map(it => dotR * 2 + 8 + ctx.measureText(it.label).width + chipPad * 2);
        const totalLegW  = chipWidths.reduce((a, b) => a + b, 0) + gap * (legendItems.length - 1);
        let lx = outerX + (outerW - totalLegW) / 2;

        legendItems.forEach((it, i) => {
            const cw = chipWidths[i];
            roundRect(ctx, lx, legY - chipH / 2, cw, chipH, chipH / 2);
            ctx.fillStyle = GLP.bgChart;
            ctx.fill();
            ctx.strokeStyle = GLP.borderDim;
            ctx.lineWidth = 1;
            ctx.stroke();

            const dotX = lx + chipPad + dotR;
            ctx.beginPath();
            ctx.arc(dotX, legY, dotR, 0, Math.PI * 2);
            if (it.dash) {
                ctx.strokeStyle = it.color;
                ctx.lineWidth = 1.5;
                ctx.stroke();
            } else {
                ctx.fillStyle = it.color;
                ctx.fill();
            }

            ctx.fillStyle = GLP.textDim;
            ctx.textAlign = 'left';
            ctx.fillText(it.label, dotX + dotR + 8, legY);
            lx += cw + gap;
        });
    }

    // ── STATS GRID — matches GLP web UI layout (Image #21) ────────────────
    const statsY   = outerY + outerH + 8;
    const statsH   = STATS_H;
    const sX       = PX - 8;          // left edge of stats card
    const sW       = W - 2 * PX + 16; // width of stats card
    const colW     = sW / 2;
    const lX       = sX + 16;         // left col text start
    const rX       = sX + colW + 16;  // right col text start
    const lastWF   = weightFlow.filter(v => v > 0).slice(-1)[0] != null
        ? +(weightFlow.filter(v => v > 0).slice(-1)[0]).toFixed(1) : null;

    // Build rows: [label, mainVal, subVal, special]
    // special = 'phasen' renders chips instead of text
    const leftRows = [];
    if (avgPres != null) leftRows.push([
        'DRUCK  (Ø / MAX ZIEL)',
        `${avgPres} bar`,
        (tgtPressVal && tgtPressVal > 0) ? `/ ${tgtPressVal} bar` : (maxPres ? `/ ${maxPres} max` : '')
    ]);
    if (avgFlow != null) leftRows.push([
        'PUMPENFLUSS  (Ø / ZIEL)',
        `${avgFlow} ml/s`,
        (tgtFlowVal && tgtFlowVal > 0) ? `/ ${tgtFlowVal} ml/s` : ''
    ]);
    if (avgTemp != null) leftRows.push([
        'TEMPERATUR  (Ø ±Σ / ZIEL)',
        `${avgTemp} °C`,
        [tempSD ? `±${tempSD}` : '', (tgtTempVal && tgtTempVal > 0) ? `/ ${tgtTempVal} °C` : ''].filter(Boolean).join('  ')
    ]);
    const rightRows = [];
    const weightVal = finalWeight ?? yieldG;
    if (weightVal != null) rightRows.push([
        'GEWICHT  (GESAMT / FLUSS ENDE)',
        `${weightVal} g`,
        lastWF ? `/ ${lastWF} ml/s` : ''
    ]);
    if (avgWF != null) rightRows.push([
        'GEWICHTSFLUSS  (Ø / MAX)',
        `${avgWF} ml/s`,
        maxWF ? `/ ${maxWF} max` : ''
    ]);
    rightRows.push(['DAUER', fmtDurSec(totalSec), '']);

    const nRows = Math.max(leftRows.length, rightRows.length);
    const rowH  = statsH / nRows;

    roundRect(ctx, sX, statsY, sW, statsH, 8);
    ctx.fillStyle = GLP.bgCard;
    ctx.fill();
    ctx.strokeStyle = GLP.border;
    ctx.lineWidth = 1;
    ctx.stroke();

    // Vertical divider
    ctx.beginPath();
    ctx.moveTo(sX + colW, statsY + 10);
    ctx.lineTo(sX + colW, statsY + statsH - 10);
    ctx.stroke();

    const drawStatsCol = (rows, textX) => {
        rows.forEach(([lbl, val, sub, special], r) => {
            const ry = statsY + r * rowH;
            if (r > 0) {
                ctx.strokeStyle = GLP.border;
                ctx.lineWidth   = 1;
                ctx.beginPath();
                ctx.moveTo(textX - 4, ry);
                ctx.lineTo(textX + colW - 24, ry);
                ctx.stroke();
            }
            ctx.textAlign    = 'left';
            ctx.textBaseline = 'alphabetic';
            ctx.fillStyle    = GLP.textMute;
            ctx.font         = F(12);
            ctx.fillText(lbl, textX, ry + 15);

            if (special === 'phasen') {
                // Draw phase chips
                const chipH = 18, chipPad = 6, chipY2 = ry + 20;
                ctx.font = F(12);
                ctx.textBaseline = 'middle';
                let cx = textX;
                const chips = [];
                if (preinfEndSec != null) chips.push({ t: `Preinfusion  ${fmtDurSec(preinfEndSec)}`, c: '52,152,219' });
                if (extDurSec    != null) chips.push({ t: `Extraktion  ${fmtDurSec(extDurSec)}`,    c: '243,156,18' });
                chips.forEach(({ t, c }) => {
                    const tw = ctx.measureText(t).width;
                    const cw = tw + chipPad * 2;
                    roundRect(ctx, cx, chipY2, cw, chipH, 3);
                    ctx.fillStyle = `rgba(${c},0.18)`;
                    ctx.fill();
                    ctx.fillStyle = `rgba(${c},0.9)`;
                    ctx.fillText(t, cx + chipPad, chipY2 + chipH / 2);
                    cx += cw + 8;
                });
                ctx.textBaseline = 'alphabetic';
            } else {
                ctx.font = F(20, true);
                const valW = ctx.measureText(val).width;
                ctx.fillStyle = GLP.text;
                ctx.fillText(val, textX, ry + 38);
                if (sub) {
                    ctx.fillStyle = GLP.textMute;
                    ctx.font      = F(13);
                    ctx.fillText(sub, textX + valW + 8, ry + 38);
                }
            }
        });
    };

    drawStatsCol(leftRows,  lX);
    drawStatsCol(rightRows, rX);
    ctx.textAlign = 'left';

    // ── FOOTER ─────────────────────────────────────────────────────────────
    const footY = H - 38;
    ctx.fillStyle = GLP.bgCard;
    ctx.fillRect(0, footY - 12, W, H - footY + 12);
    ctx.strokeStyle = GLP.border;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, footY - 12); ctx.lineTo(W, footY - 12); ctx.stroke();

    ctx.fillStyle = GLP.textMute;
    ctx.font = F(20);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText('Gaggiuino Local Profiler', PX, footY + 6);

    // "Made with GLP" pill — same soft-tint chip convention as the rest of the app
    const pillText = 'Made with GLP';
    ctx.font = F(16, true);
    const pillPad = 12;
    const pillW = ctx.measureText(pillText).width + pillPad * 2;
    const pillH = 30;
    const pillX = W - PX - pillW, pillY = footY + 6 - pillH / 2;
    roundRect(ctx, pillX, pillY, pillW, pillH, pillH / 2);
    ctx.fillStyle = GLP.accentTint + '0.14)';
    ctx.fill();
    ctx.strokeStyle = GLP.accentTint + '0.3)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = GLP.accentFrom;
    ctx.textAlign = 'center';
    ctx.fillText(pillText, pillX + pillW / 2, footY + 6);
    ctx.textAlign = 'left';

    return canvas.toBuffer('image/png');
}

module.exports = {
    generateShareCard,
    isAvailable: () => createCanvas !== null,
    // Exported for unit testing of the pure logic pieces
    scoreTierPhrase,
    resolveBeanOriginCode,
    starPoints,
};
