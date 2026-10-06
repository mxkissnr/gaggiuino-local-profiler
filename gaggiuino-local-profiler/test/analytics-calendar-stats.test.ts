import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

// analytics.js's import chain reads localStorage/navigator at module load and
// zrender's env detection wants a Node.js UA (same stubs as
// analytics-new-charts.test.js). computeCalendarStats() itself is pure.
type Analytics = typeof import('../public-src/views/analytics.js');
let computeCalendarStats: Analytics['computeCalendarStats'];
let renderStreaks: Analytics['_renderStreaks'];
type State = typeof import('../public-src/state/index.js');
let S: State['S'];

type ShotRow = Parameters<Analytics['computeCalendarStats']>[0][number];

beforeAll(async () => {
  Object.defineProperty(globalThis, 'localStorage', {
    value: { getItem: () => null, setItem: () => {} },
    configurable: true, writable: true,
  });
  Object.defineProperty(globalThis, 'navigator', {
    value: { language: 'en', userAgent: 'Node.js' },
    configurable: true, writable: true,
  });
  Object.defineProperty(globalThis, 'window', {
    value: { calcShotScore: () => null, getShotData: () => ({}) },
    configurable: true, writable: true,
  });
  ({ computeCalendarStats, _renderStreaks: renderStreaks } = await import('../public-src/views/analytics.js'));
  ({ S } = await import('../public-src/state/index.js'));
  S.currentLang = 'en';
});

// Local wall-clock timestamps, so the local-day bucketing under test matches
// what the view sees at runtime. Month is 1-based for readability.
function at(y: number, month: number, d: number, h = 12, mi = 0): number {
  return Math.floor(new Date(y, month - 1, d, h, mi, 0, 0).getTime() / 1000);
}

let _id = 0;
function shot(timestamp: number): ShotRow {
  _id++;
  return { id: _id, timestamp };
}

function scoreOf(map: Record<number, number>): (s: ShotRow) => number | null {
  return s => map[s.id] ?? null;
}

// computeCalendarStats() takes milliseconds (Date.now()), while the shots and
// `at()` above use Unix seconds.
const NOW = at(2026, 5, 20, 12, 0) * 1000; // 2026-05-20

describe('computeCalendarStats (#1467)', () => {
  // Deterministic ids so the score map below lines up per test.
  beforeEach(() => { _id = 0; });

  it('counts a current streak that ends yesterday', () => {
    const shots = [shot(at(2026, 5, 18)), shot(at(2026, 5, 19))];
    const stats = computeCalendarStats(shots, scoreOf({}), NOW);
    expect(stats.current).toBe(2);
    expect(stats.longest).toEqual({ len: 2, start: '2026-05-18', end: '2026-05-19' });
  });

  it('breaks the current streak on a gap', () => {
    const shots = [shot(at(2026, 5, 16)), shot(at(2026, 5, 18)), shot(at(2026, 5, 19))];
    const stats = computeCalendarStats(shots, scoreOf({}), NOW);
    expect(stats.current).toBe(2); // 18 + 19, the 16th is a separate day
  });

  it('reports the longest run with its start and end dates', () => {
    const shots = [
      shot(at(2026, 5, 1)), shot(at(2026, 5, 2)), shot(at(2026, 5, 3)), shot(at(2026, 5, 4)),
      shot(at(2026, 5, 10)), shot(at(2026, 5, 11)),
    ];
    const stats = computeCalendarStats(shots, scoreOf({}), NOW);
    expect(stats.longest).toEqual({ len: 4, start: '2026-05-01', end: '2026-05-04' });
  });

  it('finds the busiest day', () => {
    const shots = [
      shot(at(2026, 5, 12)), shot(at(2026, 5, 12, 14)), shot(at(2026, 5, 12, 18)),
      shot(at(2026, 5, 13)),
    ];
    const stats = computeCalendarStats(shots, scoreOf({}), NOW);
    expect(stats.busiest).toEqual({ day: '2026-05-12', count: 3 });
  });

  it('counts perfect shots and their share', () => {
    const shots = [shot(at(2026, 5, 1)), shot(at(2026, 5, 2)), shot(at(2026, 5, 3)), shot(at(2026, 5, 4))];
    const scores: Record<number, number> = { 1: 100, 2: 80, 3: 90, 4: 70 };
    const stats = computeCalendarStats(shots, scoreOf(scores), NOW);
    expect(stats.perfect).toBe(1);
    expect(stats.perfectShare).toBe(25);
  });

  it('attributes a late-evening shot to its local day', () => {
    const shots = [shot(at(2026, 5, 19, 23, 30))];
    const stats = computeCalendarStats(shots, scoreOf({}), NOW);
    expect(stats.current).toBe(1);
    expect(stats.longest).toEqual({ len: 1, start: '2026-05-19', end: '2026-05-19' });
  });

  it('returns zeroed figures with no shots', () => {
    const stats = computeCalendarStats([], scoreOf({}), NOW);
    expect(stats).toEqual({ current: 0, longest: null, busiest: null, perfect: 0, perfectShare: 0 });
  });
});

describe('_renderStreaks (#1467)', () => {
  it('shows the day count exactly once for a 15-day run', () => {
    const markup = renderStreaks(
      { current: 15, longest: null, busiest: null, perfect: 0, perfectShare: 0 },
      'en',
    );
    expect(markup.split('15')).toHaveLength(2); // "15" once -> one split point
  });
});
