// ── HTML escaping (XSS prevention) ───────────────────────────────────────
export function esc(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Roast freshness ───────────────────────────────────────────────────────
// Roast dates appear in two formats across the app: DD.MM.YYYY (bean form,
// TT.MM.JJJJ placeholder) and YYYY-MM-DD (ISO, bags & imports). Returns whole
// days since roast, or null when unparseable / implausible (>2 years).
export function roastAgeDays(str, nowMs = Date.now()) {
  if (!str || typeof str !== 'string') return null;
  let d = null;
  let m = str.trim().match(/^(\d{1,2})[.\-\/](\d{1,2})[.\-\/](\d{2,4})$/);
  if (m) {
    const y = m[3].length === 2 ? 2000 + parseInt(m[3]) : parseInt(m[3]);
    d = new Date(y, parseInt(m[2]) - 1, parseInt(m[1]));
  } else {
    m = str.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) d = new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]));
  }
  if (!d || isNaN(d)) return null;
  const days = Math.floor((nowMs - d.getTime()) / 86400000);
  return days >= 0 && days <= 730 ? days : null;
}

// Same windows as the degassing tracker in the annotation panel.
export function freshnessState(days) {
  if (days == null) return null;
  if (days < 4)   return 'degassing';
  if (days < 7)   return 'almost';
  if (days <= 21) return 'peak';
  if (days <= 35) return 'fading';
  return 'old';
}

// ── Brew ratio ────────────────────────────────────────────────────────────
// Final weight / annotated dose; null when either side is missing or absurd.
export function calcBrewRatio(shot, data) {
  const dose = parseFloat(shot?.annotation?.dose);
  if (!dose || dose < 5 || dose > 30) return null;
  const w = data?.weight;
  const yieldG = w?.length ? w[w.length - 1].y : null;
  if (!yieldG || yieldG < 5) return null;
  const ratio = yieldG / dose;
  return ratio > 0.5 && ratio < 6 ? ratio : null;
}

// ── Bean rating ───────────────────────────────────────────────────────────
// Average star rating (1-5) across all shots annotated with this bean name
// (case-insensitive, same join precedent as computeBeanRemaining). Returns
// { avg, count } or null when no rated shot matches.
export function calcBeanRating(beanName, shots) {
  if (!beanName || !Array.isArray(shots)) return null;
  const name = beanName.toLowerCase();
  const ratings = shots
    .filter(s => (s.annotation?.coffee || '').toLowerCase() === name)
    .map(s => parseFloat(s.annotation?.rating))
    .filter(r => r >= 1 && r <= 5);
  if (!ratings.length) return null;
  const mean = ratings.reduce((a, b) => a + b, 0) / ratings.length;
  return { avg: Math.round(mean * 10) / 10, count: ratings.length };
}

// ── Math helpers ──────────────────────────────────────────────────────────
export function avg(arr) {
  if (!arr?.length) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

export function avgActive(arr, t = 0.5) {
  if (!arr?.length) return null;
  const active = arr.filter(v => v > t);
  return active.length ? active.reduce((a, b) => a + b, 0) / active.length : arr[arr.length - 1];
}

export function max(arr) {
  if (!arr?.length) return null;
  return arr.reduce((m, v) => v > m ? v : m, arr[0]);
}

export function safeLast(arr) {
  if (!arr?.length) return null;
  for (let i = arr.length - 1; i >= 0; i--)
    if (arr[i] != null && !isNaN(arr[i])) return arr[i];
  return null;
}

export function stddev(arr) {
  if (!arr?.length) return null;
  const m = arr.reduce((a, b) => a + b, 0) / arr.length;
  return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length);
}

// ── Formatting ────────────────────────────────────────────────────────────
export function fmt(v, unit = '') {
  return v == null ? '-' : `${v.toFixed(1)}${unit}`;
}

export function formatTimeLabel(s) {
  if (s == null || isNaN(s)) return '00:00';
  return `${Math.floor(s / 60).toString().padStart(2, '0')}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
}

// ── Data mapping ──────────────────────────────────────────────────────────
export function mapToXY(timeArr, dataArr) {
  if (!timeArr || !dataArr) return [];
  return timeArr
    .map((t, i) => ({ x: t / 10, y: dataArr[i] != null ? dataArr[i] / 10 : null }))
    .filter(pt => pt.y !== null);
}

// ── Phase detection ───────────────────────────────────────────────────────
export function detectPhases(times, pressures) {
  if (!times?.length || pressures?.length < 5) return null;
  const THRESH = 3.5;
  let endIdx = -1;
  for (let i = 0; i < pressures.length; i++) {
    if (times[i] >= 1 && pressures[i] >= THRESH) { endIdx = i; break; }
  }
  if (endIdx <= 0) return null;
  const preinfusion = times[endIdx];
  if (preinfusion < 1.5) return null;
  return { preinfusion, extraction: times[times.length - 1] - preinfusion };
}

// ── Channeling detection ──────────────────────────────────────────────────
export function detectChanneling(times, pressures) {
  if (!times?.length || pressures?.length < 5) return false;
  for (let i = 1; i < pressures.length; i++) {
    if (pressures[i - 1] < 5) continue;
    const dt = times[i] - times[i - 1];
    if (dt <= 0 || dt > 3) continue;
    if (pressures[i - 1] - pressures[i] > 1.5) return true;
  }
  return false;
}

// ── Date helpers ──────────────────────────────────────────────────────────
export function isoToGerman(iso) {
  if (!iso) return '';
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : iso;
}

export function germanToIso(s) {
  if (!s) return null;
  const m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

export function parseDMY(s) {
  if (!s) return null;
  const m = s.match(/^(\d{1,2})[.\-\/](\d{1,2})[.\-\/](\d{2,4})$/);
  if (!m) return null;
  const y = m[3].length === 2 ? 2000 + parseInt(m[3]) : parseInt(m[3]);
  const d = new Date(y, parseInt(m[2]) - 1, parseInt(m[1]));
  return isNaN(d) ? null : d;
}

// ── Score helpers ─────────────────────────────────────────────────────────
export function scoreClass(n) {
  return n >= 88 ? 'score-great' : n >= 75 ? 'score-good' : n >= 60 ? 'score-ok' : n >= 45 ? 'score-poor' : 'score-bad';
}

export function scoreColor(sc) {
  return sc >= 88 ? '#16a34a' : sc >= 75 ? '#65a30d' : sc >= 60 ? '#ca8a04' : sc >= 45 ? '#ea580c' : '#dc2626';
}
