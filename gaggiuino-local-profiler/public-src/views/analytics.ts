import Chart from 'chart.js/auto';
import { S } from '../state/index.js';
import * as chartRegistry from '../state/charts.js';
import { t, tHtml } from '../i18n.js';
import { localeFor } from '../constants.js';
import { esc, html, joinHtml, scoreClass, chartColors, themeColor } from '../utils.js';
import type { Html } from '../utils.js';
import { _parseGrindNum } from './shots/grind.js';
import { _equipmentName } from './shots/index.js';
import { summaryLine } from './analytics-summary.js';
import type { AnalyticsPageFilter } from './analytics-summary.js';
import { WARNING_ICON_SVG } from '../icons.js';
import { openDetailSheet } from '../components/detail-sheet.js';
import type { DetailAnchorPoint } from '../components/detail-sheet.js';
import type { ChartConfiguration, TooltipItem } from 'chart.js';
import { _chartCanvas, _counterPeriod, _counterText, _dateFromKey, _dayKeyNum, _dayKeyOf, _keyFromNum, _libCollection, _machineScopeSuffix, _machines, _mutedTickColor, _pageFilter, _pageShots, _profileNameOf, _saveAnalyticsFilter, _scoreChartColor } from './analytics/shared.js';
import type { EquipKey, EquipStat, EquipStatEntry, ShotRow } from './analytics/shared.js';
import { buildCalendar, openCalendarDayDetail } from './analytics/calendar.js';
import { buildWorldMap } from './analytics/world-map.js';
import { buildBeanShelf } from './analytics/bean-shelf.js';
import { buildFacts } from './analytics/facts.js';
import { buildMachineComparison } from './analytics/machine-comparison.js';
import { buildDialinProgression } from './analytics/dialin-progression.js';

export { getAnalyticsFilter } from './analytics/shared.js';
export { _MONTH_LABEL_MIN_COLUMNS, _monthLabelsToDraw, _renderCalendar, _renderStreaks, buildCalendar, computeCalendarStats, openCalendarDayDetail } from './analytics/calendar.js';
export type { CalendarStats, MonthLabelStart } from './analytics/calendar.js';
export { buildWorldMap, computeMapBoundingCoords, featureBounds, featureLabelPoint, greatCircleKm, homeCountryFromLocale, originFrameCoords, resolveWorldMapColors, splitAntimeridianRing, worldMapTooltipFormatter } from './analytics/world-map.js';
export { _computeBeanRanking, _sortBeanShelfRows, buildBeanShelf, expandBeanShelf, openBeanShelfDetail, setBeanShelfSort } from './analytics/bean-shelf.js';
export { buildFacts, openFactDetail, shuffleFacts } from './analytics/facts.js';
export { _computeMachineComparison, buildMachineComparison } from './analytics/machine-comparison.js';
export { buildDialinProgression, setDialinProgressionBean } from './analytics/dialin-progression.js';

// Whether the viewer left the "More insights" fold open (#1467).
const ANALYTICS_MORE_KEY = 'glp.analyticsMore.open';

// Toolbar entry point: updates the shared filter, persists it and re-runs the
// whole page once.
export function setAnalyticsFilter(patch: Partial<AnalyticsPageFilter>): void {
  if (patch.days === 7 || patch.days === 30 || patch.days === 90 || patch.days === 0) _pageFilter.days = patch.days;
  if (typeof patch.query === 'string') _pageFilter.query = patch.query;
  _saveAnalyticsFilter();
  rebuildAnalyticsPage();
}

// ── "More insights" fold (#1467) ───────────────────────────────────────────
// The rarer charts live in a <details> that is closed by default. Chart.js and
// ECharts cannot measure a hidden canvas, so their builders run only once the
// fold is open — and on later filter changes only while it stays open. The
// viewer's open/closed choice is remembered across visits.
function _moreFold(): HTMLDetailsElement | null {
  return document.getElementById('analyticsMore') as HTMLDetailsElement | null;
}

// Pure decision behind the lazy fold, exported so a test can pin "closed → no
// build, first open → build" without a DOM.
export function shouldBuildAnalyticsMore(foldOpen: boolean, pageEmpty: boolean): boolean {
  return foldOpen && !pageEmpty;
}

function _saveMoreOpen(open: boolean): void {
  try { localStorage.setItem(ANALYTICS_MORE_KEY, open ? '1' : '0'); } catch { /* private mode / quota */ }
}

let _moreWired = false;

// Pure decision behind the fold's grey counter, exported for the test: the
// machine comparison stays hidden until >= 2 machines exist, and a section the
// empty filter hid is left out.
export function countVisibleMoreSections(sections: { id: string; periodHidden: boolean }[], machineCount: number): number {
  return sections.filter(s => !(s.id === 'machineComparisonCard' && machineCount < 2) && !s.periodHidden).length;
}

function _moreSectionCount(fold: HTMLElement): number {
  const sections = Array.from(fold.querySelectorAll<HTMLElement>('.analytics-sec')).map(el => {
    const periodWrap = el.closest<HTMLElement>('[data-analytics-period]');
    return { id: el.id, periodHidden: !!periodWrap && periodWrap.style.display === 'none' };
  });
  return countVisibleMoreSections(sections, (_machines() || []).length);
}

function _updateMoreCount(): void {
  const fold = _moreFold();
  const countEl = document.getElementById('analyticsMoreCount');
  if (!fold || !countEl) return;
  countEl.textContent = t('analytics_more_count', _moreSectionCount(fold));
}

