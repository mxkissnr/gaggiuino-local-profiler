import Chart from 'chart.js/auto';
import { S } from '../state/index.js';
import * as chartRegistry from '../state/charts.js';
import { t, tHtml } from '../i18n.js';
import { localeFor, COFFEE_COUNTRIES, COUNTRY_CENTROIDS, countryName, HOME_COUNTRY_NUM } from '../constants.js';
import { esc, html, joinHtml, scoreClass, scoreColor, chartColors, themeColor, onThemeChange } from '../utils.js';
import type { Html } from '../utils.js';
import { _parseGrindNum } from './shots/grind.js';
import { _equipmentName } from './shots/index.js';
import { summaryLine, filterAnalyticsShots } from './analytics-summary.js';
import type { AnalyticsPageFilter } from './analytics-summary.js';
import { computeFacts } from './analytics-facts.js';
import type { Fact, FactIcon } from './analytics-facts.js';
import { WARNING_ICON_SVG } from '../icons.js';
import { openDetailSheet } from '../components/detail-sheet.js';
import type { DetailAnchorPoint } from '../components/detail-sheet.js';
import { shelfBagImage } from './library/shelf.js';
import type { ShelfBagImageBean } from './library/shelf.js';
import { loadBeanImageBlobUrl } from '../bean-image.js';
import type { LibraryRow, MachineRecord, ShotMeta } from '../state/index.js';
import type { ChartConfiguration, TooltipItem } from 'chart.js';

// state/index.ts types shot rows as metadata-only ShotMeta (id/timestamp plus
// an index signature); this view reads the annotation, profile, curve and
// machine fields, so this local alias names them — same pattern as
// views/shots/index.ts.
interface ShotAnnotation {
  coffee?: string | null | undefined;
  beanId?: number | null | undefined;
  basketId?: number | null | undefined;
  puckScreenId?: number | null | undefined;
  grinder?: string | null | undefined;
  grindSetting?: string | number | null | undefined;
  dose?: number | null | undefined;
}

interface ShotRow extends ShotMeta {
  profileName?: string | null;
  profile?: { name?: string | null } | null;
  duration?: number | null;
  weight?: number | null;
  tempStabilityDev?: number | null;
  datapoints?: { temperature?: (number | null)[]; targetTemperature?: (number | null)[] } | null | undefined;
  annotation?: ShotAnnotation | null;
}

// S.machines is typed as the bare MachineRecord (id + index signature); the
// machine comparison below reads the display name off the same rows.
interface MachineRow extends MachineRecord {
  name?: string | null;
}

// ShotMeta's index signature makes its fields unknown, so every builder reads
// rows through this alias instead of through S.shots directly.
function _shots(): ShotRow[] { return S.shots; }
function _allShots(): ShotRow[] { return S.allShots; }
function _machines(): MachineRow[] { return S.machines; }

// ── Page filter: period + search (#1467) ──────────────────────────────────
// The whole Analytics page shares one toolbar. Every period-scoped builder
// reads _pageShots() instead of the raw S.shots, so the period and query apply
// everywhere at once; the coffee year, the lifetime facts and the machine
// comparison stay on the whole history on purpose.
const ANALYTICS_PREFS_KEY = 'glp.analyticsFilter';
const DEFAULT_ANALYTICS_FILTER: AnalyticsPageFilter = { days: 30, query: '' };

// Whether the viewer left the "More insights" fold open (#1467).
const ANALYTICS_MORE_KEY = 'glp.analyticsMore.open';

function _loadAnalyticsFilter(): AnalyticsPageFilter {
  try {
    const raw = localStorage.getItem(ANALYTICS_PREFS_KEY);
    if (!raw) return { ...DEFAULT_ANALYTICS_FILTER };
    const parsed = JSON.parse(raw) as Partial<AnalyticsPageFilter>;
    const days = parsed.days === 7 || parsed.days === 30 || parsed.days === 90 || parsed.days === 0
      ? parsed.days : DEFAULT_ANALYTICS_FILTER.days;
    const query = typeof parsed.query === 'string' ? parsed.query : '';
    return { days, query };
  } catch {
    // Unreadable/private-mode storage falls back to the defaults.
    return { ...DEFAULT_ANALYTICS_FILTER };
  }
}

const _pageFilter: AnalyticsPageFilter = _loadAnalyticsFilter();

function _saveAnalyticsFilter(): void {
  try { localStorage.setItem(ANALYTICS_PREFS_KEY, JSON.stringify(_pageFilter)); } catch { /* private mode / quota */ }
}

export function getAnalyticsFilter(): AnalyticsPageFilter { return { ..._pageFilter }; }

// Toolbar entry point: updates the shared filter, persists it and re-runs the
// whole page once.
export function setAnalyticsFilter(patch: Partial<AnalyticsPageFilter>): void {
  if (patch.days === 7 || patch.days === 30 || patch.days === 90 || patch.days === 0) _pageFilter.days = patch.days;
  if (typeof patch.query === 'string') _pageFilter.query = patch.query;
  _saveAnalyticsFilter();
  rebuildAnalyticsPage();
}

// The profile label buildProfileChart() groups by — and the search matches.
function _profileNameOf(s: ShotRow): string { return s.profile?.name || s.profileName || 'Unbekannt'; }

function _pageShots(): ShotRow[] {
  return filterAnalyticsShots(_shots(), _pageFilter, Date.now(), _profileNameOf);
}

// A sparse render replaces a chart's canvas with an empty note. That was fine
// when builders ran once, but rebuildAnalyticsPage() re-runs them on every
// toolbar change and the canvas is never recreated (#1467). Remember each
// canvas's wrapper and restore the canvas before the next draw.
const _chartWraps = new Map<string, HTMLElement>();

function _chartCanvas(id: string): HTMLCanvasElement | null {
  const canvas = document.getElementById(id) as HTMLCanvasElement | null;
  if (canvas) {
    const parent = canvas.parentElement;
    if (parent) _chartWraps.set(id, parent);
    return canvas;
  }
  const wrap = _chartWraps.get(id);
  if (!wrap || !document.contains(wrap)) { _chartWraps.delete(id); return null; }
  wrap.innerHTML = html`<canvas id="${esc(id)}"></canvas>`;
  return document.getElementById(id) as HTMLCanvasElement | null;
}

// Equipment groupings share one aggregation/rendering pair (a grinder name,
// or a basket/puck-screen id resolved to a name at render time).
type EquipKey = string | number;

interface EquipStat { count: number; scores: number[]; durations: number[] }

interface EquipStatEntry {
  name: string;
  count: number;
  avgScore: number | null;
  bestScore: number | null;
  avgDuration: number | null;
}

// One bean's aggregate for the "Beans by score" shelf (#1467) and its detail
// sheet.
interface BeanRankRow {
  name: string;
  // The most recent shot's annotation.beanId, or null when it carried none.
  beanId: number | null;
  shots: number;
  avgScore: number | null;
  best: number | null;
  hundreds: number;
  avgTime: number | null;
  firstGood: number | null;
  lastGrind: string | number | null | undefined;
  trend: number | null;
}

// CoffeeLibrary (state/index.ts) types beans/grinders only; the world map
// additionally reads each bean's origin list and geocoded location.
interface SharedBean extends LibraryRow {
  id?: number | null;
  name: string;
  origin?: string | null;
  region?: string | null;
  origins?: { code?: string | null; percent?: number | null }[] | null;
  location?: { lon: number; lat: number } | null;
}

function _beans(): SharedBean[] { return (S.coffeeLibrary.beans || []) as SharedBean[]; }

// baskets/puckScreens are optional library collections (see CoffeeLibrary) —
// same collection-by-name lookup views/shots/index.ts does for its own
// annotation panel.
function _libCollection(name: 'baskets' | 'puckScreens'): Record<string, unknown>[] | undefined {
  return S.coffeeLibrary[name];
}

// World map: a bean's origins (a blend carries several), the per-country
// stats the tooltip reads back off a series datum, and the params ECharts
// hands a tooltip formatter.
interface MapOrigin { code: string; weight: number }
interface MapEntry { bean: SharedBean; origins: MapOrigin[] }
interface MapStats {
  shots: number;
  beans: Set<string>;
  beanShots: Map<string, number>;
  scoreSum: number;
  scoreCount: number;
  beanScoreSum: Map<string, number>;
  beanScoreCount: Map<string, number>;
}

interface MapTooltipParams {
  seriesType?: string;
  name?: string;
  data?: { _stats?: MapStats; _region?: string | null } | null;
}

// GeoJSON pieces the antimeridian splitting touches: topojson.feature()
// returns a FeatureCollection whose rings may cross the ±180° seam.
type Ring = number[][];
type Polygon = Ring[];
type MultiPolygon = Polygon[];

interface GeoJsonGeometry {
  type: string;
  coordinates?: Polygon | MultiPolygon;
}

interface GeoJsonFeature {
  geometry: GeoJsonGeometry;
  properties: Record<string, unknown>;
  id?: string | number;
}

interface GeoJsonFeatureCollection { features: GeoJsonFeature[] }

interface WorldTopo { objects: { countries: unknown } }

