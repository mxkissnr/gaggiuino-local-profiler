// Month view for the Statistics Shot Calendar (#1331, part 1): one calendar
// month of day cells, each showing the bean pulled most that day as a round
// thumbnail. The pure aggregation (buildMonthDays / dotSize) is DOM-free so it
// can be unit-tested under vitest's node environment; renderMonthCalendar owns
// the markup and the day popover. views/analytics.ts keeps the 12-month
// heatmap as the compact year overview and mounts this above it.
import { S } from '../state/index.js';
import { t } from '../i18n.js';
import { localeFor } from '../constants.js';
import { esc, html, joinHtml, scoreClass } from '../utils.js';
import type { Html } from '../utils.js';
import { loadBeanImageBlobUrl } from '../bean-image.js';
import type { LibraryRow, ShotMeta } from '../state/index.js';

// Same metadata-only shot view as views/analytics.ts's ShotRow: only the
// annotation id/name and the profile name are read, scores come from the
// caller through scoreOf so the aggregation stays pure.
export interface MonthShot extends ShotMeta {
  profileName?: string | null;
  profile?: { name?: string | null } | null;
  // `| undefined` mirrors views/analytics.ts's ShotAnnotation so its ShotRow
  // stays assignable here under exactOptionalPropertyTypes.
  annotation?: {
    beanId?: number | null | undefined;
    coffee?: string | null | undefined;
  } | null;
}

export interface MonthDay {
  key: string;                    // YYYY-MM-DD in local time
  day: number;                    // day of month, 1..31
  outside: boolean;               // padding cell from a neighbouring month
  count: number;
  avgScore: number | null;        // rounded day average, null without scores
  mainBeanId: number | null;      // bean with the most shots that day
  mainBeanName: string | null;
  shotIds: number[];              // chronological
  firstOfBean: boolean;           // first appearance of mainBeanId in the input
}

export type DotSize = 's' | 'm' | 'l';

// Thumbnail size by shot count: 1 / 2 / 3+.
export function dotSize(count: number): DotSize {
  return count >= 3 ? 'l' : count === 2 ? 'm' : 's';
}

function _pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

// Local calendar date. toISOString() is UTC and shifts a late-evening shot
// into the next day.
function _localKey(d: Date): string {
  return `${d.getFullYear()}-${_pad2(d.getMonth() + 1)}-${_pad2(d.getDate())}`;
}

interface DayBucket {
  shots: MonthShot[];
  scores: number[];
  beanCounts: Map<number, number>;
  beanLast: Map<number, number>;
  beanName: Map<number, string>;
}

