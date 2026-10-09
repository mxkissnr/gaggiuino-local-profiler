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

  it('measures the gap from the last drawn label, not a skipped one', () => {
    // Apr is dropped; Mai at column 3 is still only two columns after Apr but
    // exactly three after the last drawn label (Mär), so it is kept.
    const kept = monthLabelsToDraw([
      { col: 0, label: 'Mär' }, { col: 1, label: 'Apr' }, { col: 3, label: 'Mai' },
    ]);
    expect(kept.map(m => m.label)).toEqual(['Mär', 'Mai']);
  });

  it('always keeps the last visible month, dropping the label that collides', () => {
    // "MärApr": March's visible run is a single column, so April's short name
    // would draw over it — the last month keeps its label, March gives way.
    const kept = monthLabelsToDraw([{ col: 0, label: 'Mär' }, { col: 1, label: 'Apr' }]);
    expect(kept.map(m => m.label)).toEqual(['Apr']);
  });

  it('drops a middle label when the last month starts right after it', () => {
    // Nov (column 10) collides with the last month, Dez (column 11), so Nov
    // gives way; Jan (column 0) is far enough from Dez to stay.
    const kept = monthLabelsToDraw([
      { col: 0, label: 'Jan' }, { col: 10, label: 'Nov' }, { col: 11, label: 'Dez' },
    ]);
    expect(kept.map(m => m.label)).toEqual(['Jan', 'Dez']);
  });

  it('keeps the only month when it is also the first', () => {
    const kept = monthLabelsToDraw([{ col: 0, label: 'Dez' }]);
    expect(kept.map(m => m.label)).toEqual(['Dez']);
  });
});
