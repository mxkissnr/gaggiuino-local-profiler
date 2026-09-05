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
  let m = str.trim().match(/^(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{2,4})$/);
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

// ── Date-input helpers (#473) ────────────────────────────────────────────
// Native <input type="date"> always reads/writes ISO YYYY-MM-DD via .value
// (roastAgeDays above already parses that alongside the legacy DD.MM.YYYY
// text-field format, so no backend change was needed for existing fields).
// This normalizes either stored format into the YYYY-MM-DD a date input
// needs to pre-fill correctly when opening an edit form; returns '' (an
// empty, unset date input) when the string doesn't parse.
export function toIsoDateInput(str) {
  if (!str || typeof str !== 'string') return '';
  const s = str.trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{2,4})$/);
  if (m) {
    const y = m[3].length === 2 ? 2000 + parseInt(m[3]) : parseInt(m[3]);
    return `${y}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
  }
  return '';
}

// Today's date as YYYY-MM-DD in local time (not UTC — Date#toISOString()
// would roll over a day early/late depending on the user's timezone) — used
// as both the default value and the `max` of freeze-date-style pickers that
// shouldn't accept a future date.
export function todayIsoDate(nowMs = Date.now()) {
  const d = new Date(nowMs);
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${y}-${mo}-${da}`;
}

// Parses a date-input's YYYY-MM-DD value into a local-noon epoch ms
// timestamp (noon, not midnight, sidesteps DST-transition edge cases where
// local midnight doesn't exist or is ambiguous) — used wherever a picked
// date needs to become the epoch-ms timestamp the backend stores (e.g.
// frozenAt). Returns null for an empty/invalid value.
export function isoDateInputToMs(value) {
  const m = typeof value === 'string' && value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]), 12, 0, 0);
  return isNaN(d) ? null : d.getTime();
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

// ── Frozen portions (freeze/thaw) ────────────────────────────────────────
// #477: an earlier version discounted the bag's own freshness badge by the
// total time ANY portion spent frozen — but that badge represents the whole
// bag, including coffee that was never frozen and keeps aging normally.
// Freezing 20 of 500g doesn't pause the other 480g's clock, so the bag-level
// badge must always use plain roastAgeDays(), never an offset one.
//
// A frozen portion's OWN effective age is tracked separately here instead:
// it accrues normally up to frozenAt, then holds flat while (any of) it is
// still frozen (remainingCount > 0, no thawedAt), then resumes counting
// from thawedAt once closed out — i.e. its clock only runs while not frozen.
export function frozenPortionAgeDays(roastDateStr, portion, nowMs = Date.now()) {
  if (!portion || !(portion.frozenAt > 0)) return null;
  const ageAtFreeze = roastAgeDays(roastDateStr, portion.frozenAt);
  if (ageAtFreeze == null) return null;
  if (!(portion.thawedAt > portion.frozenAt)) return ageAtFreeze;
  const daysSinceThaw = Math.floor((nowMs - portion.thawedAt) / 86400000);
  return ageAtFreeze + Math.max(0, daysSinceThaw);
}