// topojson-client ships no type declarations (see the dynamic import in
// buildWorldMap()); feature() is the only entry point used here.
interface TopojsonModule {
  feature(topology: WorldTopo, object: unknown): GeoJsonFeatureCollection;
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
// counter in the viewer's language. main.ts calls this with the rest of the
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

// ── Helpers ───────────────────────────────────────────────────────────────
// Day keys are built from LOCAL calendar fields — toISOString() is UTC and
// shifts a late-evening shot into the next day (#1467).
function _localDayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function _dayKeyOf(tsSeconds: number): string { return _localDayKey(new Date(tsSeconds * 1000)); }
function _dateFromKey(key: string): Date {
  const [y, m, d] = key.split('-');
  return new Date(Number(y), Number(m) - 1, Number(d));
}
// Serial day number from the key's own fields, so consecutive days differ by
// exactly one even across a DST change.
function _dayKeyNum(key: string): number {
  const [y, m, d] = key.split('-');
  return Math.floor(Date.UTC(Number(y), Number(m) - 1, Number(d)) / 86400000);
}
function _keyFromNum(n: number): string {
  const d = new Date(n * 86400000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
function _fmtCalendarDay(key: string, locale: string): string {
  return _dateFromKey(key).toLocaleDateString(locale, { day: 'numeric', month: 'long' });
}

export interface CalendarStats {
  current: number;
  longest: { len: number; start: string; end: string } | null;
  busiest: { day: string; count: number } | null;
  perfect: number;
  perfectShare: number;
}

// Pure coffee-year numbers (#1467): current streak (consecutive days ending
// today or yesterday), longest run with its dates, the busiest day and the
// share of perfect (100-point) shots. Local day keys throughout.
export function computeCalendarStats(
  shots: ShotRow[],
  scoreOf: (s: ShotRow) => number | null,
  nowMs: number,
): CalendarStats {
  const counts = new Map<string, number>();
  let perfect = 0;
  for (const s of shots) {
    const key = _dayKeyOf(s.timestamp);
    counts.set(key, (counts.get(key) || 0) + 1);
    const sc = scoreOf(s);
    if (sc !== null && sc >= 100) perfect++;
  }
  const perfectShare = shots.length > 0 ? Math.round((perfect / shots.length) * 100) : 0;

  const nums = [...counts.keys()].map(_dayKeyNum).sort((a, b) => a - b);

  let longest: CalendarStats['longest'] = null;
  const first = nums[0];
  if (first !== undefined) {
    let runStart = first, runLen = 1;
    let bestStart = first, bestLen = 1, bestEnd = first;
    for (let i = 1; i < nums.length; i++) {
      const n = nums[i];
      const prev = nums[i - 1];
      if (n === undefined || prev === undefined) continue;
      if (n === prev + 1) runLen++;
      else { runStart = n; runLen = 1; }
      if (runLen > bestLen) { bestLen = runLen; bestStart = runStart; bestEnd = n; }
    }
    longest = { len: bestLen, start: _keyFromNum(bestStart), end: _keyFromNum(bestEnd) };
  }

  const todayNum = _dayKeyNum(_localDayKey(new Date(nowMs)));
  let cursor: number | null = counts.has(_keyFromNum(todayNum)) ? todayNum
    : counts.has(_keyFromNum(todayNum - 1)) ? todayNum - 1
    : null;
  let current = 0;
  while (cursor !== null && counts.has(_keyFromNum(cursor))) { current++; cursor--; }

  let busiest: CalendarStats['busiest'] = null;
  for (const [day, count] of counts) {
    if (!busiest || count > busiest.count
      || (count === busiest.count && _dayKeyNum(day) < _dayKeyNum(busiest.day))) {
      busiest = { day, count };
    }
  }

  return { current, longest, busiest, perfect, perfectShare };
}

// #811: was the hardcoded #52525b (Tailwind zinc-600) on every chart's tick
// labels -- a fixed dark-theme gray that didn't track --gray-600 across
// themes/accents. Canvas needs a resolved color, not a CSS var() reference,
// so this reads the live custom property the same way buildWorldMap() below
// already does for its own colors.
const _mutedTickColor = () =>
  (getComputedStyle(document.documentElement).getPropertyValue('--gray-600') || '#52525b').trim() || '#52525b';
const _bgColor = (sc: number | null): string => sc == null ? 'rgba(63,63,70,.5)'
  : sc >= 88 ? 'rgba(34,197,94,.7)' : sc >= 75 ? 'rgba(132,204,22,.7)'
  : sc >= 60 ? 'rgba(234,179,8,.7)'  : sc >= 45 ? 'rgba(249,115,22,.7)' : 'rgba(239,68,68,.7)';

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
    + (summary.delta ? ` · ${t(`analytics_summary_delta_${summary.delta.bucket}`, summary.delta.avg7)}` : '');

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
// name needs a lookup (_equipmentName() from views/shots/index.js). Grouped
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
      datasets: [{ data: hours.map(h => h.count), backgroundColor: hours.map(h => _bgColor(avgSc(h))), borderRadius: 3, borderSkipped: false }]
    },
    options: { responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false },
        tooltip: { callbacks: { label: (c: TooltipItem<'bar'>) => {
          const h = hours[c.dataIndex];
          const sc = h ? avgSc(h) : null;
          return `${c.parsed.y} Shot${c.parsed.y !== 1 ? 's' : ''}${sc !== null ? ' · Ø ' + sc : ''}`;
        }}}
      },
      scales: {
        x: { ticks: { color: _mutedTickColor(), font: { size: 9 }, maxRotation: 0 }, grid: { display: false } },
        y: { ticks: { color: _mutedTickColor(), font: { size: 10 }, precision: 0 }, grid: { color: themeColor('--gray-700', '#2b2f33') } }
      }
    }
  } satisfies ChartConfiguration<'bar'>));
}

