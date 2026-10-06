import type { ShotMeta } from '../state/index.js';
import { TRANSLATIONS } from '../constants.js';
import type { Translations } from '../i18n.js';

// "Did you know?" facts (#1467, slice 6a). Pure and DOM-free, like
// analytics-summary.ts: computeFacts() takes the metadata-only shot rows and
// the same per-shot score function the trend uses, and returns display-ready
// facts. All calendar fields are read in LOCAL time (new Date(ts * 1000)), the
// same convention _dayKeyOf uses, so a late-evening shot never slips a day.
//
// Numbers and dates are formatted here rather than in the renderer because a
// fact's "big" value, sentence and rows are one unit; the locale is the only
// thing the renderer would have added, so it is passed in instead.

export interface FactShot extends ShotMeta {
  duration?: number | null;
  weight?: number | null;
}

export type FactIcon =
  | 'moon' | 'cups' | 'clock' | 'bolt' | 'cal' | 'jug' | 'film' | 'suitcase' | 'snail';

// A row is [i18n label key, display-ready value]. The renderer resolves known
// keys through t(); a literal (a time, a date) passes through unchanged.
export interface Fact {
  id: string;
  icon: FactIcon;
  big: string;
  textKey: string;
  vars: Record<string, string | number>;
  rows: [string, string][];
  night?: boolean;
  gauge?: number;
}

const DAY_MS = 86400000;
const NIGHT_START_HOUR = 23;
const NIGHT_END_HOUR = 4;
const NIGHT_GROUP_SHIFT_SECONDS = NIGHT_END_HOUR * 3600;

function _pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function _minuteOfDay(tsSeconds: number): number {
  const d = new Date(tsSeconds * 1000);
  return d.getHours() * 60 + d.getMinutes();
}

// Circular distance in minutes between two minute-of-day values: 23:30 is one
// hour from 00:30, not twenty-three. Exported so the wrap-around stays pinned
// by a unit test.
export function _circularMinutes(a: number, b: number): number {
  const raw = Math.abs(a - b) % 1440;
  return Math.min(raw, 1440 - raw);
}

function _median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  if (s.length % 2 === 1) return s[mid] ?? 0;
  const lo = s[mid - 1] ?? 0;
  const hi = s[mid] ?? 0;
  return (lo + hi) / 2;
}