function _rebuildMore(): void {
  const fold = _moreFold();
  if (!fold || !fold.open) return;
  // The machine comparison reads the whole history and renders a table, not a
  // canvas, so it belongs to no filter and stays correct for an empty filter.
  // The filter-bound charts below only run when the filter has shots.
  buildMachineComparison();
  _updateMoreCount();
  if (!shouldBuildAnalyticsMore(fold.open, _pageShots().length === 0)) return;
  buildProfileChart();
  buildGrinderStats();
  buildBasketStats();
  buildPuckScreenStats();
  buildDistribution();
  buildTimeOfDay();
  buildWeekdayHourHeatmap();
  buildDialinProgression();
}

// Restore the remembered fold state, wire its toggle and keep the grey section
// counter in the viewer's language. boot/views.ts calls this with the rest of the
// analytics toolbar wiring; initAnalytics() calls it again (it is idempotent)
// so the counter follows a language switch.
export function initAnalyticsMoreFold(): void {
  const fold = _moreFold();
  if (!fold) return;
  if (!_moreWired) {
    _moreWired = true;
    try { fold.open = localStorage.getItem(ANALYTICS_MORE_KEY) === '1'; } catch { /* private mode */ }
    fold.addEventListener('toggle', () => {
      _saveMoreOpen(fold.open);
      // Only build while the analytics view is on screen: a programmatic open
      // at startup must not measure hidden canvases.
      if (fold.open && S.currentMode === 'analytics') _rebuildMore();
    });
  }
  _updateMoreCount();
}

// ── Analytics entry point ─────────────────────────────────────────────────
export function initAnalytics() {
  // #957: S.allShots is filled by a background page walk after the Shots tab
  // first paints. Analytics is a whole-history view — build from whatever is
  // loaded now, and re-run once the walk finishes so the numbers settle on
  // the full history. (Builders below read S.allShots / S.shots directly.)
  if (!S.allShotsLoaded) {
    window.onAllShotMetaLoaded = () => { window.onAllShotMetaLoaded = null; initAnalytics(); };
  }
  initAnalyticsMoreFold();
  rebuildAnalyticsPage();
  buildCalendar();
  buildFacts();
}

// Re-runs every builder that honours the toolbar's period/query, and applies
// the empty state: an all-empty filter shows one quiet line and hides those
// sections instead of drawing empty charts. The whole-history sections
// (coffee year, lifetime facts) are rebuilt separately by initAnalytics(); the
// folded charts run only while the fold is open, with the machine comparison
// exempt from the empty state because it reads the whole history.
export function rebuildAnalyticsPage(): void {
  const empty = _pageShots().length === 0;
  const emptyEl = document.getElementById('analyticsFilterEmpty');
  if (emptyEl) emptyEl.style.display = empty ? '' : 'none';
  document.querySelectorAll<HTMLElement>('[data-analytics-period]').forEach(el => {
    el.style.display = empty ? 'none' : '';
  });

  // Runs before the empty-state return: the fold's machine comparison is not
  // filter-bound, and the filter-bound charts inside the fold skip themselves.
  _rebuildMore();
  if (empty) return;

  buildSummaryKpis();
  buildTrendChart();
  buildRecipeSummary();
  buildBeanShelf();
  void buildWorldMap();
}

// ── Verdict header (#1467) ────────────────────────────────────────────────
// Replaces the old one-line "Übersicht" card: a plain-language verdict on the
// left (title + sub line) and the period's average score on the right. Reads
// the period-filtered shots and passes the period length to summaryLine() so
// its numbers match the toolbar.
export function buildSummaryKpis() {
  const titleEl = document.getElementById('verdictTitle');
  const subEl = document.getElementById('verdictSub');
  const scoreEl = document.getElementById('verdictScore');
  if (!titleEl || !subEl || !scoreEl) return;

  const days = _pageFilter.days;
  const summary = summaryLine(
    _pageShots(),
    s => (window.calcShotScore ? window.calcShotScore(s) : null),
    Date.now(),
    days,
  );

  const bucket = summary.delta?.bucket;
  titleEl.textContent = t(
    bucket === 'well-above' || bucket === 'above' ? 'analytics_verdict_title_up'
    : bucket === 'on-par' ? 'analytics_verdict_title_steady'
    : bucket === 'below' || bucket === 'well-below' ? 'analytics_verdict_title_down'
    : 'analytics_verdict_title_none',
  );

  const period = days === 0 ? t('analytics_period_all') : t('analytics_period_days', days);
  subEl.textContent = t('analytics_verdict_sub', summary.verdict.shots, period)
    + (summary.delta ? ` · ${t(`analytics_summary_delta_${summary.delta.bucket}`, summary.delta.avg7)}` : '')
    + _machineScopeSuffix();

  const avg = summary.verdict.avgScore;
  scoreEl.className = avg !== null ? `analytics-verdict-score-num ${scoreClass(avg)}` : 'analytics-verdict-score-num';
  scoreEl.textContent = avg !== null ? String(avg) : '—';

  // Trend warning: check last 5 scored shots for declining trend
  const scored = _pageShots().filter(s => window.calcShotScore && window.calcShotScore(s) != null);
  const warnEl = document.getElementById('trendWarning');
  if (warnEl) {
    const recent = scored.slice(-5);
    if (recent.length >= 3 && window.calcShotScore) {
      const recentScores = recent.map(s => window.calcShotScore!(s) ?? 0);
      const n = recentScores.length;
      const xs = recentScores.map((_, i) => i);
      const xm = (n - 1) / 2;
      const ym = recentScores.reduce((a, b) => a + b, 0) / n;
      const slope = xs.reduce((s, x, i) => s + (x - xm) * ((recentScores[i] ?? 0) - ym), 0) /
                    xs.reduce((s, x) => s + (x - xm) ** 2, 0);
      if (slope < -1.5) {
        const drop = Math.abs(slope).toFixed(1);
        warnEl.className = 'trend-warning';
        // #811: the ⚠ glyph came out of the translated string; the icon is
        // rendered here instead so translators never carry markup. `n`/`drop`
        // are numbers computed above, so there is no untrusted input here.
        warnEl.innerHTML = html`${WARNING_ICON_SVG} ${esc(t('analytics_trend_warning', n, drop))}`;
        warnEl.style.display = '';
      } else {
        warnEl.style.display = 'none';
      }
    } else {
      warnEl.style.display = 'none';
    }
  }
}

