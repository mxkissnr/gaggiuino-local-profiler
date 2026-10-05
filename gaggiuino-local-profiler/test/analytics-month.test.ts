import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { MonthDay, MonthShot } from '../public-src/views/analytics-month.js';

// Same window/localStorage stubbing as analytics-equipment-stats.test.ts:
// the module pulls in state/index.js, which reads localStorage at load, so the
// real module is imported dynamically after the stub is in place.
type MonthModule = typeof import('../public-src/views/analytics-month.js');
let buildMonthDays: MonthModule['buildMonthDays'];
let dotSize: MonthModule['dotSize'];
let shiftMonth: MonthModule['shiftMonth'];
let summaryLine: MonthModule['summaryLine'];
let beanHasPhoto: MonthModule['beanHasPhoto'];
let cellKind: MonthModule['cellKind'];
let dayCellHtml: MonthModule['dayCellHtml'];

beforeAll(async () => {
  Object.defineProperty(globalThis, 'localStorage', {
    value: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    configurable: true, writable: true,
  });
  Object.defineProperty(globalThis, 'window', {
    value: {},
    configurable: true, writable: true,
  });
  ({ buildMonthDays, dotSize, shiftMonth, summaryLine, beanHasPhoto, cellKind, dayCellHtml } = await import('../public-src/views/analytics-month.js'));
});

function at<T>(arr: readonly T[], i: number): T {
  const v = arr[i];
  if (v === undefined) throw new Error(`missing element at index ${i}`);
  return v;
}

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

function shot(o: ShotOverrides): MonthShot {
  const s: MonthShot = { id: o.id, timestamp: o.timestamp };
  if (o.beanId !== undefined || o.coffee !== undefined) {
    s.annotation = { beanId: o.beanId ?? null, coffee: o.coffee ?? null };
  }
  return s;
}

const noScore = (): number | null => null;
function scoreById(scores: Record<number, number>): (s: MonthShot) => number | null {
  return s => scores[s.id] ?? null;
}

function day(days: MonthDay[], key: string): MonthDay {
  const d = days.find(x => x.key === key);
  if (!d) throw new Error(`missing day ${key}`);
  return d;
}

describe('dotSize', () => {
  it('maps 1 / 2 / 3+ shots to s / m / l', () => {
    expect(dotSize(0)).toBe('s');
    expect(dotSize(1)).toBe('s');
    expect(dotSize(2)).toBe('m');
    expect(dotSize(3)).toBe('l');
    expect(dotSize(12)).toBe('l');
  });
});

describe('beanHasPhoto', () => {
  it('is false for an unknown bean id', () => {
    expect(beanHasPhoto([{ id: 1, image: 'jpg' }], 2)).toBe(false);
  });
  it('is false for a bean without a stored photo', () => {
    const beans = [{ id: 1 }, { id: 2, image: null }];
    expect(beanHasPhoto(beans, 1)).toBe(false);
    expect(beanHasPhoto(beans, 2)).toBe(false);
  });
  it('is true for a bean with a stored photo', () => {
    expect(beanHasPhoto([{ id: 1 }, { id: 2, image: 'jpg' }], 2)).toBe(true);
  });
  it('is false without a bean list', () => {
    expect(beanHasPhoto(undefined, 1)).toBe(false);
  });
});

describe('shiftMonth', () => {
  it('moves across year boundaries in both directions', () => {
    expect(shiftMonth(2024, 11, 1)).toEqual([2025, 0]);
    expect(shiftMonth(2024, 0, -1)).toEqual([2023, 11]);
    expect(shiftMonth(2024, 5, 0)).toEqual([2024, 5]);
  });
});

