import { describe, it, expect } from 'vitest';
import { summaryLine, type SummaryShot } from '../public-src/views/analytics-summary.js';

// Local wall-clock timestamp, so the local-date bucketing under test matches
// what the builders see at runtime.
function ts(y: number, month: number, d: number, h = 12, mi = 0): number {
  return Math.floor(new Date(y, month, d, h, mi, 0, 0).getTime() / 1000);
}

interface ShotOverrides {
  id: number;
  timestamp: number;
  beanId?: number;
  coffee?: string;
}

function shot(o: ShotOverrides): SummaryShot {
  const s: SummaryShot = { id: o.id, timestamp: o.timestamp };
  if (o.beanId !== undefined || o.coffee !== undefined) {
    s.annotation = { beanId: o.beanId ?? null, coffee: o.coffee ?? null };
  }
  return s;
}

function scoreById(scores: Record<number, number>): (s: SummaryShot) => number | null {
  return s => scores[s.id] ?? null;
}

describe('summaryLine', () => {
  // 2024-03-20 12:00 local: the 30-day window opens 2024-02-19, the 7-day
  // window 2024-03-13, both at 12:00.
  const now = ts(2024, 2, 20, 12) * 1000;

  function line(shots: SummaryShot[], scores: Record<number, number>) {
    return summaryLine(shots, scoreById(scores), now);
  }

  it('verdict counts every 30-day shot but averages only the scored ones', () => {
    const shots = [
      shot({ id: 1, timestamp: ts(2024, 2, 1) }),   // in the 30-day window
      shot({ id: 2, timestamp: ts(2024, 2, 5) }),   // in the 30-day window, unscored
      shot({ id: 3, timestamp: ts(2024, 0, 1) }),   // too old
    ];
    const v = line(shots, { 1: 80, 3: 100 }).verdict;
    expect(v.shots).toBe(2);
    expect(v.avgScore).toBe(80);
  });

  it('verdict average is null without a scored shot in the last 30 days', () => {
    const v = line([shot({ id: 1, timestamp: ts(2024, 2, 1) })], {}).verdict;
    expect(v.shots).toBe(1);
    expect(v.avgScore).toBeNull();
  });

  it('buckets the last-7-day average against the 30-day average', () => {
    const all = [
      shot({ id: 1, timestamp: ts(2024, 2, 1) }),      // older than 7 days
      shot({ id: 2, timestamp: ts(2024, 2, 1, 14) }),  // older than 7 days
      shot({ id: 3, timestamp: ts(2024, 2, 15) }),     // last 7 days
      shot({ id: 4, timestamp: ts(2024, 2, 15, 14) }),
      shot({ id: 5, timestamp: ts(2024, 2, 15, 18) }),
    ];
    expect(line(all, { 1: 70, 2: 70, 3: 95, 4: 95, 5: 95 }).delta).toEqual({ bucket: 'well-above', avg7: 95 });
    expect(line(all, { 1: 78, 2: 78, 3: 82, 4: 82, 5: 82 }).delta).toEqual({ bucket: 'above', avg7: 82 });
    expect(line(all, { 1: 80, 2: 80, 3: 81, 4: 80, 5: 79 }).delta).toEqual({ bucket: 'on-par', avg7: 80 });
    expect(line(all, { 1: 84, 2: 84, 3: 76, 4: 76, 5: 76 }).delta).toEqual({ bucket: 'below', avg7: 76 });
    expect(line(all, { 1: 90, 2: 90, 3: 70, 4: 70, 5: 70 }).delta).toEqual({ bucket: 'well-below', avg7: 70 });
  });

  it('leaves delta null with fewer than 3 scored shots in the last 7 days', () => {
    const old = shot({ id: 1, timestamp: ts(2024, 2, 1) });
    const solo = shot({ id: 2, timestamp: ts(2024, 2, 15) });
    const two = [solo, shot({ id: 3, timestamp: ts(2024, 2, 16) })];
    // One recent scored shot, then two: both stay below the 3-shot floor.
    expect(line([old, solo], { 1: 70, 2: 95 }).delta).toBeNull();
    expect(line([old, ...two], { 1: 70, 2: 95, 3: 95 }).delta).toBeNull();
    // The third recent scored shot crosses the floor (avg30 89, avg7 95).
    const three = [...two, shot({ id: 4, timestamp: ts(2024, 2, 17) })];
    expect(line([old, ...three], { 1: 70, 2: 95, 3: 95, 4: 95 }).delta).toEqual({ bucket: 'well-above', avg7: 95 });
  });

  it('picks the best bean with at least 2 scored shots in the last 30 days', () => {
    const shots = [
      shot({ id: 1, timestamp: ts(2024, 2, 1), beanId: 1, coffee: 'Alpha' }), // 1 shot, avg 100
      shot({ id: 2, timestamp: ts(2024, 2, 2), beanId: 2, coffee: 'Beta' }),  // 2 shots, avg 90
      shot({ id: 3, timestamp: ts(2024, 2, 3), beanId: 2, coffee: 'Beta' }),
    ];
    const ctx = line(shots, { 1: 100, 2: 90, 3: 90 }).context;
    expect(ctx).toEqual({ name: 'Beta', avgScore: 90 });
  });

  it('leaves context null when no bean reaches 2 scored shots', () => {
    const shots = [
      shot({ id: 1, timestamp: ts(2024, 2, 1), beanId: 1, coffee: 'Alpha' }),
      shot({ id: 2, timestamp: ts(2024, 2, 2), beanId: 2, coffee: 'Beta' }),
    ];
    expect(line(shots, { 1: 100, 2: 95 }).context).toBeNull();
  });

  it('counts a streak that ends yesterday', () => {
    const shots = [
      shot({ id: 1, timestamp: ts(2024, 2, 17) }),
      shot({ id: 2, timestamp: ts(2024, 2, 18) }),
      shot({ id: 3, timestamp: ts(2024, 2, 19) }), // yesterday
    ];
    const s = line(shots, {});
    expect(s.streak).toBe(3);
    expect(s.streakNote).toBe(false);
  });

  it('breaks the streak on a gap and ignores a last shot older than yesterday', () => {
    const gapped = [
      shot({ id: 1, timestamp: ts(2024, 2, 15) }),
      shot({ id: 2, timestamp: ts(2024, 2, 18) }),
      shot({ id: 3, timestamp: ts(2024, 2, 19) }), // yesterday; 17th is the gap
    ];
    expect(line(gapped, {}).streak).toBe(2);

    const stale = [
      shot({ id: 1, timestamp: ts(2024, 2, 16) }),
      shot({ id: 2, timestamp: ts(2024, 2, 17) }),
    ];
    expect(line(stale, {}).streak).toBe(0);
  });

  it('flags a streak note at 7 days or more', () => {
    const shots = Array.from({ length: 7 }, (_, i) =>
      shot({ id: i + 1, timestamp: ts(2024, 2, 14 + i) }));
    const s = line(shots, {});
    expect(s.streak).toBe(7);
    expect(s.streakNote).toBe(true);
  });
});