// ── Grinder, Basket & Puck Screen Stats (#668, #674) ────────────────────────
// Score-by-equipment groupings sharing one aggregation/rendering pair.
// Grinder is a free-text name stored directly on the annotation; baskets/
// puck screens are pure ID-based library links (#635), so resolving id ->
// name needs a lookup (_equipmentName() from views/shots/index.ts). Grouped
// by whatever getKey() returns (a grinder name, or a basket/puck-screen id
// as a string via Object.entries) rather than by the resolved name, so two
// same-named baskets (go/internal/library (baskets) enforces no uniqueness)
// still render as separate cards — the name is only resolved for display,
// after grouping.

// Pure aggregation kept separate from rendering, same pattern as
// _computeBeanRanking() below — unit-testable without a DOM.
// getKey(shot) returns the raw grouping key for a shot (grinder's name, or
// an equipment id), or null/undefined to skip that shot. getName(key)
// resolves the display name for a key -- identity for grinder (the key
// already is the name), or a library id->name lookup for basket/puck screen.
export function _computeEquipmentStats(
  shots: ShotRow[],
  getKey: (s: ShotRow) => EquipKey | null | undefined,
  getName: (key: string) => string | null,
): EquipStatEntry[] {
  const byEquip: Record<EquipKey, EquipStat> = {};
  for (const s of shots) {
    const key = getKey(s);
    if (key == null) continue;
    let stat = byEquip[key];
    if (!stat) { stat = { count: 0, scores: [], durations: [] }; byEquip[key] = stat; }
    stat.count++;
    const sc = window.calcShotScore ? window.calcShotScore(s) : null;
    if (sc !== null) stat.scores.push(sc);
    const dur = (s.duration || 0) / 10;
    if (dur > 5) stat.durations.push(dur);
  }
  return Object.entries(byEquip)
    .map(([key, d]) => {
      const name = getName(key);
      return name ? {
        name,
        count:   d.count,
        avgScore: d.scores.length    ? Math.round(d.scores.reduce((a, b) => a + b, 0) / d.scores.length) : null,
        bestScore: d.scores.length   ? Math.max(...d.scores) : null,
        avgDuration: d.durations.length ? Math.round((d.durations.reduce((a, b) => a + b, 0) / d.durations.length) * 10) / 10 : null,
      } : null;
    })
    // A basket/puck screen deleted from the library after being annotated
    // on past shots resolves to no name here — dropped rather than shown
    // as a blank card, same "silently omitted" precedent the rest of this
    // file uses for missing data (e.g. no-earlier-same-profile-shot).
    .filter((e): e is EquipStatEntry => e !== null)
    .sort((a, b) => b.count - a.count);
}

function _renderEquipmentStats(containerId: string, entries: EquipStatEntry[], emptyKey: string): void {
  const el = document.getElementById(containerId);
  if (!el) return;
  if (entries.length === 0) {
    el.innerHTML = html`<p class="empty-note">${tHtml(emptyKey)}</p>`;
    return;
  }
  const cards = entries.map(d => html`<div class="bean-card">
      <div class="bean-card-name" title="${esc(d.name)}">${esc(d.name)}</div>
      <div class="bean-card-stats">
        <div class="bean-stat"><span class="bean-stat-val">${esc(d.count)}</span><span class="bean-stat-lbl">${tHtml('bean_stat_shots')}</span></div>
        ${d.avgScore    !== null ? html`<div class="bean-stat"><span class="bean-stat-val ${esc(scoreClass(d.avgScore))}">${esc(d.avgScore)}</span><span class="bean-stat-lbl">${tHtml('bean_stat_avg')}</span></div>` : esc('')}
        ${d.bestScore   !== null ? html`<div class="bean-stat"><span class="bean-stat-val">${esc(d.bestScore)}</span><span class="bean-stat-lbl">${tHtml('bean_stat_best')}</span></div>` : esc('')}
        ${d.avgDuration !== null ? html`<div class="bean-stat"><span class="bean-stat-val">${esc(d.avgDuration)}s</span><span class="bean-stat-lbl">${tHtml('bean_stat_duration')}</span></div>` : esc('')}
      </div>
    </div>`);
  el.innerHTML = html`<div class="bean-cards">${joinHtml(cards)}</div>`;
}

export function buildGrinderStats() {
  const entries = _computeEquipmentStats(
    _pageShots(),
    s => s.annotation?.grinder || null,
    key => key,
  );
  _renderEquipmentStats('grinderStats', entries, 'analytics_no_grinders');
}

export function buildBasketStats() {
  const entries = _computeEquipmentStats(
    _pageShots(),
    s => s.annotation?.basketId,
    id => _equipmentName(_libCollection('baskets'), Number(id)),
  );
  _renderEquipmentStats('basketStats', entries, 'analytics_no_baskets');
}