describe('buildMonthDays', () => {
  it('pads the month to full Monday-first weeks', () => {
    // January 2024 starts on a Monday and has 31 days -> 4 whole weeks plus
    // 3 days, padded to exactly 5 weeks (4 trailing cells).
    const days = buildMonthDays([], 2024, 0, noScore);
    expect(days.length).toBe(35);
    expect(at(days, 0).day).toBe(1);
    expect(at(days, 0).outside).toBe(false);
    expect(at(days, 30).day).toBe(31);
    expect(at(days, 30).outside).toBe(false);
    expect(at(days, 31).outside).toBe(true);

    // September 2024 starts on a Sunday: 6 leading padding days, 42 cells.
    const sep = buildMonthDays([], 2024, 8, noScore);
    expect(sep.length).toBe(42);
    expect(at(sep, 5).outside).toBe(true);
    expect(at(sep, 6).day).toBe(1);
    expect(at(sep, 6).outside).toBe(false);
  });

  it('buckets a 23:30 shot on its local day, not the UTC next day', () => {
    const days = buildMonthDays([shot({ id: 1, timestamp: ts(2024, 2, 10, 23, 30) })], 2024, 2, noScore);
    expect(day(days, '2024-03-10').count).toBe(1);
    expect(day(days, '2024-03-11').count).toBe(0);
  });

  it('picks the bean with most shots and breaks a tie by the later shot', () => {
    const shots = [
      shot({ id: 1, timestamp: ts(2024, 2, 10, 8), beanId: 1, coffee: 'Alpha' }),
      shot({ id: 2, timestamp: ts(2024, 2, 10, 18), beanId: 2, coffee: 'Beta' }),
    ];
    const d = day(buildMonthDays(shots, 2024, 2, noScore), '2024-03-10');
    expect(d.count).toBe(2);
    expect(d.mainBeanId).toBe(2);
    expect(d.mainBeanName).toBe('Beta');

    // ... and the outright majority wins regardless of order.
    const shots2 = [
      ...shots,
      shot({ id: 3, timestamp: ts(2024, 2, 10, 9), beanId: 1, coffee: 'Alpha' }),
    ];
    const d2 = day(buildMonthDays(shots2, 2024, 2, noScore), '2024-03-10');
    expect(d2.mainBeanId).toBe(1);
    expect(d2.mainBeanName).toBe('Alpha');
  });

  it('leaves the main bean null when no shot carries a bean', () => {
    const d = day(buildMonthDays([shot({ id: 1, timestamp: ts(2024, 2, 10) })], 2024, 2, noScore), '2024-03-10');
    expect(d.count).toBe(1);
    expect(d.mainBeanId).toBeNull();
    expect(d.mainBeanName).toBeNull();
  });

  it('averages only scored shots and rounds; null without any score', () => {
    const shots = [
      shot({ id: 1, timestamp: ts(2024, 2, 10, 8) }),
      shot({ id: 2, timestamp: ts(2024, 2, 10, 9) }),
      shot({ id: 3, timestamp: ts(2024, 2, 10, 10) }),
    ];
    const scored = buildMonthDays(shots, 2024, 2, scoreById({ 1: 80, 2: 91 }));
    expect(day(scored, '2024-03-10').avgScore).toBe(86); // round(85.5)
    const unscored = buildMonthDays(shots, 2024, 2, noScore);
    expect(day(unscored, '2024-03-10').avgScore).toBeNull();
  });

  it('records shot ids chronologically', () => {
    const shots = [
      shot({ id: 3, timestamp: ts(2024, 2, 10, 18) }),
      shot({ id: 1, timestamp: ts(2024, 2, 10, 8) }),
      shot({ id: 2, timestamp: ts(2024, 2, 10, 12) }),
    ];
    expect(day(buildMonthDays(shots, 2024, 2, noScore), '2024-03-10').shotIds).toEqual([1, 2, 3]);
  });

  it("marks firstOfBean only on the main bean's first day in the input", () => {
    const shots = [
      shot({ id: 1, timestamp: ts(2024, 2, 10, 8), beanId: 5, coffee: 'Gamma' }),
      shot({ id: 2, timestamp: ts(2024, 2, 12, 8), beanId: 5, coffee: 'Gamma' }),
    ];
    const days = buildMonthDays(shots, 2024, 2, noScore);
    expect(day(days, '2024-03-10').firstOfBean).toBe(true);
    expect(day(days, '2024-03-12').firstOfBean).toBe(false);
  });

  it('does not mark firstOfBean when the bean was already pulled earlier', () => {
    const shots = [
      shot({ id: 1, timestamp: ts(2024, 2, 1, 8), beanId: 5, coffee: 'Gamma' }), // previous month
      shot({ id: 2, timestamp: ts(2024, 3, 5, 8), beanId: 5, coffee: 'Gamma' }),
    ];
    const days = buildMonthDays(shots, 2024, 3, noScore);
    expect(day(days, '2024-04-05').firstOfBean).toBe(false);
  });
});

