import { S } from '../../state/index.js';
import { t } from '../../i18n.js';
import { localeFor } from '../../constants.js';
import { esc, html, joinHtml, localDateKey, scoreClass } from '../../utils.js';
import type { Html } from '../../utils.js';
import { openDetailSheet } from '../../components/detail-sheet.js';
import type { DetailAnchorPoint } from '../../components/detail-sheet.js';
import { _dateFromKey, _dayKeyNum, _dayKeyOf, _fmtCalendarDay, _keyFromNum, _shots } from './shared.js';
import type { ShotRow } from './shared.js';

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

  const todayNum = _dayKeyNum(localDateKey(new Date(nowMs)));
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
      <span class="cal-fig-num">${esc(stats.busiest ? stats.busiest.count : 0)}<span class="cal-fig-unit">${esc(t('analytics_unit_shots', stats.busiest ? stats.busiest.count : 0))}</span></span>
      <span class="cal-fig-lbl">${esc(busiestLbl)}</span>
    </div>
    <div class="cal-fig cal-fig-perfect">
      <span class="cal-fig-num">${esc(stats.perfect)}<span class="cal-fig-unit">${esc(t('analytics_unit_shots', stats.perfect))}</span></span>
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
  const sub = `${shots.length} ${t('analytics_unit_shots', shots.length)}${avg !== null ? ` · Ø ${avg}` : ''}`;
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

function _sizeCalendarCells(el: HTMLElement): void {
  if (window.innerWidth >= 900) el.style.removeProperty('--cal-cell');
  else el.style.setProperty('--cal-cell', `${Math.max(6, Math.floor((el.clientWidth - CAL_PHONE_GUTTER) / CAL_PHONE_WEEKS))}px`);
}

// A mobile browser's URL bar showing or hiding fires `resize` while the viewer
// is mid-scroll, so re-measure the cells but leave the horizontal position
// alone — snapping back to the newest week there would yank the grid out from
// under them. Only the initial render pins to the newest week.
function _onCalendarResize(): void {
  const el = document.getElementById('shotCalendar');
  if (el) _sizeCalendarCells(el);
}

let _calResizeBound = false;
function _bindCalendarResize(): void {
  if (_calResizeBound) return;
  _calResizeBound = true;
  window.addEventListener('resize', _onCalendarResize);
}

// A month label is drawn at the first week column of its month. Short locale
// names ("Mär", "Apr") are wider than one column, so two labels whose months
// start in adjacent columns would draw over each other ("MärApr"). A label is
// kept only when it starts at least this many columns after the previous one.
export const _MONTH_LABEL_MIN_COLUMNS = 3;

export interface MonthLabelStart { col: number; label: string }

// Pick the month labels to draw from the first-week column of each month. A
// label is dropped when it would start fewer than _MONTH_LABEL_MIN_COLUMNS
// columns after the last kept label, but the last visible month always keeps
// its label: when it collides with the label before it, that earlier label
// gives way instead. A dropped month still occupies its columns, so the next
// label keeps its own column and the month runs stay aligned with the grid.
export function _monthLabelsToDraw(starts: MonthLabelStart[]): MonthLabelStart[] {
  const kept: MonthLabelStart[] = [];
  for (const start of starts) {
    const prev = kept[kept.length - 1];
    if (!prev || start.col - prev.col >= _MONTH_LABEL_MIN_COLUMNS) kept.push(start);
  }
  const last = starts[starts.length - 1];
  if (last && kept[kept.length - 1] !== last) {
    let prev = kept[kept.length - 1];
    while (prev && last.col - prev.col < _MONTH_LABEL_MIN_COLUMNS) {
      kept.pop();
      prev = kept[kept.length - 1];
    }
    kept.push(last);
  }
  return kept;
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
  const todayKey = localDateKey(today);

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
      const key = localDateKey(cur);
      const agg = dayMap.get(key);
      const count = agg ? agg.count : 0;
      const avg = agg && agg.scores.length ? Math.round(agg.scores.reduce((a, b) => a + b, 0) / agg.scores.length) : null;
      week.push({ date: new Date(cur), key, count, avg, hasPerfect: !!agg?.hasPerfect, isFuture: cur > today, isToday: key === todayKey });
      cur.setDate(cur.getDate() + 1);
    }
    weeks.push(week);
  }

  // Month labels above the first week of each month. Overlapping short names
  // are suppressed (their columns stay reserved by the span).
  const monthRuns: { col: number; span: number; label: string }[] = [];
  let lastMonth = -1;
  for (let w = 0; w < weeks.length; w++) {
    const monday = weeks[w]?.[0];
    if (!monday) continue;
    const label = monday.date.toLocaleDateString(locale, { month: 'short' });
    if (monday.date.getMonth() !== lastMonth) { monthRuns.push({ col: w, span: 1, label }); lastMonth = monday.date.getMonth(); }
    else { const run = monthRuns[monthRuns.length - 1]; if (run) run.span++; }
  }
  const drawnCols = new Set(_monthLabelsToDraw(monthRuns).map(m => m.col));
  const monthItems = monthRuns.map(m => html`<span class="cal-month" style="grid-column: span ${esc(m.span)}">${drawnCols.has(m.col) ? esc(m.label) : esc('')}</span>`);

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
        const aria = `${dateStr} · ${day.count} ${t('analytics_unit_shots', day.count)}${day.avg !== null ? ` · Ø ${day.avg}` : ''}`;
        cells.push(html`<button type="button" class="${esc(classes.join(' '))}" data-action="analytics-day" data-day="${esc(day.key)}" aria-label="${esc(aria)}"></button>`);
      } else {
        cells.push(html`<span class="${esc(classes.join(' '))}" aria-hidden="true"></span>`);
      }
    }
  }

  el.innerHTML = html`<div class="cal-months">${joinHtml(monthItems)}</div><div class="cal-grid">${joinHtml(cells)}</div>`;
  // Size the phone cells to the wrapper, then pin to the newest week. Only this
  // initial render scrolls; resize keeps whatever position the viewer has.
  _bindCalendarResize();
  _sizeCalendarCells(el);
  el.scrollLeft = el.scrollWidth;

  const streaksEl = document.getElementById('calStreaks');
  if (streaksEl) {
    const stats = computeCalendarStats(_shots(), s => (window.calcShotScore ? window.calcShotScore(s) : null), Date.now());
    streaksEl.innerHTML = _renderStreaks(stats, locale);
    const fig = typeof streaksEl.querySelector === 'function' ? streaksEl.querySelector<HTMLElement>('.cal-fig-longest') : null;
    if (fig) _wireStreakHover(el, fig, stats.longest);
  }
}