// Resolved point colour on the shared score scale: scoreColor() names the
// theme token (--ok / --warn / --err) and themeColor() resolves it to a value
// Chart.js can paint. Fallbacks match the tokens' light-theme hexes.
function _trendPointColor(sc: number): string {
  const token = scoreColor(sc);
  const name = token.startsWith('var(') ? token.slice(4, -1) : '';
  const fallback = sc >= 90 ? '#5cb98a' : sc >= 70 ? '#d3a03f' : '#e0705f';
  return themeColor(name, fallback);
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
  if (counterEl) counterEl.textContent = longView ? t('analytics_trend_weekly') : '';

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
  const pointColors = scoreData.map(_trendPointColor);
  const pointRadii  = scoreData.map((sc, i) => (i === scoreData.length - 1 ? 6 : 4) + (sc >= 100 ? 1 : 0));

  chartRegistry.set('trendChart', new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Score', data: scoreData, borderColor: themeColor('--gray-600', '#52525b'),
          pointBackgroundColor: pointColors,
          pointBorderColor: scoreData.map(sc => sc >= 100 ? '#f3e1c0' : _trendPointColor(sc)),
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
  el.innerHTML = rows.length ? html`<div class="bests-list">${joinHtml(rows)}</div>` : html``;
}

export function buildCalendar() {
  _renderCalendar();
}

// One cup per day of a streak, up to a week (inline SVG, accent when filled).
function _cups(n: number): Html {
  const cups: Html[] = [];
  for (let i = 0; i < 7; i++) {
    const cls = i < n ? 'cal-cup filled' : 'cal-cup';
    cups.push(html`<svg class="${esc(cls)}" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 8h11v5a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4z" fill="currentColor"/><path d="M16 9h1.5a2.5 2.5 0 0 1 0 5H16" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>`);
  }
  return html`<span class="cal-cups">${joinHtml(cups)}</span>`;
}

export function _renderStreaks(stats: CalendarStats, locale: string): Html {
  const longest = stats.longest;
  const longestLbl = longest
    ? t('analytics_streak_longest', _fmtCalendarDay(longest.start, locale), _fmtCalendarDay(longest.end, locale))
    : '';
  const busiestLbl = stats.busiest ? t('analytics_busiest', _fmtCalendarDay(stats.busiest.day, locale)) : '';
  return html`
    <div class="cal-fig cal-fig-current">
      <span class="cal-fig-num">${esc(stats.current)}<span class="cal-fig-unit">${esc(t('analytics_unit_days', stats.current))}</span></span>
      <span class="cal-fig-lbl">${esc(t('analytics_streak_current'))}</span>
      ${_cups(stats.current)}
    </div>
    <div class="cal-fig cal-fig-longest" tabindex="0">
      <span class="cal-fig-num">${esc(longest ? longest.len : 0)}<span class="cal-fig-unit">${esc(t('analytics_unit_days', longest ? longest.len : 0))}</span></span>
      <span class="cal-fig-lbl">${esc(longestLbl)}</span>
      ${_cups(longest ? longest.len : 0)}
    </div>
    <div class="cal-fig cal-fig-busiest">
      <span class="cal-fig-num">${esc(stats.busiest ? stats.busiest.count : 0)}<span class="cal-fig-unit">${esc(t('analytics_unit_shots'))}</span></span>
      <span class="cal-fig-lbl">${esc(busiestLbl)}</span>
    </div>
    <div class="cal-fig cal-fig-perfect">
      <span class="cal-fig-num">${esc(stats.perfect)}<span class="cal-fig-unit">${esc(t('analytics_unit_shots'))}</span></span>
      <span class="cal-fig-lbl">${esc(t('analytics_perfect', stats.perfectShare))}</span>
    </div>`;
}

// Hover/focus on the longest-streak figure marks the run's cells and dims the
// rest of the grid.
function _wireStreakHover(grid: HTMLElement, figure: HTMLElement, longest: CalendarStats['longest']): void {
  if (!longest || typeof grid.querySelectorAll !== 'function') return;
  const run = new Set<string>();
  for (let n = _dayKeyNum(longest.start); n <= _dayKeyNum(longest.end); n++) run.add(_keyFromNum(n));
  const paint = (on: boolean): void => {
    for (const cell of Array.from(grid.querySelectorAll<HTMLElement>('.cal-day'))) {
      const day = cell.dataset?.day;
      if (!on) { cell.classList?.remove('in-run'); cell.classList?.remove('cal-dim'); }
      else if (day && run.has(day)) cell.classList?.add('in-run');
      else cell.classList?.add('cal-dim');
    }
  };
  figure.addEventListener('mouseenter', () => paint(true));
  figure.addEventListener('mouseleave', () => paint(false));
  figure.addEventListener('focus', () => paint(true));
  figure.addEventListener('blur', () => paint(false));
}

export function openCalendarDayDetail(day: string, anchor: HTMLElement | DetailAnchorPoint | null): void {
  const shots = _shots().filter(s => _dayKeyOf(s.timestamp) === day);
  const locale = localeFor(S.currentLang);
  const scores = shots
    .map(s => (window.calcShotScore ? window.calcShotScore(s) : null))
    .filter((sc): sc is number => sc !== null);
  const avg = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
  const sub = `${shots.length} ${t('analytics_unit_shots')}${avg !== null ? ` · Ø ${avg}` : ''}`;
  const rows = shots.map(s => {
    const time = new Date(s.timestamp * 1000).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
    const name = s.annotation?.coffee || s.profile?.name || s.profileName || '';
    const sc = window.calcShotScore ? window.calcShotScore(s) : null;
    const scHtml = sc !== null ? html`<span class="${esc(scoreClass(sc))}">${esc(sc)}</span>` : esc('—');
    return html`<div class="bests-row"><span class="bests-lbl">${esc(time)} · ${esc(name)}</span><span class="bests-val">${scHtml} <button type="button" class="bests-link" data-action="goto-shot" data-id="${esc(s.id)}">→</button></span></div>`;
  });
  openDetailSheet({
    title: _dateFromKey(day).toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
    sub,
    body: html`<div class="detail-rows">${joinHtml(rows)}</div>`,
    anchor,
  });
}

// #1490: below 900px the last 22 weeks should fill the wrapper, so the newest
// weeks read at a glance while the older ones stay one horizontal scroll away.
// The grid is max-content (that is what makes the year scrollable), which rules
// out a percentage track size — measure the wrapper and set the cell in px.
const CAL_PHONE_WEEKS = 22;
// Weekday column + the gap after it + the 21 gaps between the 22 week columns.
const CAL_PHONE_GUTTER = 26 + 3 + (CAL_PHONE_WEEKS - 1) * 3;

function _sizeCalendarCells(): void {
  const el = document.getElementById('shotCalendar');
  if (!el) return;
  if (window.innerWidth >= 900) el.style.removeProperty('--cal-cell');
  else el.style.setProperty('--cal-cell', `${Math.max(6, Math.floor((el.clientWidth - CAL_PHONE_GUTTER) / CAL_PHONE_WEEKS))}px`);
  // Newest week sits at the right edge; keep it visible across resizes too.
  el.scrollLeft = el.scrollWidth;
}

let _calResizeBound = false;
function _bindCalendarResize(): void {
  if (_calResizeBound) return;
  _calResizeBound = true;
  window.addEventListener('resize', _sizeCalendarCells);
}

export function _renderCalendar() {
  const el = document.getElementById('shotCalendar');
  if (!el) return;

  interface DayAgg { count: number; scores: number[]; hasPerfect: boolean; }
  const dayMap = new Map<string, DayAgg>();
  let firstTs: number | null = null;
  for (const s of _shots()) {
    const key = _dayKeyOf(s.timestamp);
    let day = dayMap.get(key);
    if (!day) { day = { count: 0, scores: [], hasPerfect: false }; dayMap.set(key, day); }
    day.count++;
    if (firstTs === null || s.timestamp < firstTs) firstTs = s.timestamp;
    if (window.calcShotScore) {
      const sc = window.calcShotScore(s);
      if (sc !== null) { day.scores.push(sc); if (sc >= 100) day.hasPerfect = true; }
    }
  }

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayKey = _localDayKey(today);

  // Range: Monday on/before the later of (first shot, today - 364 days) to the
  // Sunday of the current week.
  const cutoff = new Date(today);
  cutoff.setDate(cutoff.getDate() - 364);
  let rangeStart = cutoff;
  if (firstTs !== null) {
    const f = new Date(firstTs * 1000);
    const firstDay = new Date(f.getFullYear(), f.getMonth(), f.getDate());
    if (firstDay > cutoff) rangeStart = firstDay;
  }
  const start = new Date(rangeStart);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  const end = new Date(today);
  end.setDate(end.getDate() + (6 - ((today.getDay() + 6) % 7)));

  const locale = localeFor(S.currentLang);
  const cls = (c: number): string => c === 0 ? 'cal-0' : c === 1 ? 'cal-1' : c === 2 ? 'cal-2' : c === 3 ? 'cal-3' : 'cal-4';

  interface CalDay { date: Date; key: string; count: number; avg: number | null; hasPerfect: boolean; isFuture: boolean; isToday: boolean; }
  const weeks: CalDay[][] = [];
  const cur = new Date(start);
  while (cur <= end) {
    const week: CalDay[] = [];
    for (let d = 0; d < 7; d++) {
      const key = _localDayKey(cur);
      const agg = dayMap.get(key);
      const count = agg ? agg.count : 0;
      const avg = agg && agg.scores.length ? Math.round(agg.scores.reduce((a, b) => a + b, 0) / agg.scores.length) : null;
      week.push({ date: new Date(cur), key, count, avg, hasPerfect: !!agg?.hasPerfect, isFuture: cur > today, isToday: key === todayKey });
      cur.setDate(cur.getDate() + 1);
    }
    weeks.push(week);
  }

  // Month labels above the first week of each month.
  const monthRuns: { span: number; label: string }[] = [];
  let lastMonth = -1;
  for (const week of weeks) {
    const monday = week[0];
    if (!monday) continue;
    const label = monday.date.toLocaleDateString(locale, { month: 'short' });
    if (monday.date.getMonth() !== lastMonth) { monthRuns.push({ span: 1, label }); lastMonth = monday.date.getMonth(); }
    else { const run = monthRuns[monthRuns.length - 1]; if (run) run.span++; }
  }
  const monthItems = monthRuns.map(m => html`<span class="cal-month" style="grid-column: span ${esc(m.span)}">${esc(m.label)}</span>`);

  // First grid column: Monday/Wednesday/Friday labels; the rest empty.
  const cells: Html[] = [];
  for (let r = 0; r < 7; r++) {
    const label = (r === 0 || r === 2 || r === 4)
      ? new Date(2024, 0, 1 + r).toLocaleDateString(locale, { weekday: 'short' })
      : '';
    cells.push(html`<span class="cal-weekday">${esc(label)}</span>`);
  }

  for (const week of weeks) {
    for (const day of week) {
      if (day.isFuture) { cells.push(html`<span class="cal-day cal-future" aria-hidden="true"></span>`); continue; }
      const classes = ['cal-day', cls(day.count)];
      if (day.hasPerfect) classes.push('cal-crema');
      if (day.isToday) classes.push('cal-today');
      if (day.count > 0) {
        classes.push('cal-day-link');
        const dateStr = day.date.toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
        const aria = `${dateStr} · ${day.count} ${t('analytics_unit_shots')}${day.avg !== null ? ` · Ø ${day.avg}` : ''}`;
        cells.push(html`<button type="button" class="${esc(classes.join(' '))}" data-action="analytics-day" data-day="${esc(day.key)}" aria-label="${esc(aria)}"></button>`);
      } else {
        cells.push(html`<span class="${esc(classes.join(' '))}" aria-hidden="true"></span>`);
      }
    }
  }

  el.innerHTML = html`<div class="cal-months">${joinHtml(monthItems)}</div><div class="cal-grid">${joinHtml(cells)}</div>`;
  // Size the phone cells to the wrapper and pin it to the newest week.
  _bindCalendarResize();
  _sizeCalendarCells();

  const streaksEl = document.getElementById('calStreaks');
  if (streaksEl) {
    const stats = computeCalendarStats(_shots(), s => (window.calcShotScore ? window.calcShotScore(s) : null), Date.now());
    streaksEl.innerHTML = _renderStreaks(stats, locale);
    const fig = typeof streaksEl.querySelector === 'function' ? streaksEl.querySelector<HTMLElement>('.cal-fig-longest') : null;
    if (fig) _wireStreakHover(el, fig, stats.longest);
  }
}

// ── Origin world map ──────────────────────────────────────────────────────
// Choropleth + region points of coffee origins: shots are joined to library
// beans by name (case-insensitive, same precedent as the stock math) and
// colored by shot count; beans with an origin but no shots yet are still
// highlighted. Rendered with Apache ECharts (roam/zoom + scatter points),
// registered from countries-110m.json via topojson-client — both bundled
// as real npm deps (no CDN), the topojson data file itself is served
// locally (CSP connect-src 'self') and cached after the first Analytics visit.
let _worldTopo: WorldTopo | null = null;
let _worldMapRegistered = false;
let _echartsInstance: ReturnType<(typeof import('echarts'))['init']> | null = null;
let _resizeBound = false;
let _worldMapThemeListenerRegistered = false;
// #797: echarts + topojson-client (~380 kB gzip combined) are dynamic
// imports now, only fetched once the map actually has data to draw — cached
// as a promise (not the resolved modules) so a second buildWorldMap() call
// racing the first one's still-in-flight import reuses the same request
// instead of firing a duplicate one.
let _mapLibsPromise: Promise<[typeof import('echarts'), TopojsonModule]> | null = null;

// #648: buildWorldMap() is fired unawaited from initAnalytics(), which can
// itself run again (re-navigating to Analytics) before a prior call's
// countries-110m.json fetch has resolved. A monotonic token guard, same
// pattern shots/index.js's loadData() uses (#644), makes sure only the
// still-latest call writes _worldTopo / touches the DOM after the await.
let _worldMapReqToken = 0;

// #1467: the home point ([lon, lat]) resolved once from the registered world
// geometry for the locale's country — null when the locale has no region or
// it isn't a HOME_COUNTRY_NUM entry, which just means no routes are drawn.
let _worldMapHome: [number, number] | null = null;
// #1467: the map click handler is bound once per echarts instance, so it
// reads the latest aggregation/home from here instead of closing over one
// build's locals.
let _mapClickData: { byCode: Record<string, MapStats>; home: [number, number] | null } | null = null;
// #1467: ECharts names a map region from its GeoJSON properties.name (the
// full country name), while the map data and detail sheet key countries by
// ISO code — this maps the former to the latter for click-through.
let _mapNameToCode: Map<string, string> | null = null;

// Converts a #rrggbb (or #rgb) hex color to an rgba() string at the given
// alpha; falls back to the raw input unchanged if it isn't hex (e.g. an
// already-rgba CSS custom property value).
function _hexToRgba(hex: string, alpha: number): string {
  const m = /^#?([a-f\d]{3}|[a-f\d]{6})$/i.exec(String(hex || '').trim());
  if (!m) return hex;
  let h = m[1] ?? '';
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  const num = parseInt(h, 16);
  const r = (num >> 16) & 255, g = (num >> 8) & 255, b = num & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

// #1024: every color ECharts needs for the map was a hardcoded dark-theme
// literal (backgroundColor, geo/land fill+borders) except accentTo/mutedText,
// which already resolved live from CSS custom properties — the same class of
// bug #814 fixed for Chart.js charts (chartColors()/themeColor(), both in
// utils.js). Resolved here the same way, via themeColor() + _hexToRgba(),
// and factored into its own function so both the initial setOption() below
// and the onThemeChange repaint further down build the exact same colors.
// MUST be called at paint time, not cached — see themeColor()'s own comment.
//
// Token choices: background from --gray-900 (page-background role; dark
// theme's #131416 keeps this visually close to the old rgba(9,9,11,.55)
// literal, light theme's #f7f7f6 gives a light wash instead of a dark box),
// land fill from --gray-600 and borders from --gray-500 (the app's two
// "muted chrome" roles elsewhere, e.g. chartColors()'s own tick color) —
// alphas (.55/.4/.7/.6) kept identical to the original literals.
export function resolveWorldMapColors() {
  const bg     = themeColor('--gray-900', '#131416');
  const land   = themeColor('--gray-600', '#93989c');
  const border = themeColor('--gray-500', '#a4a9ad');
  return {
    accentTo:          themeColor('--accent-to', '#f97316'),
    mutedText:         themeColor('--gray-500', '#71717a'),
    backgroundColor:   _hexToRgba(bg, .55),
    areaColor:         _hexToRgba(land, .4),
    emphasisAreaColor: _hexToRgba(land, .6),
    borderColor:       _hexToRgba(border, .7),
    // Text-outline halo behind a bean's map label, meant to keep it legible
    // over the (accent-colored) land/scatter point beneath it regardless of
    // theme — same background role as `bg` above, not a separate token.
    textBorderColor:   _hexToRgba(bg, .7),
  };
}

// #1024: unlike the Chart.js charts (which re-theme in place via
// applyChartTheme(), see main.js's onThemeChange() registration), the map
// never repainted on a theme switch at all — switching Dark/Light/Auto while
// Statistics was already open left it on whatever colors it was built with.
// Partial setOption() (no notMerge flag) only touches the color-bearing keys
// below — no need to refetch topojson or redo the beans/shots aggregation.
function _repaintWorldMapTheme() {
  if (!_echartsInstance) return; // map not built yet (view closed / no data)
  const c = resolveWorldMapColors();
  _echartsInstance.setOption({
    backgroundColor: c.backgroundColor,
    geo: {
      itemStyle: { areaColor: c.areaColor, borderColor: c.borderColor },
      emphasis: { itemStyle: { areaColor: c.emphasisAreaColor } },
    },
    series: [
      { itemStyle: { areaColor: c.accentTo, borderColor: c.borderColor } },
      { itemStyle: { color: c.accentTo, shadowColor: _hexToRgba(c.accentTo, .6) }, label: { color: c.mutedText, textBorderColor: c.textBorderColor } },
      { lineStyle: { color: _hexToRgba(c.accentTo, .35) } },
      { itemStyle: { color: themeColor('--gray-300', '#d4d4d8') } },
    ],
  });
}

// Pure helper (unit-testable): given a list of [lon, lat] coordinates with
// data on the map, returns ECharts `geo.boundingCoords` ([[west, north],
// [east, south]]) that frames them instead of defaulting to the whole globe.
// The box is padded, clamped to valid lon/lat and widened symmetrically to a
// minimum span so a single origin still gets context.
export function computeMapBoundingCoords(coords: (number[] | null | undefined)[] | null): [[number, number], [number, number]] | undefined {
  const valid = (coords || []).filter((c): c is [number, number] => Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1]));
  if (!valid.length) return undefined;
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const [lon, lat] of valid) {
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  let west = minLon - 8, east = maxLon + 8, south = minLat - 6, north = maxLat + 6;
  // Widen symmetrically so a single origin still shows neighbouring context.
  const MIN_LON_SPAN = 30, MIN_LAT_SPAN = 20;
  if (east - west < MIN_LON_SPAN) { const pad = (MIN_LON_SPAN - (east - west)) / 2; west -= pad; east += pad; }
  if (north - south < MIN_LAT_SPAN) { const pad = (MIN_LAT_SPAN - (north - south)) / 2; south -= pad; north += pad; }
  west = Math.max(-180, west); east = Math.min(180, east);
  south = Math.max(-85, south); north = Math.min(85, north);
  return [[west, north], [east, south]];
}

