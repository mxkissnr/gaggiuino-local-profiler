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
import { beanInitials } from './library/shelf.js';
import type { ShotMeta } from '../state/index.js';

// Same metadata-only shot view as views/analytics.ts's ShotRow: only the
// annotation id/name and the profile name are read, scores come from the
// caller through scoreOf so the aggregation stays pure.
export interface MonthShot extends ShotMeta {
  profileName?: string | null;
  profile?: { name?: string | null } | null;
  annotation?: {
    beanId?: number | null;
    coffee?: string | null;
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

function _shots(): MonthShot[] { return S.shots; }

function _scoreOf(shot: MonthShot): number | null {
  const fn = window.calcShotScore;
  if (!fn) return null;
  const v = fn(shot);
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// Shown month; navigation keeps it until the view is rebuilt.
let _viewYear = new Date().getFullYear();
let _viewMonth = new Date().getMonth();
let _openDay: string | null = null;
let _days: MonthDay[] = [];
let _shotsById = new Map<number, MonthShot>();
let _escHandler: ((e: KeyboardEvent) => void) | null = null;

function _switchTo(year: number, month: number): void {
  _viewYear = year;
  _viewMonth = month;
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

function _dayCell(day: MonthDay, today: Date, locale: string): Html {
  if (day.outside) return html`<div class="cal-month-cell cal-month-outside"></div>`;
  const cellDate = new Date(`${day.key}T00:00:00`);
  if (cellDate > today) return html`<div class="cal-month-cell cal-month-future"></div>`;

  const label = _dayLabel(day, locale);
  if (day.count === 0) {
    return html`<div class="cal-month-cell"><span class="cal-month-dot" title="${esc(label)}"></span></div>`;
  }

  const size = dotSize(day.count);
  const ring = day.avgScore !== null ? scoreClass(day.avgScore) : 'cal-month-ring-none';
  const initial = beanInitials(day.mainBeanName || '');
  const inner: Html = day.mainBeanId != null
    ? html`<img class="cal-month-img" alt=""><span class="cal-month-initials" aria-hidden="true">${esc(initial)}</span>`
    : html`<span class="cal-month-dot"></span>`;
  return html`<div class="cal-month-cell"><button type="button" class="cal-month-thumb cal-month-${esc(size)} ${esc(ring)}${day.firstOfBean ? html` is-new-bag` : esc('')}" data-action="analytics-month-day" data-day="${esc(day.key)}"${day.mainBeanId != null ? html` data-bean-id="${esc(day.mainBeanId)}"` : esc('')} aria-label="${esc(label)}" title="${esc(label)}">${inner}</button></div>`;
}

// Bean photos need the auth token, so <img src> can't point at the API
// directly (see bean-image.ts) — set the blob-url src after render and only
// then reveal it over the initials fallback.
function _loadThumbs(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>('.cal-month-thumb[data-bean-id]').forEach(btn => {
    const id = Number(btn.dataset.beanId);
    if (!Number.isFinite(id)) return;
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
  if (typeof year === 'number') _viewYear = year;
  if (typeof month === 'number') _viewMonth = month;
  // A rebuild (language change, data reload, machine filter) is a fresh
  // render: close any open day popover instead of leaving it pointing at a
  // day whose shot list may have changed underneath it.
  _openDay = null;

  const locale = localeFor(S.currentLang);
  const shots = _shots();
  _days = buildMonthDays(shots, _viewYear, _viewMonth, _scoreOf);
  _shotsById = new Map<number, MonthShot>(shots.map((s): [number, MonthShot] => [s.id, s]));

  const now = new Date();
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
