import { describe, it, expect, beforeAll } from 'vitest';

// grind.js pulls in state.js (localStorage/navigator at module load) and
// i18n.js — neither is available in the plain Node test environment, so
// stub the minimum before importing, same approach as share-or-download.test.js.
let calcBestGrindCombosForBean;

beforeAll(async () => {
  Object.defineProperty(globalThis, 'localStorage', {
    value: { getItem: () => null, setItem: () => {} },
    configurable: true, writable: true,
  });
  Object.defineProperty(globalThis, 'navigator', {
    value: { language: 'en' },
    configurable: true, writable: true,
  });
  ({ calcBestGrindCombosForBean } = await import('../public-src/views/shots/grind.js'));
});

// Shots carry a pre-computed .score (server-side), which calcShotScore()
// in shots/utils.js prefers over recomputing — so tests just set .score
// directly instead of faking datapoints.
const shot = (coffee, grinder, grindSetting, score) => ({
  annotation: { coffee, grinder, grindSetting },
  score,
});

describe('calcBestGrindCombosForBean', () => {
  it('returns null when the bean has no shots', () => {
    expect(calcBestGrindCombosForBean('Nonexistent Bean', [])).toBeNull();
    expect(calcBestGrindCombosForBean('Nonexistent Bean', [shot('Other Bean', 'Niche Zero', '18', 90)])).toBeNull();
  });

  it('returns null below the minimum sample size for every combo', () => {
    const shots = [
      shot('Bean A', 'Niche Zero', '18', 90),
      shot('Bean A', 'Niche Zero', '18', 88),
    ];
    expect(calcBestGrindCombosForBean('Bean A', shots)).toBeNull();
  });

  it('computes avg score and shot count for a single grinder+grind cluster', () => {
    const uniform = [
      shot('Bean A', 'Niche Zero', '18', 90),
      shot('Bean A', 'Niche Zero', '18', 80),
      shot('Bean A', 'Niche Zero', '18', 88),
    ];
    const result = calcBestGrindCombosForBean('bean a', uniform); // case-insensitive
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ grinder: 'Niche Zero', grindSetting: 18, shotCount: 3 });
    expect(result[0].avgScore).toBe(Math.round((90 + 80 + 88) / 3));
  });

  it('picks the best-scoring grind setting among several for the same grinder', () => {
    const shots = [
      shot('Bean A', 'Niche Zero', '16', 60),
      shot('Bean A', 'Niche Zero', '16', 62),
      shot('Bean A', 'Niche Zero', '16', 58),
      shot('Bean A', 'Niche Zero', '18', 95),
      shot('Bean A', 'Niche Zero', '18', 93),
      shot('Bean A', 'Niche Zero', '18', 97),
    ];
    const result = calcBestGrindCombosForBean('Bean A', shots);
    expect(result[0]).toMatchObject({ grinder: 'Niche Zero', grindSetting: 18 });
    expect(result[0].avgScore).toBe(95);
  });

  it('ranks combos across multiple grinders best-first', () => {
    const shots = [
      shot('Bean A', 'Niche Zero', '18', 70),
      shot('Bean A', 'Niche Zero', '18', 72),
      shot('Bean A', 'Niche Zero', '18', 68),
      shot('Bean A', 'DF64', '20', 90),
      shot('Bean A', 'DF64', '20', 92),
      shot('Bean A', 'DF64', '20', 94),
    ];
    const result = calcBestGrindCombosForBean('Bean A', shots);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ grinder: 'DF64', grindSetting: 20, avgScore: 92 });
    expect(result[1]).toMatchObject({ grinder: 'Niche Zero', grindSetting: 18, avgScore: 70 });
  });

  it('ignores shots without a parseable grind setting or grinder', () => {
    const shots = [
      shot('Bean A', 'Niche Zero', '18', 90),
      shot('Bean A', 'Niche Zero', '18', 88),
      shot('Bean A', 'Niche Zero', '18', 92),
      { annotation: { coffee: 'Bean A', grinder: '', grindSetting: '18' }, score: 99 },
      { annotation: { coffee: 'Bean A', grinder: 'Niche Zero', grindSetting: '' }, score: 99 },
    ];
    const result = calcBestGrindCombosForBean('Bean A', shots);
    expect(result).toHaveLength(1);
    expect(result[0].shotCount).toBe(3);
  });
});