// A stock-tracked bean with nothing left shouldn't nag about freshness — the
// badge is only meaningful while there's still coffee to brew. Beans with no
// stock tracking at all (stock_g unset, remaining is null) keep showing it.
export function shouldShowFreshBadge(stock_g, remaining) {
  return !(stock_g > 0 && remaining !== null && remaining <= 0);
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

// ── Share-or-download a file blob ──────────────────────────────────────────
// Plain Blob + <a download> + click() is unreliable on mobile Safari and
// in-app browsers (silently no-ops instead of saving the file). Prefer the
// native Web Share sheet when the platform supports sharing files, falling
// back to the classic anchor-click download otherwise (typically desktop).
//
// fallbackOnError: when navigator.share() itself fails for a reason other
// than the user cancelling (AbortError), default behavior falls back to the
// anchor download so the user still gets their file; pass false to instead
// let the error propagate to the caller (e.g. to show its own alert).
export async function shareOrDownloadBlob(blob, filename, { title, fallbackOnError = true } = {}) {
  const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return; // user cancelled — respect it, no fallback
      if (!fallbackOnError) throw e;
      // else: fall through to the anchor-download fallback below
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
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

// mapShotDatapoints(datapoints) -> the XY-series bundle the shot charts and
// metrics read. Split out of views/shots/utils.js's getShotData (#957) so the
// per-shot curve cache (shot-curves.js) maps a lazily-fetched datapoints
// object through the exact same shape. Pure; a missing/empty datapoints
// yields all-empty series, never null. Kept in this leaf module (no imports)
// so shot-curves.js can depend on it without an import cycle.
export function mapShotDatapoints(datapoints) {
  const d = datapoints || {};
  const t = d.timeInShot || [];
  return {
    rawTimes:       t.map(v => v / 10),
    pressure:       mapToXY(t, d.pressure),
    targetPressure: mapToXY(t, d.targetPressure),
    flow:           mapToXY(t, d.pumpFlow),
    targetFlow:     mapToXY(t, d.targetPumpFlow),
    weight:         mapToXY(t, d.shotWeight || d.weight),
    // bleScaleConnected is set by GaggiMate shots: true = real BLE scale weight,
    // false = volumetric estimate. For Gaggiuino shots (no flag), fall back to
    // checking whether shotWeight is present (Gaggiuino only stores shotWeight
    // when a real BLE scale was connected during that shot).
    weightIsReal:   d.bleScaleConnected != null ? d.bleScaleConnected === true : !!(d.shotWeight?.length),
    weightFlow:     mapToXY(t, d.weightFlow),
    temp:           mapToXY(t, d.temperature),
    targetTemp:     mapToXY(t, d.targetTemperature),
  };
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
  const m = s.match(/^(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{2,4})$/);
  if (!m) return null;
  const y = m[3].length === 2 ? 2000 + parseInt(m[3]) : parseInt(m[3]);
  const d = new Date(y, parseInt(m[2]) - 1, parseInt(m[1]));
  return isNaN(d) ? null : d;
}

// ── Day-separator grouping (#412, hybrid grouping #426) ─────────────────
// Buckets a shot list (any order — each shot just needs a `timestamp`, unix
// seconds) into contiguous groups for the sidebar's separator headers. Pure
// function: the "today" reference and all labels/formatters are passed in
// rather than read from Date.now()/i18n, so boundary behavior is testable
// without faking globals.
//
// Grouping tiers:
//   - today / yesterday  -> todayLabel / yesterdayLabel, one bucket each,
//                           tier: 'day'
//   - 2..13 days ago      -> per-day bucket, label = formatRecent(date),
//                            tier: 'day'
//   - 14+ days ago        -> per-MONTH bucket (multiple old days in the same
//                            month merge into one group), label =
//                            formatOlder(date), tier: 'month'
// Letting the caller supply formatRecent/formatOlder keeps this module free
// of locale/i18n knowledge (e.g. LOCALE_MAP + toLocaleDateString).
// The `tier` field (#439) lets the sidebar tell recent day-headers (always
// expanded, non-interactive) apart from month-headers (collapsible
// accordion, restoring pre-#399 behavior) without inferring it from key
// shape/length.
const RECENT_WINDOW_DAYS = 14; // today(0) + yesterday(1) + 12 more per-day buckets

export function groupShotsByDay(shots, now, todayLabel, yesterdayLabel, formatRecent, formatOlder) {
  const dayKey = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const monthKey = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());

  const today = dayKey(now);
  const yesterdayDate = new Date(now);
  yesterdayDate.setDate(now.getDate() - 1);
  const yesterday = dayKey(yesterdayDate);
  const todayStart = startOfDay(now);

  const groups = [];
  let current = null;
  (shots || []).forEach(shot => {
    const d = new Date(shot.timestamp * 1000);
    const dKey = dayKey(d);
    const daysAgo = Math.round((todayStart - startOfDay(d)) / 86400000);
    const isRecent = daysAgo < RECENT_WINDOW_DAYS;
    const key = isRecent ? dKey : monthKey(d);
    if (!current || current.key !== key) {
      const label = dKey === today ? todayLabel
        : dKey === yesterday ? yesterdayLabel
        : isRecent ? formatRecent(d)
        : formatOlder(d);
      current = { key, label, tier: isRecent ? 'day' : 'month', shots: [] };
      groups.push(current);
    }
    current.shots.push(shot);
  });
  return groups;
}

// ── Score helpers ─────────────────────────────────────────────────────────
// Unified 3-tier scale (#397): green >= 90, yellow >= 70, red below — the
// single source of truth for shot-score coloring across sidebar, shot
// detail, analytics, and the dial-in wizards. No per-view thresholds.
export function scoreClass(n) {
  return n >= 90 ? 'score-great' : n >= 70 ? 'score-ok' : 'score-bad';
}

// Returns a CSS custom-property reference so callers stay theme-aware
// (accent/light-dark) instead of a hardcoded hex.
export function scoreColor(sc) {
  if (sc == null) return 'var(--gray-600)';
  return sc >= 90 ? 'var(--ok)' : sc >= 70 ? 'var(--warn)' : 'var(--err)';
}

// Signed delta formatting for the same-profile auto-compare chips (#402):
// "+2", "−0.3 bar", "±0" — a real minus sign (−, U+2212) rather than a
// hyphen, matching how the rest of the app renders negative deltas.
export function formatDelta(value, decimals = 0, unit = '') {
  if (value == null) return null;
  const rounded = Number(value.toFixed(decimals));
  const sign = rounded > 0 ? '+' : rounded < 0 ? '−' : '±';
  return `${sign}${Math.abs(rounded).toFixed(decimals)}${unit}`;
}

// #814: Chart.js cannot read CSS custom properties — it needs resolved colour
// values at construction time. Every chart in the app was therefore configured
// with hardcoded dark-theme hexes (#e4e4e7 legend, #a1a1aa ticks, #27272a
// grid), which meant charts kept dark chrome on a light page: the legend and
// axis labels measured roughly 1.3:1 against the light background, i.e.
// effectively invisible.
//
// Resolve them from the tokens instead. MUST be called at render time, not at
// module load: the value is whatever the active theme resolves to right now,
// and a value captured at import time would be frozen to whichever theme
// happened to be active when the module first loaded.
export function themeColor(varName, fallback = '') {
  if (typeof getComputedStyle !== 'function' || typeof document === 'undefined') return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(varName).trim() || fallback;
}

// The three roles every chart needs. Fallbacks are the old dark-theme values,
// so a chart still renders sanely if this is somehow called before the
// stylesheet has applied.
export function chartColors() {
  return {
    text: themeColor('--gray-200', '#e4e4e7'),  // legend / dataset labels
    tick: themeColor('--gray-500', '#a1a1aa'),  // axis tick labels
    grid: themeColor('--gray-700', '#27272a'),  // grid lines
  };
}

// #814: fired by _applyTheme() in main.js after the theme attribute changes.
// A chart already on screen keeps the colours it was built with, so views
// holding a live Chart instance listen for this and rebuild — without it,
// switching theme in Settings leaves every open chart on the old palette
// until something else happens to re-render it.
export const THEME_CHANGE_EVENT = 'glp-theme-change';

export function onThemeChange(handler) {
  window.addEventListener(THEME_CHANGE_EVENT, handler);
  return () => window.removeEventListener(THEME_CHANGE_EVENT, handler);
}

// #814: repaints a live Chart.js instance's CHROME (legend, ticks, grid) to the
// current theme. Only touches the three chrome roles — dataset colours are the
// Okabe-Ito series palette and are deliberately theme-independent, so a series
// keeps meaning the same thing in both themes.
//
// Updating in place rather than rebuilding: a rebuild would lose zoom/pan
// state and restart the intro animation on every theme switch, and there is
// nothing about a colour change that requires new geometry.
export function applyChartTheme(chart) {
  if (!chart || !chart.options) return;
  const C = chartColors();
  const legend = chart.options.plugins?.legend?.labels;
  if (legend) legend.color = C.text;
  for (const axis of Object.values(chart.options.scales || {})) {
    if (!axis) continue;
    if (axis.ticks) axis.ticks.color = C.tick;
    // Leave grid.color alone where the axis deliberately draws no grid
    // (drawOnChartArea:false) — writing a colour there would be harmless but
    // misleading to read later.
    if (axis.grid && axis.grid.drawOnChartArea !== false) axis.grid.color = C.grid;
  }
  chart.update('none');   // 'none' = no animation; this is a repaint, not a transition
}