export function buildPuckScreenStats() {
  const entries = _computeEquipmentStats(
    _pageShots(),
    s => s.annotation?.puckScreenId,
    id => _equipmentName(_libCollection('puckScreens'), Number(id)),
  );
  _renderEquipmentStats('puckScreenStats', entries, 'analytics_no_puckscreens');
}

// ── Distributions ─────────────────────────────────────────────────────────
export function buildDistribution() {
  _buildDoseDist();
  _buildRatioDist();
}

function _buildDoseDist() {
  const ctx = _chartCanvas('doseDistChart');
  if (!ctx) return;
  chartRegistry.dispose('doseDistChart');
  const doses = _pageShots().map(s => s.annotation?.dose).filter((d): d is number => d != null && d > 5 && d < 50);
  if (doses.length < 5) {
    ctx.parentElement!.innerHTML = html`<p class="empty-note pad-top">${tHtml('analytics_no_distribution')}</p>`;
    return;
  }
  const lo = Math.floor(Math.min(...doses) * 2) / 2;
  const hi = Math.ceil(Math.max(...doses) * 2) / 2;
  const buckets: Record<string, number> = {};
  for (let b = lo; b <= hi + 0.001; b += 0.5) buckets[b.toFixed(1)] = 0;
  for (const d of doses) { const k = (Math.floor(d * 2) / 2).toFixed(1); if (k in buckets) buckets[k] = (buckets[k] ?? 0) + 1; }
  chartRegistry.set('doseDistChart', new Chart(ctx, {
    type: 'bar',
    data: { labels: Object.keys(buckets).map(k => k + 'g'),
            datasets: [{ data: Object.values(buckets), backgroundColor: 'rgba(239,68,68,.6)', borderRadius: 3, borderSkipped: false }] },
    options: { responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: _mutedTickColor(), font: { size: 10 } }, grid: { display: false } },
        y: { ticks: { color: _mutedTickColor(), font: { size: 10 }, precision: 0 }, grid: { color: themeColor('--gray-700', '#2b2f33') } }
      }
    }
  } satisfies ChartConfiguration<'bar'>));
}

function _buildRatioDist() {
  const ctx = _chartCanvas('ratioDistChart');
  if (!ctx) return;
  chartRegistry.dispose('ratioDistChart');
  const ratios = _pageShots()
    .map(s => s.annotation?.dose && s.weight ? (s.weight / 10) / s.annotation.dose : null)
    .filter((r): r is number => r != null && r > 1 && r < 4);
  if (ratios.length < 5) {
    ctx.parentElement!.innerHTML = html`<p class="empty-note pad-top">${tHtml('analytics_no_distribution')}</p>`;
    return;
  }
  const lo = Math.floor(Math.min(...ratios) * 10) / 10;
  const hi = Math.ceil(Math.max(...ratios) * 10) / 10;
  const buckets: Record<string, number> = {};
  for (let b = lo; b <= hi + 0.001; b += 0.1) buckets[b.toFixed(1)] = 0;
  for (const r of ratios) { const k = (Math.floor(r * 10) / 10).toFixed(1); if (k in buckets) buckets[k] = (buckets[k] ?? 0) + 1; }
  chartRegistry.set('ratioDistChart', new Chart(ctx, {
    type: 'bar',
    data: { labels: Object.keys(buckets).map(k => '1:' + k),
            datasets: [{ data: Object.values(buckets), backgroundColor: 'rgba(132,204,22,.6)', borderRadius: 3, borderSkipped: false }] },
    options: { responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: _mutedTickColor(), font: { size: 10 } }, grid: { display: false } },
        y: { ticks: { color: _mutedTickColor(), font: { size: 10 }, precision: 0 }, grid: { color: themeColor('--gray-700', '#2b2f33') } }
      }
    }
  } satisfies ChartConfiguration<'bar'>));
}

// ── Time of Day ───────────────────────────────────────────────────────────
export function buildTimeOfDay() {
  const ctx = _chartCanvas('timeOfDayChart');
  if (!ctx) return;
  chartRegistry.dispose('timeOfDayChart');
  const hours: { count: number; scores: number[] }[] = Array.from({ length: 24 }, () => ({ count: 0, scores: [] }));
  for (const s of _pageShots()) {
    const h = new Date(s.timestamp * 1000).getHours();
    const bin = hours[h];
    if (!bin) continue;
    bin.count++;
    if (window.calcShotScore) {
      const sc = window.calcShotScore(s);
      if (sc !== null) bin.scores.push(sc);
    }
  }
  if (!hours.some(h => h.count > 0)) {
    ctx.parentElement!.innerHTML = html`<p class="empty-note pad-top">${tHtml('analytics_no_time')}</p>`;
    return;
  }
  const avgSc = (h: { count: number; scores: number[] }): number | null =>
    h.scores.length ? Math.round(h.scores.reduce((a, b) => a + b, 0) / h.scores.length) : null;
  chartRegistry.set('timeOfDayChart', new Chart(ctx, {
    type: 'bar',
    data: {
      labels: hours.map((_, i) => String(i).padStart(2, '0') + ':00'),
      datasets: [{ data: hours.map(h => h.count), backgroundColor: hours.map(h => _withAlpha(_scoreChartColor(avgSc(h)), 0.7)), borderRadius: 3, borderSkipped: false }]
    },
    options: { responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false },
        tooltip: { callbacks: { label: (c: TooltipItem<'bar'>) => {
          const h = hours[c.dataIndex];
          const sc = h ? avgSc(h) : null;
          return `${c.parsed.y} ${t('analytics_unit_shots', c.parsed.y)}${sc !== null ? ' · Ø ' + sc : ''}`;
        }}}
      },
      scales: {
        x: { ticks: { color: _mutedTickColor(), font: { size: 9 }, maxRotation: 0 }, grid: { display: false } },
        y: { ticks: { color: _mutedTickColor(), font: { size: 10 }, precision: 0 }, grid: { color: themeColor('--gray-700', '#2b2f33') } }
      }
    }
  } satisfies ChartConfiguration<'bar'>));
}