// Pure helper (unit-testable): splits a ring's [lon, lat] coordinate array
// wherever two consecutive points jump by more than 180° of longitude — the
// signature of a landmass crossing the antimeridian in raw topojson→GeoJSON
// output. topojson.feature() does not cut rings at the seam, so ECharts ends
// up drawing a straight line across the whole map connecting e.g. lon=178.7
// to lon=-180. This inserts an interpolated point at lon=±180 at the split
// and returns each side as its own closed ring, so the caller can promote
// each into a separate polygon instead of one ring drawing a seam-spanning
// line. Pragmatic, not geodetically exact — good enough to kill the artifact.
// Closes a ring piece (appends its own first point) so first === last. If a
// direct close would itself cross the seam (the piece's start and end sit on
// opposite ±180 sides — this happens for a piece that both entered and exited
// through the antimeridian, e.g. a circumpolar coastline like Antarctica's),
// route the closing edge along the map border via the nearest pole instead
// of drawing straight across the map.
function _closeRingPiece(seg: Ring): Ring {
  const first = seg[0], lastPt = seg[seg.length - 1];
  if (!first || !lastPt) return seg;
  const [fx = 0, fy = 0] = first;
  const [lx = 0, ly = 0] = lastPt;
  if (fx === lx && fy === ly) return seg;
  if (Math.abs(fx - lx) > 180) {
    const pole = ly < 0 ? -90 : 90;
    const sideOut = lx > 0 ? 180 : -180;
    const sideIn  = fx > 0 ? 180 : -180;
    seg.push([sideOut, pole], [sideIn, pole], first);
  } else {
    seg.push(first);
  }
  return seg;
}

export function splitAntimeridianRing(ring: Ring): Ring[] {
  if (!Array.isArray(ring) || ring.length < 2) return [ring];
  // A ring's own closing edge (last point deep-equal to the first) can be
  // the one that jumps the seam — a circumpolar coastline (e.g. Antarctica's
  // 110m outline) that sweeps through every longitude and happens to be
  // encoded starting/ending exactly at the antimeridian. That's not two
  // separate landmasses either side of the date line (unlike Russia/Fiji),
  // so it isn't split into pieces — instead _closeRingPiece() below routes
  // that closing edge along the map border (nearest pole) instead of cutting
  // straight across, the standard way flat equirectangular maps render a
  // polygon that touches both the left and right edges.
  const firstPt = ring[0];
  const last = ring[ring.length - 1];
  if (!firstPt || !last) return [ring];
  const closesAtStart = last[0] === firstPt[0] && last[1] === firstPt[1];
  const scanEnd = closesAtStart ? ring.length - 1 : ring.length;
  const segments: Ring[] = [[firstPt]];
  for (let i = 1; i < scanEnd; i++) {
    const prev = ring[i - 1];
    const cur = ring[i];
    const current = segments[segments.length - 1];
    if (!prev || !cur || !current) continue;
    const lon1 = prev[0] ?? 0;
    const lon2 = cur[0] ?? 0;
    const lat2 = cur[1] ?? 0;
    const dLon = lon2 - lon1;
    if (Math.abs(dLon) > 180) {
      // Crossing the seam: close the current segment on this side, start a
      // new one on the other side, both anchored at the same interpolated
      // latitude on their respective edge (+180 or -180).
      const side1 = lon1 > 0 ? 180 : -180;
      const side2 = lon2 > 0 ? 180 : -180;
      current.push([side1, lat2]);
      segments.push([[side2, lat2]]);
    } else {
      current.push([lon2, lat2]);
    }
  }
  if (segments.length === 1) {
    const only = segments[0];
    if (!only) return [ring];
    return [closesAtStart ? _closeRingPiece(only) : only];
  }
  // A jump landing exactly on a closed ring's own closing edge produces a
  // degenerate 1-point trailing segment — not a renderable ring. Drop
  // segments with fewer than 2 distinct points before closing.
  const usable = segments.filter(seg => seg.length >= 2);
  if (usable.length === 0) return [ring];
  // Every surviving piece needs to be independently closed — a piece that
  // both entered and exited through the seam (start and end on opposite
  // ±180 sides) must NOT be closed by a direct chord back to its own start,
  // same fix as the circumpolar single-ring case above.
  return usable.map(_closeRingPiece);
}

// Splits a single polygon's rings (outer + holes) at the antimeridian. If no
// ring in the polygon crosses the seam, returns the polygon unchanged (as a
// single-element array so the caller can flatten uniformly). If any ring
// does cross, every resulting piece — from the outer ring or a hole — is
// promoted to its own independent single-ring polygon; the original
// outer/hole relationship isn't preserved for split pieces, which is a
// deliberate simplification (see buildWorldMap comment) since perfect
// topology at the seam isn't the goal, just killing the line artifact.
function _splitPolygonAtAntimeridian(rings: Polygon): Ring[][] {
  const allPieces: Ring[] = [];
  let anySplit = false;
  for (const ring of rings) {
    const pieces = splitAntimeridianRing(ring);
    if (pieces.length > 1) anySplit = true;
    allPieces.push(...pieces);
  }
  if (!anySplit) return [rings];
  return allPieces.map(piece => [piece]);
}

// Applies antimeridian splitting to an entire GeoJSON geometry (Polygon or
// MultiPolygon), promoting any split-off ring pieces into standalone
// polygons of a MultiPolygon rather than leaving them as extra rings of one
// polygon (which would be misread as holes). Other geometry types pass
// through unchanged.
function _splitGeometryAtAntimeridian(geometry: GeoJsonGeometry): GeoJsonGeometry {
  if (!geometry) return geometry;
  if (geometry.type === 'Polygon') {
    const polys = _splitPolygonAtAntimeridian(geometry.coordinates as Polygon);
    if (polys.length === 1) return geometry;
    return { type: 'MultiPolygon', coordinates: polys };
  }
  if (geometry.type === 'MultiPolygon') {
    const outPolys = [];
    let changed = false;
    for (const rings of geometry.coordinates as MultiPolygon) {
      const polys = _splitPolygonAtAntimeridian(rings);
      if (polys.length !== 1) changed = true;
      outPolys.push(...polys);
    }
    if (!changed) return geometry;
    return { type: 'MultiPolygon', coordinates: outPolys };
  }
  return geometry;
}

// World-map tooltip content, factored out of buildWorldMap()'s setOption()
// call so it can be unit-tested without echarts/DOM (same reasoning as
// computeMapBoundingCoords/splitAntimeridianRing above). Bean names and regions
// reach this from the Library (typed by hand) or the bean importer (scraped
// from a roaster's website), so both branches escape everything that isn't a
// fixed country code or a plain number before it's handed to echarts, which
// renders a formatter's return value as tooltip innerHTML (#1054).
export function worldMapTooltipFormatter(params: MapTooltipParams) {
  if (params.seriesType === 'map') {
    const stats = params.data?._stats;
    if (!stats) return null;
    const name = countryName(params.name, S.currentLang);
    // Annotate a bean's weighted contribution only when it's a blend
    // (non-integer share) — a single-origin bean's full count is
    // already implied by the total, no need to repeat it per-bean.
    const beanList = [...stats.beans].map(beanName => {
      const share = stats.beanShots.get(beanName);
      return Number.isInteger(share) ? esc(beanName) : `${esc(beanName)} (${Math.round(share ?? 0)})`;
    }).join(', ');
    return `${name}: ${Math.round(stats.shots)} ${t('analytics_map_shots')} (${beanList})`;
  }
  const region = params.data?._region;
  return `${esc(params.name)}${region ? ' · ' + esc(region) : ''}`;
}

// ── Origin map: home country, routes, chips and click-through (#1467) ─────
// The country the user brews in, from the browser's UI language. Intl.Locale
// maximize() fills in the likely region ("de" -> DE, "nl" -> NL); null when
// the tag can't be resolved, which simply means the map draws no routes.
// Nothing is stored or sent — a local convenience, not a setting.
export function homeCountryFromLocale(lang: string | undefined): string | null {
  if (typeof lang !== 'string' || !lang.trim()) return null;
  try {
    const region = new Intl.Locale(lang).maximize().region;
    return region ? region.toUpperCase() : null;
  } catch {
    return null;
  }
}

// [lon, lat] centre of the largest polygon's bounding box in a Polygon or
// MultiPolygon. Ranking by area keeps e.g. mainland France from being pulled
// out to its overseas territories.
export function featureLabelPoint(geometry: GeoJsonGeometry | null | undefined): [number, number] | null {
  if (!geometry || !Array.isArray(geometry.coordinates)) return null;
  const polygons: Polygon[] = geometry.type === 'Polygon'
    ? [geometry.coordinates as Polygon]
    : geometry.type === 'MultiPolygon' ? (geometry.coordinates as MultiPolygon) : [];
  let best: { area: number; bbox: [number, number, number, number] } | null = null;
  for (const rings of polygons) {
    const outer = rings?.[0];
    if (!Array.isArray(outer) || outer.length < 3) continue;
    const bbox = _ringBbox(outer);
    if (!bbox) continue;
    const area = Math.abs(_ringArea(outer));
    if (!best || area > best.area) best = { area, bbox };
  }
  if (!best) return null;
  const [minLon, minLat, maxLon, maxLat] = best.bbox;
  return [(minLon + maxLon) / 2, (minLat + maxLat) / 2];
}

function _ringBbox(ring: number[][]): [number, number, number, number] | null {
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  let any = false;
  for (const point of ring) {
    const lon = point?.[0], lat = point?.[1];
    if (typeof lon !== 'number' || typeof lat !== 'number') continue;
    any = true;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  return any ? [minLon, minLat, maxLon, maxLat] : null;
}

// Shoelace area (absolute) — only used to rank a MultiPolygon's parts, so raw
// lon/lat units (not km) are fine.
function _ringArea(ring: number[][]): number {
  let sum = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    const ax = a?.[0] ?? 0, ay = a?.[1] ?? 0, bx = b?.[0] ?? 0, by = b?.[1] ?? 0;
    sum += ax * by - bx * ay;
  }
  return sum / 2;
}

