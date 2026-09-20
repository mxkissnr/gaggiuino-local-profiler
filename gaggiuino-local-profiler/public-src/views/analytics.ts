import Chart from 'chart.js/auto';
import { S } from '../state/index.js';
import * as chartRegistry from '../state/charts.js';
import * as timerRegistry from '../state/timers.js';
import { t } from '../i18n.js';
import { localeFor, COFFEE_COUNTRIES, COUNTRY_CENTROIDS, countryName } from '../constants.js';
import { esc, scoreClass, chartColors, themeColor, onThemeChange } from '../utils.js';
import { _parseGrindNum } from './shots/grind.js';
import { _equipmentName } from './shots/index.js';
import { TARGET_ICON_SVG, WARNING_ICON_SVG } from '../icons.js';
import type { MachineRecord, ShotMeta } from '../state/index.js';
import type { ChartConfiguration } from 'chart.js';

// state/index.ts types shot rows as metadata-only ShotMeta (id/timestamp plus
// an index signature); this view reads the annotation, profile, curve and
// machine fields, so this local alias names them — same pattern as
// views/shots/index.ts.
interface ShotAnnotation {
  coffee?: string | null;
  beanId?: number | null;
  basketId?: number | null;
  puckScreenId?: number | null;
  grinder?: string | null;
  grindSetting?: string | number | null;
  dose?: number | null;
}

