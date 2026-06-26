'use strict';

const fs = require('fs');

let createCanvas = null;
let GlobalFonts  = null;
try {
    ({ createCanvas, GlobalFonts } = require('@napi-rs/canvas'));
    // Register fonts explicitly — loadSystemFonts() is unreliable on headless Linux
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
    // Pick whichever registered family is available (getFamilies returns JSON Buffer in some versions)
    let families = [];
    if (GlobalFonts.getFamilies) {
        try {
            const raw = GlobalFonts.getFamilies();
            const parsed = JSON.parse(Buffer.isBuffer(raw) ? raw.toString() : JSON.stringify(raw));
            families = Array.isArray(parsed) ? parsed.map(f => f.family || f) : [];
        } catch { /* ignore */ }
    }
    globalThis._glpCardFont = families.includes('Liberation Sans') ? 'Liberation Sans'
        : families.includes('DejaVu Sans')  ? 'DejaVu Sans'
        : 'sans-serif';
} catch {
    createCanvas = null;
}

const W = 1080, H = 1080, PAD = 60;
const AMBER   = '#f59e0b';
const AMBER_D = '#7a2e0a';
const FG      = '#f0d9b5';
const FG_DIM  = '#8a6a40';
const BG0     = '#0d0705';
const BG1     = '#1a0c07';

function font(size, weight = 'normal') {
    const f = globalThis._glpCardFont || 'sans-serif';
    return `${weight === 'bold' ? 'bold ' : ''}${size}px ${f}`;
}

