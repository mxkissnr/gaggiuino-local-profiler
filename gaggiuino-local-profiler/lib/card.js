'use strict';

const fs = require('fs');

let createCanvas = null;
let GlobalFonts  = null;
try {
    ({ createCanvas, GlobalFonts } = require('@napi-rs/canvas'));
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

// ── Exact GLP web UI colors (from shots/index.js datasets) ─────────────────
const GLP = {
    bg:        '#100806',
    bgDark:    '#0a0503',
    bgCard:    '#1a0c07',
    bgChart:   '#0d0604',
    amber:     '#f59e0b',
    amberDim:  '#7a3d08',
    cream:     '#f0d9b5',
    creamDim:  '#a07840',
    creamMute: '#5a3818',
    border:    '#27272a',
    borderBr:  '#3d1a08',
    // Series colors — copied exactly from GLP shots/index.js
    cPressure:    '#3498db',
    cFlow:        '#f39c12',
    cWeightFlow:  '#9b59b6',
    cWeight:      '#2ecc71',
    cTemp:        '#e74c3c',
    green:        '#22c55e',
    red:          '#ef4444',
};

const W = 1080, H = 1080, PX = 52;

function F(size, bold = false) {
    const fam = globalThis._glpCardFont || 'sans-serif';
    return `${bold ? 'bold ' : ''}${size}px ${fam}`;
}

function scoreColor(s) {
    if (s == null) return GLP.creamDim;
    if (s >= 80)   return GLP.green;
    if (s >= 60)   return GLP.amber;
    return GLP.red;
}

function avg(arr) {
    if (!arr || !arr.length) return null;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
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

function generateShareCard(shot, score, format = 'square') {
    if (!createCanvas) throw new Error('canvas module not available');

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
    const avgPres     = pressure.length ? +(avg(pressure.filter(v => v > 1.5))).toFixed(1)  : null;
    const avgTemp     = temp.length     ? +(avg(temp.filter(v => v > 50))).toFixed(1)       : null;
    const finalWeight = weight.length   ? +(weight[weight.length - 1]).toFixed(1)           : null;
    const machine     = ann.machine || shot.machine || '';

    const dateStr = shot.timestamp
        ? new Date(shot.timestamp * 1000).toLocaleDateString('de-DE', { day: '2-digit', month: 'short', year: 'numeric' })
        : '';
    const shotId  = shot.id ? `Shot #${shot.id}` : '';
    const sColor  = scoreColor(score);
    const preEnd  = detectPreinfusionEnd(pressure);

    // ── BACKGROUND ─────────────────────────────────────────────────────────
    ctx.fillStyle = GLP.bg;
    ctx.fillRect(0, 0, W, H);

    // ── HEADER BAR ─────────────────────────────────────────────────────────
    const HH = 90;
    ctx.fillStyle = GLP.bgCard;
    ctx.fillRect(0, 0, W, HH);
    ctx.strokeStyle = GLP.borderBr;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, HH); ctx.lineTo(W, HH); ctx.stroke();

    // GLP wordmark
    ctx.fillStyle = GLP.amber;
    ctx.font = F(50, true);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText('GLP', PX, HH / 2);

    // Shot pill
    if (shotId) {
        const pillX = PX + 108, pillY = HH / 2 - 15;
        roundRect(ctx, pillX, pillY, 128, 30, 5);
        ctx.fillStyle = 'rgba(120,60,8,0.5)';
        ctx.fill();
        ctx.strokeStyle = GLP.amberDim;
        ctx.lineWidth = 1; ctx.stroke();
        ctx.fillStyle = GLP.amber;
        ctx.font = F(18);
        ctx.textBaseline = 'middle';
        ctx.fillText(shotId, pillX + 9, HH / 2);
    }

    // Date top-right
    ctx.fillStyle = GLP.creamDim;
    ctx.font = F(21);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(dateStr, W - PX, HH / 2);
    ctx.textAlign = 'left';

    // ── SCORE BADGE ────────────────────────────────────────────────────────
    if (score != null) {
        const scx = W - PX - 52, scy = HH + 86, r = 66;
        // Background disc
        ctx.beginPath();
        ctx.arc(scx, scy, r, 0, Math.PI * 2);
        ctx.fillStyle = GLP.bgCard;
        ctx.fill();
        // Ring
        ctx.beginPath();
        ctx.arc(scx, scy, r, -Math.PI / 2, 1.5 * Math.PI);
        ctx.strokeStyle = sColor;
        ctx.lineWidth = 4;
        ctx.stroke();
        // Number
        ctx.fillStyle = sColor;
        ctx.font = F(52, true);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(score), scx, scy - 7);
        // Label
        ctx.font = F(16);
        ctx.fillStyle = sColor;
        ctx.fillText('SCORE', scx, scy + 28);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
    }

    // ── PROFILE + BEAN ─────────────────────────────────────────────────────
    const nameMaxW = W - 2 * PX - (score != null ? 170 : 20);
    ctx.textBaseline = 'alphabetic';

    let pName = profileName;
    ctx.font = F(58, true);
    while (ctx.measureText(pName).width > nameMaxW && pName.length > 4)
        pName = pName.slice(0, -4) + '…';
    ctx.fillStyle = GLP.cream;
    ctx.fillText(pName, PX, HH + 56);

    let subY = HH + 98;
    const subParts = [bean, machine].filter(Boolean);
    if (subParts.length) {
        ctx.fillStyle = GLP.creamDim;
        ctx.font = F(27);
        let subLine = subParts.join('  ·  ');
        while (ctx.measureText(subLine).width > nameMaxW + 140 && subLine.length > 4)
            subLine = subLine.slice(0, -4) + '…';
        ctx.fillText(subLine, PX, subY);
        subY += 38;
    }

    // Dose → Yield · Ratio · Dur line
    const doseParts = [];
    if (dose)   doseParts.push(`${dose}g`);
    if (yieldG) doseParts.push(`→ ${yieldG}g`);
    if (ratio)  doseParts.push(`· ${ratio}`);
    if (dur)    doseParts.push(`· ${dur}`);

    if (doseParts.length) {
        const doseY = subY + 18;
        ctx.fillStyle = GLP.creamMute;
        ctx.font = F(26);
        ctx.fillText('DOSIS', PX, doseY);
        ctx.fillStyle = GLP.cream;
        ctx.font = F(26, true);
        ctx.fillText(doseParts.join('  '), PX + 88, doseY);
        subY = doseY;
    }

    // Separator
    const sepY = subY + 24;
    const sg = ctx.createLinearGradient(PX, 0, W - PX, 0);
    sg.addColorStop(0,   GLP.amber);
    sg.addColorStop(0.7, GLP.amberDim);
    sg.addColorStop(1,   'rgba(60,20,5,0)');
    ctx.strokeStyle = sg;
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(PX, sepY); ctx.lineTo(W - PX, sepY); ctx.stroke();

    // ── CHART ──────────────────────────────────────────────────────────────
    // Chart coordinate system with margins for axes + legend
    const CHART_L  = 44;   // left margin (Y axis labels)
    const CHART_R  = 44;   // right margin (right Y axis)
    const CHART_T  = 28;   // top margin (phase labels)
    const CHART_B  = 28;   // bottom margin (X axis)
    const LEGEND_H = 50;

    const outerX = PX - 8;
    const outerY = sepY + 12;
    const outerW = W - 2 * PX + 16;
    const outerH = Math.round(410 * SCALE);  // taller for story format

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

    // Y axis scales
    const LEFT_MAX  = 12;   // bar / (ml/s)
    const RIGHT_MAX = Math.max(100, ...temp.filter(Boolean), ...weight.filter(Boolean)) || 100;

    const yLeft  = v => plotY + plotH - Math.max(0, Math.min(v / LEFT_MAX, 1)) * plotH;
    const yRight = v => plotY + plotH - Math.max(0, Math.min(v / RIGHT_MAX, 1)) * plotH;
    const xTime  = i => plotX + (i / Math.max(nPts - 1, 1)) * plotW;

    // Grid lines (horizontal, at 0 3 6 9 12 on left axis)
    [0, 3, 6, 9, 12].forEach(bar => {
        const gy = yLeft(bar);
        ctx.strokeStyle = GLP.border;
        ctx.lineWidth = 1;
        ctx.setLineDash(bar === 0 ? [] : [3, 4]);
        ctx.beginPath(); ctx.moveTo(plotX, gy); ctx.lineTo(plotX + plotW, gy); ctx.stroke();
        ctx.setLineDash([]);
        // Left axis label
        if (bar > 0) {
            ctx.fillStyle = '#a1a1aa';
            ctx.font = F(17);
            ctx.textAlign = 'right';
            ctx.textBaseline = 'middle';
            ctx.fillText(String(bar), outerX + CHART_L - 6, gy);
        }
    });
    ctx.textAlign = 'left';

    // Right Y axis ticks (20 40 60 80 100)
    [20, 40, 60, 80].forEach(v => {
        const gy = yRight(v);
        ctx.fillStyle = '#71717a';
        ctx.font = F(15);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(v), outerX + outerW - CHART_R + 5, gy);
    });

    // X axis — time ticks every 5s
    const xTickStep = totalSec <= 40 ? 5 : totalSec <= 90 ? 10 : 20;
    for (let t = 0; t <= totalSec; t += xTickStep) {
        const gx = plotX + (t / totalSec) * plotW;
        ctx.strokeStyle = '#3a3a3a';
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 4]);
        ctx.beginPath(); ctx.moveTo(gx, plotY); ctx.lineTo(gx, plotY + plotH); ctx.stroke();
        ctx.setLineDash([]);
        const m = Math.floor(t / 60), s = t % 60;
        const label = m > 0 ? `${m}:${String(s).padStart(2,'0')}` : `${s}s`;
        ctx.fillStyle = '#71717a';
        ctx.font = F(16);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText(label, gx, plotY + plotH + 6);
    }

    // Clip to plot area for actual data drawing
    ctx.save();
    roundRect(ctx, plotX, plotY, plotW, plotH, 0);
    ctx.clip();

    // Phase backgrounds
    if (preEnd !== null && nPts > 0) {
        const pxEnd = xTime(preEnd);
        // Preinfusion tint
        ctx.fillStyle = 'rgba(52,120,200,0.08)';
        ctx.fillRect(plotX, plotY, pxEnd - plotX, plotH);
        // Extraction tint
        ctx.fillStyle = 'rgba(200,100,20,0.06)';
        ctx.fillRect(pxEnd, plotY, plotX + plotW - pxEnd, plotH);
        // Phase divider line
        ctx.strokeStyle = 'rgba(120,120,120,0.35)';
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

    // Phase labels — only show when the zone is wide enough to avoid overlap
    if (preEnd !== null && nPts > 0) {
        const pxEnd     = xTime(preEnd);
        const preWidth  = pxEnd - plotX;
        const extWidth  = plotX + plotW - pxEnd;
        ctx.fillStyle   = 'rgba(160,160,200,0.65)';
        ctx.font        = F(16);
        ctx.textBaseline = 'middle';
        ctx.textAlign   = 'left';
        if (preWidth > 90)  ctx.fillText('Preinfusion', plotX + 6,  outerY + CHART_T / 2);
        if (extWidth > 90)  ctx.fillText('Extraktion',  pxEnd + 6,  outerY + CHART_T / 2);
    }

    // ── LEGEND ─────────────────────────────────────────────────────────────
    const legendItems = [];
    if (pressure.length   > 2) legendItems.push({ color: GLP.cPressure,   label: 'Druck',        dash: false });
    if (flow.length       > 2) legendItems.push({ color: GLP.cFlow,       label: 'Pumpenfluss',  dash: false });
    if (weightFlow.length > 2) legendItems.push({ color: GLP.cWeightFlow, label: 'Gewichtsfluss',dash: false });
    if (weight.length     > 2) legendItems.push({ color: GLP.cWeight,     label: 'Gewicht',      dash: false });
    if (temp.length       > 2) legendItems.push({ color: GLP.cTemp,       label: 'Temperatur',   dash: false });
    if (tgtPress.length   > 2) legendItems.push({ color: GLP.cPressure,   label: 'Ziel Druck',   dash: true });
    if (tgtFlow.length    > 2) legendItems.push({ color: GLP.cFlow,       label: 'Ziel Fluss',   dash: true });
    if (tgtTemp.length    > 2) legendItems.push({ color: GLP.cTemp,       label: 'Ziel Temp',    dash: true });

    if (legendItems.length) {
        const legY = outerY + outerH - LEGEND_H / 2;
        ctx.font = F(17);
        ctx.textBaseline = 'middle';
        // Measure total width
        const itemWidths = legendItems.map(it => 14 + 4 + ctx.measureText(it.label).width + 14);
        const totalLegW  = itemWidths.reduce((a, b) => a + b, 0);
        let lx = outerX + (outerW - totalLegW) / 2;

        legendItems.forEach((it, i) => {
            if (it.dash) {
                // dashed line swatch
                ctx.strokeStyle = it.color;
                ctx.lineWidth = 2;
                ctx.setLineDash([4, 3]);
                ctx.beginPath(); ctx.moveTo(lx, legY); ctx.lineTo(lx + 14, legY); ctx.stroke();
                ctx.setLineDash([]);
            } else {
                // solid square swatch
                ctx.fillStyle = it.color;
                ctx.fillRect(lx, legY - 6, 12, 12);
            }
            ctx.fillStyle = '#a1a1aa';
            ctx.textAlign = 'left';
            ctx.fillText(it.label, lx + 16, legY);
            lx += itemWidths[i];
        });
    }

    // ── STATS BAR ──────────────────────────────────────────────────────────
    const statsY = outerY + outerH + 14;
    const statsItems = [];
    if (avgPres     != null) statsItems.push(['DRUCK  Ø',  `${avgPres} bar`]);
    if (avgTemp     != null) statsItems.push(['TEMP  Ø',   `${avgTemp} °C`]);
    if (dur)                 statsItems.push(['DAUER',     dur]);
    if (finalWeight != null) statsItems.push(['GEWICHT',   `${finalWeight}g`]);
    else if (yieldG != null) statsItems.push(['YIELD',     `${yieldG}g`]);

    if (statsItems.length) {
        const statsH = 100;
        const cellW  = (W - 2 * PX) / statsItems.length;

        roundRect(ctx, PX - 8, statsY, W - 2 * PX + 16, statsH, 8);
        ctx.fillStyle = GLP.bgCard;
        ctx.fill();
        ctx.strokeStyle = GLP.border;
        ctx.lineWidth = 1;
        ctx.stroke();

        statsItems.forEach(([label, val], i) => {
            const cx2 = PX + i * cellW;
            if (i > 0) {
                ctx.strokeStyle = GLP.border;
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(cx2 - 1, statsY + 10);
                ctx.lineTo(cx2 - 1, statsY + statsH - 10);
                ctx.stroke();
            }
            ctx.fillStyle = GLP.creamMute;
            ctx.font = F(17);
            ctx.textAlign = 'center';
            ctx.textBaseline = 'alphabetic';
            ctx.fillText(label, cx2 + cellW / 2, statsY + 30);
            ctx.fillStyle = GLP.cream;
            ctx.font = F(34, true);
            ctx.fillText(val, cx2 + cellW / 2, statsY + 78);
        });
        ctx.textAlign = 'left';
    }

    // ── FOOTER ─────────────────────────────────────────────────────────────
    const footY = H - 50;
    ctx.fillStyle = GLP.bgCard;
    ctx.fillRect(0, footY - 12, W, H - footY + 12);
    ctx.strokeStyle = GLP.borderBr;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, footY - 12); ctx.lineTo(W, footY - 12); ctx.stroke();

    ctx.fillStyle = GLP.amberDim;
    ctx.font = F(20);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText('Gaggiuino Local Profiler', PX, footY + 6);
    ctx.fillStyle = GLP.creamMute;
    ctx.textAlign = 'right';
    ctx.fillText('glp.local', W - PX, footY + 6);
    ctx.textAlign = 'left';

    return canvas.toBuffer('image/png');
}

module.exports = { generateShareCard, isAvailable: () => createCanvas !== null };
