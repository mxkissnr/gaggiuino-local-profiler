import { describe, it, expect, beforeAll } from 'vitest';

// analytics.js's import chain reads localStorage/navigator at module load and
// zrender's env detection wants a Node.js UA (same stubs as
// analytics-calendar-stats.test.js). computeRecipeSummary() and _trendAxisMin()
// themselves are pure.
type Analytics = typeof import('../public-src/views/analytics.js');
let computeRecipeSummary: Analytics['computeRecipeSummary'];
let trendAxisMin: Analytics['_trendAxisMin'];

type ShotRow = Parameters<Analytics['computeRecipeSummary']>[0][number];

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
  ({ computeRecipeSummary, _trendAxisMin: trendAxisMin } = await import('../public-src/views/analytics.js'));
});

interface ShotOverrides {
  dose?: number;
  weight?: number;
  duration?: number;
  grindSetting?: string | number;
}

// weight is the list row's final yield in tenths of a gram, duration in tenths
// of a second (both /10 to the displayed unit, as the rest of analytics does).
function shot(o: ShotOverrides): ShotRow {
  return {
    id: 1,
    timestamp: 0,
    duration: o.duration,
    weight: o.weight,
    annotation: { dose: o.dose, grindSetting: o.grindSetting },
  } as unknown as ShotRow;
}

describe('computeRecipeSummary (#1467)', () => {
  it('averages dose, yield and time and derives the ratio', () => {
    const r = computeRecipeSummary([
      shot({ dose: 18, weight: 360, duration: 300 }), // 18 g -> 36.0 g, 30.0 s
      shot({ dose: 19, weight: 380, duration: 320 }), // 19 g -> 38.0 g, 32.0 s
    ]);
    expect(r.dose).toBe(18.5);
    expect(r.yield).toBe(37);
    expect(r.ratio).toBe(2);
    expect(r.time).toBe(31);
  });

  it('rounds dose/yield to 0.1, the ratio to 0.1 and the time to whole seconds', () => {
    const r = computeRecipeSummary([
      shot({ dose: 18, weight: 361, duration: 305 }), // 36.1 g, 30.5 s
      shot({ dose: 18, weight: 362, duration: 306 }), // 36.2 g, 30.6 s
    ]);
    expect(r.dose).toBe(18);
    expect(r.yield).toBe(36.2); // 36.15 -> 36.2
    expect(r.ratio).toBe(2);    // 36.2 / 18 = 2.011 -> 2.0
    expect(r.time).toBe(31);    // 30.55 -> 31
  });

  it('builds one grind range from mixed string and number settings', () => {
    const r = computeRecipeSummary([
      shot({ grindSetting: '8' }),
      shot({ grindSetting: 11 }),
      shot({ grindSetting: '9.5 clicks' }),
    ]);
    expect(r.grindMin).toBe(8);
    expect(r.grindMax).toBe(11);
  });

  it('reports a single grind value when every setting is the same', () => {
    const r = computeRecipeSummary([shot({ grindSetting: 9 }), shot({ grindSetting: '9' })]);
    expect(r.grindMin).toBe(9);
    expect(r.grindMax).toBe(9);
  });

  it('returns null for every missing field', () => {
    const r = computeRecipeSummary([shot({}), shot({})]);
    expect(r).toEqual({ dose: null, yield: null, ratio: null, time: null, grindMin: null, grindMax: null });
  });

  it('skips zero dose/yield/time instead of averaging them in', () => {
    const r = computeRecipeSummary([
      shot({ dose: 18, weight: 360, duration: 300 }),
      shot({ dose: 0, weight: 0, duration: 0 }),
    ]);
    expect(r.dose).toBe(18);
    expect(r.yield).toBe(36);
    expect(r.time).toBe(30);
  });
});

describe('_trendAxisMin (#1467)', () => {
  it('drops 5 below the minimum and floors to a multiple of 5', () => {
    expect(trendAxisMin([79, 95])).toBe(70);
    expect(trendAxisMin([96])).toBe(90);
    expect(trendAxisMin([70])).toBe(65);
  });

  it('never goes below 0', () => {
    expect(trendAxisMin([3])).toBe(0);
  });

  it('stays at 0 for an empty window', () => {
    expect(trendAxisMin([])).toBe(0);
  });
});