// Y-axis floor for the score trend: 5 below the lowest shown score, rounded
// down to a multiple of 5, never below 0 (empty window stays at 0).
export function _trendAxisMin(scores: number[]): number {
  if (scores.length === 0) return 0;
  return Math.max(0, Math.floor((Math.min(...scores) - 5) / 5) * 5);
}

// The trend switches from one point per shot to one point per calendar day for
// the 90-day and whole-history periods; 7 and 30 days keep the per-shot line
// (#1490).
export function isLongTrendPeriod(days: number): boolean {
  return days === 90 || days === 0;
}

export interface TrendDailyBand {
  keys: string[];          // local calendar day keys, one per day, first → last shot
  mean: (number | null)[]; // 7-day rolling mean score, null when the window has no shot
  min: (number | null)[];  // lowest score in the same 7-day window
  max: (number | null)[];  // highest score in the same 7-day window
}

// One entry per calendar day from the first to the last scored shot (#1490),
// each carrying the seven-day window ending on that day (the day itself plus
// the six before). A day whose window has no shot is null on all three series
// so the caller can span the gap. Local day keys throughout, so a late-evening
// shot stays on its own day and consecutive days differ by one across DST.
export function trendDailyBand(
  shots: readonly ShotRow[],
  scoreOf: (s: ShotRow) => number | null,
): TrendDailyBand {
  const byDay = new Map<string, number[]>();
  let first: number | null = null;
  let last: number | null = null;
  for (const s of shots) {
    const sc = scoreOf(s);
    if (sc === null) continue;
    const n = _dayKeyNum(_dayKeyOf(s.timestamp));
    if (first === null || n < first) first = n;
    if (last === null || n > last) last = n;
    const key = _keyFromNum(n);
    const arr = byDay.get(key);
    if (arr) arr.push(sc); else byDay.set(key, [sc]);
  }

  const keys: string[] = [];
  const mean: (number | null)[] = [];
  const min: (number | null)[] = [];
  const max: (number | null)[] = [];
  if (first === null || last === null) return { keys, mean, min, max };

  for (let n = first; n <= last; n++) {
    keys.push(_keyFromNum(n));
    const win: number[] = [];
    for (let w = n - 6; w <= n; w++) {
      const arr = byDay.get(_keyFromNum(w));
      if (arr) win.push(...arr);
    }
    if (win.length === 0) { mean.push(null); min.push(null); max.push(null); continue; }
    mean.push(Math.round(win.reduce((a, b) => a + b, 0) / win.length));
    min.push(Math.min(...win));
    max.push(Math.max(...win));
  }
  return { keys, mean, min, max };
}

// Canvas can't paint `color-mix` or a CSS var, so the band fill needs the
// resolved --ok turned into a translucent rgba string.
function _withAlpha(color: string, alpha: number): string {
  const hex = color.trim();
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  const cap = m?.[1];
  if (cap) {
    const v = parseInt(cap, 16);
    return `rgba(${(v >> 16) & 255}, ${(v >> 8) & 255}, ${v & 255}, ${alpha})`;
  }
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(hex);
  const inner = rgb?.[1];
  if (inner) {
    const [r = '0', g = '0', b = '0'] = inner.split(',');
    return `rgba(${r.trim()}, ${g.trim()}, ${b.trim()}, ${alpha})`;
  }
  return hex;
}

