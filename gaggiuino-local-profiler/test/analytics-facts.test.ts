import { describe, it, expect } from 'vitest';
import { computeFacts, _circularMinutes } from '../public-src/views/analytics-facts.js';
import type { Fact, FactShot } from '../public-src/views/analytics-facts.js';

// analytics-facts is pure and DOM-free (only a type-only import), so the tests
// drive it directly. Every timestamp is built through the local Date
// constructor so the "local time" contract holds whatever TZ the runner is in.
const scores = new Map<number, number>();
let uid = 0;

function shot(
  timestamp: number,
  opts: { duration?: number; weight?: number; score?: number } = {},
): FactShot {
  uid += 1;
  const s = { id: uid, timestamp, duration: opts.duration, weight: opts.weight } as unknown as FactShot;
  if (opts.score !== undefined) scores.set(uid, opts.score);
  return s;
}

const scoreOf = (s: FactShot): number | null => scores.get(s.id) ?? null;

const at = (y: number, mo: number, d: number, h: number, mi: number): number =>
  Math.floor(new Date(y, mo - 1, d, h, mi, 0, 0).getTime() / 1000);

// Three perfect shots a minute apart — a reliable 4-fact block
// (first_hundred, hundred_run, quick_refill and often total_yield).
const pad100 = (ts: number, duration = 300, weight?: number): FactShot[] => [
  shot(ts, { duration, score: 100, ...(weight !== undefined ? { weight } : {}) }),
  shot(ts + 60, { duration, score: 100, ...(weight !== undefined ? { weight } : {}) }),
  shot(ts + 120, { duration, score: 100, ...(weight !== undefined ? { weight } : {}) }),
];

const ids = (facts: Fact[]): string[] => facts.map(f => f.id);
const byId = (facts: Fact[], id: string): Fact | undefined => facts.find(f => f.id === id);

describe('_circularMinutes (#1467)', () => {
  it('measures across midnight, not the long way round', () => {
    expect(_circularMinutes(23 * 60 + 30, 30)).toBe(60); // 23:30 vs 00:30 → 1 h
    expect(_circularMinutes(30, 23 * 60 + 30)).toBe(60);
    expect(_circularMinutes(60, 23 * 60)).toBe(120); // 01:00 vs 23:00 → 2 h
    expect(_circularMinutes(0, 0)).toBe(0);
  });
});

describe('computeFacts minimum (#1467)', () => {
  it('returns nothing with no shots', () => {
    expect(computeFacts([], scoreOf)).toEqual([]);
  });

  it('returns nothing when fewer than three facts hold', () => {
    // A lone perfect shot is only first_hundred (1 fact).
    const facts = computeFacts(pad100(at(2024, 3, 6, 11, 11)).slice(0, 1), scoreOf);
    expect(facts).toEqual([]);
  });
});