// One entry per calendar day of `month` (0-based), padded to full Monday-first
// weeks. Padding cells are flagged `outside`. Days without shots keep zero
// counts and nulls.
export function buildMonthDays(
  shots: readonly MonthShot[],
  year: number,
  month: number,
  scoreOf: (shot: MonthShot) => number | null,
): MonthDay[] {
  const byDay = new Map<string, DayBucket>();
  // Earliest shot of each bean anywhere in the input, to decide firstOfBean.
  const beanFirst = new Map<number, number>();

  for (const s of shots) {
    const d = new Date(s.timestamp * 1000);
    const key = _localKey(d);
    let b = byDay.get(key);
    if (!b) {
      b = { shots: [], scores: [], beanCounts: new Map(), beanLast: new Map(), beanName: new Map() };
      byDay.set(key, b);
    }
    b.shots.push(s);
    const sc = scoreOf(s);
    if (sc !== null && Number.isFinite(sc)) b.scores.push(sc);

    const beanId = s.annotation?.beanId;
    if (typeof beanId === 'number') {
      b.beanCounts.set(beanId, (b.beanCounts.get(beanId) ?? 0) + 1);
      b.beanLast.set(beanId, s.timestamp);
      const coffee = s.annotation?.coffee;
      if (coffee) b.beanName.set(beanId, coffee);
      const firstTs = beanFirst.get(beanId);
      if (firstTs === undefined || s.timestamp < firstTs) beanFirst.set(beanId, s.timestamp);
    }
  }

  const first = new Date(year, month, 1);
  const startDow = (first.getDay() + 6) % 7; // Monday = 0
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const totalCells = Math.ceil((startDow + daysInMonth) / 7) * 7;

  const days: MonthDay[] = [];
  for (let i = 0; i < totalCells; i++) {
    const cellDate = new Date(year, month, 1 - startDow + i);
    const key = _localKey(cellDate);
    const outside = cellDate.getMonth() !== month || cellDate.getFullYear() !== year;
    const b = byDay.get(key);
    if (outside || !b) {
      days.push({
        key, day: cellDate.getDate(), outside,
        count: 0, avgScore: null, mainBeanId: null, mainBeanName: null,
        shotIds: [], firstOfBean: false,
      });
      continue;
    }

    const ordered = [...b.shots].sort((x, y) => x.timestamp - y.timestamp);
    // Main bean: most shots; a tie goes to the bean whose last shot is later.
    let mainBeanId: number | null = null;
    let bestCount = -1;
    let bestLast = -Infinity;
    for (const [beanId, count] of b.beanCounts) {
      const last = b.beanLast.get(beanId) ?? -Infinity;
      if (count > bestCount || (count === bestCount && last > bestLast)) {
        mainBeanId = beanId;
        bestCount = count;
        bestLast = last;
      }
    }

    const avgScore = b.scores.length
      ? Math.round(b.scores.reduce((a, v) => a + v, 0) / b.scores.length)
      : null;
    const mainBeanName = mainBeanId != null ? (b.beanName.get(mainBeanId) ?? null) : null;

    // New bag only when this day holds the main bean's very first shot in the
    // whole input — a bean already pulled earlier never counts as a new bag.
    let firstOfBean = false;
    if (mainBeanId != null) {
      const firstTs = beanFirst.get(mainBeanId);
      if (firstTs !== undefined && _localKey(new Date(firstTs * 1000)) === key) firstOfBean = true;
    }

    days.push({
      key, day: cellDate.getDate(), outside: false,
      count: ordered.length, avgScore, mainBeanId, mainBeanName,
      shotIds: ordered.map(s => s.id), firstOfBean,
    });
  }
  return days;
}

// Pure month arithmetic the navigation buttons use; works across year
// boundaries (December -> January).
export function shiftMonth(year: number, month: number, delta: number): [number, number] {
  const d = new Date(year, month + delta, 1);
  return [d.getFullYear(), d.getMonth()];
}

const DAY_MS = 86400000;

export type SummaryDeltaBucket = 'well-above' | 'above' | 'on-par' | 'below' | 'well-below';

export interface SummaryLine {
  verdict: { shots: number; avgScore: number | null };
  delta: { bucket: SummaryDeltaBucket; avg7: number } | null;
  context: { name: string; avgScore: number } | null;
  streak: number;
  streakNote: boolean;
}

// Consecutive days with a shot, ending today or yesterday. A gap of a full
// empty day (or a last shot older than yesterday) breaks the run.
function _currentStreak(activeDays: Set<string>, nowMs: number): number {
  const cursor = new Date(nowMs);
  cursor.setHours(0, 0, 0, 0);
  if (!activeDays.has(_localKey(cursor))) cursor.setDate(cursor.getDate() - 1);
  let streak = 0;
  while (activeDays.has(_localKey(cursor))) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
    cursor.setHours(0, 0, 0, 0);
  }
  return streak;
}

