import { describe, it, expect, beforeAll } from 'vitest';

// Same harness as analytics-new-charts.test.js: analytics.js pulls in
// state.js/i18n.js (localStorage/navigator at module load) and calls
// window.calcShotScore at runtime, so stub a minimal scoring window.
type Analytics = typeof import('../public-src/views/analytics.js');
let _computeBeanRanking: Analytics['_computeBeanRanking'];
let _sortBeanShelfRows: Analytics['_sortBeanShelfRows'];

type ShotRow = Parameters<Analytics['_computeBeanRanking']>[0][number];
type BeanRankRow = ReturnType<Analytics['_computeBeanRanking']>[number];

interface ShotOverrides {
  timestamp?: number | undefined;
  duration?: number | undefined;
  score?: number | undefined;
  coffee?: string | null | undefined;
  beanId?: number | null | undefined;
  grindSetting?: string | number | null | undefined;
}

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
    value: {
      calcShotScore: (shot: ShotRow) => shot.score ?? null,
      getShotData: () => ({}),
    },
    configurable: true, writable: true,
  });
  ({ _computeBeanRanking, _sortBeanShelfRows } = await import('../public-src/views/analytics.js'));
});

const shot = (overrides: ShotOverrides = {}): ShotRow => ({
  id: overrides.timestamp ?? 1,
  timestamp: overrides.timestamp ?? 0,
  duration: overrides.duration ?? 280,
  score: overrides.score,
  annotation: { coffee: overrides.coffee, beanId: overrides.beanId, grindSetting: overrides.grindSetting },
});

const row = (o: Partial<BeanRankRow> & { name: string }): BeanRankRow => ({
  name: o.name,
  beanId: o.beanId ?? null,
  shots: o.shots ?? 1,
  avgScore: o.avgScore ?? null,
  best: o.best ?? null,
  hundreds: o.hundreds ?? 0,
  avgTime: o.avgTime ?? null,
  firstGood: o.firstGood ?? null,
  lastGrind: o.lastGrind ?? null,
  trend: o.trend ?? null,
});

describe('_computeBeanRanking shelf fields (#1467)', () => {
  it('takes beanId from the most recent shot, null when it carries none', () => {
    const withIds = _computeBeanRanking([
      shot({ coffee: 'A', timestamp: 1, beanId: 7 }),
      shot({ coffee: 'A', timestamp: 2, beanId: 9 }),
      shot({ coffee: 'A', timestamp: 3 }),
    ]);
    expect(withIds[0]?.beanId).toBeNull();

    const older = _computeBeanRanking([
      shot({ coffee: 'B', timestamp: 1, beanId: 7 }),
      shot({ coffee: 'B', timestamp: 2, beanId: 4 }),
    ]);
    expect(older[0]?.beanId).toBe(4);
  });

  it('reports best score, 100-count and the first ≥ 80 shot number', () => {
    const rows = _computeBeanRanking([
      shot({ coffee: 'A', timestamp: 1, score: 50 }),
      shot({ coffee: 'A', timestamp: 2, score: 70 }),
      shot({ coffee: 'A', timestamp: 3, score: 82 }),
      shot({ coffee: 'A', timestamp: 4, score: 100 }),
      shot({ coffee: 'A', timestamp: 5, score: 100 }),
    ]);
    expect(rows[0]?.best).toBe(100);
    expect(rows[0]?.hundreds).toBe(2);
    expect(rows[0]?.firstGood).toBe(3);
  });

  it('leaves best and firstGood null when nothing scored', () => {
    const rows = _computeBeanRanking([
      shot({ coffee: 'A', timestamp: 1 }),
      shot({ coffee: 'A', timestamp: 2 }),
    ]);
    expect(rows[0]?.best).toBeNull();
    expect(rows[0]?.hundreds).toBe(0);
    expect(rows[0]?.firstGood).toBeNull();
  });

  it('averages brew time ignoring shots of 5 s or less', () => {
    const rows = _computeBeanRanking([
      shot({ coffee: 'A', timestamp: 1, duration: 280 }),
      shot({ coffee: 'A', timestamp: 2, duration: 320 }),
      shot({ coffee: 'A', timestamp: 3, duration: 10 }), // 1 s — ignored
      shot({ coffee: 'A', timestamp: 4, duration: 40 }), // 4 s — ignored
    ]);
    expect(rows[0]?.avgTime).toBe(30);
  });

  it('leaves avgTime null when every shot is too short', () => {
    const rows = _computeBeanRanking([
      shot({ coffee: 'A', timestamp: 1, duration: 30 }),
      shot({ coffee: 'A', timestamp: 2, duration: 50 }),
    ]);
    expect(rows[0]?.avgTime).toBeNull();
  });
});

describe('_sortBeanShelfRows (#1467)', () => {
  it('sorts by score descending with nulls last, ties by shot count', () => {
    const sorted = _sortBeanShelfRows([
      row({ name: 'A', avgScore: 90, shots: 2 }),
      row({ name: 'B', avgScore: null, shots: 5 }),
      row({ name: 'C', avgScore: 90, shots: 4 }),
      row({ name: 'D', avgScore: 70, shots: 1 }),
    ], 'score');
    expect(sorted.map(r => r.name)).toEqual(['C', 'A', 'D', 'B']);
  });

  it('sorts by shot count descending, score breaking ties', () => {
    const sorted = _sortBeanShelfRows([
      row({ name: 'A', avgScore: 90, shots: 2 }),
      row({ name: 'B', avgScore: null, shots: 5 }),
      row({ name: 'C', avgScore: 80, shots: 4 }),
      row({ name: 'D', avgScore: 70, shots: 5 }),
    ], 'shots');
    expect(sorted.map(r => r.name)).toEqual(['D', 'B', 'C', 'A']);
  });

  it('does not mutate the input array', () => {
    const rows = [row({ name: 'A', avgScore: 50 }), row({ name: 'B', avgScore: 90 })];
    _sortBeanShelfRows(rows, 'score');
    expect(rows.map(r => r.name)).toEqual(['A', 'B']);
  });
});