// Point popover for the score trend: the shot's recipe (score, brew time,
// dose -> yield with ratio, grind, profile) plus a shortcut to the shot.
function _openTrendShotDetail(shot: ShotRow, anchor: HTMLElement | DetailAnchorPoint | null): void {
  const locale = localeFor(S.currentLang);
  const sc = window.calcShotScore ? window.calcShotScore(shot) : null;
  const dose = shot.annotation?.dose;
  const weight = shot.weight;
  const yieldG = typeof weight === 'number' && weight > 0 ? weight / 10 : null;
  const grind = shot.annotation?.grindSetting;
  const profile = shot.profile?.name || shot.profileName || '';
  const row = (lbl: string, val: Html): Html =>
    html`<div class="bests-row"><span class="bests-lbl">${esc(lbl)}</span><span class="bests-val">${val}</span></div>`;
  const scHtml = sc !== null ? html`<span class="${esc(scoreClass(sc))}">${esc(sc)}</span>` : esc('');
  const recipeVal = dose != null && yieldG !== null
    ? html`${esc(Number(dose).toFixed(1))} g → ${esc(yieldG.toFixed(1))} g${Number(dose) > 0 ? html` · 1:${esc((yieldG / Number(dose)).toFixed(1))}` : esc('')}`
    : esc('');
  const durSecs = typeof shot.duration === 'number' && shot.duration > 0 ? Math.round(shot.duration / 10) : null;
  // Screenshot review (#1467): only show rows that carry a value — a missing
  // field is omitted, not rendered as a "—" placeholder — while the open-shot
  // shortcut stays.
  openDetailSheet({
    title: new Date(shot.timestamp * 1000).toLocaleString(locale, { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
    sub: shot.annotation?.coffee || profile,
    body: html`<div class="detail-rows">
      ${sc !== null ? row(t('sort_score'), scHtml) : esc('')}
      ${durSecs !== null ? row(t('analytics_recipe_time'), esc(`${durSecs} s`)) : esc('')}
      ${dose != null && yieldG !== null ? row(t('recipe_dose_yield'), recipeVal) : esc('')}
      ${grind != null && grind !== '' ? row(t('ann_grind_setting'), esc(String(grind))) : esc('')}
      ${profile ? row(t('meta_profile'), esc(profile)) : esc('')}
      <div class="bests-row"><span class="bests-lbl"></span><span class="bests-val"><button type="button" class="bests-link" data-action="goto-shot" data-id="${esc(shot.id)}">→</button></span></div>
    </div>`,
    anchor,
  });
}

export function buildTrendChart() {
  // #814: resolved per render, never at module load — the value has to be
  // whatever the ACTIVE theme resolves to right now.
  const C = chartColors();
  const src = _pageShots().filter(s => {
    if (!window.calcShotScore) return false;
    return window.calcShotScore(s) !== null;
  });

  const ctx = _chartCanvas('trendChart');
  if (!ctx) return;
  chartRegistry.dispose('trendChart');

  // #1490: 90 days and "All" draw one point per calendar day with a 7-day
  // band; the heading carries the "7-day average" counter only for those.
  const longView = isLongTrendPeriod(_pageFilter.days);
  const counterEl = document.getElementById('trendCounter');
  if (counterEl) counterEl.textContent = longView ? _counterText(t('analytics_trend_weekly')) : _counterPeriod();

  if (src.length < 2) {
    ctx.parentElement!.innerHTML = html`<p class="empty-note pad-top">${tHtml('analytics_no_trend')}</p>`;
    return;
  }

  const locale    = localeFor(S.currentLang);
  const scoreData = src.map(s => window.calcShotScore!(s) ?? 0);
  const avg       = Math.round(scoreData.reduce((a, b) => a + b, 0) / scoreData.length);
  const avgLine   = { label: t('analytics_trend_avg', avg), data: scoreData.map(() => avg),
    borderColor: themeColor('--gray-500', '#a1a1aa'), borderDash: [4, 4],
    pointRadius: 0, pointStyle: 'line' as const, fill: false, borderWidth: 2, order: 1 };

  if (longView) {
    const band = trendDailyBand(src, s => window.calcShotScore!(s));
    const ok = themeColor('--ok', '#5cb98a');
    // Anchor the popover at the tapped point (canvas-local x/y plus the canvas
    // offset) rather than the whole canvas.
    chartRegistry.set('trendChart', new Chart(ctx, {
      type: 'line',
      data: {
        labels: band.keys,
        datasets: [
          // The band is two invisible lines; the lower one fills to the upper.
          { label: '', data: band.max, borderWidth: 0, pointRadius: 0, backgroundColor: 'transparent', fill: false, spanGaps: true, order: 3 },
          { label: '', data: band.min, borderWidth: 0, pointRadius: 0, backgroundColor: _withAlpha(ok, 0.16), fill: '-1', spanGaps: true, order: 3 },
          { label: t('analytics_trend_weekly'), data: band.mean, borderColor: ok, borderWidth: 2,
            pointRadius: 0, pointHoverRadius: 4, pointStyle: 'circle', fill: false, spanGaps: true,
            tension: 0.3, cubicInterpolationMode: 'monotone', order: 2 },
          { ...avgLine, data: band.mean.map(() => avg) },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        // The mean line and the band have no points to hit, so the default
        // nearest/intersect test would almost never fire; hit by index across
        // the day's datasets instead (elements[0] may be a band dataset, but
        // its index is still the day).
        interaction: { mode: 'index', intersect: false },
        onClick: (_: unknown, elements: { index: number; element?: { x?: number; y?: number } }[]) => {
          const first = elements[0];
          if (!first) return;
          const dayKey = band.keys[first.index];
          if (!dayKey) return;
          const el = first.element;
          if (el && typeof el.x === 'number' && typeof el.y === 'number') {
            const rect = ctx.getBoundingClientRect();
            openCalendarDayDetail(dayKey, { x: rect.left + el.x, y: rect.top + el.y });
          } else {
            openCalendarDayDetail(dayKey, ctx);
          }
        },
        plugins: {
          legend: { labels: { color: C.tick, font: { size: 11 }, usePointStyle: true, filter: (item) => item.text !== '' } },
          tooltip: {
            filter: (item) => (item.dataset.label ?? '') !== '',
            callbacks: { title: (items) => {
              const i = items[0]?.dataIndex;
              const dayKey = i != null ? band.keys[i] : undefined;
              return dayKey ? _dateFromKey(dayKey).toLocaleDateString(locale, { day: 'numeric', month: 'long' }) : '';
            } },
          },
        },
        scales: {
          // One label per day, but only the first of each month is drawn, so the
          // axis stays quiet however long the period is.
          x: { ticks: { color: _mutedTickColor(), font: { size: 10 }, autoSkip: false, maxRotation: 0,
              callback: (_value: string | number, index: number) => {
                const dayKey = band.keys[index];
                if (!dayKey) return '';
                const d = _dateFromKey(dayKey);
                return d.getDate() === 1 ? d.toLocaleDateString(locale, { month: 'short' }) : '';
              } },
            // A line per day would drown the calm; the month labels carry the axis.
            grid: { display: false } },
          y: { min: _trendAxisMin(scoreData), max: 100, ticks: { color: _mutedTickColor(), font: { size: 10 }, stepSize: 20 }, grid: { color: themeColor('--gray-700', '#2b2f33') } }
        }
      }
    } satisfies ChartConfiguration<'line'>));
    return;
  }

  // 7 and 30 days keep the per-shot line from #1467.
  const labels    = src.map(s => new Date(s.timestamp * 1000).toLocaleDateString(locale, { day: '2-digit', month: '2-digit' }));
  const pointColors = scoreData.map(_scoreChartColor);
  const pointRadii  = scoreData.map((sc, i) => (i === scoreData.length - 1 ? 6 : 4) + (sc >= 100 ? 1 : 0));

  chartRegistry.set('trendChart', new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: t('sort_score'), data: scoreData, borderColor: themeColor('--gray-600', '#52525b'),
          pointBackgroundColor: pointColors,
          pointBorderColor: scoreData.map(sc => sc >= 100 ? '#f3e1c0' : _scoreChartColor(sc)),
          pointBorderWidth: scoreData.map(sc => sc >= 100 ? 2 : 1),
          pointRadius: pointRadii, pointHoverRadius: 7, pointStyle: 'circle',
          fill: false, tension: 0.3, cubicInterpolationMode: 'monotone', order: 2 },
        avgLine
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      onClick: (_: unknown, elements: { index: number; element?: { x?: number; y?: number } }[]) => {
        const first = elements[0];
        const shot = first ? src[first.index] : undefined;
        if (!shot) return;
        // Anchor the popover at the clicked point (canvas-local x/y plus the
        // canvas offset), not at the whole canvas, which on desktop would park
        // the popover beside the full-width chart.
        const el = first?.element;
        if (el && typeof el.x === 'number' && typeof el.y === 'number') {
          const rect = ctx.getBoundingClientRect();
          _openTrendShotDetail(shot, { x: rect.left + el.x, y: rect.top + el.y });
        } else {
          _openTrendShotDetail(shot, ctx);
        }
      },
      plugins: {
        legend: { labels: { color: C.tick, font: { size: 11 }, usePointStyle: true } },
      },
      scales: {
        x: { ticks: { color: _mutedTickColor(), font: { size: 10 }, maxRotation: 45 }, grid: { color: themeColor('--gray-700', '#2b2f33') } },
        y: { min: _trendAxisMin(scoreData), max: 100, ticks: { color: _mutedTickColor(), font: { size: 10 }, stepSize: 20 }, grid: { color: themeColor('--gray-700', '#2b2f33') } }
      }
    }
  } satisfies ChartConfiguration<'line'>));
}