describe('computeFacts odd_hour (#1467)', () => {
  it('flags the shot furthest from the median time when it is ≥ 4 h away', () => {
    const shots: FactShot[] = [
      shot(at(2024, 3, 4, 8, 0), { duration: 300, score: 90 }),
      shot(at(2024, 3, 4, 8, 1), { duration: 300, score: 91 }),
      shot(at(2024, 3, 4, 8, 2), { duration: 300, score: 92 }),
      shot(at(2024, 3, 4, 8, 3), { duration: 300, score: 93 }),
      shot(at(2024, 3, 4, 8, 4), { duration: 300, score: 94 }),
      shot(at(2024, 3, 5, 23, 30), { duration: 300, score: 88 }),
    ];
    const facts = computeFacts([...shots, ...pad100(at(2024, 3, 6, 10, 0))], scoreOf, 'en-US');
    const odd = byId(facts, 'odd_hour');
    expect(odd).toBeDefined();
    expect(odd?.big).toBe('23:30');
    expect(odd?.night).toBe(true);
    expect(odd?.vars.score).toBe('88');
  });

  it('uses the day wording when the odd shot is not at night', () => {
    const shots: FactShot[] = [
      shot(at(2024, 3, 4, 8, 0), { duration: 300, score: 90 }),
      shot(at(2024, 3, 4, 8, 1), { duration: 300, score: 91 }),
      shot(at(2024, 3, 4, 8, 2), { duration: 300, score: 92 }),
      shot(at(2024, 3, 4, 8, 3), { duration: 300, score: 93 }),
      shot(at(2024, 3, 4, 8, 4), { duration: 300, score: 94 }),
      shot(at(2024, 3, 4, 15, 30), { duration: 300, score: 88 }),
    ];
    const facts = computeFacts([...shots, ...pad100(at(2024, 3, 6, 10, 0))], scoreOf, 'en-US');
    const odd = byId(facts, 'odd_hour');
    expect(odd?.textKey).toBe('analytics_fact_odd_hour_day');
    expect(odd?.night).toBeFalsy();
  });

  it('does not flag a 1 h wrap-around (00:30 median vs 23:30 shot)', () => {
    const shots: FactShot[] = [
      shot(at(2024, 3, 4, 0, 30), { duration: 300, score: 90 }),
      shot(at(2024, 3, 4, 0, 31), { duration: 300, score: 91 }),
      shot(at(2024, 3, 4, 0, 32), { duration: 300, score: 92 }),
      shot(at(2024, 3, 4, 0, 33), { duration: 300, score: 93 }),
      shot(at(2024, 3, 4, 0, 34), { duration: 300, score: 94 }),
      shot(at(2024, 3, 4, 23, 30), { duration: 300, score: 88 }),
    ];
    // The extra facts come from perfect shots kept near midnight too, so the
    // 23:30 shot is the only one far from the median and its circular distance
    // (1 h) is what decides the result.
    const facts = computeFacts([
      ...shots,
      shot(at(2024, 3, 4, 0, 40), { duration: 300, score: 100 }),
      shot(at(2024, 3, 4, 0, 41), { duration: 300, score: 100 }),
      shot(at(2024, 3, 4, 0, 42), { duration: 300, score: 100 }),
    ], scoreOf, 'en-US');
    expect(facts.length).toBeGreaterThanOrEqual(3);
    expect(ids(facts)).not.toContain('odd_hour');
  });
});

describe('computeFacts night_round (#1467)', () => {
  it('groups shots across midnight into one evening', () => {
    const shots: FactShot[] = [
      shot(at(2024, 3, 5, 23, 30), { duration: 300, score: 80 }),
      shot(at(2024, 3, 6, 0, 30), { duration: 300, score: 81 }),
      shot(at(2024, 3, 6, 1, 30), { duration: 300, score: 82 }),
    ];
    const facts = computeFacts([...shots, ...pad100(at(2024, 3, 6, 10, 0))], scoreOf, 'en-US');
    const night = byId(facts, 'night_round');
    expect(night).toBeDefined();
    expect(night?.night).toBe(true);
    expect(night?.big).toBe('3 in 120 min');
    expect(night?.rows).toHaveLength(3);
  });

  it('needs at least three shots in the evening', () => {
    const shots: FactShot[] = [
      shot(at(2024, 3, 5, 23, 30), { duration: 300, score: 80 }),
      shot(at(2024, 3, 6, 1, 30), { duration: 300, score: 82 }),
    ];
    const facts = computeFacts([...shots, ...pad100(at(2024, 3, 6, 10, 0))], scoreOf, 'en-US');
    expect(ids(facts)).not.toContain('night_round');
  });
});

describe('computeFacts first_hundred (#1467)', () => {
  it('adds the wish variant when hours and minutes match', () => {
    const facts = computeFacts(pad100(at(2024, 3, 6, 11, 11)), scoreOf, 'en-US');
    expect(byId(facts, 'first_hundred')?.textKey).toBe('analytics_fact_first_hundred_wish');
  });

  it('uses the plain variant otherwise', () => {
    const facts = computeFacts(pad100(at(2024, 3, 6, 11, 15)), scoreOf, 'en-US');
    expect(byId(facts, 'first_hundred')?.textKey).toBe('analytics_fact_first_hundred');
  });
});

