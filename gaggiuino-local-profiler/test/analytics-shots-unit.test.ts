import { describe, it, expect, beforeAll } from 'vitest';
import de from '../public-src/i18n/de.js';
import en from '../public-src/i18n/en.js';

// analytics.js's import chain reads localStorage/navigator at module load (same
// stubs as analytics-calendar-stats.test.js); _monthLabelsToDraw() itself is pure.
type Analytics = typeof import('../public-src/views/analytics.js');
let monthLabelsToDraw: Analytics['_monthLabelsToDraw'];

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
  ({ _monthLabelsToDraw: monthLabelsToDraw } = await import('../public-src/views/analytics.js'));
});

const unitOf = (dict: typeof de, n: number): string =>
  (dict.analytics_unit_shots as (n: number) => string)(n);

describe('analytics_unit_shots (#1543)', () => {
  it('prints the singular for a single shot in German and English', () => {
    expect(unitOf(de, 1)).toBe('Shot');
    expect(unitOf(en, 1)).toBe('shot');
  });

  it('prints the plural for several shots in German and English', () => {
    expect(unitOf(de, 2)).toBe('Shots');
    expect(unitOf(en, 2)).toBe('shots');
  });
});

describe('_monthLabelsToDraw (#1543)', () => {
  it('keeps every label when the months start far enough apart', () => {
    const kept = monthLabelsToDraw([
      { col: 0, label: 'Jan' }, { col: 4, label: 'Feb' }, { col: 9, label: 'Mär' },
    ]);
    expect(kept.map(m => m.label)).toEqual(['Jan', 'Feb', 'Mär']);
  });

  it('drops a label that starts too soon after the previous one', () => {
    // "MärApr": March's visible run is a single column, so April's short name
    // would draw over it.
    const kept = monthLabelsToDraw([{ col: 0, label: 'Mär' }, { col: 1, label: 'Apr' }]);
    expect(kept.map(m => m.label)).toEqual(['Mär']);
  });

  it('measures the gap from the last drawn label, not the skipped one', () => {
    // Apr is dropped; Mai at column 3 is still only two columns after Apr but
    // exactly three after the last drawn label (Mär), so it is kept.
    const kept = monthLabelsToDraw([
      { col: 0, label: 'Mär' }, { col: 1, label: 'Apr' }, { col: 3, label: 'Mai' },
    ]);
    expect(kept.map(m => m.label)).toEqual(['Mär', 'Mai']);
  });

  it('keeps the first month when it is the only one', () => {
    const kept = monthLabelsToDraw([{ col: 0, label: 'Dez' }]);
    expect(kept.map(m => m.label)).toEqual(['Dez']);
  });
});
