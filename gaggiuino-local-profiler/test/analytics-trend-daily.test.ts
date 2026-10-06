import { describe, it, expect, beforeAll } from 'vitest';

// analytics.js pulls in state.js/i18n.js (localStorage/navigator at module
// load) and zrender's env detection wants a Node.js UA — the same stubs the
// other analytics tests use. trendDailyBand() and isLongTrendPeriod() are pure.
type Analytics = typeof import('../public-src/views/analytics.js');
let trendDailyBand: Analytics['trendDailyBand'];
let isLongTrendPeriod: Analytics['isLongTrendPeriod'];

type ShotRow = Parameters<Analytics['trendDailyBand']>[0][number];

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
  ({ trendDailyBand, isLongTrendPeriod } = await import('../public-src/views/analytics.js'));
});

// Local wall-clock timestamps at 08:00 so _dayKeyOf() (which reads local
// calendar fields) lands unambiguously on the intended day.
function ts(y: number, m: number, d: number, h = 8): number {
  return new Date(y, m - 1, d, h).getTime() / 1000;
}
function shot(timestamp: number, score: number | null): ShotRow {
  return { id: 1, timestamp, score };
}
const scoreOf = (s: ShotRow): number | null => (typeof s.score === 'number' ? s.score : null);

describe('trendDailyBand (#1490)', () => {
  it('gives one entry per calendar day with a 7-day rolling mean, min and max', () => {
    const band = trendDailyBand([shot(ts(2024, 1, 10), 80), shot(ts(2024, 1, 11), 90)], scoreOf);
    expect(band.keys).toEqual(['2024-01-10', '2024-01-11']);
    expect(band.mean).toEqual([80, 85]);
    expect(band.min).toEqual([80, 80]);
    expect(band.max).toEqual([80, 90]);
  });

  it('nulls the window on days with no shot in it', () => {
    // A shot on the 1st and the next on the 10th: the seven-day window slides
    // off the first shot on the 8th, so the 8th, 9th and 10th are all gaps.
    const band = trendDailyBand([shot(ts(2024, 3, 1), 70), shot(ts(2024, 3, 10), 90)], scoreOf);
    expect(band.keys.length).toBe(10);
    expect(band.mean[6]).toBe(70);   // 7 Mar: window 1–7 Mar still holds the shot
    expect(band.mean[7]).toBeNull(); // 8 Mar: window 2–8 Mar holds none
    expect(band.mean[9]).toBeNull();
    expect(band.min[7]).toBeNull();
    expect(band.max[9]).toBeNull();
  });

  it('walks every calendar day across a month boundary with local day keys', () => {
    const band = trendDailyBand([shot(ts(2024, 1, 30), 60), shot(ts(2024, 2, 2), 100)], scoreOf);
    expect(band.keys).toEqual(['2024-01-30', '2024-01-31', '2024-02-01', '2024-02-02']);
  });

  it('keeps a late-evening shot on its own local day', () => {
    const late = new Date(2024, 0, 31, 23, 30).getTime() / 1000;
    const band = trendDailyBand([shot(late, 88)], scoreOf);
    expect(band.keys).toEqual(['2024-01-31']);
  });

  it('is empty for no scored shots', () => {
    expect(trendDailyBand([], scoreOf)).toEqual({ keys: [], mean: [], min: [], max: [] });
    expect(trendDailyBand([shot(ts(2024, 1, 1), null)], scoreOf).keys).toEqual([]);
  });
});

describe('isLongTrendPeriod (#1490)', () => {
  it('selects the daily view for 90 days and the whole history only', () => {
    expect(isLongTrendPeriod(90)).toBe(true);
    expect(isLongTrendPeriod(0)).toBe(true);
    expect(isLongTrendPeriod(7)).toBe(false);
    expect(isLongTrendPeriod(30)).toBe(false);
  });
});