interface ShotRow extends ShotMeta {
  profileName?: string | null;
  profile?: { name?: string | null } | null;
  duration?: number | null;
  weight?: number | null;
  tempStabilityDev?: number | null;
  datapoints?: { temperature?: (number | null)[]; targetTemperature?: (number | null)[] } | null;
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

// Bean ranking table (#394).
interface BeanRankRow {
  name: string;
  shots: number;
  avgScore: number | null;
  lastGrind: string | number | null | undefined;
  trend: number | null;
}

type BeanRankKey = 'name' | 'shots' | 'avgScore' | 'lastGrind' | 'trend';

// CoffeeLibrary (state/index.ts) types beans/grinders only; the world map
// additionally reads each bean's origin list and geocoded location.
interface SharedBean {
  id?: number | null;
  name: string;
  origin?: string | null;
  region?: string | null;
  origins?: { code?: string | null; percent?: number | null }[] | null;
  location?: { lon: number; lat: number } | null;
}

function _beans(): SharedBean[] { return (S.coffeeLibrary.beans || []) as unknown as SharedBean[]; }

// baskets/puckScreens are library collections CoffeeLibrary doesn't declare —
// same collection-by-name lookup views/shots/index.ts does for its own
// annotation panel.
function _libCollection(name: 'baskets' | 'puckScreens'): Record<string, unknown>[] | undefined {
  return (S.coffeeLibrary as unknown as Record<string, Record<string, unknown>[] | undefined>)[name];
}

// World map: a bean's origins (a blend carries several), the per-country
// stats the tooltip reads back off a series datum, and the params ECharts
// hands a tooltip formatter.
interface MapOrigin { code: string; weight: number }
interface MapEntry { bean: SharedBean; origins: MapOrigin[] }
interface MapStats { shots: number; beans: Set<string>; beanShots: Map<string, number> }

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

// ── Analytics entry point ─────────────────────────────────────────────────
export function initAnalytics() {
  // #957: S.allShots is filled by a background page walk after the Shots tab
  // first paints. Analytics is a whole-history view — build from whatever is
  // loaded now, and re-run once the walk finishes so the numbers settle on
  // the full history. (Builders below read S.allShots / S.shots directly.)
  if (!S.allShotsLoaded) {
    window.onAllShotMetaLoaded = () => { window.onAllShotMetaLoaded = null; initAnalytics(); };
  }
  buildSummaryKpis();
  buildTrendChart();
  buildCalendar();
  buildPersonalBests();
  buildBeanStats();
  void buildWorldMap();
  buildProfileChart();
  buildGrinderStats();
  buildBasketStats();
  buildPuckScreenStats();
  buildDistribution();
  buildTimeOfDay();
  buildWeekdayHourHeatmap();
  buildBeanRanking();
  buildMachineComparison();
  buildDialinProgression();
}

// ── Helpers ───────────────────────────────────────────────────────────────
function calcLongestStreak(shots: ShotRow[]): number {
  if (!shots.length) return 0;
  const days = [...new Set(shots.map(s => {
    const d = new Date(s.timestamp * 1000);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }))].sort();
  let max = 1, cur = 1;
  for (let i = 1; i < days.length; i++) {
    const diff = (new Date(days[i]).getTime() - new Date(days[i-1]).getTime()) / 86400000;
    if (diff === 1) { max = Math.max(max, ++cur); } else cur = 1;
  }
  return max;
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

// ── Summary KPIs ──────────────────────────────────────────────────────────
export function buildSummaryKpis() {
  const el = document.getElementById('summaryKpis');
  if (!el) return;

  const total   = _shots().length;
  const scored  = _shots().filter(s => window.calcShotScore && window.calcShotScore(s) != null);
  const avgScore = scored.length
    ? Math.round(scored.reduce((a, s) => a + (window.calcShotScore!(s) ?? 0), 0) / scored.length)
    : null;

  const totalG = _shots().reduce((sum, s) => sum + (s.annotation?.dose || 0), 0);
  const totalCoffee = totalG >= 1000 ? (totalG / 1000).toFixed(1) + ' kg' : Math.round(totalG) + ' g';

  const _now = new Date();
  const weekStartMs = new Date(_now.getFullYear(), _now.getMonth(), _now.getDate() - (_now.getDay() + 6) % 7).getTime();
  const thisWeek = _shots().filter(s => s.timestamp * 1000 >= weekStartMs).length;
  const streak   = calcLongestStreak(_shots());

  const kpis = [
    { val: total,  lbl: t('analytics_total_shots') },
    { val: avgScore !== null ? avgScore : '—', lbl: t('analytics_avg_score'), cls: avgScore !== null ? scoreClass(avgScore) : '' },
    { val: total > 0 ? totalCoffee : '—', lbl: t('analytics_total_coffee') },
    { val: thisWeek, lbl: t('analytics_this_week') },
    { val: streak > 0 ? t('analytics_days', streak) : '—', lbl: t('analytics_streak') },
  ];
  el.innerHTML = kpis.map(k =>
    `<div class="kpi-tile"><div class="kpi-val ${k.cls||''}">${k.val}</div><div class="kpi-lbl">${k.lbl}</div></div>`
  ).join('');

  // Trend warning: check last 5 scored shots for declining trend
  const warnEl = document.getElementById('trendWarning');
  if (warnEl) {
    const recent = scored.slice(-5);
    if (recent.length >= 3 && window.calcShotScore) {
      const recentScores = recent.map(s => window.calcShotScore!(s) ?? 0);
      const n = recentScores.length;
      const xs = recentScores.map((_, i) => i);
      const xm = (n - 1) / 2;
      const ym = recentScores.reduce((a, b) => a + b, 0) / n;
      const slope = xs.reduce((s, x, i) => s + (x - xm) * (recentScores[i] - ym), 0) /
                    xs.reduce((s, x) => s + (x - xm) ** 2, 0);
      if (slope < -1.5) {
        const drop = Math.abs(slope).toFixed(1);
        warnEl.className = 'trend-warning';
        // #811: the ⚠ glyph came out of the translated string; the icon is
        // rendered here instead so translators never carry markup. `n`/`drop`
        // are numbers computed above, so there is no untrusted input here.
        warnEl.innerHTML = `${WARNING_ICON_SVG} ${esc(t('analytics_trend_warning', n, drop))}`;
        warnEl.style.display = '';
      } else {
        warnEl.style.display = 'none';
      }
    } else {
      warnEl.style.display = 'none';
    }
  }
}

// ── Personal Bests ────────────────────────────────────────────────────────
export function buildPersonalBests() {
  const el = document.getElementById('personalBests');
  if (!el) return;
  if (_shots().length < 3) {
    el.innerHTML = `<p class="empty-note">${t('analytics_no_bests')}</p>`;
    return;
  }

  let bestShot: ShotRow | null = null, bestScore = -1;
  for (const s of _shots()) {
    if (!window.calcShotScore) continue;
    const sc = window.calcShotScore(s);
    if (sc !== null && sc > bestScore) { bestScore = sc; bestShot = s; }
  }

  const byBean: Record<string, number> = {}, byProfile: Record<string, number> = {}, byDay: Record<string, number> = {};
  for (const s of _shots()) {
    const bean = s.annotation?.coffee;
    if (bean) byBean[bean] = (byBean[bean] || 0) + 1;
    const prof = s.profile?.name || s.profileName;
    if (prof) byProfile[prof] = (byProfile[prof] || 0) + 1;
    const key = new Date(s.timestamp * 1000).toISOString().slice(0, 10);
    byDay[key] = (byDay[key] || 0) + 1;
  }
  const favBean    = Object.entries(byBean).sort((a, b) => b[1] - a[1])[0];
  const favProfile = Object.entries(byProfile).sort((a, b) => b[1] - a[1])[0];
  const busiestDay = Object.entries(byDay).sort((a, b) => b[1] - a[1])[0];
  const streak     = calcLongestStreak(_shots());
  const locale     = localeFor(S.currentLang);

  const rows: { lbl: string; val: string; link?: number }[] = [];
  if (bestShot) {
    const d  = new Date(bestShot.timestamp * 1000).toLocaleDateString(locale, { day: '2-digit', month: '2-digit', year: 'numeric' });
    rows.push({ lbl: t('analytics_best_shot'),
      val: `<span class="${scoreClass(bestScore)}">${bestScore}</span> · ${d}`,
      link: bestShot.id });
  }
  if (streak > 0) rows.push({ lbl: t('analytics_longest_streak'), val: t('analytics_days', streak) });
  if (favBean)    rows.push({ lbl: t('analytics_fav_bean'),    val: `${esc(favBean[0])} <span class="bests-count">${favBean[1]} ${t('bean_stat_shots')}</span>` });
  if (favProfile) rows.push({ lbl: t('analytics_fav_profile'), val: `${esc(favProfile[0])} <span class="bests-count">${favProfile[1]} ${t('bean_stat_shots')}</span>` });
  if (busiestDay) {
    const d = new Date(busiestDay[0]).toLocaleDateString(locale, { day: '2-digit', month: '2-digit', year: 'numeric' });
    rows.push({ lbl: t('analytics_busiest_day'), val: `${d} <span class="bests-count">${busiestDay[1]} ${t('bean_stat_shots')}</span>` });
  }

  el.innerHTML = `<div class="bests-list">${rows.map(r =>
    `<div class="bests-row"><span class="bests-lbl">${r.lbl}</span><span class="bests-val">${r.val}${
      r.link ? ` <button class="bests-link" data-action="goto-shot" data-id="${r.link}">→</button>` : ''}</span></div>`
  ).join('')}</div>`;
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
    if (!byEquip[key]) byEquip[key] = { count: 0, scores: [], durations: [] };
    byEquip[key].count++;
    const sc = window.calcShotScore ? window.calcShotScore(s) : null;
    if (sc !== null) byEquip[key].scores.push(sc);
    const dur = (s.duration || 0) / 10;
    if (dur > 5) byEquip[key].durations.push(dur);
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
    el.innerHTML = `<p class="empty-note">${t(emptyKey)}</p>`;
    return;
  }
  let html = '<div class="bean-cards">';
  for (const d of entries) {
    html += `<div class="bean-card">
      <div class="bean-card-name" title="${esc(d.name)}">${esc(d.name)}</div>
      <div class="bean-card-stats">
        <div class="bean-stat"><span class="bean-stat-val">${d.count}</span><span class="bean-stat-lbl">${t('bean_stat_shots')}</span></div>
        ${d.avgScore    !== null ? `<div class="bean-stat"><span class="bean-stat-val ${scoreClass(d.avgScore)}">${d.avgScore}</span><span class="bean-stat-lbl">${t('bean_stat_avg')}</span></div>` : ''}
        ${d.bestScore   !== null ? `<div class="bean-stat"><span class="bean-stat-val">${d.bestScore}</span><span class="bean-stat-lbl">${t('bean_stat_best')}</span></div>` : ''}
        ${d.avgDuration !== null ? `<div class="bean-stat"><span class="bean-stat-val">${d.avgDuration}s</span><span class="bean-stat-lbl">${t('bean_stat_duration')}</span></div>` : ''}
      </div>
    </div>`;
  }
  el.innerHTML = html + '</div>';
}

export function buildGrinderStats() {
  const entries = _computeEquipmentStats(
    _shots(),
    s => s.annotation?.grinder || null,
    key => key,
  );
  _renderEquipmentStats('grinderStats', entries, 'analytics_no_grinders');
}

export function buildBasketStats() {
  const entries = _computeEquipmentStats(
    _shots(),
    s => s.annotation?.basketId,
    id => _equipmentName(_libCollection('baskets'), Number(id)),
  );
  _renderEquipmentStats('basketStats', entries, 'analytics_no_baskets');
}

export function buildPuckScreenStats() {
  const entries = _computeEquipmentStats(
    _shots(),
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
  const ctx = document.getElementById('doseDistChart') as HTMLCanvasElement | null;
  if (!ctx) return;
  chartRegistry.dispose('doseDistChart');
  const doses = _shots().map(s => s.annotation?.dose).filter((d): d is number => d != null && d > 5 && d < 50);
  if (doses.length < 5) {
    ctx.parentElement!.innerHTML = `<p class="empty-note pad-top">${t('analytics_no_distribution')}</p>`;
    return;
  }
  const lo = Math.floor(Math.min(...doses) * 2) / 2;
  const hi = Math.ceil(Math.max(...doses) * 2) / 2;
  const buckets: Record<string, number> = {};
  for (let b = lo; b <= hi + 0.001; b += 0.5) buckets[b.toFixed(1)] = 0;
  for (const d of doses) { const k = (Math.floor(d * 2) / 2).toFixed(1); if (k in buckets) buckets[k]++; }
  chartRegistry.set('doseDistChart', new Chart(ctx, {
    type: 'bar',
    data: { labels: Object.keys(buckets).map(k => k + 'g'),
            datasets: [{ data: Object.values(buckets), backgroundColor: 'rgba(239,68,68,.6)', borderRadius: 3, borderSkipped: false }] },
    options: { responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: _mutedTickColor(), font: { size: 10 } }, grid: { display: false } },
        y: { ticks: { color: _mutedTickColor(), font: { size: 10 }, precision: 0 }, grid: { color: 'rgba(63,63,70,.3)' } }
      }
    }
  } as unknown as ChartConfiguration<'bar'>));
}