// ── Your recipe on average ────────────────────────────────────────────────
export interface RecipeSummary {
  dose: number | null;
  yield: number | null;
  ratio: number | null;
  time: number | null;
  grindMin: number | null;
  grindMax: number | null;
}

// Pure averages over the shots the trend window shows (#1467). Yield is the
// list row's weight in tenths of a gram (the /10 the rest of analytics
// applies); grind goes through _parseGrindNum so string and number settings
// mix. Any field is null when no shot carries it.
export function computeRecipeSummary(shots: ShotRow[]): RecipeSummary {
  const doses: number[] = [], yields: number[] = [], times: number[] = [];
  let grindMin: number | null = null, grindMax: number | null = null;
  for (const s of shots) {
    const dose = s.annotation?.dose;
    if (typeof dose === 'number' && dose > 0) doses.push(dose);
    const weight = s.weight;
    if (typeof weight === 'number' && weight > 0) yields.push(weight / 10);
    const dur = s.duration;
    if (typeof dur === 'number' && dur > 0) times.push(dur / 10);
    const g = _parseGrindNum(s.annotation?.grindSetting);
    if (g !== null) {
      grindMin = grindMin === null ? g : Math.min(grindMin, g);
      grindMax = grindMax === null ? g : Math.max(grindMax, g);
    }
  }
  const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
  const dose = doses.length ? Math.round(mean(doses) * 10) / 10 : null;
  const yieldG = yields.length ? Math.round(mean(yields) * 10) / 10 : null;
  const ratio = dose !== null && dose > 0 && yieldG !== null ? Math.round((yieldG / dose) * 10) / 10 : null;
  const time = times.length ? Math.round(mean(times)) : null;
  return { dose, yield: yieldG, ratio, time, grindMin, grindMax };
}

export function buildRecipeSummary() {
  const el = document.getElementById('recipeRows');
  if (!el) return;
  const src = _pageShots().filter(s => window.calcShotScore ? window.calcShotScore(s) !== null : false);
  const r = computeRecipeSummary(src);

  const rows: Html[] = [];
  if (r.dose !== null && r.yield !== null) {
    const ratioPart = r.ratio !== null ? ` · 1:${r.ratio.toFixed(1)}` : '';
    rows.push(html`<div class="bests-row"><span class="bests-lbl">${tHtml('analytics_recipe_recipe')}</span><span class="bests-val">${esc(r.dose.toFixed(1))} g → ${esc(r.yield.toFixed(1))} g${esc(ratioPart)}</span></div>`);
  }
  if (r.time !== null) {
    rows.push(html`<div class="bests-row"><span class="bests-lbl">${tHtml('analytics_recipe_time')}</span><span class="bests-val">${esc(r.time)} s</span></div>`);
  }
  if (r.grindMin !== null) {
    const label = r.grindMin === r.grindMax ? String(r.grindMin) : `${r.grindMin}–${r.grindMax}`;
    rows.push(html`<div class="bests-row"><span class="bests-lbl">${tHtml('analytics_recipe_grind')}</span><span class="bests-val">${esc(label)}</span></div>`);
  }

  const card = document.getElementById('recipeCard');
  if (card) card.style.display = rows.length ? '' : 'none';
  const countEl = document.getElementById('recipeCount');
  if (countEl) countEl.textContent = _counterPeriod();
  el.innerHTML = rows.length ? html`<div class="bests-list">${joinHtml(rows)}</div>` : html``;
}

