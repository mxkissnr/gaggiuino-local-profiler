import { S }                               from '../../state.js';
import { t }                               from '../../i18n.js';
import { detectChanneling }                from '../../utils.js';
import { getShotData, calcShotScore }      from './utils.js';

// ── Mini chart thumbnail ───────────────────────────────────────────────────

export function _miniShotChart(shot) {
  const d  = shot.datapoints || {};
  const tm = d.timeInShot || [];
  const series = [
    { vals: (d.pressure  || []).map((v, i) => ({ x: tm[i] / 10, y: v / 10 })).filter(p => p.y > 0), color: '#60a5fa' },
    { vals: (d.pumpFlow  || []).map((v, i) => ({ x: tm[i] / 10, y: v / 10 })).filter(p => p.y >= 0), color: '#fb923c' },
  ].filter(s => s.vals.length >= 3);
  if (!series.length) return '<div class="comp-thumb-no-data">–</div>';

  const W = 140, H = 65, pad = 2;
  const allX = series.flatMap(s => s.vals.map(p => p.x));
  const allY = series.flatMap(s => s.vals.map(p => p.y));
  const xMin = Math.min(...allX), xMax = Math.max(...allX) || 1;
  const yMax = Math.max(...allY, 1);

  const px = x => pad + ((x - xMin) / (xMax - xMin)) * (W - pad * 2);
  const py = y => H - pad - (y / yMax) * (H - pad * 2);

  const polyline = ({ vals, color }) => {
    const pts = vals.map(p => `${px(p.x).toFixed(1)},${py(p.y).toFixed(1)}`).join(' ');
    return `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" opacity=".9"/>`;
  };
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:100%;height:${H}px;display:block">${series.map(polyline).join('')}</svg>`;
}

// ── Grind setting parser ───────────────────────────────────────────────────

export function _parseGrindNum(s) {
  if (!s) return null;
  const m = String(s).match(/(\d+(?:[.,]\d+)?)/);
  return m ? parseFloat(m[1].replace(',', '.')) : null;
}

// ── Grind advice ──────────────────────────────────────────────────────────

export function calcGrindAdvice(shot, data) {
  const secs = (shot.duration || 0) / 10;
  if (secs < 8) return null;
  const pTimes = data.pressure.map(p => p.x);
  const pAll   = data.pressure.map(p => p.y);
  if (detectChanneling(pTimes, pAll))
    return { type: 'warning', icon: '⚡', text: t('grind_channeling_full') };
  if (secs < 18) return { type: 'finer',   icon: '↓', text: t('grind_short', secs.toFixed(0)) };
  if (secs < 23) return { type: 'finer',   icon: '↓', text: t('grind_short_slight', secs.toFixed(0)) };
  if (secs > 50) return { type: 'coarser', icon: '↑', text: t('grind_long', secs.toFixed(0)) };
  if (secs > 42) return { type: 'coarser', icon: '↑', text: t('grind_long_slight', secs.toFixed(0)) };
  const pVals = pAll.filter(v => v >= 5);
  const avgP  = pVals.length ? pVals.reduce((a, b) => a + b, 0) / pVals.length : 0;
  return { type: 'ok', icon: '✓', text: `Mahlgrad passt – ${secs.toFixed(0)} s${avgP > 0 ? `, ${avgP.toFixed(1)} bar Ø` : ''}` };
}

export function calcComparativeGrindAdvice(shot, allShots) {
  const ann          = shot.annotation || {};
  const coffee       = ann.coffee?.trim().toLowerCase();
  const grinder      = ann.grinder?.trim().toLowerCase();
  const profile      = (shot.profile?.name || shot.profileName || '').trim().toLowerCase();
  const dose         = parseFloat(ann.dose) || null;
  const currentGrind = _parseGrindNum(ann.grindSetting);
  if (!coffee || !grinder) return null;

  const comparable = allShots.filter(s => {
    if (s.id === shot.id) return false;
    const a  = s.annotation || {};
    if (a.coffee?.trim().toLowerCase() !== coffee)   return false;
    if (a.grinder?.trim().toLowerCase() !== grinder) return false;
    if ((s.profile?.name || s.profileName || '').trim().toLowerCase() !== profile) return false;
    if (dose) {
      const sd = parseFloat(a.dose) || null;
      if (!sd || Math.abs(sd - dose) > 1) return false;
    }
    if (_parseGrindNum(a.grindSetting) === null) return false;
    return calcShotScore(s, getShotData(s)) !== null;
  });
  if (comparable.length < 1) return null;

  const byGrind = {};
  comparable.forEach(s => {
    const g   = _parseGrindNum(s.annotation.grindSetting);
    const sc  = calcShotScore(s, getShotData(s));
    const key = Math.round(g * 2) / 2;
    if (!byGrind[key]) byGrind[key] = [];
    byGrind[key].push(sc);
  });

  let bestSetting = null, bestAvg = -1;
  Object.entries(byGrind).forEach(([key, scores]) => {
    const a = scores.reduce((a, b) => a + b, 0) / scores.length;
    if (a > bestAvg) { bestAvg = a; bestSetting = parseFloat(key); }
  });
  if (bestSetting === null) return null;

  const n         = comparable.length;
  const bestScore = Math.round(bestAvg);
  const shots     = comparable
    .map(s => ({ shot: s, grind: _parseGrindNum(s.annotation.grindSetting), score: calcShotScore(s, getShotData(s)) }))
    .sort((a, b) => b.score - a.score);

  if (currentGrind === null)
    return { type: 'ok',      icon: '📊', text: t('grind_comparative_ok',      n, bestSetting, bestScore), shots };
  const diff = currentGrind - bestSetting;
  if (Math.abs(diff) < 0.6)
    return { type: 'ok',      icon: '📊', text: t('grind_comparative_ok',      n, bestSetting, bestScore), shots };
  if (diff > 0)
    return { type: 'finer',   icon: '📊', text: t('grind_comparative_finer',   n, bestSetting, bestScore), shots };
  return   { type: 'coarser', icon: '📊', text: t('grind_comparative_coarser', n, bestSetting, bestScore), shots };
}