function _buildRatioDist() {
  const ctx = document.getElementById('ratioDistChart') as HTMLCanvasElement | null;
  if (!ctx) return;
  chartRegistry.dispose('ratioDistChart');
  const ratios = _shots()
    .map(s => s.annotation?.dose && s.weight ? (s.weight / 10) / s.annotation.dose : null)
    .filter((r): r is number => r != null && r > 1 && r < 4);
  if (ratios.length < 5) {
    ctx.parentElement!.innerHTML = `<p class="empty-note pad-top">${t('analytics_no_distribution')}</p>`;
    return;
  }
  const lo = Math.floor(Math.min(...ratios) * 10) / 10;
  const hi = Math.ceil(Math.max(...ratios) * 10) / 10;
  const buckets: Record<string, number> = {};
  for (let b = lo; b <= hi + 0.001; b += 0.1) buckets[b.toFixed(1)] = 0;
  for (const r of ratios) { const k = (Math.floor(r * 10) / 10).toFixed(1); if (k in buckets) buckets[k]++; }
  chartRegistry.set('ratioDistChart', new Chart(ctx, {
    type: 'bar',
    data: { labels: Object.keys(buckets).map(k => '1:' + k),
            datasets: [{ data: Object.values(buckets), backgroundColor: 'rgba(132,204,22,.6)', borderRadius: 3, borderSkipped: false }] },
    options: { responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: _mutedTickColor(), font: { size: 10 } }, grid: { display: false } },
        y: { ticks: { color: _mutedTickColor(), font: { size: 10 }, precision: 0 }, grid: { color: 'rgba(63,63,70,.3)' } }
      }
    }
  } as unknown as ChartConfiguration<'bar'>));
}

// ── Time of Day ───────────────────────────────────────────────────────────
export function buildTimeOfDay() {
  const ctx = document.getElementById('timeOfDayChart') as HTMLCanvasElement | null;
  if (!ctx) return;
  chartRegistry.dispose('timeOfDayChart');
  const hours: { count: number; scores: number[] }[] = Array.from({ length: 24 }, () => ({ count: 0, scores: [] }));
  for (const s of _shots()) {
    const h = new Date(s.timestamp * 1000).getHours();
    hours[h].count++;
    if (window.calcShotScore) {
      const sc = window.calcShotScore(s);
      if (sc !== null) hours[h].scores.push(sc);
    }
  }
  if (!hours.some(h => h.count > 0)) {
    ctx.parentElement!.innerHTML = `<p class="empty-note pad-top">${t('analytics_no_time')}</p>`;
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
        tooltip: { callbacks: { label: (c: { dataIndex: number; parsed: { y: number } }) => {
          const h = hours[c.dataIndex], sc = avgSc(h);
          return `${c.parsed.y} Shot${c.parsed.y !== 1 ? 's' : ''}${sc !== null ? ' · Ø ' + sc : ''}`;
        }}}
      },
      scales: {
        x: { ticks: { color: _mutedTickColor(), font: { size: 9 }, maxRotation: 0 }, grid: { display: false } },
        y: { ticks: { color: _mutedTickColor(), font: { size: 10 }, precision: 0 }, grid: { color: 'rgba(63,63,70,.3)' } }
      }
    }
  } as unknown as ChartConfiguration<'bar'>));
}