function scoreColor(s) {
    if (s == null) return '#888888';
    if (s >= 80)   return '#22c55e';
    if (s >= 60)   return AMBER;
    return '#ef4444';
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

function sparkline(ctx, vals, x0, y0, cw, ch, maxVal) {
    if (!vals || vals.length < 2) return;
    const mx = maxVal || Math.max(...vals, 1);
    ctx.beginPath();
    for (let i = 0; i < vals.length; i++) {
        const x = x0 + (i / (vals.length - 1)) * cw;
        const y = y0 + ch - Math.min(vals[i] / mx, 1) * ch;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
}

function generateShareCard(shot, score) {
    if (!createCanvas) throw new Error('canvas module not available');

    const canvas = createCanvas(W, H);
    const ctx    = canvas.getContext('2d');

    const profileName = shot.profile?.name || shot.profile_name || shot.profileName || 'Unknown';
    const ann  = shot.annotation || {};
    const dp   = shot.datapoints || {};

    const bean  = ann.coffee || '';
    const dose  = ann.dose  != null ? `${(+ann.dose).toFixed(1)}g`          : null;
    const wt    = ann.totalWeight ?? ann.yield ?? null;
    const yld   = wt   != null ? `${(+wt).toFixed(1)}g`                    : null;
    const ratio = ann.dose && wt ? `1:${(wt / ann.dose).toFixed(1)}`        : null;
    const dur   = shot.duration  ? `${(shot.duration / 10).toFixed(0)}s`    : null;
    const dateStr = shot.timestamp
        ? new Date(shot.timestamp * 1000).toLocaleDateString('de-DE', { day: '2-digit', month: 'short', year: 'numeric' })
        : '';
    const shotId = shot.id ? `#${shot.id}` : '';

    const pressure   = (dp.pressure       || []).map(v => v / 10);
    const targetPres = (dp.targetPressure || []).map(v => v / 10);
    const sColor = scoreColor(score);

    // ── Background ─────────────────────────────────────────────────────────────
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0,   BG0);
    bg.addColorStop(0.5, BG1);
    bg.addColorStop(1,   BG0);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // Subtle vignette
    const vig = ctx.createRadialGradient(W / 2, H / 2, W * 0.3, W / 2, H / 2, W * 0.75);
    vig.addColorStop(0, 'rgba(0,0,0,0)');
    vig.addColorStop(1, 'rgba(0,0,0,0.45)');
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, W, H);

    // Outer border
    roundRect(ctx, 4, 4, W - 8, H - 8, 18);
    ctx.strokeStyle = '#3d1a08';
    ctx.lineWidth = 3;
    ctx.stroke();

    // ── Header bar ─────────────────────────────────────────────────────────────
    const HEADER_H = 112;
    roundRect(ctx, 4, 4, W - 8, HEADER_H, 16);
    const hg = ctx.createLinearGradient(0, 0, 0, HEADER_H);
    hg.addColorStop(0, 'rgba(40,15,5,0.95)');
    hg.addColorStop(1, 'rgba(20,8,3,0.6)');
    ctx.fillStyle = hg;
    ctx.fill();

    // GLP wordmark
    ctx.fillStyle = AMBER;
    ctx.font = font(72, 'bold');
    ctx.textBaseline = 'middle';
    ctx.fillText('GLP', PAD, 58);

    // Shot ID + date in header
    ctx.fillStyle = FG_DIM;
    ctx.font = font(28);
    if (shotId) ctx.fillText(shotId, PAD + 140, 42);
    if (dateStr) ctx.fillText(dateStr, PAD + 140, 76);

    // Score badge (right side)
    if (score != null) {
        const scx = W - PAD - 52, scy = 56, r = 48;

        // Ring glow
        ctx.beginPath();
        ctx.arc(scx, scy, r + 12, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${sColor === '#22c55e' ? '34,197,94' : sColor === AMBER ? '245,158,11' : '239,68,68'},0.12)`;
        ctx.fill();

        // Ring
        ctx.beginPath();
        ctx.arc(scx, scy, r, 0, Math.PI * 2);
        ctx.strokeStyle = sColor;
        ctx.lineWidth = 4;
        ctx.stroke();

        // Score number
        ctx.fillStyle = sColor;
        ctx.font = font(46, 'bold');
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(score), scx, scy - 4);

        ctx.fillStyle = `rgba(${sColor === '#22c55e' ? '34,197,94' : sColor === AMBER ? '245,158,11' : '239,68,68'},0.75)`;
        ctx.font = font(18);
        ctx.fillText('SCORE', scx, scy + 26);

        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
    }

    // Header bottom separator
    const sg = ctx.createLinearGradient(PAD, 0, W - PAD, 0);
    sg.addColorStop(0, AMBER);
    sg.addColorStop(1, AMBER_D);
    ctx.strokeStyle = sg;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(PAD, HEADER_H + 4);
    ctx.lineTo(W - PAD, HEADER_H + 4);
    ctx.stroke();

    // ── Profile + Bean ─────────────────────────────────────────────────────────
    ctx.textBaseline = 'alphabetic';
    const nameY = HEADER_H + 68;

    ctx.fillStyle = FG;
    ctx.font = font(52, 'bold');
    const maxNameW = W - 2 * PAD - (score != null ? 160 : 20);
    let pName = profileName;
    while (ctx.measureText(pName).width > maxNameW && pName.length > 4)
        pName = pName.slice(0, -4) + '…';
    ctx.fillText(pName, PAD, nameY);

    if (bean) {
        ctx.fillStyle = FG_DIM;
        ctx.font = font(30);
        ctx.fillText(bean, PAD, nameY + 42);
    }

    // ── Chart ──────────────────────────────────────────────────────────────────
    const cx0 = PAD, cy0 = HEADER_H + (bean ? 154 : 120), cw = W - 2 * PAD, ch = 430;
    const maxBar = 12;

    // Chart background card
    roundRect(ctx, cx0 - 8, cy0 - 8, cw + 16, ch + 16, 12);
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fill();
    ctx.strokeStyle = '#2a1005';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.save();
    roundRect(ctx, cx0 - 8, cy0 - 8, cw + 16, ch + 16, 12);
    ctx.clip();

    // Grid lines + bar labels
    [3, 6, 9].forEach(bar => {
        const gy = cy0 + ch - (bar / maxBar) * ch;
        ctx.strokeStyle = 'rgba(80,35,10,0.5)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 5]);
        ctx.beginPath();
        ctx.moveTo(cx0, gy);
        ctx.lineTo(cx0 + cw, gy);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.fillStyle = 'rgba(90,45,15,0.8)';
        ctx.font = font(20);
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText(`${bar}`, cx0 + 38, gy);
    });
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';

    // Bar unit label
    ctx.fillStyle = 'rgba(90,45,15,0.7)';
    ctx.font = font(18);
    ctx.fillText('bar', cx0 + 44, cy0 + 22);

    // Target pressure (dashed, subtle)
    if (targetPres.length > 2) {
        ctx.setLineDash([8, 6]);
        sparkline(ctx, targetPres, cx0, cy0, cw, ch, maxBar);
        ctx.strokeStyle = 'rgba(245,158,11,0.25)';
        ctx.lineWidth = 2.5;
        ctx.lineJoin = 'round';
        ctx.stroke();
        ctx.setLineDash([]);
    }

    if (pressure.length > 2) {
        // Fill
        const fg = ctx.createLinearGradient(0, cy0, 0, cy0 + ch);
        fg.addColorStop(0,   'rgba(245,158,11,0.2)');
        fg.addColorStop(0.7, 'rgba(245,158,11,0.05)');
        fg.addColorStop(1,   'rgba(245,158,11,0)');
        sparkline(ctx, pressure, cx0, cy0, cw, ch, maxBar);
        ctx.lineTo(cx0 + cw, cy0 + ch);
        ctx.lineTo(cx0, cy0 + ch);
        ctx.closePath();
        ctx.fillStyle = fg;
        ctx.fill();

        // Glow layer
        ctx.shadowColor = AMBER;
        ctx.shadowBlur  = 18;
        sparkline(ctx, pressure, cx0, cy0, cw, ch, maxBar);
        ctx.strokeStyle = 'rgba(245,158,11,0.3)';
        ctx.lineWidth   = 14;
        ctx.lineJoin    = 'round';
        ctx.lineCap     = 'round';
        ctx.stroke();
        ctx.shadowBlur  = 0;

        // Main line
        sparkline(ctx, pressure, cx0, cy0, cw, ch, maxBar);
        ctx.strokeStyle = AMBER;
        ctx.lineWidth   = 3.5;
        ctx.lineJoin    = 'round';
        ctx.lineCap     = 'round';
        ctx.stroke();
    } else {
        ctx.fillStyle = 'rgba(90,40,15,0.6)';
        ctx.font = font(26);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('Keine Druckdaten', cx0 + cw / 2, cy0 + ch / 2);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
    }

    ctx.restore();

    // ── Metadata pills ──────────────────────────────────────────────────────────
    const cols = [['DOSE', dose], ['YIELD', yld], ['RATIO', ratio], ['DAUER', dur]].filter(([, v]) => v);
    if (cols.length) {
        const metaY  = cy0 + ch + 36;
        const pillW  = (W - 2 * PAD - (cols.length - 1) * 16) / cols.length;
        const pillH  = 114;

        cols.forEach(([label, val], i) => {
            const px = PAD + i * (pillW + 16);

            roundRect(ctx, px, metaY, pillW, pillH, 10);
            ctx.fillStyle = 'rgba(30,12,4,0.75)';
            ctx.fill();
            ctx.strokeStyle = '#3d1a08';
            ctx.lineWidth = 1;
            ctx.stroke();

            ctx.fillStyle = FG_DIM;
            ctx.font = font(20);
            ctx.textAlign = 'center';
            ctx.textBaseline = 'alphabetic';
            ctx.fillText(label, px + pillW / 2, metaY + 30);

            ctx.fillStyle = FG;
            ctx.font = font(40, 'bold');
            ctx.fillText(val, px + pillW / 2, metaY + 86);
        });
        ctx.textAlign = 'left';
    }

    // ── Footer ─────────────────────────────────────────────────────────────────
    const footY = H - 58;

    const ftg = ctx.createLinearGradient(0, footY - 40, 0, H);
    ftg.addColorStop(0, 'rgba(0,0,0,0)');
    ftg.addColorStop(1, 'rgba(0,0,0,0.6)');
    ctx.fillStyle = ftg;
    ctx.fillRect(0, footY - 40, W, H - footY + 40);

    ctx.fillStyle = '#4a2a10';
    ctx.font = font(22);
    ctx.textBaseline = 'middle';
    ctx.fillText('Gaggiuino Local Profiler', PAD, footY);

    ctx.textAlign = 'right';
    ctx.fillStyle = '#3d1a08';
    ctx.fillText('glp.local', W - PAD, footY);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';

    return canvas.toBuffer('image/png');
}

module.exports = { generateShareCard, isAvailable: () => createCanvas !== null };
