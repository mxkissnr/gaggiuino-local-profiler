'use strict';

let createCanvas;
try {
    ({ createCanvas } = require('@napi-rs/canvas'));
} catch {
    createCanvas = null;
}

const W = 1080, H = 1080, PAD = 64;

function scoreColor(s) {
    if (s == null) return '#888888';
    if (s >= 80)   return '#22c55e';
    if (s >= 60)   return '#f59e0b';
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
    const dose  = ann.dose  != null ? `${ann.dose}g`  : null;
    const wt    = ann.totalWeight ?? ann.yield ?? null;
    const yld   = wt   != null ? `${(+wt).toFixed(1)}g`                     : null;
    const ratio = ann.dose && wt ? `1:${(wt / ann.dose).toFixed(1)}`         : null;
    const dur   = shot.duration  ? `${(shot.duration / 10).toFixed(0)}s`     : null;
    const dateStr = shot.timestamp
        ? new Date(shot.timestamp * 1000).toLocaleDateString('de-DE', { day:'2-digit', month:'short', year:'numeric' })
        : '';

    const pressure    = (dp.pressure       || []).map(v => v / 10);
    const targetPres  = (dp.targetPressure || []).map(v => v / 10);
    const sColor = scoreColor(score);

    // ── Background ──────────────────────────────────────────────────────────
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#100806');
    bg.addColorStop(1, '#1c0e08');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    ctx.strokeStyle = '#3d1f0a';
    ctx.lineWidth = 3;
    ctx.strokeRect(1.5, 1.5, W - 3, H - 3);

    // ── Header ──────────────────────────────────────────────────────────────
    const hg = ctx.createLinearGradient(0, 0, 0, 130);
    hg.addColorStop(0, 'rgba(0,0,0,0.55)');
    hg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = hg;
    ctx.fillRect(0, 0, W, 130);

    ctx.fillStyle = '#f59e0b';
    ctx.font = 'bold 64px serif';
    ctx.fillText('GLP', PAD, 84);

    ctx.fillStyle = '#7a4a25';
    ctx.font = '20px sans-serif';
    ctx.fillText('GAGGIUINO LOCAL PROFILER', PAD, 112);

    // Score circle
    if (score != null) {
        const scx = W - PAD - 54, scy = 68, r = 54;
        ctx.beginPath();
        ctx.arc(scx, scy, r + 8, 0, Math.PI * 2);
        ctx.fillStyle = `${sColor}1a`;
        ctx.fill();

        ctx.beginPath();
        ctx.arc(scx, scy, r, 0, Math.PI * 2);
        ctx.strokeStyle = sColor;
        ctx.lineWidth = 4;
        ctx.stroke();

        ctx.fillStyle = sColor;
        ctx.font = 'bold 46px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(String(score), scx, scy + 15);

        ctx.fillStyle = `${sColor}bb`;
        ctx.font = '19px sans-serif';
        ctx.fillText('SCORE', scx, scy + 38);
        ctx.textAlign = 'left';
    }

    // Separator
    const sg = ctx.createLinearGradient(PAD, 0, W - PAD, 0);
    sg.addColorStop(0, '#f59e0b');
    sg.addColorStop(1, '#7a2e0a');
    ctx.strokeStyle = sg;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(PAD, 143);
    ctx.lineTo(W - PAD, 143);
    ctx.stroke();

    // ── Profile + Bean ──────────────────────────────────────────────────────
    ctx.fillStyle = '#f5ddb0';
    ctx.font = 'bold 52px serif';
    let pName = profileName;
    const maxW = W - 2 * PAD - 160;
    while (ctx.measureText(pName).width > maxW && pName.length > 4)
        pName = pName.slice(0, -4) + '…';
    ctx.fillText(pName, PAD, 200);

    if (bean) {
        ctx.fillStyle = '#a07040';
        ctx.font = '29px sans-serif';
        ctx.fillText(bean, PAD, 242);
    }

    // ── Chart ───────────────────────────────────────────────────────────────
    const cx0 = PAD, cy0 = 278, cw = W - 2 * PAD, ch = 390;
    const maxBar = 12;

    roundRect(ctx, cx0, cy0, cw, ch, 10);
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.fill();

    ctx.save();
    roundRect(ctx, cx0, cy0, cw, ch, 10);
    ctx.clip();

    // Grid
    [3, 6, 9].forEach(bar => {
        const gy = cy0 + ch - (bar / maxBar) * ch;
        ctx.strokeStyle = 'rgba(90,40,15,0.45)';
        ctx.lineWidth = 1;
        ctx.setLineDash([5, 4]);
        ctx.beginPath();
        ctx.moveTo(cx0, gy);
        ctx.lineTo(cx0 + cw, gy);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#5a3015';
        ctx.font = '19px sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText(`${bar}`, cx0 + 36, gy + 7);
    });
    ctx.textAlign = 'left';

    // Target pressure (dashed, dim)
    if (targetPres.length > 2) {
        ctx.setLineDash([8, 6]);
        sparkline(ctx, targetPres, cx0, cy0, cw, ch, maxBar);
        ctx.strokeStyle = 'rgba(245,158,11,0.3)';
        ctx.lineWidth = 2;
        ctx.lineJoin = 'round';
        ctx.stroke();
        ctx.setLineDash([]);
    }

    if (pressure.length > 2) {
        // Fill under curve
        const fg = ctx.createLinearGradient(0, cy0, 0, cy0 + ch);
        fg.addColorStop(0, 'rgba(245,158,11,0.18)');
        fg.addColorStop(1, 'rgba(245,158,11,0)');

        sparkline(ctx, pressure, cx0, cy0, cw, ch, maxBar);
        ctx.lineTo(cx0 + cw, cy0 + ch);
        ctx.lineTo(cx0, cy0 + ch);
        ctx.closePath();
        ctx.fillStyle = fg;
        ctx.fill();

        // Glow
        ctx.shadowColor = '#f59e0b';
        ctx.shadowBlur = 14;
        sparkline(ctx, pressure, cx0, cy0, cw, ch, maxBar);
        ctx.strokeStyle = 'rgba(245,158,11,0.35)';
        ctx.lineWidth = 10;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.stroke();
        ctx.shadowBlur = 0;

        // Main line
        sparkline(ctx, pressure, cx0, cy0, cw, ch, maxBar);
        ctx.strokeStyle = '#f59e0b';
        ctx.lineWidth = 4;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.stroke();
    } else {
        ctx.fillStyle = 'rgba(90,40,15,0.6)';
        ctx.font = '26px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('keine Druckdaten', cx0 + cw / 2, cy0 + ch / 2);
        ctx.textAlign = 'left';
    }

    // bar label
    ctx.fillStyle = '#5a3015';
    ctx.font = '18px sans-serif';
    ctx.fillText('bar', cx0 + 40, cy0 + 22);

    ctx.restore();

    // ── Divider ─────────────────────────────────────────────────────────────
    ctx.strokeStyle = '#3d1f0a';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(PAD, cy0 + ch + 28);
    ctx.lineTo(W - PAD, cy0 + ch + 28);
    ctx.stroke();

    // ── Metadata ────────────────────────────────────────────────────────────
    const metaY = cy0 + ch + 56;
    const cols  = [['DOSE', dose], ['YIELD', yld], ['RATIO', ratio], ['DAUER', dur]].filter(([, v]) => v);
    if (cols.length) {
        const cw2 = (W - 2 * PAD) / cols.length;
        cols.forEach(([label, val], i) => {
            const mx = PAD + i * cw2;
            ctx.fillStyle = '#7a4a25';
            ctx.font = '19px sans-serif';
            ctx.fillText(label, mx, metaY);
            ctx.fillStyle = '#f5ddb0';
            ctx.font = 'bold 44px serif';
            ctx.fillText(val, mx, metaY + 48);
        });
    }

    // ── Footer ──────────────────────────────────────────────────────────────
    const footY = H - 56;
    const ftg = ctx.createLinearGradient(0, footY - 24, 0, H);
    ftg.addColorStop(0, 'rgba(0,0,0,0)');
    ftg.addColorStop(1, 'rgba(0,0,0,0.5)');
    ctx.fillStyle = ftg;
    ctx.fillRect(0, footY - 24, W, H - footY + 24);

    ctx.fillStyle = '#5a3015';
    ctx.font = '22px sans-serif';
    ctx.fillText(dateStr, PAD, footY + 18);

    ctx.textAlign = 'right';
    ctx.fillText('Gaggiuino Local Profiler', W - PAD, footY + 18);
    ctx.textAlign = 'left';

    return canvas.toBuffer('image/png');
}

module.exports = { generateShareCard, isAvailable: () => createCanvas !== null };