export function setTrendWindow(n: number): void {
  S.trendWindow = n;
  document.getElementById('trendBtn30')!.classList.toggle('active', n === 30);
  document.getElementById('trendBtn90')!.classList.toggle('active', n === 90);
  document.getElementById('trendBtnAll')!.classList.toggle('active', n === 0);
  buildTrendChart();
}

export function buildTrendChart() {
  // #814: resolved per render, never at module load — the value has to be
  // whatever the ACTIVE theme resolves to right now.
  const C = chartColors();
  const all = _shots().filter(s => {
    if (!window.calcShotScore) return false;
    return window.calcShotScore(s) !== null;
  });
  const src = S.trendWindow > 0 ? all.slice(-S.trendWindow) : all;

  const ctx = document.getElementById('trendChart') as HTMLCanvasElement | null;
  if (!ctx) return;
  chartRegistry.dispose('trendChart');

  if (src.length < 2) {
    ctx.parentElement!.innerHTML = `<p class="empty-note pad-top">${t('analytics_no_trend')}</p>`;
    return;
  }

  const locale   = localeFor(S.currentLang);
  const labels   = src.map(s => new Date(s.timestamp * 1000).toLocaleDateString(locale, { day: '2-digit', month: '2-digit' }));
  const scoreData = src.map(s => window.calcShotScore!(s) ?? 0);
  const maData    = scoreData.map((_, i) => {
    const sl = scoreData.slice(Math.max(0, i - 4), i + 1);
    return Math.round(sl.reduce((a, b) => a + b, 0) / sl.length);
  });

  chartRegistry.set('trendChart', new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Score', data: scoreData, borderColor: '#ef4444', backgroundColor: 'rgba(239,68,68,.12)',
          pointRadius: 4, pointHoverRadius: 6, fill: true, tension: 0.3, order: 2 },
        { label: 'Ø 5-Shot', data: maData, borderColor: 'rgba(255,255,255,.35)',
          pointRadius: 0, fill: false, tension: 0.5, borderWidth: 2, order: 1 }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      onClick: (_: unknown, elements: { index: number }[]) => {
        if (elements.length > 0 && window.goToShot) window.goToShot(src[elements[0].index].id);
      },
      plugins: {
        legend: { labels: { color: C.tick, font: { size: 11 } } },
        tooltip: { callbacks: { footer: () => '↗ Shot anzeigen' } },
      },
      scales: {
        x: { ticks: { color: _mutedTickColor(), font: { size: 10 }, maxRotation: 45 }, grid: { color: 'rgba(63,63,70,.3)' } },
        y: { min: 0, max: 100, ticks: { color: _mutedTickColor(), font: { size: 10 }, stepSize: 20 }, grid: { color: 'rgba(63,63,70,.3)' } }
      }
    }
  } as unknown as ChartConfiguration<'line'>));
}

export function buildCalendar() {
  const el = document.getElementById('shotCalendar');
  if (!el) return;

  if (!timerRegistry.get('_calendarResizeObserver')) {
    const observer = new ResizeObserver(() => _renderCalendar());
    timerRegistry.set('_calendarResizeObserver', observer);
    observer.observe(el);
  }
  _renderCalendar();
}

export function _renderCalendar() {
  const el = document.getElementById('shotCalendar');
  if (!el) return;

  const dayMap: Record<string, { count: number; scores: number[]; lastId: number | null }> = {};
  for (const s of _shots()) {
    const key = new Date(s.timestamp * 1000).toISOString().slice(0, 10);
    if (!dayMap[key]) dayMap[key] = { count: 0, scores: [], lastId: null };
    dayMap[key].count++;
    dayMap[key].lastId = s.id;
    if (window.calcShotScore) {
      const sc = window.calcShotScore(s);
      if (sc !== null) dayMap[key].scores.push(sc);
    }
  }

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const startDate = new Date(today);
  startDate.setDate(startDate.getDate() - 364);
  const dow = (startDate.getDay() + 6) % 7;
  startDate.setDate(startDate.getDate() - dow);

  const locale = localeFor(S.currentLang);
  const months: { weekIdx: number; label: string }[] = [];
  let lastMonth = -1;
  const weeks: { date: Date; key: string; count: number; avgSc: number | null; lastId: number | null }[][] = [];
  const cur = new Date(startDate);

  while (cur <= today) {
    const week: { date: Date; key: string; count: number; avgSc: number | null; lastId: number | null }[] = [];
    for (let d = 0; d < 7; d++) {
      const key  = cur.toISOString().slice(0, 10);
      const data = dayMap[key] || { count: 0, scores: [], lastId: null };
      const avgSc = data.scores.length ? Math.round(data.scores.reduce((a, b) => a + b, 0) / data.scores.length) : null;
      if (d === 0 && cur.getMonth() !== lastMonth) {
        months.push({ weekIdx: weeks.length, label: cur.toLocaleDateString(locale, { month: 'short' }) });
        lastMonth = cur.getMonth();
      }
      week.push({ date: new Date(cur), key, count: data.count, avgSc, lastId: data.lastId || null });
      cur.setDate(cur.getDate() + 1);
    }
    weeks.push(week);
  }

  const GAP      = 2;
  const W        = Math.floor(el.getBoundingClientRect().width) || 600;
  const cellSize = Math.max(4, Math.floor((W - (weeks.length - 1) * GAP) / weeks.length));
  const CELL     = cellSize + GAP;
  const cellSz   = `width:${cellSize}px;height:${cellSize}px`;

  const cls = (c: number): string => c === 0 ? 'cal-0' : c === 1 ? 'cal-1' : c === 2 ? 'cal-2' : 'cal-3';

  let html = `<div style="position:relative;height:${cellSize + 3}px;margin-bottom:4px">`;
  for (const m of months) html += `<span style="position:absolute;left:${m.weekIdx * CELL}px;font-size:.65rem;color:var(--gray-600)">${m.label}</span>`;
  html += `</div><div class="cal-grid" style="gap:${GAP}px">`;

  for (const week of weeks) {
    html += `<div class="cal-week" style="gap:${GAP}px">`;
    for (const day of week) {
      const isFuture = day.date > today;
      const dateStr  = day.date.toLocaleDateString(locale, { day: '2-digit', month: '2-digit', year: 'numeric' });
      const title    = day.count === 0 ? dateStr
                     : `${dateStr}: ${day.count} Shot${day.count > 1 ? 's' : ''}${day.avgSc !== null ? ` · Ø ${day.avgSc}` : ''}`;
      const clickable = !isFuture && day.count > 0 && day.lastId !== null;
      html += `<div class="${isFuture ? 'cal-future' : cls(day.count)} cal-day${clickable ? ' cal-day-link' : ''}" style="${cellSz}" title="${title}"${clickable ? ` data-action="goto-shot" data-id="${day.lastId}"` : ''}></div>`;
    }
    html += `</div>`;
  }
  html += `</div>`;
  el.innerHTML = html;
}