// One-line summary of how the shots are going (#1331, part 2): the last 30
// days (count + average score), the last 7 days against that average, the best
// bean of the last 30 days, and the current streak. Pure and DOM-free so
// buildSummaryKpis() and the tests share the exact same numbers.
export function summaryLine(
  shots: readonly MonthShot[],
  scoreOf: (shot: MonthShot) => number | null,
  nowMs: number,
): SummaryLine {
  const start30 = nowMs - 30 * DAY_MS;
  const start7 = nowMs - 7 * DAY_MS;

  let shots30 = 0;
  let sum30 = 0;
  let n30 = 0;
  let sum7 = 0;
  let n7 = 0;
  const bean30 = new Map<number, { name: string; sum: number; n: number }>();
  const activeDays = new Set<string>();

  for (const s of shots) {
    const ms = s.timestamp * 1000;
    activeDays.add(_localKey(new Date(ms)));
    if (ms < start30 || ms > nowMs) continue;
    shots30++;
    const sc = scoreOf(s);
    if (sc === null || !Number.isFinite(sc)) continue;
    sum30 += sc;
    n30++;
    if (ms >= start7) {
      sum7 += sc;
      n7++;
    }
    const beanId = s.annotation?.beanId;
    const name = s.annotation?.coffee;
    if (typeof beanId === 'number' && name) {
      const entry = bean30.get(beanId) ?? { name, sum: 0, n: 0 };
      entry.name = name;
      entry.sum += sc;
      entry.n++;
      bean30.set(beanId, entry);
    }
  }

  const avgScore30 = n30 ? Math.round(sum30 / n30) : null;
  const verdict = { shots: shots30, avgScore: avgScore30 };

  let delta: SummaryLine['delta'] = null;
  if (n7 >= 3 && avgScore30 !== null) {
    const avg7 = Math.round(sum7 / n7);
    const diff = avg7 - avgScore30;
    const bucket: SummaryDeltaBucket = diff >= 5 ? 'well-above'
      : diff >= 2 ? 'above'
      : diff > -2 ? 'on-par'
      : diff > -5 ? 'below'
      : 'well-below';
    delta = { bucket, avg7 };
  }

  let context: SummaryLine['context'] = null;
  for (const entry of bean30.values()) {
    if (entry.n < 2) continue;
    const avg = Math.round(entry.sum / entry.n);
    if (!context || avg > context.avgScore) context = { name: entry.name, avgScore: avg };
  }

  const streak = _currentStreak(activeDays, nowMs);
  return { verdict, delta, context, streak, streakNote: streak >= 7 };
}

function _shots(): MonthShot[] { return S.shots; }

function _scoreOf(shot: MonthShot): number | null {
  const fn = window.calcShotScore;
  if (!fn) return null;
  const v = fn(shot);
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// Shown month. Until the user navigates it follows the current month on every
// render, so a view left open across a month boundary rolls over on its own;
// navigating pins the chosen month instead.
let _viewYear = new Date().getFullYear();
let _viewMonth = new Date().getMonth();
let _navigated = false;
let _openDay: string | null = null;
let _days: MonthDay[] = [];
let _shotsById = new Map<number, MonthShot>();
let _escHandler: ((e: KeyboardEvent) => void) | null = null;

function _switchTo(year: number, month: number): void {
  _viewYear = year;
  _viewMonth = month;
  // Pin the view once the user picks a month, but resume following "now" the
  // moment they navigate back to the current one, so a later month boundary
  // still rolls the view forward.
  const now = new Date();
  _navigated = year !== now.getFullYear() || month !== now.getMonth();
  const el = document.getElementById('shotMonthCalendar');
  if (el) renderMonthCalendar(el);
}

export function analyticsMonthPrev(): void {
  const [y, m] = shiftMonth(_viewYear, _viewMonth, -1);
  _switchTo(y, m);
}

export function analyticsMonthNext(): void {
  const now = new Date();
  if (_viewYear === now.getFullYear() && _viewMonth === now.getMonth()) return;
  const [y, m] = shiftMonth(_viewYear, _viewMonth, 1);
  _switchTo(y, m);
}

export function analyticsMonthDay(dayKey: string | undefined): void {
  if (!dayKey) return;
  _openDay = _openDay === dayKey ? null : dayKey;
  const el = document.getElementById('shotMonthCalendar');
  if (el) _renderPopover(el);
}

function _ensureEscHandler(): void {
  if (_escHandler) return;
  _escHandler = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !_openDay) return;
    _openDay = null;
    const el = document.getElementById('shotMonthCalendar');
    if (el) _renderPopover(el);
  };
  document.addEventListener('keydown', _escHandler);
}

function _weekdayLabels(locale: string): string[] {
  const fmt = new Intl.DateTimeFormat(locale, { weekday: 'short' });
  const labels: string[] = [];
  for (let i = 0; i < 7; i++) labels.push(fmt.format(new Date(2024, 0, 1 + i))); // 2024-01-01 is a Monday
  return labels;
}

