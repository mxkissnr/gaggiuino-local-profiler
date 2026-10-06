import type { ShotMeta } from '../state/index.js';

// Same metadata-only shot view as views/analytics.ts's ShotRow: only the
// annotation id/name and the profile name are read, scores come from the
// caller through scoreOf so the aggregation stays pure.
export interface SummaryShot extends ShotMeta {
  profileName?: string | null;
  profile?: { name?: string | null } | null;
  // `| undefined` mirrors views/analytics.ts's ShotAnnotation so its ShotRow
  // stays assignable here under exactOptionalPropertyTypes.
  annotation?: {
    beanId?: number | null | undefined;
    coffee?: string | null | undefined;
  } | null;
}

function _pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

// Local calendar date. toISOString() is UTC and shifts a late-evening shot
// into the next day.
function _localKey(d: Date): string {
  return `${d.getFullYear()}-${_pad2(d.getMonth() + 1)}-${_pad2(d.getDate())}`;
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
  shots: readonly SummaryShot[],
  scoreOf: (shot: SummaryShot) => number | null,
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