export function buildBeanStats() {
  const el = document.getElementById('beanStats');
  if (!el) return;

  const byBean: Record<string, { count: number; scores: number[]; durations: number[]; dialinShot: number | null }> = {};
  for (const s of _shots()) {
    const name = s.annotation?.coffee;
    if (!name) continue;
    if (!byBean[name]) byBean[name] = { count: 0, scores: [], durations: [], dialinShot: null };
    byBean[name].count++;
    if (window.calcShotScore) {
      const sc = window.calcShotScore(s);
      if (sc !== null) {
        byBean[name].scores.push(sc);
        if (byBean[name].dialinShot === null && sc >= 80)
          byBean[name].dialinShot = byBean[name].count;
      }
    }
    const dur = (s.duration || 0) / 10;
    if (dur > 5) byBean[name].durations.push(dur);
  }

  const beans = Object.entries(byBean).sort((a, b) => b[1].count - a[1].count);

  if (beans.length === 0) {
    el.innerHTML = `<p class="empty-note">${t('analytics_no_beans')}</p>`;
    return;
  }

  let html = '<div class="bean-cards">';
  for (const [name, d] of beans) {
    const avgSc  = d.scores.length    ? Math.round(d.scores.reduce((a, b) => a + b, 0) / d.scores.length) : null;
    const bestSc = d.scores.length    ? Math.max(...d.scores) : null;
    const avgDur = d.durations.length ? (d.durations.reduce((a, b) => a + b, 0) / d.durations.length).toFixed(1) : null;
    const scCls  = avgSc !== null ? scoreClass(avgSc) : '';
    html += `<div class="bean-card">
      <div class="bean-card-name" title="${esc(name)}">${esc(name)}</div>
      <div class="bean-card-stats">
        <div class="bean-stat"><span class="bean-stat-val">${d.count}</span><span class="bean-stat-lbl">${t('bean_stat_shots')}</span></div>
        ${avgSc  !== null ? `<div class="bean-stat"><span class="bean-stat-val ${scCls}">${avgSc}</span><span class="bean-stat-lbl">${t('bean_stat_avg')}</span></div>` : ''}
        ${bestSc !== null ? `<div class="bean-stat"><span class="bean-stat-val">${bestSc}</span><span class="bean-stat-lbl">${t('bean_stat_best')}</span></div>` : ''}
        ${avgDur !== null ? `<div class="bean-stat"><span class="bean-stat-val">${avgDur}s</span><span class="bean-stat-lbl">${t('bean_stat_duration')}</span></div>` : ''}
      </div>
      ${d.dialinShot !== null ? `<div class="bean-stat-dialin">${TARGET_ICON_SVG} ${t('analytics_dialin', d.dialinShot)}</div>` : (d.scores.length >= 3 ? `<div class="bean-stat-dialin" style="color:var(--gray-600)">${t('analytics_dialin_none')}</div>` : '')}
    </div>`;
  }
  html += '</div>';
  el.innerHTML = html;
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

// Converts a #rrggbb (or #rgb) hex color to an rgba() string at the given
// alpha; falls back to the raw input unchanged if it isn't hex (e.g. an
// already-rgba CSS custom property value).
function _hexToRgba(hex: string, alpha: number): string {
  const m = /^#?([a-f\d]{3}|[a-f\d]{6})$/i.exec(String(hex || '').trim());
  if (!m) return hex;
  let h = m[1];
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
    ],
  });
}