describe('computeFacts hundred_run (#1467)', () => {
  it('reports the longest consecutive perfect run', () => {
    const shots: FactShot[] = [
      shot(at(2024, 3, 6, 10, 0), { duration: 300, score: 100 }),
      shot(at(2024, 3, 6, 10, 1), { duration: 300, score: 100 }),
      shot(at(2024, 3, 6, 10, 2), { duration: 300, score: 96 }),
      shot(at(2024, 3, 6, 10, 3), { duration: 300, score: 100 }),
      shot(at(2024, 3, 6, 10, 4), { duration: 300, score: 100 }),
      shot(at(2024, 3, 6, 10, 5), { duration: 300, score: 100 }),
    ];
    const facts = computeFacts(shots, scoreOf, 'en-US');
    expect(byId(facts, 'hundred_run')?.big).toBe('3 × 100');
  });

  it('needs a run of at least three', () => {
    const shots: FactShot[] = [
      shot(at(2024, 3, 6, 10, 0), { duration: 700, weight: 4000, score: 100 }),
      shot(at(2024, 3, 6, 10, 1), { duration: 300, weight: 4000, score: 100 }),
      shot(at(2024, 3, 6, 10, 2), { duration: 300, weight: 4000, score: 90 }),
    ];
    const facts = computeFacts(shots, scoreOf, 'en-US');
    expect(ids(facts)).not.toContain('hundred_run');
    expect(facts.length).toBeGreaterThanOrEqual(3);
  });
});

describe('computeFacts best_weekday (#1467)', () => {
  const day = (y: number, mo: number, d: number, count: number, score: number): FactShot[] =>
    Array.from({ length: count }, (_, i) =>
      shot(at(y, mo, d, 10 + i, 0), { duration: 1200, weight: 200, score }));

  it('names the best weekday among the qualifying ones', () => {
    const shots = [...day(2024, 3, 4, 10, 95), ...day(2024, 3, 5, 5, 80), ...day(2024, 3, 6, 5, 70)];
    const facts = computeFacts(shots, scoreOf, 'en-US');
    const bw = byId(facts, 'best_weekday');
    expect(bw).toBeDefined();
    expect(bw?.textKey).toBe('analytics_fact_best_weekday');
    expect(bw?.rows).toHaveLength(3);
    expect(bw?.vars.weekday).toBe('Monday');
    expect(bw?.big).toBe('Monday');
  });

  it('uses the rare variant when the best day is also the least used', () => {
    const shots = [...day(2024, 3, 4, 5, 95), ...day(2024, 3, 5, 5, 80), ...day(2024, 3, 6, 6, 70)];
    const facts = computeFacts(shots, scoreOf, 'en-US');
    expect(byId(facts, 'best_weekday')?.textKey).toBe('analytics_fact_best_weekday_rare');
  });

  it('names the weekday in the active locale', () => {
    const shots = [...day(2024, 3, 4, 10, 95), ...day(2024, 3, 5, 5, 80), ...day(2024, 3, 6, 5, 70)];
    const facts = computeFacts(shots, scoreOf, 'de-DE');
    expect(byId(facts, 'best_weekday')?.big).toBe('Montag');
  });

  it('needs at least three qualifying weekdays', () => {
    const shots = [...day(2024, 3, 4, 10, 95), ...day(2024, 3, 5, 10, 80)];
    const facts = computeFacts([...shots, ...pad100(at(2024, 3, 7, 10, 0))], scoreOf, 'en-US');
    expect(ids(facts)).not.toContain('best_weekday');
  });
});

