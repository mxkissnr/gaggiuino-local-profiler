import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

// #2119: the numbers behind the bean comparison. Same harness as
// analytics-bean-ranking-by-id.test.ts: the module reuses the analytics bean
// ranking, whose import chain reads localStorage/navigator at module load and
// scores through window.calcShotScore.
type StatsModule = typeof import('../public-src/views/library/bean-compare-stats.js');
let stats: StatsModule;
let S: (typeof import('../public-src/state/index.js'))['S'];

type Shot = Parameters<StatsModule['computeBeanComparison']>[2][number];
type Bean = Parameters<StatsModule['computeBeanComparison']>[0];
type CompareStats = Parameters<StatsModule['compareVerdict']>[0];

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
      calcShotScore: (shot: { score?: number | null }) => shot.score ?? null,
      getShotData: () => ({}),
    },
    configurable: true, writable: true,
  });
  stats = await import('../public-src/views/library/bean-compare-stats.js');
  ({ S } = await import('../public-src/state/index.js'));
});

interface ShotOpts {
  bean: number;
  score?: number | null;
  grinder?: string;
  grind?: number;
  dose?: number;
  weight?: number;
  taste?: string;
  rating?: string;
  mix?: boolean;
}

let nextId = 1;
function shot(o: ShotOpts): Shot {
  const id = nextId++;
  const annotation: Record<string, unknown> = {
    beanId: o.bean, grinder: o.grinder ?? 'Niche', grindSetting: o.grind ?? 12, dose: o.dose ?? 18,
  };
  if (o.taste) annotation.tasteTag = o.taste;
  if (o.rating) annotation.rating = o.rating;
  if (o.mix) annotation.beanMix = [{ beanId: o.bean, coffee: 'Part A', grams: 9 }, { beanId: 99, coffee: 'Part B', grams: 9 }];
  // weight is the final yield in tenths of a gram, duration in tenths of a second.
  return { id, timestamp: id, score: o.score === undefined ? 85 : o.score, duration: 280, weight: o.weight ?? 360, annotation } as unknown as Shot;
}

function bean(id: number, over: Record<string, unknown> = {}): Bean {
  return { id, name: `Bean ${id}`, bags: [], ...over } as unknown as Bean;
}

function statsWith(over: Partial<CompareStats>): CompareStats {
  return {
    shots: 5, scoredShots: 5, avgScore: 80, best: 90, rating: null, taste: null, bestGrind: null,
    dose: null, yield: null, avgTime: null, firstGood: null, pricePerShot: null, gramsLeft: null,
    roastAgeDays: null, freshness: null, ...over,
  };
}

beforeEach(() => {
  S.coffeeLibrary = { beans: [{ id: 1, name: 'Bean 1' }, { id: 2, name: 'Bean 2' }], grinders: [] };
});