// Pure helper (unit-testable): given a list of [lon, lat] coordinates with
// data on the map, returns a { center, zoom } that frames them instead of
// defaulting to the whole globe. `zoom` is clamped to a sane range so a
// single country (or a single point) doesn't zoom in absurdly far, and
// stays within the geo.scaleLimit used by buildWorldMap (max 12).
export function computeMapBoundingView(coords: (number[] | null | undefined)[] | null): { center: number[] | undefined; zoom: number } {
  const valid = (coords || []).filter((c): c is number[] => Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1]));
  if (!valid.length) return { center: undefined, zoom: 1 };
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const [lon, lat] of valid) {
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  const center = [(minLon + maxLon) / 2, (minLat + maxLat) / 2];
  const lonSpan = maxLon - minLon;
  const latSpan = maxLat - minLat;
  // Latitude degrees read visually "taller" than longitude degrees on an
  // equirectangular-ish projection, so weight them more when picking the
  // limiting axis; floor the span so a single point still gets some padding.
  const span = Math.max(lonSpan, latSpan * 1.8, 8);
  const padded = span * 1.6;
  const zoom = Math.min(6, Math.max(1, 360 / padded));
  return { center, zoom };
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
  if (first[0] === lastPt[0] && first[1] === lastPt[1]) return seg;
  if (Math.abs(first[0] - lastPt[0]) > 180) {
    const pole = lastPt[1] < 0 ? -90 : 90;
    const sideOut = lastPt[0] > 0 ? 180 : -180;
    const sideIn  = first[0] > 0 ? 180 : -180;
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
  const last = ring[ring.length - 1];
  const closesAtStart = last[0] === ring[0][0] && last[1] === ring[0][1];
  const scanEnd = closesAtStart ? ring.length - 1 : ring.length;
  const segments = [[ring[0]]];
  for (let i = 1; i < scanEnd; i++) {
    const [lon1] = ring[i - 1];
    const [lon2, lat2] = ring[i];
    const dLon = lon2 - lon1;
    if (Math.abs(dLon) > 180) {
      // Crossing the seam: close the current segment on this side, start a
      // new one on the other side, both anchored at the same interpolated
      // latitude on their respective edge (+180 or -180).
      const side1 = lon1 > 0 ? 180 : -180;
      const side2 = lon2 > 0 ? 180 : -180;
      segments[segments.length - 1].push([side1, lat2]);
      segments.push([[side2, lat2]]);
    } else {
      segments[segments.length - 1].push([lon2, lat2]);
    }
  }
  if (segments.length === 1) {
    return [closesAtStart ? _closeRingPiece(segments[0]) : segments[0]];
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
// computeMapBoundingView/splitAntimeridianRing above). Bean names and regions
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
      return Number.isInteger(share) ? esc(beanName) : `${esc(beanName)} (${share})`;
    }).join(', ');
    return `${name}: ${stats.shots} ${t('analytics_map_shots')} (${beanList})`;
  }
  const region = params.data?._region;
  return `${esc(params.name)}${region ? ' · ' + esc(region) : ''}`;
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
      if (!byCode[o.code]) byCode[o.code] = { shots: 0, beans: new Set(), beanShots: new Map() };
      byCode[o.code].beans.add(bean.name);
      if (!byCode[o.code].beanShots.has(bean.name)) byCode[o.code].beanShots.set(bean.name, 0);
    }
  }
  for (const s of _shots()) {
    const entry = resolveMapEntry(s.annotation);
    if (!entry) continue;
    for (const o of entry.origins) {
      const stats = byCode[o.code];
      stats.shots += o.weight;
      stats.beanShots.set(entry.bean.name, (stats.beanShots.get(entry.bean.name) ?? 0) + o.weight);
    }
  }
  for (const stats of Object.values(byCode)) {
    stats.shots = Math.round(stats.shots * 10) / 10;
    for (const [name, val] of stats.beanShots) stats.beanShots.set(name, Math.round(val * 10) / 10);
  }

  if (Object.keys(byCode).length === 0) {
    if (_echartsInstance) { _echartsInstance.dispose(); _echartsInstance = null; }
    wrap.innerHTML = `<p class="empty-note">${t('analytics_map_empty')}</p>`;
    return;
  }
  if (!wrap.querySelector('.world-map-canvas')) {
    wrap.innerHTML = `<div class="world-map-canvas" style="width:100%;height:100%"></div>
      <div class="world-map-hint">${t('analytics_map_zoom_hint')}</div>`;
  }
  const container = wrap.querySelector<HTMLElement>('.world-map-canvas')!;

  if (!_worldTopo) {
    let topo: WorldTopo;
    try { topo = await (await fetch('countries-110m.json')).json() as WorldTopo; }
    catch {
      if (token !== _worldMapReqToken) return; // a newer call has since taken over
      wrap.innerHTML = `<p class="empty-note">${t('analytics_map_empty')}</p>`;
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
      container.innerHTML = `<p class="empty-note">${t('analytics_map_loading')}</p>`;
    }
    [echarts, topojson] = await _mapLibsPromise;
  } catch {
    // A concurrent call resetting the same promise to null is idempotent, not a real race.
    _mapLibsPromise = null; // don't cache a rejected promise — allow a retry on the next navigation
    if (token !== _worldMapReqToken) return; // a newer call has since taken over
    wrap.innerHTML = `<p class="empty-note">${t('analytics_map_unavailable')}</p>`;
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
  const points: { name: string; value: number[]; _region: string | null; label?: unknown }[] = [];
  for (const { bean, origins } of nameToBean.values()) {
    // Even a blend gets exactly one map point — from its geocoded growing
    // region if resolved, else a centroid fallback keyed on its primary
    // (first-listed) origin country.
    const primaryCode = origins[0].code;
    let coord: number[] | null = bean.location ? [bean.location.lon, bean.location.lat] : null;
    if (!coord) {
      const centroid = COUNTRY_CENTROIDS[primaryCode];
      if (!centroid) continue;
      const n = (seenAtCentroid[primaryCode] = (seenAtCentroid[primaryCode] || 0) + 1) - 1;
      const jitter = n * 0.35;
      coord = [centroid[0] + (n % 2 === 0 ? jitter : -jitter), centroid[1] + (n % 3) * 0.2];
    }
    const shots = byCode[primaryCode]?.beans.has(bean.name)
      ? _shots().filter(s => resolveMapEntry(s.annotation)?.bean === bean).length
      : 0;
    // Always-visible label for beans that actually have shots logged (kept
    // off for zero-shot points so the map doesn't get cluttered with beans
    // that are only sitting in the Library with an origin set).
    const label = shots > 0
      ? { show: true, formatter: '{b}', position: 'right', distance: 5, fontSize: 9, fontWeight: 500 }
      : undefined;
    points.push({ name: bean.name, value: [...coord, shots], _region: bean.region || null, label });
  }

  // Brand + chrome colors, read live from the CSS custom properties so the
  // map follows whichever accent/theme the user has picked (#1024: this used
  // to be true only for accentTo/mutedText, with the rest hardcoded dark).
  const c = resolveWorldMapColors();

  if (!_echartsInstance) {
    container.innerHTML = ''; // clear the loading message before echarts takes over this node
    _echartsInstance = echarts.init(container);
  }

  const boundingCoords = [
    ...Object.keys(byCode).map(code => COUNTRY_CENTROIDS[code]).filter(Boolean),
    ...points.map(p => [p.value[0], p.value[1]]),
  ];
  const { center, zoom } = computeMapBoundingView(boundingCoords);

  _echartsInstance.setOption({
    backgroundColor: c.backgroundColor,
    tooltip: {
      formatter: worldMapTooltipFormatter,
    },
    geo: {
      map: 'world', roam: true, scaleLimit: { min: 1, max: 12 }, center, zoom,
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
    ],
  }, true);

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
  for (const s of _shots()) {
    const p = s.profile?.name || s.profileName || 'Unbekannt';
    if (!byProfile[p]) byProfile[p] = { scores: [], count: 0 };
    byProfile[p].count++;
    if (window.calcShotScore) {
      const sc = window.calcShotScore(s);
      if (sc !== null) byProfile[p].scores.push(sc);
    }
  }

  const entries = Object.entries(byProfile)
    .filter(([, v]) => v.scores.length > 0)
    .map(([name, v]) => ({ name, count: v.count, avgScore: Math.round(v.scores.reduce((a, b) => a + b, 0) / v.scores.length) }))
    .sort((a, b) => b.avgScore - a.avgScore);

  const wrap = document.getElementById('profileChartWrap')!;
  const ctx  = document.getElementById('profileChart') as HTMLCanvasElement | null;
  if (!ctx) return;
  chartRegistry.dispose('profileBarChart');

  if (entries.length === 0) {
    wrap.innerHTML = `<p class="empty-note">${t('analytics_no_profiles')}</p>`;
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
        tooltip: { callbacks: { afterLabel: (c: { dataIndex: number }) => `${entries[c.dataIndex].count} Shots` } }
      },
      scales: {
        x: { min: 0, max: 100, ticks: { color: _mutedTickColor(), font: { size: 10 } }, grid: { color: 'rgba(63,63,70,.3)' } },
        y: { ticks: { color: C.tick, font: { size: 11 } }, grid: { display: false } }
      }
    }
  } as unknown as ChartConfiguration<'bar'>));
}