describe('computeFacts total_yield (#1467)', () => {
  it('sums yield into litres with a gauge toward the next 10 l', () => {
    const shots = [
      shot(at(2024, 3, 6, 10, 0), { duration: 300, weight: 4000, score: 100 }),
      shot(at(2024, 3, 6, 10, 1), { duration: 300, weight: 4000, score: 100 }),
      shot(at(2024, 3, 6, 10, 2), { duration: 300, weight: 4000, score: 100 }),
    ];
    const facts = computeFacts(shots, scoreOf, 'en-US');
    const ty = byId(facts, 'total_yield');
    expect(ty).toBeDefined();
    expect(ty?.big).toBe('1.2 l');
    expect(ty?.gauge).toBeCloseTo(12, 5);
  });

  it('stays out below one litre', () => {
    const shots = [
      shot(at(2024, 3, 6, 10, 0), { duration: 700, weight: 300, score: 100 }),
      shot(at(2024, 3, 6, 10, 1), { duration: 700, weight: 300, score: 100 }),
      shot(at(2024, 3, 6, 10, 2), { duration: 700, weight: 300, score: 100 }),
    ];
    const facts = computeFacts(shots, scoreOf, 'en-US');
    expect(ids(facts)).not.toContain('total_yield');
  });

  it('uses the locale decimal separator and unit (de)', () => {
    const shots = [
      shot(at(2024, 3, 6, 10, 0), { duration: 300, weight: 4000, score: 100 }),
      shot(at(2024, 3, 6, 10, 1), { duration: 300, weight: 4000, score: 100 }),
      shot(at(2024, 3, 6, 10, 2), { duration: 300, weight: 4000, score: 100 }),
    ];
    const facts = computeFacts(shots, scoreOf, 'de-DE');
    expect(byId(facts, 'total_yield')?.big).toBe('1,2 l');
  });
});

describe('computeFacts total_time (#1467)', () => {
  it('sums brew time and uses the movie variant past 90 minutes', () => {
    const shots = [
      shot(at(2024, 3, 6, 10, 0), { duration: 10000, score: 100 }),
      shot(at(2024, 3, 6, 10, 30), { duration: 10000, score: 100 }),
      shot(at(2024, 3, 6, 11, 0), { duration: 10000, score: 100 }),
      shot(at(2024, 3, 6, 11, 30), { duration: 10000, score: 100 }),
      shot(at(2024, 3, 6, 12, 0), { duration: 10000, score: 100 }),
      shot(at(2024, 3, 6, 12, 30), { duration: 10000, score: 100 }),
    ];
    const facts = computeFacts(shots, scoreOf, 'en-US');
    const tt = byId(facts, 'total_time');
    expect(tt).toBeDefined();
    expect(tt?.big).toBe('1.7 h');
    expect(tt?.textKey).toBe('analytics_fact_total_time_movie');
  });

  it('ignores shots of five seconds or less', () => {
    const shots = [
      shot(at(2024, 3, 6, 10, 0), { duration: 40, weight: 4000, score: 100 }),
      shot(at(2024, 3, 6, 10, 1), { duration: 40, weight: 4000, score: 100 }),
      shot(at(2024, 3, 6, 10, 2), { duration: 40, weight: 4000, score: 100 }),
    ];
    const facts = computeFacts(shots, scoreOf, 'en-US');
    expect(ids(facts)).not.toContain('total_time');
    expect(ids(facts)).not.toContain('longest_shot');
  });
});

describe('computeFacts longest_break (#1467)', () => {
  it('finds the biggest gap at two days or more', () => {
    const shots = [
      ...pad100(at(2024, 3, 4, 10, 0)),
      shot(at(2024, 3, 7, 10, 5), { duration: 300, score: 70 }),
    ];
    const facts = computeFacts(shots, scoreOf, 'en-US');
    const lb = byId(facts, 'longest_break');
    expect(lb).toBeDefined();
    expect(lb?.big).toBe('3 days');
    expect(lb?.rows[2]?.[1]).toContain('3 d');
  });

  it('stays out below two days', () => {
    const shots = [
      ...pad100(at(2024, 3, 4, 10, 0)),
      shot(at(2024, 3, 5, 9, 0), { duration: 300, score: 70 }),
    ];
    const facts = computeFacts(shots, scoreOf, 'en-US');
    expect(ids(facts)).not.toContain('longest_break');
  });
});