function _dateLabel(day: MonthDay, locale: string): string {
  return new Date(`${day.key}T00:00:00`).toLocaleDateString(locale, {
    weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric',
  });
}

function _dayLabel(day: MonthDay, locale: string): string {
  const dateStr = _dateLabel(day, locale);
  if (day.count === 0) return `${dateStr}: ${t('analytics_month_day_empty')}`;
  const parts: string[] = [`${dateStr}: ${t('analytics_month_shots', day.count)}`];
  if (day.avgScore !== null) parts.push(`Ø ${day.avgScore}`);
  if (day.mainBeanName) parts.push(day.mainBeanName);
  if (day.count >= 6) parts.push(t('analytics_month_marathon'));
  if (day.firstOfBean) parts.push(t('analytics_month_new_bag'));
  return parts.join(' · ');
}

export type CellKind = 'empty' | 'photo' | 'disc';

// Which day-cell flavour to draw: a day without shots shows only its number, a
// day whose main bean has a photo shows that photo, and everything else (no
// bean, or a bean without a photo) shows the number on a score-tinted disc.
export function cellKind(day: Pick<MonthDay, 'count'>, hasPhoto: boolean): CellKind {
  if (day.count === 0) return 'empty';
  return hasPhoto ? 'photo' : 'disc';
}

// One in-month day cell. `hasPhoto` mirrors the beanHasPhoto check _loadThumbs
// uses, so a day only gets an <img> when there is a photo to fetch.
export function dayCellHtml(day: MonthDay, today: Date, locale: string, hasPhoto: boolean): Html {
  if (day.outside) return html`<div class="cal-month-cell cal-month-outside"></div>`;
  const cellDate = new Date(`${day.key}T00:00:00`);
  if (cellDate > today) return html`<div class="cal-month-cell cal-month-future"></div>`;

  const todayCls: Html = day.key === _localKey(today) ? html` is-today` : esc('');
  const label = _dayLabel(day, locale);
  const kind = cellKind(day, hasPhoto);

  if (kind === 'empty') {
    return html`<div class="cal-month-cell${todayCls}"><span class="cal-month-num" title="${esc(label)}">${esc(day.day)}</span></div>`;
  }

  const size = dotSize(day.count);
  const ring = day.avgScore !== null ? scoreClass(day.avgScore) : 'cal-month-ring-none';
  const inner: Html = kind === 'photo'
    ? html`<img class="cal-month-img" alt="">`
    : html`<span class="cal-month-num">${esc(day.day)}</span>`;
  const beanAttr = kind === 'photo' && day.mainBeanId != null
    ? html` data-bean-id="${esc(day.mainBeanId)}"`
    : esc('');
  return html`<div class="cal-month-cell has-shot${todayCls}"><button type="button" class="cal-month-thumb cal-month-${esc(size)} ${esc(ring)}${kind === 'disc' ? html` no-img` : esc('')}${day.firstOfBean ? html` is-new-bag` : esc('')}" data-action="analytics-month-day" data-day="${esc(day.key)}"${beanAttr} aria-label="${esc(label)}" title="${esc(label)}">${inner}</button></div>`;
}

function _dayCell(day: MonthDay, today: Date, locale: string): Html {
  const hasPhoto = day.mainBeanId != null && beanHasPhoto(S.coffeeLibrary.beans, day.mainBeanId);
  return dayCellHtml(day, today, locale, hasPhoto);
}

// A bean without a stored photo has nothing to fetch, and requesting it would
// 404 and log a console error (the E2E smoke test fails on that).
export function beanHasPhoto(beans: readonly LibraryRow[] | undefined, id: number): boolean {
  return !!beans?.some(b => b.id === id && !!b.image);
}

// Bean photos need the auth token, so <img src> can't point at the API
// directly (see bean-image.ts) — set the blob-url src after render and only
// then reveal it over the initials fallback.
function _loadThumbs(root: HTMLElement): void {
  const beans = S.coffeeLibrary.beans;
  root.querySelectorAll<HTMLElement>('.cal-month-thumb[data-bean-id]').forEach(btn => {
    const id = Number(btn.dataset.beanId);
    if (!Number.isFinite(id)) return;
    if (!beanHasPhoto(beans, id)) return;
    void loadBeanImageBlobUrl(id).then(url => {
      if (!url) return;
      const img = btn.querySelector<HTMLImageElement>('img.cal-month-img');
      if (!img) return;
      img.src = url;
      btn.classList.add('has-img');
    });
  });
}