// Great-circle distance in km (haversine) between two [lon, lat] points.
export function greatCircleKm(a: [number, number], b: [number, number]): number {
  const R = 6371;
  const toRad = (deg: number): number => (deg * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Chips live just below the fixed-height map wrapper, as a sibling in the
// same analytics card.
function _mapChipsHost(wrap: HTMLElement): HTMLElement | null {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null;
  const card = wrap.parentElement;
  if (!card) return null;
  const existing = typeof card.querySelector === 'function' ? card.querySelector<HTMLElement>('.map-chips') : null;
  if (existing) return existing;
  const chips = document.createElement('div');
  chips.className = 'map-chips';
  if (typeof wrap.insertAdjacentElement === 'function') wrap.insertAdjacentElement('afterend', chips);
  else card.appendChild(chips);
  return chips;
}

function _clearMapExtras(wrap: HTMLElement): void {
  const card = wrap.parentElement;
  if (!card || typeof card.querySelector !== 'function') return;
  const chips = card.querySelector<HTMLElement>('.map-chips');
  if (chips) chips.innerHTML = html``;
  const count = card.querySelector<HTMLElement>('.analytics-map-count');
  if (count) count.remove();
}

function _renderMapChips(wrap: HTMLElement, countries: string[], byCode: Record<string, MapStats>): void {
  const host = _mapChipsHost(wrap);
  if (!host) return;
  host.innerHTML = joinHtml(countries.map(code =>
    html`<button type="button" class="chip analytics-filter-btn" data-code="${esc(code)}">${esc(countryName(code, S.currentLang))} ${esc(Math.round(byCode[code]?.shots ?? 0))}</button>`));
  if (typeof host.querySelectorAll !== 'function') return;
  host.querySelectorAll<HTMLElement>('.chip').forEach(chip => {
    const code = chip.dataset.code;
    if (!code) return;
    chip.addEventListener('click', () => _openCountryDetail(code, chip));
  });
}

function _renderMapHeadingCount(wrap: HTMLElement, n: number): void {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return;
  const card = wrap.parentElement;
  if (!card || typeof card.querySelector !== 'function') return;
  const title = card.querySelector<HTMLElement>('.analytics-section-title');
  if (!title) return;
  const old = title.querySelector<HTMLElement>('.analytics-map-count');
  if (old) old.remove();
  const span = document.createElement('span');
  span.className = 'meta-sub analytics-map-count';
  span.textContent = t('analytics_map_count', n);
  title.appendChild(span);
}

// Detail sheet for one origin country: its beans (shot count + average score)
// and — when a home point exists — the distance to the user's cup.
function _openCountryDetail(code: string, anchor: HTMLElement | DetailAnchorPoint | null): void {
  const stats = _mapClickData?.byCode[code];
  if (!stats) return;
  const locale = localeFor(S.currentLang);
  const avg = stats.scoreCount ? Math.round(stats.scoreSum / stats.scoreCount) : null;
  const rows: Html[] = [...stats.beanShots.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([beanName, share]) => {
      const count = stats.beanScoreCount.get(beanName) ?? 0;
      const sum = stats.beanScoreSum.get(beanName) ?? 0;
      const beanAvg = count ? Math.round(sum / count) : null;
      const scHtml = beanAvg !== null ? html`<span class="${esc(scoreClass(beanAvg))}">${esc(beanAvg)}</span>` : esc('—');
      return html`<div class="bests-row"><span class="bests-lbl">${esc(beanName)}</span><span class="bests-val">${esc(Math.round(share))} · ${scHtml}</span></div>`;
    });
  const centroid = COUNTRY_CENTROIDS[code];
  const home = _mapClickData?.home;
  if (home && centroid) {
    const km = Math.round(greatCircleKm(centroid, home) / 10) * 10;
    rows.push(html`<div class="bests-row"><span class="bests-lbl">${tHtml('analytics_map_distance')}</span><span class="bests-val">${esc(km.toLocaleString(locale))} km</span></div>`);
  }
  openDetailSheet({
    title: countryName(code, S.currentLang),
    sub: t('analytics_map_sub', Math.round(stats.shots), avg),
    body: html`<div class="detail-rows">${joinHtml(rows)}</div>`,
    anchor,
  });
}

interface MapClickParams {
  seriesType?: string;
  name?: string;
  data?: { _code?: string };
  event?: { clientX?: number; clientY?: number; event?: { clientX?: number; clientY?: number } };
}

// Bound once per echarts instance; reads _mapClickData for the latest build.
function _onMapClick(raw: unknown): void {
  const params = raw as MapClickParams;
  let code = params.seriesType === 'map' ? params.name : params.data?._code;
  if (!code) return;
  // Map regions are named by full country name; translate to the ISO code the
  // detail sheet keys on (an already-code name passes through unchanged).
  code = _mapNameToCode?.get(code) ?? code;
  const native = params.event?.event ?? params.event;
  const anchor = native && typeof native.clientX === 'number' && typeof native.clientY === 'number'
    ? { x: native.clientX, y: native.clientY }
    : null;
  _openCountryDetail(code, anchor);
}

export async function buildWorldMap() {
  const token = ++_worldMapReqToken;
  const wrap = document.getElementById('worldMapWrap');
  if (!wrap) return;

  // #1024: register once ever, not once per buildWorldMap() call (mirrors
  // the _worldMapRegistered guard below for echarts.registerMap) -- the
  // listener itself is a no-op via _repaintWorldMapTheme()'s _echartsInstance
  // check whenever the map hasn't been built yet. Guarded on `window` existing
  // since onThemeChange() (utils.js) binds to it unconditionally, and this
  // function is also exercised in headless unit tests with no window global
  // (test/analytics-world-map-race.test.js).
  if (!_worldMapThemeListenerRegistered && typeof window !== 'undefined') {
    onThemeChange(_repaintWorldMapTheme);
    _worldMapThemeListenerRegistered = true;
  }

  // bean name (lowercased) → { bean, origins:[{code, weight}] }, restricted to
  // known coffee countries. A blend's weights come from its per-country
  // percent when set (normalized to sum to 1), else split equally across its
  // origin countries — so one shot of a 2-country blend contributes 0.5 to
  // each by default, or e.g. 0.7/0.3 when weighted.
  const nameToBean = new Map<string, MapEntry>();
  const idToBean   = new Map<number, MapEntry>();
  for (const b of _beans()) {
    const rawOrigins: { code?: string | null; percent?: number | null }[] =
      Array.isArray(b.origins) && b.origins.length ? b.origins : (b.origin ? [{ code: b.origin }] : []);
    const valid = rawOrigins.filter(o => COFFEE_COUNTRIES.some(c => c.code === o.code));
    if (!valid.length) continue;
    const totalPercent = valid.reduce((sum, o) => sum + (o.percent || 0), 0);
    const origins = valid.map(o => ({
      code: o.code as string,
      weight: totalPercent > 0 ? (o.percent || 0) / totalPercent : 1 / valid.length,
    }));
    const entry = { bean: b, origins };
    nameToBean.set(String(b.name || '').toLowerCase(), entry);
    if (b.id != null) idToBean.set(b.id, entry);
  }
  // #456: beanId-first lookup (survives bean renames), falling back to the
  // name key for annotations that predate beanId or a name that no longer
  // resolves to any current bean.
  const resolveMapEntry = (ann: ShotAnnotation | null | undefined): MapEntry | undefined =>
    (ann?.beanId != null && idToBean.get(ann.beanId))
    || nameToBean.get(String(ann?.coffee || '').toLowerCase());

  // code → { shots, beans:Set, beanShots:Map } — beans with an origin count
  // even without shots; beanShots tracks each bean's own weighted
  // contribution to this country (only interesting — i.e. non-integer —
  // for blends), used to annotate the tooltip.
  const byCode: Record<string, MapStats> = {};
  for (const { bean, origins } of nameToBean.values()) {
    for (const o of origins) {
      let codeStats = byCode[o.code];
      if (!codeStats) {
        codeStats = { shots: 0, beans: new Set(), beanShots: new Map(), scoreSum: 0, scoreCount: 0, beanScoreSum: new Map(), beanScoreCount: new Map() };
        byCode[o.code] = codeStats;
      }
      codeStats.beans.add(bean.name);
      if (!codeStats.beanShots.has(bean.name)) codeStats.beanShots.set(bean.name, 0);
    }
  }
  for (const s of _pageShots()) {
    const entry = resolveMapEntry(s.annotation);
    if (!entry) continue;
    const score = window.calcShotScore ? window.calcShotScore(s) : null;
    for (const o of entry.origins) {
      const stats = byCode[o.code];
      if (!stats) continue;
      stats.shots += o.weight;
      stats.beanShots.set(entry.bean.name, (stats.beanShots.get(entry.bean.name) ?? 0) + o.weight);
      if (score !== null) {
        stats.scoreSum += score;
        stats.scoreCount++;
        stats.beanScoreSum.set(entry.bean.name, (stats.beanScoreSum.get(entry.bean.name) ?? 0) + score);
        stats.beanScoreCount.set(entry.bean.name, (stats.beanScoreCount.get(entry.bean.name) ?? 0) + 1);
      }
    }
  }
  for (const stats of Object.values(byCode)) {
    stats.shots = Math.round(stats.shots * 10) / 10;
    for (const [name, val] of stats.beanShots) stats.beanShots.set(name, Math.round(val * 10) / 10);
  }

  if (Object.keys(byCode).length === 0) {
    if (_echartsInstance) { _echartsInstance.dispose(); _echartsInstance = null; }
    wrap.innerHTML = html`<p class="empty-note">${tHtml('analytics_map_empty')}</p>`;
    _clearMapExtras(wrap);
    return;
  }

  // #1467: origin countries that actually have shots, most-brewed first —
  // the chips row, the heading counter and the routes all key off this list.
  const countriesWithShots = Object.keys(byCode)
    .filter(code => (byCode[code]?.shots ?? 0) > 0)
    .sort((a, b) => (byCode[b]?.shots ?? 0) - (byCode[a]?.shots ?? 0));
  if (!wrap.querySelector('.world-map-canvas')) {
    wrap.innerHTML = html`<div class="world-map-canvas" style="width:100%;height:100%"></div>
      <div class="world-map-hint">${tHtml('analytics_map_zoom_hint')}</div>`;
  }
  const container = wrap.querySelector<HTMLElement>('.world-map-canvas')!;

  if (!_worldTopo) {
    let topo: WorldTopo;
    try { topo = await (await fetch('countries-110m.json')).json() as WorldTopo; }
    catch {
      if (token !== _worldMapReqToken) return; // a newer call has since taken over
      wrap.innerHTML = html`<p class="empty-note">${tHtml('analytics_map_empty')}</p>`;
      return;
    }
    if (token !== _worldMapReqToken) return; // a newer call has since taken over
    // Guarded above by the token check — not a real race.
    _worldTopo = topo;
  }

  // #797: echarts + topojson-client only ship once there's actually
  // something to draw (not on every Analytics visit). _mapLibsPromise
  // caches the in-flight import so a second buildWorldMap() call racing
  // this one's chunk download reuses the same request instead of firing a
  // duplicate one.
  let echarts: typeof import('echarts');
  let topojson: TopojsonModule;
  try {
    if (!_mapLibsPromise) {
      // @ts-expect-error -- topojson-client 3.1.0 ships no type declarations
      _mapLibsPromise = Promise.all([import('echarts'), import('topojson-client')]);
      container.innerHTML = html`<p class="empty-note">${tHtml('analytics_map_loading')}</p>`;
    }
    [echarts, topojson] = await _mapLibsPromise;
  } catch {
    // A concurrent call resetting the same promise to null is idempotent, not a real race.
    _mapLibsPromise = null; // don't cache a rejected promise — allow a retry on the next navigation
    if (token !== _worldMapReqToken) return; // a newer call has since taken over
    wrap.innerHTML = html`<p class="empty-note">${tHtml('analytics_map_unavailable')}</p>`;
    return;
  }
  if (token !== _worldMapReqToken) return; // a newer call has since taken over

  if (!_worldMapRegistered) {
    const geo = topojson.feature(_worldTopo, _worldTopo.objects.countries);
    // Some countries' geometries cross the ±180° antimeridian (e.g. Russia,
    // Fiji); topojson.feature() doesn't cut rings there, which makes ECharts
    // draw a straight line across the whole map connecting the two edges.
    // Split those rings before they're used for anything.
    for (const f of geo.features) f.geometry = _splitGeometryAtAntimeridian(f.geometry);
    const numToCode = new Map(COFFEE_COUNTRIES.map(c => [c.num, c.code]));
    for (const f of geo.features) f.properties = { ...f.properties, code: numToCode.get(String(f.id)) || null };
    // #1467: ECharts fires a map click with the region's full name; remember
    // the name -> ISO code relationship so click-through can resolve it.
    _mapNameToCode = new Map<string, string>();
    for (const f of geo.features) {
      const props = f.properties as { name?: string; code?: string | null };
      if (props.name && props.code) _mapNameToCode.set(props.name, props.code);
    }
    // #1467: place the home point on the registered geometry once — the
    // bounding-box centre of the home country's largest landmass.
    if (!_worldMapHome) {
      const homeCode = homeCountryFromLocale(typeof navigator !== 'undefined' ? navigator.language : undefined);
      const homeNum = homeCode ? HOME_COUNTRY_NUM[homeCode] : undefined;
      const homeFeature = homeNum ? geo.features.find(f => String(f.id) === homeNum) : undefined;
      _worldMapHome = homeFeature ? featureLabelPoint(homeFeature.geometry) : null;
    }
    // topojson-client ships no types, so its GeoJSON output can't be matched to ECharts' map input.
    echarts.registerMap('world', geo as unknown as Parameters<typeof echarts.registerMap>[1]);
    _worldMapRegistered = true;
  }

  const mapData = Object.entries(byCode).map(([code, d]) => ({
    name: code,
    value: 1, // presence only — fill color is boolean, not shot-count driven
    _stats: d,
  }));

  // Scatter points: bean.location if geocoded, else the country centroid
  // (jittered a few tenths of a degree per extra bean so points don't stack).
  const seenAtCentroid: Record<string, number> = {};
  const points: { name: string; value: number[]; _region: string | null; _code: string }[] = [];
  for (const { bean, origins } of nameToBean.values()) {
    // Even a blend gets exactly one map point — from its geocoded growing
    // region if resolved, else a centroid fallback keyed on its primary
    // (first-listed) origin country.
    const primary = origins[0];
    if (!primary) continue;
    const primaryCode = primary.code;
    let coord: number[] | null = bean.location ? [bean.location.lon, bean.location.lat] : null;
    if (!coord) {
      const centroid = COUNTRY_CENTROIDS[primaryCode];
      if (!centroid) continue;
      const n = (seenAtCentroid[primaryCode] = (seenAtCentroid[primaryCode] || 0) + 1) - 1;
      const jitter = n * 0.35;
      coord = [centroid[0] + (n % 2 === 0 ? jitter : -jitter), centroid[1] + (n % 3) * 0.2];
    }
    const shots = byCode[primaryCode]?.beans.has(bean.name)
      ? _pageShots().filter(s => resolveMapEntry(s.annotation)?.bean === bean).length
      : 0;
    // #1467: the always-visible bean-name labels are gone (the chips below
    // the map replace them); the tooltip still names the bean. _code keys the
    // point back to its primary origin country for click-through.
    points.push({ name: bean.name, value: [...coord, shots], _region: bean.region || null, _code: primaryCode });
  }

  // Brand + chrome colors, read live from the CSS custom properties so the
  // map follows whichever accent/theme the user has picked (#1024: this used
  // to be true only for accentTo/mutedText, with the rest hardcoded dark).
  const c = resolveWorldMapColors();

  if (!_echartsInstance) {
    container.innerHTML = html``; // clear the loading message before echarts takes over this node
    _echartsInstance = echarts.init(container);
    // #1467: one click handler per instance; it reads _mapClickData.
    _echartsInstance.on('click', _onMapClick);
  }

  const home = _worldMapHome;
  const mapPoints = [
    ...Object.keys(byCode).map(code => COUNTRY_CENTROIDS[code]).filter(Boolean),
    ...points.map(p => [p.value[0] ?? 0, p.value[1] ?? 0]),
    // #1467: include the home point so the routes to it stay fully visible.
    ...(home ? [home] : []),
  ];
  const boundingCoords = computeMapBoundingCoords(mapPoints);

  // #1467: routes ("travelling beans") — one line per origin country with
  // shots, from its centroid to the home point. Animated only when the user
  // hasn't asked for reduced motion.
  const animateRoutes = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: no-preference)').matches;
  const routeData = home
    ? countriesWithShots
        .map(code => COUNTRY_CENTROIDS[code])
        .filter((centroid): centroid is [number, number] => Array.isArray(centroid))
        .map(centroid => ({ coords: [centroid, home] }))
    : [];
  _mapClickData = { byCode, home };

  _echartsInstance.setOption({
    backgroundColor: c.backgroundColor,
    tooltip: {
      formatter: worldMapTooltipFormatter,
    },
    geo: {
      map: 'world', roam: true, scaleLimit: { min: 1, max: 12 }, boundingCoords,
      itemStyle: { areaColor: c.areaColor, borderColor: c.borderColor, borderWidth: 0.5 },
      emphasis: { itemStyle: { areaColor: c.emphasisAreaColor }, label: { show: false } },
    },
    series: [
      {
        type: 'map', map: 'world', geoIndex: 0,
        data: mapData,
        itemStyle: { areaColor: c.accentTo, borderColor: c.borderColor, borderWidth: 0.5 },
        emphasis: { label: { show: false } },
      },
      {
        type: 'effectScatter', coordinateSystem: 'geo',
        data: points,
        symbolSize: 7,
        itemStyle: { color: c.accentTo, shadowBlur: 8, shadowColor: _hexToRgba(c.accentTo, .6) },
        label: { show: false, color: c.mutedText, textBorderColor: c.textBorderColor, textBorderWidth: 2 },
        labelLayout: { hideOverlap: true },
        rippleEffect: { scale: 2.5 },
      },
      {
        // #1467: routes from each origin country to the user's cup.
        type: 'lines', coordinateSystem: 'geo',
        data: routeData, polyline: false, silent: true,
        lineStyle: { color: _hexToRgba(c.accentTo, .35), width: 1, curveness: 0.25 },
        ...(animateRoutes ? { effect: { show: true, period: 6, trailLength: 0, symbol: 'circle', symbolSize: 3 } } : {}),
      },
      {
        // #1467: a small static dot marking the home point.
        type: 'scatter', coordinateSystem: 'geo',
        name: t('analytics_map_home'),
        data: home ? [{ name: t('analytics_map_home'), value: [home[0], home[1]] }] : [],
        symbolSize: 6,
        itemStyle: { color: themeColor('--gray-300', '#d4d4d8') },
        label: { show: false },
      },
    ],
  }, true);

  // #1467: chips + heading counter live outside the map wrapper.
  _renderMapChips(wrap, countriesWithShots, byCode);
  _renderMapHeadingCount(wrap, countriesWithShots.length);

  if (!_resizeBound) {
    window.addEventListener('resize', () => _echartsInstance?.resize());
    _resizeBound = true;
  }
  _echartsInstance.resize();
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

  const bgColor = (sc: number): string => sc >= 88 ? 'rgba(34,197,94,.7)' : sc >= 75 ? 'rgba(132,204,22,.7)'
                     : sc >= 60 ? 'rgba(234,179,8,.7)'  : sc >= 45 ? 'rgba(249,115,22,.7)' : 'rgba(239,68,68,.7)';

  chartRegistry.set('profileBarChart', new Chart(ctx, {
    type: 'bar',
    data: {
      labels:   entries.map(e => e.name.length > 20 ? e.name.slice(0, 19) + '…' : e.name),
      datasets: [{ label: 'Ø Score', data: entries.map(e => e.avgScore),
                   backgroundColor: entries.map(e => bgColor(e.avgScore)), borderRadius: 4 }]
    },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { afterLabel: (c: { dataIndex: number }) => {
          const e = entries[c.dataIndex];
          return `${e ? e.count : 0} Shots`;
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
      const title = `${weekdayLabels[wd]} ${String(h).padStart(2, '0')}:00 — ${c} Shot${c === 1 ? '' : 's'}`;
      cells.push(html`<div class="wh-cell wh-l${esc(level(c))}" title="${esc(title)}"></div>`);
    }
    dayRows.push(html`<div class="wh-row"><div class="wh-label">${esc(weekdayLabels[wd])}</div>${joinHtml(cells)}</div>`);
  }
  el.innerHTML = html`<div class="wh-heatmap"><div class="wh-row wh-header"><div class="wh-label"></div>${joinHtml(hourLabels)}</div>${joinHtml(dayRows)}</div>`;
}

// ── Beans by score (#1467) ──────────────────────────────────────────────────
// One shelf of beans, sorted by average score (or shot count), each tile a
// tap away from the bean's detail sheet. Pure aggregation kept separate from
// rendering (unit-testable without a DOM).
export function _computeBeanRanking(shots: ShotRow[]): BeanRankRow[] {
  const byBean: Record<string, ShotRow[]> = {};
  for (const s of shots) {
    const name = s.annotation?.coffee;
    if (!name) continue;
    let list = byBean[name];
    if (!list) { list = []; byBean[name] = list; }
    list.push(s);
  }

  const rows: BeanRankRow[] = [];
  for (const [name, beanShots] of Object.entries(byBean)) {
    const sorted = [...beanShots].sort((a, b) => a.timestamp - b.timestamp);
    const scored = sorted
      .map(s => ({ s, sc: window.calcShotScore ? window.calcShotScore(s) : null }))
      .filter((x): x is { s: ShotRow; sc: number } => x.sc !== null);
    const avgScore = scored.length ? Math.round(scored.reduce((a, x) => a + x.sc, 0) / scored.length) : null;
    const best = scored.length ? Math.max(...scored.map(x => x.sc)) : null;
    const hundreds = scored.reduce((a, x) => a + (x.sc >= 100 ? 1 : 0), 0);

    // The first shot (1-based, chronological) to reach 80 — the old dial-in
    // figure the bean cards reported.
    let firstGood: number | null = null;
    if (window.calcShotScore) {
      for (let i = 0; i < sorted.length; i++) {
        const shot = sorted[i];
        if (!shot) continue;
        const sc = window.calcShotScore(shot);
        if (sc !== null && sc >= 80) { firstGood = i + 1; break; }
      }
    }

    // Brew time in seconds from the ×10-scaled duration, ignoring the ≤ 5 s
    // noise of aborted shots.
    const times = sorted.map(s => (s.duration || 0) / 10).filter(d => d > 5);
    const avgTime = times.length ? Math.round((times.reduce((a, b) => a + b, 0) / times.length) * 10) / 10 : null;

    const lastShot = sorted[sorted.length - 1];
    const lastBeanId = lastShot?.annotation?.beanId;
    const beanId = typeof lastBeanId === 'number' ? lastBeanId : null;

    const lastGrindShot = [...sorted].reverse().find(s => s.annotation?.grindSetting);
    const lastGrind = lastGrindShot ? lastGrindShot.annotation!.grindSetting : null;

    let trend = null;
    if (scored.length >= 4) {
      const last5 = scored.slice(-5);
      const prev5 = scored.slice(Math.max(0, scored.length - 10), scored.length - 5);
      if (prev5.length >= 2) {
        const avg = (arr: { s: ShotRow; sc: number }[]) => arr.reduce((a, x) => a + x.sc, 0) / arr.length;
        trend = Math.round((avg(last5) - avg(prev5)) * 10) / 10;
      }
    }

    rows.push({ name, beanId, shots: sorted.length, avgScore, best, hundreds, avgTime, firstGood, lastGrind, trend });
  }
  return rows;
}

// Sort rows for the shelf. Score: descending, nulls last, ties broken by shot
// count. Shots: descending, then the same score order.
export function _sortBeanShelfRows(rows: BeanRankRow[], key: 'score' | 'shots'): BeanRankRow[] {
  const scoreDesc = (a: BeanRankRow, b: BeanRankRow): number => {
    if (a.avgScore == null && b.avgScore == null) return b.shots - a.shots;
    if (a.avgScore == null) return 1;
    if (b.avgScore == null) return -1;
    return b.avgScore - a.avgScore || b.shots - a.shots;
  };
  const copy = [...rows];
  copy.sort(key === 'shots' ? (a, b) => b.shots - a.shots || scoreDesc(a, b) : scoreDesc);
  return copy;
}

// The library bean a shelf row belongs to: by the most recent shot's beanId
// first, else by case-insensitive name.
function _matchLibraryBean(row: BeanRankRow): SharedBean | null {
  const beans = _beans();
  if (row.beanId !== null) {
    const byId = beans.find(b => b.id === row.beanId);
    if (byId) return byId;
  }
  const name = row.name.toLowerCase();
  return beans.find(b => String(b.name || '').toLowerCase() === name) ?? null;
}

function _shelfImageBean(row: BeanRankRow, bean: SharedBean | null): ShelfBagImageBean {
  if (!bean) return { name: row.name };
  return {
    id: typeof bean.id === 'number' ? bean.id : null,
    name: bean.name,
    roaster: typeof bean.roaster === 'string' ? bean.roaster : null,
    image: typeof bean.image === 'string' ? bean.image : null,
  };
}

const _BEAN_SHELF_LIMIT = 16;
let _beanShelfSort: 'score' | 'shots' = 'score';
let _beanShelfColumnsWired = false;

// The shelf grid is 3 columns on phones and 8 from 900px up. Showing a
// partial last row leaves a lone tile on the second row, so the visible
// shelf carries only complete rows; the rest waits behind "show all".
function _beanShelfColumns(): number {
  return typeof window.matchMedia === 'function' && window.matchMedia('(min-width: 900px)').matches ? 8 : 3;
}

function _beanShelfHeadCount(total: number): number {
  const columns = _beanShelfColumns();
  const cap = Math.min(_BEAN_SHELF_LIMIT, total);
  if (cap < columns) return cap; // fewer beans than one row: show them all
  return Math.floor(cap / columns) * columns;
}

// Re-render when the grid crosses the 900px 3→8 column breakpoint.
function _watchBeanShelfColumns(): void {
  if (_beanShelfColumnsWired || typeof window.matchMedia !== 'function') return;
  _beanShelfColumnsWired = true;
  window.matchMedia('(min-width: 900px)').addEventListener('change', () => buildBeanShelf());
}

// Bean photos need the auth token, so <img src> can't point at the API
// (see bean-image.js). Load them directly here rather than through
// views/library.js, whose loadBeanThumbnails would pull in the whole
// Library module (and its lightbox) just to fill these tiles.
function _loadBeanShelfThumbnails(): void {
  document.querySelectorAll<HTMLImageElement>('#beanShelf .lib-shelf-img[data-bean-id]').forEach(img => {
    const id = Number(img.dataset.beanId);
    void loadBeanImageBlobUrl(id).then(url => { if (url) img.src = url; });
  });
}

function _beanShelfTile(row: BeanRankRow, rank: number): Html {
  const bean = _matchLibraryBean(row);
  const avg = row.avgScore;
  const score = avg !== null
    ? html`<span class="analytics-shelf-score" style="color:${esc(scoreColor(avg))}">${esc(avg)}</span>`
    : html`<span class="analytics-shelf-score">–</span>`;
  const crema = row.hundreds > 0
    ? html`<span class="analytics-shelf-crema" title="${esc(t('analytics_shelf_perfect'))}"></span>`
    : esc('');
  return html`<button type="button" class="analytics-shelf-tile" data-action="analytics-bean" data-name="${esc(row.name)}">
    <span class="analytics-shelf-rank${esc(rank <= 3 ? ' top' : '')}">${esc(rank)}</span>
    <span class="analytics-shelf-bag">${shelfBagImage(_shelfImageBean(row, bean))}</span>
    <span class="analytics-shelf-name serif-display">${esc(row.name)}</span>
    <span class="analytics-shelf-row2">${score}${crema}</span>
    <span class="analytics-shelf-shots">${esc(row.shots)} ${tHtml('bean_stat_shots')}</span>
  </button>`;
}

export function buildBeanShelf(): void {
  const el = document.getElementById('beanShelf');
  if (!el) return;
  _watchBeanShelfColumns();

  const rows = _sortBeanShelfRows(_computeBeanRanking(_pageShots()), _beanShelfSort);
  const countEl = document.getElementById('beanShelfCount');
  if (countEl) countEl.textContent = rows.length ? String(rows.length) : '';
  if (!rows.length) {
    el.innerHTML = html`<p class="empty-note">${tHtml('analytics_no_beans')}</p>`;
    return;
  }

  const total = rows.length;
  const headCount = _beanShelfHeadCount(total);
  const head = rows.slice(0, headCount);
  const rest = rows.slice(headCount);
  el.innerHTML = html`
    <div class="analytics-shelf">${joinHtml(head.map((r, i) => _beanShelfTile(r, i + 1)))}</div>
    ${rest.length ? html`
      <div class="analytics-shelf analytics-shelf-rest" id="beanShelfRest" style="display:none">${joinHtml(rest.map((r, i) => _beanShelfTile(r, headCount + i + 1)))}</div>
      <button type="button" class="analytics-shelf-more" id="beanShelfMore" data-action="expand-bean-shelf">${tHtml('analytics_shelf_show_all', total)}</button>` : esc('')}`;

  _loadBeanShelfThumbnails();
}

export function setBeanShelfSort(key: 'score' | 'shots'): void {
  _beanShelfSort = key;
  document.querySelectorAll<HTMLElement>('[data-action="set-bean-shelf-sort"]').forEach(chip => {
    const on = chip.dataset.sort === key;
    chip.classList.toggle('active', on);
    chip.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  buildBeanShelf();
}

export function expandBeanShelf(): void {
  const rest = document.getElementById('beanShelfRest');
  if (rest) rest.style.display = '';
  document.getElementById('beanShelfMore')?.remove();
}

// Detail sheet for one bean on the shelf: its numbers, its dial-in figure and
// trend — and, when the bean exists in the library, a shortcut to its sheet.
export function openBeanShelfDetail(name: string, anchor: HTMLElement | null): void {
  const row = _computeBeanRanking(_pageShots()).find(r => r.name === name);
  if (!row) return;
  const bean = _matchLibraryBean(row);
  const line = (lbl: string, val: Html): Html =>
    html`<div class="bests-row"><span class="bests-lbl">${esc(lbl)}</span><span class="bests-val">${val}</span></div>`;

  const parts: Html[] = [line(t('bean_stat_shots'), esc(row.shots))];
  if (row.avgScore !== null) parts.push(line(t('bean_stat_avg'), html`<span class="${esc(scoreClass(row.avgScore))}">${esc(row.avgScore)}</span>`));
  if (row.best !== null) parts.push(line(t('bean_stat_best'), html`<span class="${esc(scoreClass(row.best))}">${esc(row.best)}</span>`));
  if (row.hundreds > 0) parts.push(line(t('analytics_shelf_perfect'), esc(row.hundreds)));
  if (row.avgTime !== null) parts.push(line(t('bean_stat_duration'), esc(`${row.avgTime} s`)));
  if (row.lastGrind != null && row.lastGrind !== '') parts.push(line(t('ann_grind_setting'), esc(String(row.lastGrind))));
  if (row.firstGood !== null) parts.push(line(t('analytics_bean_dialed_in'), tHtml('analytics_bean_dialed_in_at', row.firstGood)));
  if (row.trend !== null) {
    const color = row.trend > 0 ? scoreColor(100) : row.trend < 0 ? scoreColor(0) : 'var(--gray-500)';
    const sign = row.trend > 0 ? '+' : '';
    parts.push(line(t('analytics_bean_rank_trend'), html`<span style="color:${esc(color)}">${esc(`${sign}${row.trend}`)}</span>`));
  }
  if (bean && typeof bean.id === 'number') {
    parts.push(html`<div class="bests-row"><span class="bests-lbl"></span><span class="bests-val"><button type="button" class="bests-link" data-action="open-bean-shelf-in-library" data-id="${esc(bean.id)}">${tHtml('analytics_open_in_library')}</button></span></div>`);
  }

  const roaster = bean && typeof bean.roaster === 'string' ? bean.roaster : '';
  openDetailSheet({
    title: row.name,
    sub: roaster,
    body: html`<div class="detail-rows">${joinHtml(parts)}</div>`,
    anchor,
  });
}

// ── "Did you know?" facts ────────────────────────────────────────────────────
// Four cards at a time out of computeFacts()'s list. Shuffle advances to the
// next four of a shuffled order and reshuffles once it runs past the end, so
// there are always four cards while at least four facts hold.
const FACTS_ICONS: Record<FactIcon, Html> = {
  moon: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a6.6 6.6 0 0 0 9.8 9.8Z"/></svg>`,
  cups: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9h12v6a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4V9Z"/><path d="M16 10h1.5a2.5 2.5 0 0 1 0 5H16"/><path d="M8 3v2M12 3v2"/></svg>`,
  clock: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/><path d="M12 8v4l2.5 1.5"/></svg>`,
  bolt: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M13 3 5 13h6l-1 8 8-10h-6l1-8Z"/></svg>`,
  cal: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="5" width="16" height="16" rx="2"/><path d="M4 9h16M8 3v4M16 3v4"/></svg>`,
  jug: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8h10l-1 11a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L6 8Z"/><path d="M16 10h1.5a2 2 0 0 1 0 4H16"/><path d="M9 4h4"/></svg>`,
  film: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 5v14M17 5v14M3 9h4M3 15h4M17 9h4M17 15h4"/></svg>`,
  suitcase: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="8" width="18" height="11" rx="2"/><path d="M9 8V6a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>`,
  snail: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17h11a4 4 0 1 0-3.6-5.8"/><path d="M14 11a2 2 0 1 0-1.4 3.4"/><path d="M19 9l-1.5 2L19 13"/></svg>`,
};

const _FACTS_PER_PAGE = 4;
let _factsList: Fact[] = [];
let _factsOrder: number[] = [];
let _factsShown = 0;

function _shuffledIndices(n: number): number[] {
  const order = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const a = order[i];
    const b = order[j];
    if (a === undefined || b === undefined) continue;
    order[i] = b;
    order[j] = a;
  }
  return order;
}

// Four faint stars for a night fact, positioned inline so they do not depend
// on the card's child order.
function _factStars(): Html {
  const spots: [number, number][] = [[12, 16], [26, 30], [42, 12], [18, 46]];
  return joinHtml(spots.map(([top, right]) =>
    html`<span class="analytics-fact-star" style="top:${esc(top)}px;right:${esc(right)}px"></span>`));
}

function _factCard(fact: Fact): Html {
  const sentence = t(fact.textKey, fact.vars);
  const gauge = fact.gauge !== undefined
    ? html`<span class="analytics-fact-gauge"><span class="analytics-fact-gauge-fill" style="width:${esc(Math.max(0, Math.min(100, fact.gauge)).toFixed(1))}%"></span></span>`
    : esc('');
  return html`<button type="button" class="analytics-fact${fact.night ? html` night` : esc('')}" data-action="analytics-fact" data-fact="${esc(fact.id)}">
    ${fact.night ? _factStars() : esc('')}
    <span class="analytics-fact-icon" aria-hidden="true">${FACTS_ICONS[fact.icon]}</span>
    <span class="analytics-fact-big serif-display">${esc(fact.big)}</span>
    <span class="analytics-fact-text">${esc(sentence)}</span>
    ${gauge}
  </button>`;
}

function _renderFactsPage(): void {
  const el = document.getElementById('analyticsFacts');
  if (!el) return;
  const n = _factsList.length;
  const take = Math.min(_FACTS_PER_PAGE, n);
  const cards: Html[] = [];
  for (let k = 0; k < take; k++) {
    const idx = _factsOrder[(_factsShown + k) % n];
    const fact = idx === undefined ? undefined : _factsList[idx];
    if (fact) cards.push(_factCard(fact));
  }
  el.innerHTML = html`${joinHtml(cards)}`;
}

export function buildFacts(): void {
  const card = document.getElementById('analyticsFactsCard');
  const el = document.getElementById('analyticsFacts');
  if (!card || !el) return;
  const facts = computeFacts(
    _shots(),
    s => (window.calcShotScore ? window.calcShotScore(s) : null),
    localeFor(S.currentLang),
  );
  _factsList = facts;
  if (facts.length < 3) {
    card.style.display = 'none';
    el.innerHTML = html``;
    return;
  }
  card.style.display = '';
  const countEl = document.getElementById('analyticsFactsCount');
  if (countEl) countEl.textContent = t('analytics_facts_count', facts.length);
  _factsOrder = _shuffledIndices(facts.length);
  _factsShown = 0;
  _renderFactsPage();
}

export function shuffleFacts(): void {
  const n = _factsList.length;
  if (n < 3) return;
  _factsShown += _FACTS_PER_PAGE;
  if (_factsShown >= n) {
    _factsOrder = _shuffledIndices(n);
    _factsShown = 0;
  }
  _renderFactsPage();
}

// Detail sheet for one fact: the big value as the title, the sentence as the
// subtitle and the fact's rows in the same markup the bean shelf uses.
export function openFactDetail(id: string, anchor: HTMLElement | null): void {
  const fact = _factsList.find(f => f.id === id);
  if (!fact) return;
  const sentence = t(fact.textKey, fact.vars);
  const rows = fact.rows.map(([label, value]) =>
    html`<div class="bests-row"><span class="bests-lbl">${esc(t(label))}</span><span class="bests-val">${esc(value)}</span></div>`);
  openDetailSheet({
    title: fact.big,
    sub: sentence,
    body: html`<div class="detail-rows">${joinHtml(rows)}</div>`,
    anchor,
  });
}

// ── Machine comparison ──────────────────────────────────────────────────────
// Deliberately reads S.allShots (unfiltered), not S.shots — comparing
// machines against each other only makes sense across all of them,
// regardless of whatever S.activeMachineId currently scopes the rest of
// the app to. Only rendered once >=2 machines are registered.
function _tempStability(shot: ShotRow): number | null {
  // #957: the server computes this scalar per GET /api/shots row
  // (tempStabilityDev) from the same temp+target series it parses to score —
  // no per-shot curve fetch needed here. Fall back to a local compute only
  // for synthetic/demo shots that carry their own datapoints inline.
  if (shot.tempStabilityDev !== undefined) return shot.tempStabilityDev;
  const d = shot.datapoints ?? {};
  const temp = d.temperature, target = d.targetTemperature;
  if (!temp?.length || !target?.length) return null;
  const n = Math.min(temp.length, target.length);
  let sum = 0, count = 0;
  for (let i = 0; i < n; i++) {
    const t = temp[i], tg = target[i];
    if (t == null || tg == null || tg === 0) continue;
    sum += Math.abs(t - tg) / 10; // both datapoints ×10-scaled per GLP convention
    count++;
  }
  return count ? sum / count : null;
}

export function _computeMachineComparison(shots: ShotRow[], machines: MachineRow[]) {
  const byMachine: Record<number, { name: string | null | undefined; shots: ShotRow[] }> = {};
  for (const m of machines) byMachine[m.id] = { name: m.name, shots: [] };
  for (const s of shots) {
    const mid = s.machineId ?? 1;
    const machine = byMachine[mid];
    if (machine) machine.shots.push(s);
  }

  return Object.values(byMachine).map(d => {
    const scored = d.shots
      .map(s => window.calcShotScore ? window.calcShotScore(s) : null)
      .filter((sc): sc is number => sc !== null);
    const avgScore = scored.length ? Math.round(scored.reduce((a, b) => a + b, 0) / scored.length) : null;

    const durations = d.shots.map(s => (s.duration || 0) / 10).filter(x => x > 5);
    const avgDuration = durations.length ? Math.round((durations.reduce((a, b) => a + b, 0) / durations.length) * 10) / 10 : null;

    const stabilities = d.shots.map(_tempStability).filter((x): x is number => x != null);
    const avgStability = stabilities.length ? Math.round((stabilities.reduce((a, b) => a + b, 0) / stabilities.length) * 10) / 10 : null;

    return { name: d.name, count: d.shots.length, avgScore, avgDuration, avgStability };
  });
}

export function buildMachineComparison() {
  const card = document.getElementById('machineComparisonCard');
  if (!card) return;
  const machines = _machines() || [];
  if (machines.length < 2) { card.style.display = 'none'; return; }
  card.style.display = '';

  const el = document.getElementById('machineComparison');
  if (!el) return;

  const rows = _computeMachineComparison(_allShots() || [], machines);
  if (!rows.some(r => r.count > 0)) {
    el.innerHTML = html`<p class="empty-note">${tHtml('analytics_no_machine_data')}</p>`;
    return;
  }

  const rowsHtml = joinHtml(rows.map(r => html`<tr>
    <td>${esc(r.name)}</td>
    <td class="num">${esc(r.count)}</td>
    <td class="num">${r.avgScore !== null ? html`<span class="${esc(scoreClass(r.avgScore))}">${esc(r.avgScore)}</span>` : esc('–')}</td>
    <td class="num">${esc(r.avgDuration !== null ? r.avgDuration + 's' : '–')}</td>
    <td class="num">${esc(r.avgStability !== null ? '±' + r.avgStability + '°' : '–')}</td>
  </tr>`));

  el.innerHTML = html`<div class="analytics-table-wrap"><table class="analytics-table">
    <thead><tr>
      <th>${tHtml('maint_log_machine')}</th><th>${tHtml('bean_stat_shots')}</th><th>${tHtml('bean_stat_avg')}</th>
      <th>${tHtml('bean_stat_duration')}</th><th>${tHtml('analytics_machine_stability')}</th>
    </tr></thead>
    <tbody>${rowsHtml}</tbody>
  </table></div>`;
}

// ── Dial-in progression ─────────────────────────────────────────────────────
// Per-bean line chart of grind setting and score across that bean's own shot
// sequence, so a dial-in arc is visible independent of calendar time. Bean
// names are matched case-insensitively (annotation.coffee), same convention
// as suggestGrindDoseForBean()/computeBeanRemaining() elsewhere.
export function buildDialinProgression() {
  const sel = document.getElementById('dialinProgressionBeanSelect') as HTMLSelectElement | null;
  if (!sel) return;

  const seen = new Map<string, string>();
  for (const s of _pageShots()) {
    const name = s.annotation?.coffee;
    if (!name) continue;
    const key = name.toLowerCase();
    if (!seen.has(key)) seen.set(key, name);
  }
  const beanNames = [...seen.values()].sort((a, b) => a.localeCompare(b));

  if (!beanNames.length) {
    sel.innerHTML = html``;
    _renderDialinProgressionChart(null);
    return;
  }

  const prevValue = sel.value;
  sel.innerHTML = joinHtml(beanNames.map(n => html`<option value="${esc(n)}">${esc(n)}</option>`));
  sel.value = beanNames.includes(prevValue) ? prevValue : beanNames[0] ?? '';
  _renderDialinProgressionChart(sel.value);
}

export function setDialinProgressionBean(name: string): void {
  _renderDialinProgressionChart(name);
}

function _renderDialinProgressionChart(beanName: string | null): void {
  // #814: resolved per render, never at module load — the value has to be
  // whatever the ACTIVE theme resolves to right now.
  const C = chartColors();
  const ctx = _chartCanvas('dialinProgressionChart');
  if (!ctx) return;
  chartRegistry.dispose('dialinProgressionChart');

  if (!beanName) {
    ctx.parentElement!.innerHTML = html`<p class="empty-note pad-top">${tHtml('analytics_no_beans')}</p>`;
    return;
  }

  const shots = _pageShots()
    .filter(s => (s.annotation?.coffee || '').toLowerCase() === beanName.toLowerCase())
    .sort((a, b) => a.timestamp - b.timestamp);

  if (shots.length < 2) {
    ctx.parentElement!.innerHTML = html`<p class="empty-note pad-top">${tHtml('analytics_no_trend')}</p>`;
    return;
  }

  const labels    = shots.map((_, i) => `#${i + 1}`);
  const grindData = shots.map(s => _parseGrindNum(s.annotation?.grindSetting));
  const scoreData = shots.map(s => window.calcShotScore ? window.calcShotScore(s) : null);

  chartRegistry.set('dialinProgressionChart', new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: t('ann_grind_setting'), data: grindData, borderColor: '#38bdf8', backgroundColor: 'transparent',
          yAxisID: 'y', spanGaps: true, tension: .2, pointRadius: 3 },
        { label: 'Score', data: scoreData, borderColor: '#ef4444', backgroundColor: 'transparent',
          yAxisID: 'y1', spanGaps: true, tension: .2, pointRadius: 3 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      onClick: (_: unknown, elements: { index: number }[]) => {
        const first = elements[0];
        const shot = first ? shots[first.index] : undefined;
        if (shot && window.goToShot) window.goToShot(shot.id);
      },
      plugins: { legend: { labels: { color: C.tick, font: { size: 11 } } } },
      scales: {
        x:  { ticks: { color: _mutedTickColor(), font: { size: 10 } }, grid: { color: themeColor('--gray-700', '#2b2f33') } },
        y:  { position: 'left',  ticks: { color: _mutedTickColor(), font: { size: 10 } }, grid: { color: themeColor('--gray-700', '#2b2f33') } },
        y1: { position: 'right', min: 0, max: 100, ticks: { color: _mutedTickColor(), font: { size: 10 } }, grid: { drawOnChartArea: false } },
      },
    },
  } satisfies ChartConfiguration<'line'>));
}