// Linear-interpolated percentile of an already-unsorted numeric list.
function _percentile(values: number[], p: number): number {
  const s = [...values].sort((a, b) => a - b);
  if (!s.length) return 0;
  const pos = p * (s.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const loV = s[lo] ?? 0;
  const hiV = s[hi] ?? loV;
  return loV + (hiV - loV) * (pos - lo);
}

function _localDayKey(d: Date): string {
  return `${d.getFullYear()}-${_pad2(d.getMonth() + 1)}-${_pad2(d.getDate())}`;
}

function _timeStr(tsSeconds: number): string {
  const d = new Date(tsSeconds * 1000);
  return `${_pad2(d.getHours())}:${_pad2(d.getMinutes())}`;
}

// Unit words and the few templated big values come from the same i18n
// dictionaries the renderer's t() reads, so a locale's units never drift from
// its sentences. Selecting by the locale's language keeps computeFacts pure.
const _FACT_DICTS = TRANSLATIONS as Record<string, Translations | undefined>;
const _EN_DICT: Translations = _FACT_DICTS['en'] ?? {};

function _langOf(locale: string): string {
  const lang = locale.split('-')[0] ?? 'en';
  return Object.prototype.hasOwnProperty.call(_FACT_DICTS, lang) ? lang : 'en';
}

function _dict(lang: string): Translations {
  return _FACT_DICTS[lang] ?? _EN_DICT;
}

function _bigText(locale: string, key: string, vars: Record<string, string | number>): string {
  const val = _dict(_langOf(locale))[key];
  return typeof val === 'function' ? val(vars) : typeof val === 'string' ? val : '';
}

function _unit(locale: string, key: string, n?: number): string {
  const val = _dict(_langOf(locale))[key];
  if (typeof val === 'function') return val(n);
  return typeof val === 'string' ? val : '';
}

function _formatNumber(locale: string, value: number, opts?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(locale, opts).format(value);
}

// Dates shown to the user follow the active locale ("Mi., 17. Juni, 21:21" for
// a German UI); the year only appears once a shot is not from this year.
function _dateOpts(d: Date, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormatOptions {
  return d.getFullYear() === new Date().getFullYear() ? opts : { ...opts, year: 'numeric' };
}

function _dateStr(tsSeconds: number, locale: string): string {
  const d = new Date(tsSeconds * 1000);
  return d.toLocaleDateString(locale, _dateOpts(d, { day: 'numeric', month: 'long' }));
}

function _dateTimeStr(tsSeconds: number, locale: string): string {
  const d = new Date(tsSeconds * 1000);
  const date = d.toLocaleDateString(locale, _dateOpts(d, { weekday: 'short', day: 'numeric', month: 'long' }));
  return `${date}, ${_timeStr(tsSeconds)}`;
}

function _hourSpan(loMin: number, hiMin: number): string {
  const lo = Math.round(loMin / 60) % 24;
  const hi = Math.round(hiMin / 60) % 24;
  return `${_pad2(lo)}–${_pad2(hi)}`;
}

function _scoreStr(sc: number | null): string {
  return sc === null ? '–' : String(sc);
}

export function computeFacts(
  shots: readonly FactShot[],
  scoreOf: (shot: FactShot) => number | null,
  locale = 'en-US',
): Fact[] {
  const sorted = shots
    .filter(s => typeof s.timestamp === 'number' && Number.isFinite(s.timestamp))
    .slice()
    .sort((a, b) => a.timestamp - b.timestamp);

  const facts: Fact[] = [];

  // ── odd_hour ──────────────────────────────────────────────────────────
  if (sorted.length) {
    const mins = sorted.map(s => _minuteOfDay(s.timestamp));
    const med = _median(mins);
    let bestShot: FactShot | null = null;
    let bestDist = -1;
    for (const s of sorted) {
      const dist = _circularMinutes(_minuteOfDay(s.timestamp), med);
      if (dist > bestDist) { bestDist = dist; bestShot = s; }
    }
    if (bestShot && bestDist >= 240) {
      const hour = new Date(bestShot.timestamp * 1000).getHours();
      const sc = scoreOf(bestShot);
      const night = hour >= 22 || hour < 5;
      const dateTime = _dateTimeStr(bestShot.timestamp, locale);
      const fact: Fact = {
        id: 'odd_hour',
        icon: 'moon',
        big: _timeStr(bestShot.timestamp),
        textKey: night ? 'analytics_fact_odd_hour' : 'analytics_fact_odd_hour_day',
        vars: { date: dateTime, score: _scoreStr(sc) },
        rows: [
          ['analytics_fact_row_date_time', dateTime],
          ['analytics_fact_row_score', _scoreStr(sc)],
          ['analytics_fact_row_usually', _hourSpan(_percentile(mins, 0.1), _percentile(mins, 0.9))],
        ],
      };
      if (night) fact.night = true;
      facts.push(fact);
    }
  }

  // ── night_round ───────────────────────────────────────────────────────
  {
    const nightShots = sorted.filter(s => {
      const h = new Date(s.timestamp * 1000).getHours();
      return h >= NIGHT_START_HOUR || h < NIGHT_END_HOUR;
    });
    const groups = new Map<string, FactShot[]>();
    for (const s of nightShots) {
      const key = _localDayKey(new Date((s.timestamp - NIGHT_GROUP_SHIFT_SECONDS) * 1000));
      const list = groups.get(key);
      if (list) list.push(s);
      else groups.set(key, [s]);
    }
    let bestKey: string | null = null;
    let bestGroup: FactShot[] = [];
    for (const [key, group] of groups) {
      if (group.length > bestGroup.length) { bestKey = key; bestGroup = group; }
    }
    if (bestKey && bestGroup.length >= 3) {
      const start = bestGroup[0];
      const end = bestGroup[bestGroup.length - 1];
      // Minutes from the first to the last shot of the round, never below 1.
      const spanMin = start && end
        ? Math.max(1, Math.round((end.timestamp - start.timestamp) / 60))
        : 1;
      const vars: Record<string, string | number> = {
        date: _dateStr(start ? start.timestamp : 0, locale),
        n: bestGroup.length,
        min: spanMin,
        from: start ? _timeStr(start.timestamp) : '00:00',
        to: end ? _timeStr(end.timestamp) : '00:00',
      };
      facts.push({
        id: 'night_round',
        icon: 'cups',
        big: _bigText(locale, 'analytics_fact_big_night_round', vars),
        textKey: 'analytics_fact_night_round',
        vars,
        rows: bestGroup.map(s => [_timeStr(s.timestamp), _scoreStr(scoreOf(s))] as [string, string]),
        night: true,
      });
    }
  }

  // ── first_hundred ─────────────────────────────────────────────────────
  {
    const first = sorted.find(s => scoreOf(s) === 100);
    if (first) {
      const d = new Date(first.timestamp * 1000);
      const wish = d.getHours() === d.getMinutes();
      facts.push({
        id: 'first_hundred',
        icon: 'clock',
        big: _timeStr(first.timestamp),
        textKey: wish ? 'analytics_fact_first_hundred_wish' : 'analytics_fact_first_hundred',
        vars: { date: _dateTimeStr(first.timestamp, locale), score: 100 },
        rows: [
          ['analytics_fact_row_date_time', _dateTimeStr(first.timestamp, locale)],
          ['analytics_fact_row_score', '100'],
        ],
      });
    }
  }

  // ── hundred_run ───────────────────────────────────────────────────────
  {
    let run = 0;
    let bestRun = 0;
    let runStart: FactShot | null = null;
    let bestStart: FactShot | null = null;
    let bestEnd: FactShot | null = null;
    for (const s of sorted) {
      if (scoreOf(s) === 100) {
        if (run === 0) runStart = s;
        run++;
        if (run > bestRun) { bestRun = run; bestStart = runStart; bestEnd = s; }
      } else {
        run = 0;
      }
    }
    if (bestRun >= 3 && bestStart && bestEnd) {
      facts.push({
        id: 'hundred_run',
        icon: 'bolt',
        big: `${_formatNumber(locale, bestRun)} × 100`,
        textKey: 'analytics_fact_hundred_run',
        vars: { n: bestRun },
        rows: [
          ['analytics_fact_row_run_length', String(bestRun)],
          ['analytics_fact_row_first', _dateStr(bestStart.timestamp, locale)],
          ['analytics_fact_row_last', _dateStr(bestEnd.timestamp, locale)],
        ],
      });
    }
  }

  // ── best_weekday ──────────────────────────────────────────────────────
  {
    const n = new Array<number>(7).fill(0);
    const sum = new Array<number>(7).fill(0);
    for (const s of sorted) {
      const sc = scoreOf(s);
      if (sc === null || !Number.isFinite(sc)) continue;
      const wd = new Date(s.timestamp * 1000).getDay();
      n[wd] = (n[wd] ?? 0) + 1;
      sum[wd] = (sum[wd] ?? 0) + sc;
    }
    const qualified: number[] = [];
    for (let i = 0; i < 7; i++) if ((n[i] ?? 0) >= 5) qualified.push(i);
    if (qualified.length >= 3) {
      const avgOf = (i: number): number => (sum[i] ?? 0) / (n[i] ?? 1);
      const byAvg = [...qualified].sort((a, b) => avgOf(b) - avgOf(a));
      const bestWd = byAvg[0] ?? 0;
      const minShots = Math.min(...qualified.map(i => n[i] ?? 0));
      const rare = (n[bestWd] ?? 0) === minShots;
      const weekdayName = new Date(2024, 0, 7 + bestWd).toLocaleDateString(locale, { weekday: 'long' });
      const top = byAvg.slice(0, 4);
      facts.push({
        id: 'best_weekday',
        icon: 'cal',
        big: weekdayName,
        textKey: rare ? 'analytics_fact_best_weekday_rare' : 'analytics_fact_best_weekday',
        vars: { weekday: weekdayName, avg: Math.round(avgOf(bestWd)), shots: n[bestWd] ?? 0 },
        rows: top.map(i => [`analytics_fact_wd_${i}`, `${n[i] ?? 0} · Ø ${Math.round(avgOf(i))}`] as [string, string]),
      });
    }
  }

  // ── total_yield ───────────────────────────────────────────────────────
  {
    let grams = 0;
    let nShots = 0;
    for (const s of sorted) {
      const w = s.weight;
      if (typeof w === 'number' && w > 0) { grams += w / 10; nShots++; }
    }
    if (nShots > 0 && grams >= 1000) {
      const litres = grams / 1000;
      const avgG = grams / nShots;
      const rem = grams % 10000;
      const nextL = (Math.floor(grams / 10000) + 1) * 10;
      const toNext = Math.max(0, Math.ceil((nextL * 1000 - grams) / avgG));
      const big = `${_formatNumber(locale, litres, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ${_unit(locale, 'analytics_unit_litres')}`;
      facts.push({
        id: 'total_yield',
        icon: 'jug',
        big,
        textKey: 'analytics_fact_total_yield',
        vars: { toNext, nextL },
        rows: [
          ['analytics_fact_row_total_grams', `${Math.round(grams)} g · ${nShots}`],
          ['analytics_fact_row_avg_grams', `${_formatNumber(locale, avgG, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} g`],
          ['analytics_fact_row_to_next', String(toNext)],
        ],
        gauge: (rem / 10000) * 100,
      });
    }
  }

  // ── total_time ────────────────────────────────────────────────────────
  {
    let seconds = 0;
    let nShots = 0;
    for (const s of sorted) {
      const dur = s.duration;
      // duration is tenths of a second; ≤ 5 s is the aborted-shot noise the
      // bean shelf already filters out.
      if (typeof dur === 'number' && dur > 50) { seconds += dur / 10; nShots++; }
    }
    if (nShots > 0 && seconds >= 1800) {
      const minutes = Math.round(seconds / 60);
      let big: string;
      if (minutes >= 120) {
        big = `${_formatNumber(locale, Math.round(minutes / 60))} ${_unit(locale, 'analytics_unit_hours')}`;
      } else if (minutes >= 60) {
        big = `${_formatNumber(locale, minutes / 60, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ${_unit(locale, 'analytics_unit_hours')}`;
      } else {
        big = `${_formatNumber(locale, minutes)} ${_unit(locale, 'analytics_unit_minutes')}`;
      }
      facts.push({
        id: 'total_time',
        icon: 'film',
        big,
        textKey: seconds >= 5400 ? 'analytics_fact_total_time_movie' : 'analytics_fact_total_time',
        vars: {},
        rows: [
          ['analytics_fact_row_total_minutes', String(minutes)],
          ['analytics_fact_row_avg_seconds', (seconds / nShots).toFixed(1)],
        ],
      });
    }
  }

  // ── longest_break ─────────────────────────────────────────────────────
  {
    let maxGap = 0;
    let before: FactShot | null = null;
    let after: FactShot | null = null;
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      if (!prev || !cur) continue;
      const gap = cur.timestamp - prev.timestamp;
      if (gap > maxGap) { maxGap = gap; before = prev; after = cur; }
    }
    if (maxGap >= 2 * DAY_MS / 1000 && before && after) {
      const days = Math.floor(maxGap / 86400);
      const hours = Math.floor((maxGap % 86400) / 3600);
      const from = _dateTimeStr(before.timestamp, locale);
      const to = _dateTimeStr(after.timestamp, locale);
      const score = _scoreStr(scoreOf(after));
      facts.push({
        id: 'longest_break',
        icon: 'suitcase',
        big: `${_formatNumber(locale, days)} ${_unit(locale, 'analytics_unit_days', days)}`,
        textKey: 'analytics_fact_longest_break',
        vars: { from, to, score },
        rows: [
          ['analytics_fact_row_before', from],
          ['analytics_fact_row_after', `${to} · ${score}`],
          ['analytics_fact_row_gap', `${days} d ${hours} h`],
        ],
      });
    }
  }

  // ── quick_refill ──────────────────────────────────────────────────────
  {
    let minGap = Infinity;
    let first: FactShot | null = null;
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      if (!prev || !cur) continue;
      const gap = cur.timestamp - prev.timestamp;
      // Sub-10 s gaps are duplicate imports of one shot, not a real refill.
      if (gap >= 10 && gap < minGap) { minGap = gap; first = prev; }
    }
    if (first && minGap < 300) {
      const secs = Math.round(minGap);
      const dateTime = _dateTimeStr(first.timestamp, locale);
      facts.push({
        id: 'quick_refill',
        icon: 'bolt',
        big: `${_formatNumber(locale, secs)} ${_unit(locale, 'analytics_unit_seconds')}`,
        textKey: 'analytics_fact_quick_refill',
        vars: { date: dateTime },
        rows: [
          ['analytics_fact_row_date_time', dateTime],
          ['analytics_fact_row_gap', `${secs} s`],
        ],
      });
    }
  }

  // ── longest_shot ──────────────────────────────────────────────────────
  {
    let best: FactShot | null = null;
    let bestBrew = 0;
    for (const s of sorted) {
      const dur = s.duration;
      if (typeof dur !== 'number') continue;
      const brew = dur / 10;
      if (brew > bestBrew) { bestBrew = brew; best = s; }
    }
    if (best && bestBrew > 60) {
      const secs = Math.round(bestBrew);
      const sc = scoreOf(best);
      const dateTime = _dateTimeStr(best.timestamp, locale);
      facts.push({
        id: 'longest_shot',
        icon: 'snail',
        big: `${_formatNumber(locale, secs)} ${_unit(locale, 'analytics_unit_seconds')}`,
        textKey: 'analytics_fact_longest_shot',
        vars: { date: dateTime, score: _scoreStr(sc) },
        rows: [
          ['analytics_fact_row_date_time', dateTime],
          ['analytics_fact_row_brew_time', `${secs} s`],
          ['analytics_fact_row_score', _scoreStr(sc)],
        ],
      });
    }
  }

  return facts.length >= 3 ? facts : [];
}