describe('computeFacts quick_refill (#1467)', () => {
  it('reports the smallest gap under five minutes', () => {
    const facts = computeFacts(pad100(at(2024, 3, 6, 10, 0)), scoreOf, 'en-US');
    const qr = byId(facts, 'quick_refill');
    expect(qr).toBeDefined();
    expect(qr?.big).toBe('60 s');
  });

  it('stays out when every gap is five minutes or more', () => {
    const shots = [
      shot(at(2024, 3, 6, 10, 0), { duration: 300, weight: 4000, score: 100 }),
      shot(at(2024, 3, 6, 10, 10), { duration: 300, weight: 4000, score: 100 }),
      shot(at(2024, 3, 6, 10, 20), { duration: 300, weight: 4000, score: 100 }),
    ];
    const facts = computeFacts(shots, scoreOf, 'en-US');
    expect(ids(facts)).not.toContain('quick_refill');
    expect(facts.length).toBeGreaterThanOrEqual(3);
  });

  it('ignores sub-10 s gaps from duplicate imports', () => {
    const base = at(2024, 3, 6, 10, 0);
    const shots = [
      shot(base, { duration: 300, score: 100 }),
      shot(base + 5, { duration: 300, score: 100 }),
      shot(base + 35, { duration: 300, score: 100 }),
      shot(base + 65, { duration: 300, score: 100 }),
    ];
    const facts = computeFacts(shots, scoreOf, 'en-US');
    expect(byId(facts, 'quick_refill')?.big).toBe('30 s');
  });

  it('never reports a zero-second refill', () => {
    const base = at(2024, 3, 6, 10, 0);
    const shots = [
      shot(base, { duration: 300, score: 100 }),
      shot(base, { duration: 300, score: 100 }),
      shot(base + 40, { duration: 300, score: 100 }),
    ];
    const facts = computeFacts(shots, scoreOf, 'en-US');
    expect(byId(facts, 'quick_refill')?.big).not.toBe('0 s');
  });
});

describe('computeFacts date formatting (#1467)', () => {
  const oddSet = (y: number, mo: number, d: number): FactShot[] => [
    shot(at(y, mo, d, 8, 0), { duration: 300, score: 90 }),
    shot(at(y, mo, d, 8, 1), { duration: 300, score: 91 }),
    shot(at(y, mo, d, 8, 2), { duration: 300, score: 92 }),
    shot(at(y, mo, d, 8, 3), { duration: 300, score: 93 }),
    shot(at(y, mo, d, 8, 4), { duration: 300, score: 94 }),
    shot(at(y, mo, d, 21, 21), { duration: 300, score: 88 }),
  ];

  it('renders date and time in the locale', () => {
    const y = new Date().getFullYear();
    const facts = computeFacts([...oddSet(y, 6, 17), ...pad100(at(y, 6, 18, 10, 0))], scoreOf, 'de-DE');
    const expected = new Date(at(y, 6, 17, 21, 21) * 1000)
      .toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric', month: 'long' });
    const date = byId(facts, 'odd_hour')?.vars.date;
    expect(date).toBe(`${expected}, 21:21`);
    expect(date).not.toMatch(/^\d{4}-\d{2}-\d{2}/);
    expect(date).toContain('Juni');
  });

  it('adds the year only when the shot is not from this year', () => {
    const y = new Date().getFullYear();
    const facts = computeFacts([...oddSet(y - 1, 6, 17), ...pad100(at(y - 1, 6, 18, 10, 0))], scoreOf, 'en-US');
    const expected = new Date(at(y - 1, 6, 17, 21, 21) * 1000)
      .toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' });
    expect(byId(facts, 'odd_hour')?.vars.date).toBe(`${expected}, 21:21`);
  });
});

describe('computeFacts longest_shot (#1467)', () => {
  it('reports the longest brew over 60 s', () => {
    const shots = [
      shot(at(2024, 3, 6, 10, 0), { duration: 700, score: 100 }),
      shot(at(2024, 3, 6, 10, 1), { duration: 300, score: 100 }),
      shot(at(2024, 3, 6, 10, 2), { duration: 300, score: 100 }),
    ];
    const facts = computeFacts(shots, scoreOf, 'en-US');
    expect(byId(facts, 'longest_shot')?.big).toBe('70 s');
  });

  it('stays out at 60 s or less', () => {
    const shots = [
      shot(at(2024, 3, 6, 10, 0), { duration: 600, weight: 4000, score: 100 }),
      shot(at(2024, 3, 6, 10, 1), { duration: 600, weight: 4000, score: 100 }),
      shot(at(2024, 3, 6, 10, 2), { duration: 600, weight: 4000, score: 100 }),
    ];
    const facts = computeFacts(shots, scoreOf, 'en-US');
    expect(ids(facts)).not.toContain('longest_shot');
    expect(facts.length).toBeGreaterThanOrEqual(3);
  });
});
