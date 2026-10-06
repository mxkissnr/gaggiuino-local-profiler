import type { ShotMeta } from '../state/index.js';

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

function _dateStr(tsSeconds: number): string {
  const d = new Date(tsSeconds * 1000);
  return `${d.getFullYear()}-${_pad2(d.getMonth() + 1)}-${_pad2(d.getDate())}`;
}

function _dateTimeStr(tsSeconds: number): string {
  return `${_dateStr(tsSeconds)} ${_timeStr(tsSeconds)}`;
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
      const fact: Fact = {
        id: 'odd_hour',
        icon: 'moon',
        big: _timeStr(bestShot.timestamp),
        textKey: 'analytics_fact_odd_hour',
        vars: { date: _dateTimeStr(bestShot.timestamp), score: _scoreStr(sc) },
        rows: [
          ['analytics_fact_row_date_time', _dateTimeStr(bestShot.timestamp)],
          ['analytics_fact_row_score', _scoreStr(sc)],
          ['analytics_fact_row_usually', _hourSpan(_percentile(mins, 0.1), _percentile(mins, 0.9))],
        ],
      };
      if (hour >= 22 || hour < 5) fact.night = true;
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
      facts.push({
        id: 'night_round',
        icon: 'cups',
        big: String(bestGroup.length),
        textKey: 'analytics_fact_night_round',
        vars: { count: bestGroup.length, date: bestKey },
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
        vars: { date: _dateTimeStr(first.timestamp), score: 100 },
        rows: [
          ['analytics_fact_row_date_time', _dateTimeStr(first.timestamp)],
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
        big: String(bestRun),
        textKey: 'analytics_fact_hundred_run',
        vars: { len: bestRun, from: _dateStr(bestStart.timestamp), to: _dateStr(bestEnd.timestamp) },
        rows: [
          ['analytics_fact_row_run_length', String(bestRun)],
          ['analytics_fact_row_first', _dateStr(bestStart.timestamp)],
          ['analytics_fact_row_last', _dateStr(bestEnd.timestamp)],
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
        big: String(Math.round(avgOf(bestWd))),
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
      const toNext = rem === 0 ? 0 : Math.ceil((10000 - rem) / avgG);
      facts.push({
        id: 'total_yield',
        icon: 'jug',
        big: litres.toFixed(1),
        textKey: 'analytics_fact_total_yield',
        vars: { litres: litres.toFixed(1), grams: Math.round(grams), shots: nShots, avg: avgG.toFixed(1), toNext },
        rows: [
          ['analytics_fact_row_total_grams', `${Math.round(grams)} g`],
          ['analytics_fact_row_avg_grams', `${avgG.toFixed(1)} g`],
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
      facts.push({
        id: 'total_time',
        icon: 'film',
        big: String(minutes),
        textKey: seconds >= 5400 ? 'analytics_fact_total_time_movie' : 'analytics_fact_total_time',
        vars: { minutes, avg: (seconds / nShots).toFixed(1) },
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
      facts.push({
        id: 'longest_break',
        icon: 'suitcase',
        big: String(days),
        textKey: 'analytics_fact_longest_break',
        vars: { days, hours, from: _dateTimeStr(before.timestamp), to: _dateTimeStr(after.timestamp) },
        rows: [
          ['analytics_fact_row_before', _dateTimeStr(before.timestamp)],
          ['analytics_fact_row_after', `${_dateTimeStr(after.timestamp)} · ${_scoreStr(scoreOf(after))}`],
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
      if (gap < minGap) { minGap = gap; first = prev; }
    }
    if (first && minGap < 300) {
      const secs = Math.round(minGap);
      facts.push({
        id: 'quick_refill',
        icon: 'bolt',
        big: String(secs),
        textKey: 'analytics_fact_quick_refill',
        vars: { seconds: secs, date: _dateTimeStr(first.timestamp) },
        rows: [
          ['analytics_fact_row_date_time', _dateTimeStr(first.timestamp)],
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
      facts.push({
        id: 'longest_shot',
        icon: 'snail',
        big: String(secs),
        textKey: 'analytics_fact_longest_shot',
        vars: { seconds: secs, date: _dateTimeStr(best.timestamp), score: _scoreStr(sc) },
        rows: [
          ['analytics_fact_row_date_time', _dateTimeStr(best.timestamp)],
          ['analytics_fact_row_brew_time', `${secs} s`],
          ['analytics_fact_row_score', _scoreStr(sc)],
        ],
      });
    }
  }

  return facts.length >= 3 ? facts : [];
}
