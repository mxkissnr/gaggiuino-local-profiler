import { describe, it, expect, beforeAll } from 'vitest';
import de from '../public-src/i18n/de.js';
import en from '../public-src/i18n/en.js';

// analytics.ts's import chain reads localStorage/navigator at module load (same
// stubs as analytics-calendar-stats.test.ts); _monthLabelsToDraw() itself is pure.
type Analytics = typeof import('../public-src/views/analytics.js');
let monthLabelsToDraw: Analytics['_monthLabelsToDraw'];
type Calendar = typeof import('../public-src/views/analytics/calendar.js');
let calendarWindow: Calendar['_calendarWindow'];

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
  ({ _calendarWindow: calendarWindow } = await import('../public-src/views/analytics/calendar.js'));
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

describe('_calendarWindow (#2214)', () => {
  const year = Array.from({ length: 53 }, (_, i) => i);

  it('shows every week as one page from 900 px up', () => {
    for (const width of [900, 1280]) {
      const win = calendarWindow(year, width, width === 900 ? 3 : 0);
      expect(win.weeks).toHaveLength(53);
      expect(win.weeks[0]).toBe(0);
      expect(win.weeks[52]).toBe(52);
      expect(win.page).toBe(0);
      expect(win.pages).toBe(1);
      expect(win.weeks).not.toBe(year);
    }
  });

  it('shows the newest 22 weeks on page 0 below 900 px', () => {
    for (const width of [390, 899]) {
      const win = calendarWindow(year, width, 0);
      expect(win.weeks[0]).toBe(31);
      expect(win.weeks[21]).toBe(52);
      expect(win.weeks).toHaveLength(22);
      expect(win.page).toBe(0);
      expect(win.pages).toBe(3);
    }
  });

  it('steps 22 weeks back per page', () => {
    const win = calendarWindow(year, 390, 1);
    expect(win.weeks).toHaveLength(22);
    expect(win.weeks[0]).toBe(9);
    expect(win.weeks[21]).toBe(30);
  });

  it('fills the oldest page with the first 22 weeks', () => {
    const win = calendarWindow(year, 390, 2);
    expect(win.weeks[0]).toBe(0);
    expect(win.weeks[21]).toBe(21);
    expect(win.page).toBe(2);
  });

  it('clamps a page outside the range', () => {
    const newest = calendarWindow(year, 390, 0);
    const oldest = calendarWindow(year, 390, 2);
    const tooFar = calendarWindow(year, 390, 9);
    expect(tooFar.page).toBe(2);
    expect(tooFar.weeks).toEqual(oldest.weeks);
    const tooEarly = calendarWindow(year, 390, -1);
    expect(tooEarly.page).toBe(0);
    expect(tooEarly.weeks).toEqual(newest.weeks);
  });

  it('keeps a short history on one page', () => {
    const short = Array.from({ length: 10 }, (_, i) => i);
    const win = calendarWindow(short, 390, 0);
    expect(win.weeks).toEqual(short);
    expect(win.pages).toBe(1);
    expect(calendarWindow([], 390, 0)).toEqual({ weeks: [], page: 0, pages: 1 });
  });
});