describe('summaryLine', () => {
  // 2024-03-20 12:00 local: the 30-day window opens 2024-02-19, the 7-day
  // window 2024-03-13, both at 12:00.
  const now = ts(2024, 2, 20, 12) * 1000;

  function line(shots: MonthShot[], scores: Record<number, number>) {
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

function mday(o: Partial<MonthDay> & { key: string; day: number }): MonthDay {
  return {
    key: o.key, day: o.day, outside: o.outside ?? false,
    count: o.count ?? 0, avgScore: o.avgScore ?? null,
    mainBeanId: o.mainBeanId ?? null, mainBeanName: o.mainBeanName ?? null,
    shotIds: o.shotIds ?? [], firstOfBean: o.firstOfBean ?? false,
  };
}

describe('cellKind', () => {
  it('is empty for a day without shots, photo or not', () => {
    expect(cellKind({ count: 0 }, true)).toBe('empty');
    expect(cellKind({ count: 0 }, false)).toBe('empty');
  });

  it('is photo when the main bean has a photo', () => {
    expect(cellKind({ count: 1 }, true)).toBe('photo');
    expect(cellKind({ count: 4 }, true)).toBe('photo');
  });

  it('is disc when there are shots but no photo', () => {
    expect(cellKind({ count: 1 }, false)).toBe('disc');
    expect(cellKind({ count: 4 }, false)).toBe('disc');
  });
});

describe('dayCellHtml', () => {
  const today = new Date(2024, 2, 20);
  const locale = 'en';

  it('shows only the day number for a day without shots, and no dot', () => {
    const out = dayCellHtml(mday({ key: '2024-03-04', day: 4, count: 0 }), today, locale, false);
    expect(out).toContain('class="cal-month-num"');
    expect(out).toContain('>4<');
    expect(out).not.toContain('cal-month-dot');
    expect(out).not.toContain('cal-month-thumb');
  });

  it('renders the photo img for a day whose bean has a photo', () => {
    const out = dayCellHtml(mday({ key: '2024-03-05', day: 5, count: 2, avgScore: 92, mainBeanId: 7, mainBeanName: 'Alpha' }), today, locale, true);
    expect(out).toContain('<img class="cal-month-img"');
    expect(out).toContain('data-bean-id="7"');
    expect(out).not.toContain('cal-month-num');
    expect(out).not.toContain('cal-month-dot');
  });

  it('renders a number disc without an img for a day with shots but no photo', () => {
    const out = dayCellHtml(mday({ key: '2024-03-06', day: 6, count: 1, avgScore: 80, mainBeanId: 7, mainBeanName: 'Alpha' }), today, locale, false);
    expect(out).toContain('no-img');
    expect(out).toContain('class="cal-month-num"');
    expect(out).toContain('>6<');
    expect(out).not.toContain('<img');
    expect(out).not.toContain('cal-month-dot');
  });

  it('renders the disc for a day with shots and no bean at all', () => {
    const out = dayCellHtml(mday({ key: '2024-03-07', day: 7, count: 1 }), today, locale, false);
    expect(out).toContain('no-img');
    expect(out).toContain('>7<');
    expect(out).not.toContain('<img');
  });

  it('marks today without a shot with is-today only', () => {
    const out = dayCellHtml(mday({ key: '2024-03-20', day: 20, count: 0 }), today, locale, false);
    expect(out).toContain('is-today');
    expect(out).not.toContain('has-shot');
  });

  it('marks a today cell with shots as has-shot so the ring stays', () => {
    const out = dayCellHtml(mday({ key: '2024-03-20', day: 20, count: 1, avgScore: 80 }), today, locale, false);
    expect(out).toContain('is-today');
    expect(out).toContain('has-shot');
  });

  it('renders no number for outside or future cells', () => {
    const outside = dayCellHtml(mday({ key: '2024-02-29', day: 29, outside: true }), today, locale, false);
    expect(outside).toContain('cal-month-outside');
    expect(outside).not.toContain('cal-month-num');
    const future = dayCellHtml(mday({ key: '2024-03-21', day: 21, count: 0 }), today, locale, false);
    expect(future).toContain('cal-month-future');
    expect(future).not.toContain('cal-month-num');
  });
});

// #1401: the shown month used to be frozen from `new Date()` at module load, so
// a view left open across a month boundary kept rendering the old month. These
// tests drive renderMonthCalendar against a minimal fake element/document (the
// suite runs under vitest's node environment, no jsdom) with the clock pinned
// so the month can change between two renders.
describe('renderMonthCalendar month rollover (#1401)', () => {
  type NavModule = Pick<MonthModule, 'renderMonthCalendar' | 'analyticsMonthNext' | 'analyticsMonthPrev'>;

  interface FakeEl {
    innerHTML: string;
    querySelector: () => null;
    querySelectorAll: () => unknown[];
  }

  // Only the members renderMonthCalendar touches: innerHTML writes, the
  // #calMonthPop lookup (absent -> early return) and the thumbnail scan (none).
  const el: FakeEl = {
    innerHTML: '',
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const monthEl = el as unknown as HTMLElement;

  function titleOf(year: number, month: number): string {
    return new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' }).format(new Date(year, month, 1));
  }

  beforeAll(() => {
    Object.defineProperty(globalThis, 'document', {
      value: {
        getElementById: (id: string) => (id === 'shotMonthCalendar' ? el : null),
        addEventListener: () => {},
        removeEventListener: () => {},
      },
      configurable: true, writable: true,
    });
  });

  beforeEach(() => {
    vi.useFakeTimers();
    el.innerHTML = '';
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // A fresh module instance per test: the shown month and the "user navigated"
  // flag are module state, and re-importing is the only way to reset them.
  async function freshNav(): Promise<NavModule> {
    vi.resetModules();
    return import('../public-src/views/analytics-month.js');
  }

  it('rolls to the new month on a re-render after a month change', async () => {
    vi.setSystemTime(new Date(2026, 9, 31, 12, 0, 0)); // 2026-10-31
    const mod = await freshNav();
    mod.renderMonthCalendar(monthEl);
    expect(el.innerHTML).toContain(titleOf(2026, 9)); // October 2026

    vi.setSystemTime(new Date(2026, 10, 1, 0, 30, 0)); // 2026-11-01
    mod.renderMonthCalendar(monthEl);
    expect(el.innerHTML).toContain(titleOf(2026, 10)); // November 2026
  });

  it('keeps the month the user navigated to across re-renders', async () => {
    vi.setSystemTime(new Date(2026, 10, 15, 12, 0, 0)); // 2026-11-15
    const mod = await freshNav();
    mod.renderMonthCalendar(monthEl);
    mod.analyticsMonthPrev(); // -> October 2026
    expect(el.innerHTML).toContain(titleOf(2026, 9));

    // A later rebuild (language change, data reload) must keep October.
    mod.renderMonthCalendar(monthEl);
    expect(el.innerHTML).toContain(titleOf(2026, 9));
    expect(el.innerHTML).not.toContain(titleOf(2026, 10));
  });

  it('resumes following the current month after navigating back to it', async () => {
    vi.setSystemTime(new Date(2026, 9, 31, 12, 0, 0)); // 2026-10-31
    const mod = await freshNav();
    mod.renderMonthCalendar(monthEl);
    mod.analyticsMonthPrev(); // -> September 2026, pinned
    expect(el.innerHTML).toContain(titleOf(2026, 8));

    mod.analyticsMonthNext(); // back to the current month, following again
    expect(el.innerHTML).toContain(titleOf(2026, 9));

    vi.setSystemTime(new Date(2026, 10, 1, 0, 30, 0)); // 2026-11-01
    mod.renderMonthCalendar(monthEl);
    expect(el.innerHTML).toContain(titleOf(2026, 10)); // November 2026
  });
});