describe('bean comparison figures (#2119)', () => {
  it('averages dose and yield on the shared grinder only', () => {
    const c = stats.computeBeanComparison(bean(1), bean(2), [
      shot({ bean: 1, grinder: 'Niche', dose: 18, weight: 360 }),
      shot({ bean: 1, grinder: 'Niche', dose: 19, weight: 400 }),
      shot({ bean: 1, grinder: 'EK43', dose: 22, weight: 500 }),
      shot({ bean: 2, grinder: 'niche ', dose: 17, weight: 340 }),
    ]);
    expect(c.grinder).toBe('Niche');
    expect(c.a.shots).toBe(3);
    expect(c.a.dose).toBe(18.5);
    expect(c.a.yield).toBe(38);
    expect(c.b.dose).toBe(17);
    expect(c.b.yield).toBe(34);
  });

  it('uses all shots for the dial-in figures when the beans share no grinder', () => {
    const c = stats.computeBeanComparison(bean(1), bean(2), [
      shot({ bean: 1, grinder: 'Niche', dose: 18 }),
      shot({ bean: 1, grinder: 'EK43', dose: 20 }),
      shot({ bean: 2, grinder: 'Comandante', dose: 15 }),
    ]);
    expect(c.grinder).toBeNull();
    expect(c.a.dose).toBe(19);
    expect(c.b.dose).toBe(15);
  });

  it('picks the grinder both beans were used with most', () => {
    expect(stats.sharedGrinder(
      [shot({ bean: 1, grinder: 'Niche' }), shot({ bean: 1, grinder: 'EK43' }), shot({ bean: 1, grinder: 'EK43' })],
      [shot({ bean: 2, grinder: 'Niche' }), shot({ bean: 2, grinder: 'ek43' }), shot({ bean: 2, grinder: 'Timemore' })],
    )).toBe('EK43');
    expect(stats.sharedGrinder([shot({ bean: 1, grinder: 'Niche' })], [shot({ bean: 2, grinder: 'EK43' })])).toBeNull();
  });

  it('prices a shot from the current bag\'s price per gram and the average dose', () => {
    const priced = bean(1, { bags: [{ id: 1, stock_g: 250, price_eur: 15, consumedG: 50, remainingG: 200, current: true }] });
    expect(stats.pricePerShot(priced, 18)).toBe(1.08);
    expect(stats.pricePerShot(priced, null)).toBeNull();
    const unpriced = bean(1, { bags: [{ id: 1, stock_g: 250, consumedG: 0, remainingG: 250, current: true }] });
    expect(stats.pricePerShot(unpriced, 18)).toBeNull();

    const c = stats.computeBeanComparison(priced, bean(2), [shot({ bean: 1, dose: 18 })]);
    expect(c.a.pricePerShot).toBe(1.08);
  });

  it('leaves mixed shots out of the per-bean figures', () => {
    const c = stats.computeBeanComparison(bean(1), bean(2), [
      shot({ bean: 1, dose: 18 }),
      shot({ bean: 1, dose: 30, mix: true }),
    ]);
    expect(c.a.shots).toBe(1);
    expect(c.a.dose).toBe(18);
  });

  it('finds the aromas both beans share across languages and spellings', () => {
    const shared = stats.sharedAromaKeys(['Blueberry', 'Chocolate', 'Zzyzx'], ['Blaubeere', 'Jasmine', ' zzyzx ']);
    expect(shared.size).toBe(2);
    expect(stats.aromaKey('Blaubeere')).toBe(stats.aromaKey('Blueberry'));
    expect(shared.has(stats.aromaKey('Blueberry'))).toBe(true);
    expect(shared.has(stats.aromaKey('Zzyzx'))).toBe(true);
    expect(stats.sharedAromaKeys(['Chocolate'], []).size).toBe(0);
    expect(stats.sharedAromaKeys(undefined, ['Chocolate']).size).toBe(0);
  });

  it('names the most common taste tag', () => {
    expect(stats.mostCommonTasteTag([
      shot({ bean: 1, taste: 'sour' }), shot({ bean: 1, taste: 'bitter' }), shot({ bean: 1, taste: 'bitter' }), shot({ bean: 1 }),
    ])).toBe('bitter');
    expect(stats.mostCommonTasteTag([shot({ bean: 1 })])).toBeNull();
  });

  it('marks the better side, and nothing on a tie or a missing value', () => {
    expect(stats.betterSide(90, 80, 'higher')).toBe('a');
    expect(stats.betterSide(90, 80, 'lower')).toBe('b');
    expect(stats.betterSide(5, 5, 'higher')).toBeNull();
    expect(stats.betterSide(null, 3, 'lower')).toBeNull();
    expect(stats.betterSide(stats.freshnessRank('peak'), stats.freshnessRank('old'), 'lower')).toBe('a');
    expect(stats.betterSide(stats.freshnessRank('fading'), stats.freshnessRank('almost'), 'lower')).toBeNull();
    expect(stats.freshnessRank(null)).toBeNull();
  });

  it('builds the full comparison from the shared helpers', () => {
    const shots = [
      shot({ bean: 1, score: 90, rating: '4' }),
      shot({ bean: 1, score: 90, rating: '5' }),
      shot({ bean: 1, score: 90 }),
      shot({ bean: 2, score: 70 }),
      shot({ bean: 2, score: 70 }),
      shot({ bean: 2, score: 70 }),
    ];
    const c = stats.computeBeanComparison(bean(1, { remainingG: 200.4 }), bean(2), shots);
    expect(c.a.avgScore).toBe(90);
    expect(c.a.best).toBe(90);
    expect(c.a.rating).toBe(4.5);
    expect(c.a.firstGood).toBe(1);
    expect(c.b.firstGood).toBeNull();
    expect(c.a.avgTime).toBe(28);
    expect(c.a.bestGrind).toEqual({ grinder: 'Niche', grindSetting: 12 });
    expect(c.a.gramsLeft).toBe(200);
    expect(c.verdict).toEqual({ kind: 'winner', winner: 'a', diff: 20, reason: 'dialin-same-grinder' });
  });
});

describe('bean comparison verdict rule (#2119)', () => {
  it('names no winner while a bean has fewer than three scored shots', () => {
    expect(stats.compareVerdict(statsWith({}), statsWith({ scoredShots: 2, avgScore: 99 }), true)).toEqual({ kind: 'few', side: 'b' });
    expect(stats.compareVerdict(statsWith({ shots: 0, scoredShots: 0, avgScore: null }), statsWith({}), true)).toEqual({ kind: 'few', side: 'a' });
    expect(stats.MIN_VERDICT_SHOTS).toBe(3);
  });

  it('calls equal averages a tie', () => {
    expect(stats.compareVerdict(statsWith({ avgScore: 84 }), statsWith({ avgScore: 84 }), true)).toEqual({ kind: 'tie' });
  });

  it('gives fewer tries to dial in as the reason, naming the shared grinder only when there is one', () => {
    const a = statsWith({ avgScore: 88, firstGood: 2 });
    const b = statsWith({ avgScore: 80, firstGood: 5 });
    expect(stats.compareVerdict(a, b, true)).toEqual({ kind: 'winner', winner: 'a', diff: 8, reason: 'dialin-same-grinder' });
    expect(stats.compareVerdict(a, b, false)).toEqual({ kind: 'winner', winner: 'a', diff: 8, reason: 'dialin' });
    // A bean that never reached 80 needed more tries than one that did.
    expect(stats.compareVerdict(statsWith({ avgScore: 70 }), statsWith({ avgScore: 75, firstGood: 3 }), true))
      .toEqual({ kind: 'winner', winner: 'b', diff: 5, reason: 'dialin-same-grinder' });
  });

  it('falls back to the best shot, then the rating, then the average', () => {
    expect(stats.compareVerdict(statsWith({ avgScore: 85, best: 98 }), statsWith({ avgScore: 80, best: 90 }), true))
      .toEqual({ kind: 'winner', winner: 'a', diff: 5, reason: 'best' });
    expect(stats.compareVerdict(statsWith({ avgScore: 85, rating: 4.5 }), statsWith({ avgScore: 80, rating: 4 }), true))
      .toEqual({ kind: 'winner', winner: 'a', diff: 5, reason: 'rating' });
    expect(stats.compareVerdict(statsWith({ avgScore: 85 }), statsWith({ avgScore: 80 }), true))
      .toEqual({ kind: 'winner', winner: 'a', diff: 5, reason: 'score' });
  });
});