function _renderPopover(el: HTMLElement): void {
  const host = el.querySelector<HTMLElement>('#calMonthPop');
  if (!host) return;
  const day = _openDay ? _days.find(d => d.key === _openDay) : undefined;
  if (!day || day.count === 0) {
    _openDay = null;
    host.innerHTML = esc('');
    host.classList.remove('open');
    return;
  }
  const locale = localeFor(S.currentLang);
  const rows = day.shotIds.map(id => {
    const s = _shotsById.get(id);
    if (!s) return esc('');
    const time = new Date(s.timestamp * 1000).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
    const name = s.profile?.name || s.profileName || '';
    const sc = _scoreOf(s);
    return html`<button type="button" class="cal-month-pop-row" data-action="goto-shot" data-id="${esc(id)}">
      <span class="cal-month-pop-time">${esc(time)}</span>
      <span class="cal-month-pop-name">${esc(name)}</span>
      ${sc !== null ? html`<span class="cal-month-pop-score ${esc(scoreClass(sc))}">${esc(sc)}</span>` : esc('')}
    </button>`;
  });
  host.innerHTML = html`<div class="cal-month-pop-title">${esc(_dateLabel(day, locale))} · ${esc(t('analytics_month_shots', day.count))}</div>${joinHtml(rows)}`;
  host.classList.add('open');
}

// Render the month view into `el`. The optional year/month only matter for a
// direct call; the nav buttons go through the module's own shown month.
export function renderMonthCalendar(el: HTMLElement, year?: number, month?: number): void {
  // An explicit year/month is a deliberate selection; otherwise the shown
  // month is reused so the nav buttons survive the rebuild a _switchTo makes.
  if (typeof year === 'number' || typeof month === 'number') _navigated = true;
  if (typeof year === 'number') _viewYear = year;
  if (typeof month === 'number') _viewMonth = month;
  const now = new Date();
  // With no navigation yet, follow the current month at render time: a view
  // left open across a month change shows the new month, not the one that was
  // current when it was mounted.
  if (!_navigated) {
    _viewYear = now.getFullYear();
    _viewMonth = now.getMonth();
  }
  // A rebuild (language change, data reload, machine filter) is a fresh
  // render: close any open day popover instead of leaving it pointing at a
  // day whose shot list may have changed underneath it.
  _openDay = null;

  const locale = localeFor(S.currentLang);
  const shots = _shots();
  _days = buildMonthDays(shots, _viewYear, _viewMonth, _scoreOf);
  _shotsById = new Map<number, MonthShot>(shots.map((s): [number, MonthShot] => [s.id, s]));

  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const isCurrentMonth = _viewYear === today.getFullYear() && _viewMonth === today.getMonth();
  const title = new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(new Date(_viewYear, _viewMonth, 1));

  const head = html`<div class="cal-month-head">
    <button type="button" class="cal-month-nav" data-action="analytics-month-prev" aria-label="${esc(t('analytics_month_prev'))}">‹</button>
    <span class="cal-month-title">${esc(title)}</span>
    <button type="button" class="cal-month-nav" data-action="analytics-month-next" aria-label="${esc(t('analytics_month_next'))}"${isCurrentMonth ? html` disabled` : esc('')}>›</button>
  </div>`;
  const weekdays = html`<div class="cal-month-weekdays">${joinHtml(_weekdayLabels(locale).map(w => html`<span class="cal-month-weekday">${esc(w)}</span>`))}</div>`;
  const grid = html`<div class="cal-month-grid">${joinHtml(_days.map(d => _dayCell(d, today, locale)))}</div>`;

  el.innerHTML = html`${head}${weekdays}${grid}<div class="cal-month-pop" id="calMonthPop"></div>`;
  _loadThumbs(el);
  _renderPopover(el);
  _ensureEscHandler();
}
