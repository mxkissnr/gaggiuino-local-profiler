import { S } from '../../state/index.js';
import { t } from '../../i18n.js';
import { esc, html, localDateKey, utcDateKey, scoreColor, themeColor } from '../../utils.js';
import { resolveBeanForAnnotation } from '../shots/utils.js';
import { filterAnalyticsShots } from '../analytics-summary.js';
import type { AnalyticsPageFilter } from '../analytics-summary.js';
import type { LibraryRow, MachineRecord, ShotMeta } from '../../state/index.js';

// state/index.ts types shot rows as metadata-only ShotMeta (id/timestamp plus
// an index signature); this view reads the annotation, profile, curve and
// machine fields, so this local alias names them — same pattern as
// views/shots/index.ts.
export interface ShotAnnotation {
  coffee?: string | null | undefined;
  beanId?: number | null | undefined;
  basketId?: number | null | undefined;
  puckScreenId?: number | null | undefined;
  grinder?: string | null | undefined;
  grindSetting?: string | number | null | undefined;
  dose?: number | null | undefined;
}

export interface ShotRow extends ShotMeta {
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
export interface MachineRow extends MachineRecord {
  name?: string | null;
}

// ShotMeta's index signature makes its fields unknown, so every builder reads
// rows through this alias instead of through S.shots directly.
export function _shots(): ShotRow[] { return S.shots; }
export function _allShots(): ShotRow[] { return S.allShots; }
export function _machines(): MachineRow[] { return S.machines; }

// ── Page filter: period + search (#1467) ──────────────────────────────────
// The whole Analytics page shares one toolbar. Every period-scoped builder
// reads _pageShots() instead of the raw S.shots, so the period and query apply
// everywhere at once; the coffee year, the lifetime facts and the machine
// comparison stay on the whole history on purpose.
const ANALYTICS_PREFS_KEY = 'glp.analyticsFilter';
const DEFAULT_ANALYTICS_FILTER: AnalyticsPageFilter = { days: 30, query: '' };

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

export const _pageFilter: AnalyticsPageFilter = _loadAnalyticsFilter();

export function _saveAnalyticsFilter(): void {
  try { localStorage.setItem(ANALYTICS_PREFS_KEY, JSON.stringify(_pageFilter)); } catch { /* private mode / quota */ }
}

export function getAnalyticsFilter(): AnalyticsPageFilter { return { ..._pageFilter }; }

// The profile label buildProfileChart() groups by — and the search matches.
export function _profileNameOf(s: ShotRow): string { return s.profile?.name || s.profileName || 'Unbekannt'; }

// #1625: one render calls _pageShots() ~15 times and each call re-filtered the
// whole history. Memoize on the shots array identity, the filter values and the
// current local day — while none of them changed, the filtered list cannot
// change, so the cached array is returned.
let _pageShotsMemo: { shots: ShotRow[]; days: number; query: string; day: string; out: ShotRow[] } | null = null;

export function _pageShots(): ShotRow[] {
  const shots = _shots();
  const day   = localDateKey(new Date());
  const memo  = _pageShotsMemo;
  if (memo && memo.shots === shots && memo.days === _pageFilter.days && memo.query === _pageFilter.query && memo.day === day) {
    return memo.out;
  }
  const out = filterAnalyticsShots(shots, _pageFilter, Date.now(), _profileNameOf);
  _pageShotsMemo = { shots, days: _pageFilter.days, query: _pageFilter.query, day, out };
  return out;
}

// #1496: short period label for the grey section counters, e.g. "30 days" /
// "all time" (the toolbar already spells out "the last 30 days").
export function _counterPeriod(): string {
  return _pageFilter.days === 0 ? t('analytics_counter_all') : t('analytics_counter_days', _pageFilter.days);
}

// "<count text> · <period>", or just the period when there is no count text.
export function _counterText(count: string): string {
  const period = _counterPeriod();
  return count ? `${count} · ${period}` : period;
}

// The topbar machine switcher already scopes the shots this page reads, so the
// verdict only names the active selection (no second filter; "nothing twice" in
// docs/DESIGN.md). Omitted with fewer than two machines.
export function _machineScopeSuffix(): string {
  const machines = _machines() || [];
  if (machines.length < 2) return '';
  const id = S.activeMachineId;
  if (id == null || id === 'all') return ` · ${t('machine_switcher_all')}`;
  const machine = machines.find(m => m.id === id);
  const name = machine?.name;
  return ` · ${typeof name === 'string' ? name : `#${id}`}`;
}

// A sparse render replaces a chart's canvas with an empty note. That was fine
// when builders ran once, but rebuildAnalyticsPage() re-runs them on every
// toolbar change and the canvas is never recreated (#1467). Remember each
// canvas's wrapper and restore the canvas before the next draw.
const _chartWraps = new Map<string, HTMLElement>();

export function _chartCanvas(id: string): HTMLCanvasElement | null {
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
export type EquipKey = string | number;

export interface EquipStat { count: number; scores: number[]; durations: number[] }

export interface EquipStatEntry {
  name: string;
  count: number;
  avgScore: number | null;
  bestScore: number | null;
  avgDuration: number | null;
}

// CoffeeLibrary (state/index.ts) types beans/grinders only; the world map
// additionally reads each bean's origin list and geocoded location.
export interface SharedBean extends LibraryRow {
  id?: number | null;
  name: string;
  origin?: string | null;
  region?: string | null;
  origins?: { code?: string | null; percent?: number | null }[] | null;
  location?: { lon: number; lat: number } | null;
}

export function _beans(): SharedBean[] { return (S.coffeeLibrary.beans || []) as SharedBean[]; }

// baskets/puckScreens are optional library collections (see CoffeeLibrary) —
// same collection-by-name lookup views/shots/index.ts does for its own
// annotation panel.
export function _libCollection(name: 'baskets' | 'puckScreens'): Record<string, unknown>[] | undefined {
  return S.coffeeLibrary[name];
}

// ── Helpers ───────────────────────────────────────────────────────────────
// Day keys come from the shared helpers. The local one is deliberate (not
// toISOString(), which is UTC and shifts a late-evening shot into the next
// day, #1467); _keyFromNum below works in UTC on purpose.
export function _dayKeyOf(tsSeconds: number): string { return localDateKey(new Date(tsSeconds * 1000)); }
export function _dateFromKey(key: string): Date {
  const [y, m, d] = key.split('-');
  return new Date(Number(y), Number(m) - 1, Number(d));
}
// Serial day number from the key's own fields, so consecutive days differ by
// exactly one even across a DST change.
export function _dayKeyNum(key: string): number {
  const [y, m, d] = key.split('-');
  return Math.floor(Date.UTC(Number(y), Number(m) - 1, Number(d)) / 86400000);
}
export function _keyFromNum(n: number): string {
  return utcDateKey(new Date(n * 86400000));
}
export function _fmtCalendarDay(key: string, locale: string): string {
  return _dateFromKey(key).toLocaleDateString(locale, { day: 'numeric', month: 'long' });
}

// #811: was the hardcoded #52525b (Tailwind zinc-600) on every chart's tick
// labels -- a fixed dark-theme gray that didn't track --gray-600 across
// themes/accents. Canvas needs a resolved color, not a CSS var() reference,
// so this reads the live custom property the same way buildWorldMap() below
// already does for its own colors.
export const _mutedTickColor = () =>
  (getComputedStyle(document.documentElement).getPropertyValue('--gray-600') || '#52525b').trim() || '#52525b';
// #1622: the shared five-step score scale (scoreColor(), utils.ts) resolved
// to a value Chart.js can paint. Fallbacks are the dark-theme token values,
// used only before the stylesheet has applied.
const _SCORE_FALLBACK: Record<string, string> = {
  '--ok': '#5cb98a', '--score-good': '#a7c25c', '--warn': '#d3a03f',
  '--score-low': '#e0913f', '--err': '#e0705f', '--gray-600': '#93989c',
};
export function _scoreChartColor(sc: number | null): string {
  const token = scoreColor(sc);
  const name = token.startsWith('var(') ? token.slice(4, -1) : '';
  return themeColor(name, _SCORE_FALLBACK[name] ?? '');
}

// #1625: the stable key a shot's bean groups under — the resolved library
// bean's id when the annotation links to one ('id:<id>'), else the lower-cased
// coffee name ('name:<name>'). The label is the library bean's CURRENT name,
// so a rename follows the id; an unresolved bean keeps its annotated name.
// Returns null when the shot names no bean and resolves to none either.
export function _beanGroup(annotation: ShotAnnotation | null | undefined, beans: SharedBean[]): { key: string; label: string; beanId: number | null } | null {
  const resolved = resolveBeanForAnnotation(annotation, beans);
  if (resolved) {
    return { key: `id:${resolved.id}`, label: String(resolved.name || annotation?.coffee || ''), beanId: resolved.id ?? null };
  }
  const name = annotation?.coffee;
  if (!name) return null;
  return { key: `name:${name.toLowerCase()}`, label: name, beanId: null };
}