export function buildProfileChart() {
  // #814: resolved per render, never at module load — the value has to be
  // whatever the ACTIVE theme resolves to right now.
  const C = chartColors();
  const byProfile: Record<string, { scores: number[]; count: number }> = {};
  for (const s of _pageShots()) {
    const p = _profileNameOf(s);
    let entry = byProfile[p];
    if (!entry) { entry = { scores: [], count: 0 }; byProfile[p] = entry; }
    entry.count++;
    if (window.calcShotScore) {
      const sc = window.calcShotScore(s);
      if (sc !== null) entry.scores.push(sc);
    }
  }

  const entries = Object.entries(byProfile)
    .filter(([, v]) => v.scores.length > 0)
    .map(([name, v]) => ({ name, count: v.count, avgScore: Math.round(v.scores.reduce((a, b) => a + b, 0) / v.scores.length) }))
    .sort((a, b) => b.avgScore - a.avgScore);

  const wrap = document.getElementById('profileChartWrap')!;
  const ctx  = _chartCanvas('profileChart');
  if (!ctx) return;
  chartRegistry.dispose('profileBarChart');

  if (entries.length === 0) {
    wrap.innerHTML = html`<p class="empty-note">${tHtml('analytics_no_profiles')}</p>`;
    return;
  }

  wrap.style.height = Math.max(120, entries.length * 36 + 20) + 'px';

  chartRegistry.set('profileBarChart', new Chart(ctx, {
    type: 'bar',
    data: {
      labels:   entries.map(e => e.name.length > 20 ? e.name.slice(0, 19) + '…' : e.name),
      datasets: [{ label: t('analytics_verdict_avg'), data: entries.map(e => e.avgScore),
                   backgroundColor: entries.map(e => _withAlpha(_scoreChartColor(e.avgScore), 0.7)), borderRadius: 4 }]
    },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { afterLabel: (c: { dataIndex: number }) => {
          const e = entries[c.dataIndex];
          return `${e ? e.count : 0} ${t('analytics_unit_shots', e ? e.count : 0)}`;
        } } }
      },
      scales: {
        x: { min: 0, max: 100, ticks: { color: _mutedTickColor(), font: { size: 10 } }, grid: { color: themeColor('--gray-700', '#2b2f33') } },
        y: { ticks: { color: C.tick, font: { size: 11 } }, grid: { display: false } }
      }
    }
  } satisfies ChartConfiguration<'bar'>));
}

// ── Weekday x Hour heatmap ─────────────────────────────────────────────────
// True 7x24 matrix of shot counts, in the same visual language as the
// calendar heatmap above (intensity buckets of the same red). Respects
// S.activeMachineId scoping and the page's period/query implicitly — _pageShots()
// is the machine-filtered projection every other builder here reads.
export function buildWeekdayHourHeatmap() {
  const el = document.getElementById('weekdayHourHeatmap');
  if (!el) return;

  if (!_pageShots().length) {
    el.innerHTML = html`<p class="empty-note">${tHtml('analytics_no_time')}</p>`;
    return;
  }

  const matrix: number[][] = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
  for (const s of _pageShots()) {
    const d  = new Date(s.timestamp * 1000);
    const wd = (d.getDay() + 6) % 7; // 0=Mon..6=Sun, same convention as the calendar above
    const row = matrix[wd];
    if (!row) continue;
    const h = d.getHours();
    row[h] = (row[h] ?? 0) + 1;
  }
  const max = Math.max(1, ...matrix.flat());
  const level = (c: number): number => c === 0 ? 0 : Math.min(4, Math.ceil((c / max) * 4));

  const locale = localeFor(S.currentLang);
  // 2024-01-01 is a Monday — used purely as a reference date to get a
  // locale-correct short weekday name via Intl, same approach the calendar
  // above uses for month labels (no hardcoded weekday translation keys).
  const refMonday = new Date(2024, 0, 1);
  const weekdayLabels = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(refMonday); d.setDate(d.getDate() + i);
    return d.toLocaleDateString(locale, { weekday: 'short' });
  });

  const hourLabels: Html[] = [];
  for (let h = 0; h < 24; h++) hourLabels.push(html`<div class="wh-hourlabel">${esc(h % 3 === 0 ? h : '')}</div>`);
  const dayRows: Html[] = [];
  for (let wd = 0; wd < 7; wd++) {
    const cells: Html[] = [];
    for (let h = 0; h < 24; h++) {
      const c = matrix[wd]?.[h] ?? 0;
      const title = `${weekdayLabels[wd]} ${String(h).padStart(2, '0')}:00 — ${c} ${t('analytics_unit_shots', c)}`;
      cells.push(html`<div class="wh-cell wh-l${esc(level(c))}" title="${esc(title)}"></div>`);
    }
    dayRows.push(html`<div class="wh-row"><div class="wh-label">${esc(weekdayLabels[wd])}</div>${joinHtml(cells)}</div>`);
  }
  el.innerHTML = html`<div class="wh-heatmap"><div class="wh-row wh-header"><div class="wh-label"></div>${joinHtml(hourLabels)}</div>${joinHtml(dayRows)}</div>`;
}