// ── Weekday x Hour heatmap ─────────────────────────────────────────────────
// True 7x24 matrix of shot counts, in the same visual language as the
// calendar heatmap above (intensity buckets of the same red). Respects
// S.activeMachineId scoping implicitly — S.shots is already the
// machine-filtered projection every other builder here reads.
export function buildWeekdayHourHeatmap() {
  const el = document.getElementById('weekdayHourHeatmap');
  if (!el) return;

  if (!_shots().length) {
    el.innerHTML = `<p class="empty-note">${t('analytics_no_time')}</p>`;
    return;
  }

  const matrix: number[][] = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
  for (const s of _shots()) {
    const d  = new Date(s.timestamp * 1000);
    const wd = (d.getDay() + 6) % 7; // 0=Mon..6=Sun, same convention as the calendar above
    matrix[wd][d.getHours()]++;
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

  let html = '<div class="wh-heatmap"><div class="wh-row wh-header"><div class="wh-label"></div>';
  for (let h = 0; h < 24; h++) html += `<div class="wh-hourlabel">${h % 3 === 0 ? h : ''}</div>`;
  html += '</div>';
  for (let wd = 0; wd < 7; wd++) {
    html += `<div class="wh-row"><div class="wh-label">${esc(weekdayLabels[wd])}</div>`;
    for (let h = 0; h < 24; h++) {
      const c = matrix[wd][h];
      const title = `${weekdayLabels[wd]} ${String(h).padStart(2, '0')}:00 — ${c} Shot${c === 1 ? '' : 's'}`;
      html += `<div class="wh-cell wh-l${level(c)}" title="${esc(title)}"></div>`;
    }
    html += '</div>';
  }
  html += '</div>';
  el.innerHTML = html;
}

// ── Bean ranking ────────────────────────────────────────────────────────────
// Sortable table: bean, shots, avg score, last grind setting used, and a
// last-5-vs-previous-5 scored trend. Pure aggregation kept separate from
// rendering so it's unit-testable without a DOM.
export function _computeBeanRanking(shots: ShotRow[]): BeanRankRow[] {
  const byBean: Record<string, ShotRow[]> = {};
  for (const s of shots) {
    const name = s.annotation?.coffee;
    if (!name) continue;
    if (!byBean[name]) byBean[name] = [];
    byBean[name].push(s);
  }

  const rows: BeanRankRow[] = [];
  for (const [name, beanShots] of Object.entries(byBean)) {
    const sorted = [...beanShots].sort((a, b) => a.timestamp - b.timestamp);
    const scored = sorted
      .map(s => ({ s, sc: window.calcShotScore ? window.calcShotScore(s) : null }))
      .filter((x): x is { s: ShotRow; sc: number } => x.sc !== null);
    const avgScore = scored.length ? Math.round(scored.reduce((a, x) => a + x.sc, 0) / scored.length) : null;

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

    rows.push({ name, shots: sorted.length, avgScore, lastGrind, trend });
  }
  return rows;
}

function _cmpNullsLast(a: string | number | null | undefined, b: string | number | null | undefined, dir: 'asc' | 'desc'): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return dir === 'asc' ? (a > b ? 1 : a < b ? -1 : 0) : (a < b ? 1 : a > b ? -1 : 0);
}

let _beanRankSort: { key: BeanRankKey; dir: 'asc' | 'desc' } = { key: 'shots', dir: 'desc' };

export function setBeanRankSort(key: BeanRankKey): void {
  if (_beanRankSort.key === key) _beanRankSort.dir = _beanRankSort.dir === 'desc' ? 'asc' : 'desc';
  else _beanRankSort = { key, dir: key === 'name' ? 'asc' : 'desc' };
  buildBeanRanking();
}

export function buildBeanRanking() {
  const el = document.getElementById('beanRanking');
  if (!el) return;

  const rows = _computeBeanRanking(_shots());
  if (!rows.length) {
    el.innerHTML = `<p class="empty-note">${t('analytics_no_beans')}</p>`;
    return;
  }

  const { key, dir } = _beanRankSort;
  rows.sort((a, b) => key === 'name' ? _cmpNullsLast(a.name.toLowerCase(), b.name.toLowerCase(), dir) : _cmpNullsLast(a[key], b[key], dir));

  const arrow = (k: string): string => k === key ? `<span class="sort-arrow">${dir === 'asc' ? '▲' : '▼'}</span>` : '';
  const cols = [
    ['name', t('lib_recipe_bean')], ['shots', t('bean_stat_shots')], ['avgScore', t('bean_stat_avg')],
    ['lastGrind', t('ann_grind_setting')], ['trend', t('analytics_bean_rank_trend')],
  ];

  const headerHtml = cols.map(([k, lbl]) =>
    `<th data-action="set-bean-rank-sort" data-key="${k}">${esc(lbl)}${arrow(k)}</th>`).join('');

  const rowsHtml = rows.map(r => {
    const scoreCell = r.avgScore !== null ? `<span class="${scoreClass(r.avgScore)}">${r.avgScore}</span>` : '–';
    const trendCell = r.trend === null ? '<span class="trend-flat">–</span>'
      : r.trend > 0.5  ? `<span class="trend-up">▲ ${r.trend > 0 ? '+' : ''}${r.trend}</span>`
      : r.trend < -0.5 ? `<span class="trend-down">▼ ${r.trend}</span>`
      : `<span class="trend-flat">▬ ${r.trend}</span>`;
    return `<tr>
      <td>${esc(r.name)}</td>
      <td class="num">${r.shots}</td>
      <td class="num">${scoreCell}</td>
      <td>${r.lastGrind ? esc(r.lastGrind) : '–'}</td>
      <td>${trendCell}</td>
    </tr>`;
  }).join('');

  el.innerHTML = `<div class="analytics-table-wrap"><table class="analytics-table">
    <thead><tr>${headerHtml}</tr></thead>
    <tbody>${rowsHtml}</tbody>
  </table></div>`;
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
    if (byMachine[mid]) byMachine[mid].shots.push(s);
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
    el.innerHTML = `<p class="empty-note">${t('analytics_no_machine_data')}</p>`;
    return;
  }

  const rowsHtml = rows.map(r => `<tr>
    <td>${esc(r.name)}</td>
    <td class="num">${r.count}</td>
    <td class="num">${r.avgScore !== null ? `<span class="${scoreClass(r.avgScore)}">${r.avgScore}</span>` : '–'}</td>
    <td class="num">${r.avgDuration !== null ? r.avgDuration + 's' : '–'}</td>
    <td class="num">${r.avgStability !== null ? '±' + r.avgStability + '°' : '–'}</td>
  </tr>`).join('');

  el.innerHTML = `<div class="analytics-table-wrap"><table class="analytics-table">
    <thead><tr>
      <th>${t('maint_log_machine')}</th><th>${t('bean_stat_shots')}</th><th>${t('bean_stat_avg')}</th>
      <th>${t('bean_stat_duration')}</th><th>${t('analytics_machine_stability')}</th>
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
  for (const s of _shots()) {
    const name = s.annotation?.coffee;
    if (!name) continue;
    const key = name.toLowerCase();
    if (!seen.has(key)) seen.set(key, name);
  }
  const beanNames = [...seen.values()].sort((a, b) => a.localeCompare(b));

  if (!beanNames.length) {
    sel.innerHTML = '';
    _renderDialinProgressionChart(null);
    return;
  }

  const prevValue = sel.value;
  sel.innerHTML = beanNames.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
  sel.value = beanNames.includes(prevValue) ? prevValue : beanNames[0];
  _renderDialinProgressionChart(sel.value);
}

export function setDialinProgressionBean(name: string): void {
  _renderDialinProgressionChart(name);
}

function _renderDialinProgressionChart(beanName: string | null): void {
  // #814: resolved per render, never at module load — the value has to be
  // whatever the ACTIVE theme resolves to right now.
  const C = chartColors();
  const ctx = document.getElementById('dialinProgressionChart') as HTMLCanvasElement | null;
  if (!ctx) return;
  chartRegistry.dispose('dialinProgressionChart');

  if (!beanName) {
    ctx.parentElement!.innerHTML = `<p class="empty-note pad-top">${t('analytics_no_beans')}</p>`;
    return;
  }

  const shots = _shots()
    .filter(s => (s.annotation?.coffee || '').toLowerCase() === beanName.toLowerCase())
    .sort((a, b) => a.timestamp - b.timestamp);

  if (shots.length < 2) {
    ctx.parentElement!.innerHTML = `<p class="empty-note pad-top">${t('analytics_no_trend')}</p>`;
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
        if (elements.length > 0 && window.goToShot) window.goToShot(shots[elements[0].index].id);
      },
      plugins: { legend: { labels: { color: C.tick, font: { size: 11 } } } },
      scales: {
        x:  { ticks: { color: _mutedTickColor(), font: { size: 10 } }, grid: { color: 'rgba(63,63,70,.3)' } },
        y:  { position: 'left',  ticks: { color: _mutedTickColor(), font: { size: 10 } }, grid: { color: 'rgba(63,63,70,.3)' } },
        y1: { position: 'right', min: 0, max: 100, ticks: { color: _mutedTickColor(), font: { size: 10 } }, grid: { drawOnChartArea: false } },
      },
    },
  } as unknown as ChartConfiguration<'line'>));
}
