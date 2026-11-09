import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { GrindShot } from '../public-src/views/shots/grind.js';
import type { ShotLike } from '../public-src/views/shots/utils.js';
import type { SummaryShot } from '../public-src/views/analytics-summary.js';

// Bean mix (#1837): a mixed shot records 2-4 beans in one dose and names only
// its primary bean at the top level. It must therefore never feed per-bean
// learning — grind advice, best combos, grind baselines, last used grind,
// per-bean analytics — while overall statistics keep counting it. This file
// proves that for every place the slice touched, and that the single-bean path
// is unchanged.

type BeanMixModule = typeof import('../public-src/shared/bean-mix.js');
type GrindModule = typeof import('../public-src/views/shots/grind.js');
type ShotUtils = typeof import('../public-src/views/shots/utils.js');
type AnalyticsShared = typeof import('../public-src/views/analytics/shared.js');
type BeanShelfModule = typeof import('../public-src/views/analytics/bean-shelf.js');
type SummaryModule = typeof import('../public-src/views/analytics-summary.js');
type BeanCardModule = typeof import('../public-src/views/library/bean-card.js');
type RankShot = Parameters<BeanShelfModule['_computeBeanRanking']>[0][number];
type BeanCardRow = Parameters<BeanCardModule['renderBeanCard']>[0];

let beanMix: BeanMixModule['beanMix'];
let isBeanMix: BeanMixModule['isBeanMix'];
let beanLabel: BeanMixModule['beanLabel'];
let calcComparativeGrindAdvice: GrindModule['calcComparativeGrindAdvice'];
let calcBestGrindCombosForBean: GrindModule['calcBestGrindCombosForBean'];
let suggestGrindDoseForBean: GrindModule['suggestGrindDoseForBean'];
let findPreviousShotForBean: ShotUtils['findPreviousShotForBean'];
let isNewestShotForBean: ShotUtils['isNewestShotForBean'];
let _beanGroup: AnalyticsShared['_beanGroup'];
let _computeBeanRanking: BeanShelfModule['_computeBeanRanking'];
let summaryLine: SummaryModule['summaryLine'];
let renderBeanCard: BeanCardModule['renderBeanCard'];

// These modules pull in state/index.ts and i18n.ts, which read
// localStorage/navigator at module load — stub the minimum, same approach as
// best-grind-combo.test.ts / grind-baseline.test.ts.
beforeAll(async () => {
  Object.defineProperty(globalThis, 'localStorage', {
    value: { getItem: () => null, setItem: () => {} },
    configurable: true, writable: true,
  });
  Object.defineProperty(globalThis, 'navigator', {
    value: { language: 'en' },
    configurable: true, writable: true,
  });
  // The bean shelf scores its rows through window.calcShotScore.
  Object.defineProperty(globalThis, 'window', {
    value: {
      calcShotScore: (shot: { score?: number | null }) => shot.score ?? null,
      getShotData: () => ({}),
    },
    configurable: true, writable: true,
  });
  ({ beanMix, isBeanMix, beanLabel } = await import('../public-src/shared/bean-mix.js'));
  ({ calcComparativeGrindAdvice, calcBestGrindCombosForBean, suggestGrindDoseForBean } =
    await import('../public-src/views/shots/grind.js'));
  ({ findPreviousShotForBean, isNewestShotForBean } = await import('../public-src/views/shots/utils.js'));
  ({ _beanGroup } = await import('../public-src/views/analytics/shared.js'));
  // bean-shelf.ts directly: views/analytics.ts pulls in chart.js for the whole
  // page, which this pure aggregation does not need.
  ({ _computeBeanRanking } = await import('../public-src/views/analytics/bean-shelf.js'));
  ({ summaryLine } = await import('../public-src/views/analytics-summary.js'));
  ({ renderBeanCard } = await import('../public-src/views/library/bean-card.js'));
});

function at<T>(arr: readonly T[], i: number): T {
  const v = arr[i];
  if (v === undefined) throw new Error(`missing element at index ${i}`);
  return v;
}

const MIX = [
  { beanId: 1, coffee: 'Bean A', grams: 10 },
  { beanId: 2, coffee: 'Bean B', grams: 8 },
];

describe('bean-mix helper', () => {
  it('returns the parts of a real mix', () => {
    expect(beanMix({ beanMix: MIX })).toEqual([
      { beanId: 1, coffee: 'Bean A', grams: 10 },
      { beanId: 2, coffee: 'Bean B', grams: 8 },
    ]);
    expect(isBeanMix({ beanMix: MIX })).toBe(true);
  });

  it('treats a single-bean annotation as no mix at all', () => {
    expect(beanMix({ coffee: 'Bean A' })).toBeNull();
    expect(beanMix({ coffee: 'Bean A', beanMix: null })).toBeNull();
    expect(beanMix(null)).toBeNull();
    expect(isBeanMix({ coffee: 'Bean A' })).toBe(false);
    // One part is not a mix — the same 2-part minimum as Go's BeanMix.
    expect(beanMix({ beanMix: [at(MIX, 0)] })).toBeNull();
    expect(isBeanMix({ beanMix: [at(MIX, 0)] })).toBe(false);
  });

  it('drops malformed parts and needs two good ones to keep the mix', () => {
    expect(beanMix({ beanMix: [{ coffee: 'Bean C', grams: 0 }, ...MIX] })).toHaveLength(2);
    expect(beanMix({ beanMix: [at(MIX, 0), { coffee: '', grams: 4 }] })).toBeNull();
  });

  it('labels a mix as "A + B", with grams on request', () => {
    expect(beanLabel({ beanMix: MIX })).toBe('Bean A + Bean B');
    expect(beanLabel({ beanMix: MIX }, true)).toBe('Bean A 10 g + Bean B 8 g');
  });

  it('labels a single-bean shot with its coffee name', () => {
    expect(beanLabel({ coffee: 'Bean A' })).toBe('Bean A');
    expect(beanLabel({ coffee: 'Bean A' }, true)).toBe('Bean A');
  });
});

// A single-bean shot on Bean A, as every function below would see it.
const single = (id: number, score: number, grindSetting = '18'): GrindShot => ({
  id,
  timestamp: 1000 + id,
  annotation: { beanId: 7, coffee: 'Bean A', grinder: 'Niche Zero', grindSetting, dose: '18' },
  score,
});

// The same bean and grinder, but recorded as a Bean A + Bean B mix whose
// primary bean is Bean A (top-level beanId/coffee stay the primary part).
const mixed = (id: number, score: number, grindSetting = '14'): GrindShot => ({
  ...single(id, score, grindSetting),
  annotation: {
    beanId: 7,
    coffee: 'Bean A',
    grinder: 'Niche Zero',
    grindSetting,
    dose: '18',
    beanMix: MIX,
  },
});

describe('grind learning ignores mixed shots (#1837)', () => {
  it('calcComparativeGrindAdvice gives a mixed shot no advice', () => {
    const shots = [single(1, 90), mixed(2, 95), single(3, 85)];
    expect(calcComparativeGrindAdvice(at(shots, 1), shots)).toBeNull();
  });

  it('calcComparativeGrindAdvice does not count mixed shots as comparable', () => {
    const target = single(1, 90);
    // A single-bean sibling still gives advice at its own grind; the mixed shot
    // at grind 14 contributes nothing.
    const advice = calcComparativeGrindAdvice(target, [target, mixed(2, 30), single(3, 88, '19')]);
    expect(advice).not.toBeNull();
    expect(advice?.shots.map(s => s.shot.id)).toEqual([3]);

    // Without a single-bean sibling there is nothing left to compare against.
    expect(calcComparativeGrindAdvice(target, [target, mixed(2, 30)])).toBeNull();
  });

  it('calcBestGrindCombosForBean ignores mixed shots', () => {
    // Three single-bean shots at grind 18 and three higher-scoring mixed shots
    // at grind 14: only the singles may form a combo.
    const singles = [single(1, 90), single(2, 88), single(3, 92)];
    const mixes = [mixed(4, 99), mixed(5, 99), mixed(6, 99)];
    const combos = calcBestGrindCombosForBean('Bean A', [...singles, ...mixes], 7);
    expect(combos).toHaveLength(1);
    expect(at(combos ?? [], 0)).toMatchObject({ grinder: 'Niche Zero', grindSetting: 18, shotCount: 3 });
  });

  it('suggestGrindDoseForBean never prefills from a mixed shot', () => {
    const library = { beans: [{ id: 7, name: 'Bean A' }] };
    const singles = [single(1, 90), single(2, 88), single(3, 91)];
    const mixes = [mixed(9, 99)];

    // preferMostRecent reads the latest Bean A shot — which is the mix; the
    // singles' own grind must win instead.
    const recent = suggestGrindDoseForBean('Bean A', library, [...singles, ...mixes], {
      preferMostRecent: true, beanId: 7,
    });
    expect(recent.grindSetting).toBe('18');

    // With only mixed shots there is nothing to learn from at all.
    expect(suggestGrindDoseForBean('Bean A', library, mixes, { preferMostRecent: true, beanId: 7 }))
      .toEqual({ grinder: '', grindSetting: '', dose: '' });
  });
});

describe('grind baseline ignores mixed shots (#1837)', () => {
  const beanShot = (id: number, grindSetting: string, timestamp: number): ShotLike => ({
    id, timestamp, annotation: { coffee: 'Bean A', grindSetting },
  });
  const mixShot = (id: number, grindSetting: string, timestamp: number): ShotLike => ({
    id, timestamp, annotation: { coffee: 'Bean A', grindSetting, beanMix: MIX },
  });

  it('findPreviousShotForBean never returns a mixed shot', () => {
    const shots = [beanShot(1, '18', 100), mixShot(2, '14', 200), beanShot(3, '19', 300)];
    expect(findPreviousShotForBean(shots, at(shots, 2))?.id).toBe(1);
    // A mixed shot has no baseline of its own.
    expect(findPreviousShotForBean(shots, at(shots, 1))).toBeNull();
  });

  it('isNewestShotForBean is false for a mixed shot', () => {
    const shots = [beanShot(1, '18', 100), mixShot(2, '14', 200)];
    expect(isNewestShotForBean(shots, at(shots, 1))).toBe(false);
    // A later mixed shot does not displace the older single-bean shot either.
    expect(isNewestShotForBean(shots, at(shots, 0))).toBe(true);
  });
});

describe('per-bean views skip mixed shots, overall stats keep them (#1837)', () => {
  let S: (typeof import('../public-src/state/index.js'))['S'];

  beforeEach(async () => {
    ({ S } = await import('../public-src/state/index.js'));
    S.currentLang = 'en';
    S.coffeeLibrary = {
      beans: [
        { id: 7, name: 'Bean A', roastDate: '2024-01-01', bags: [] },
        { id: 8, name: 'Bean B', roastDate: '2024-01-01', bags: [] },
      ],
      grinders: [],
    };
  });

  it('_beanGroup groups a single-bean shot but drops a mixed one', () => {
    const beans = [{ id: 7, name: 'Bean A' }, { id: 8, name: 'Bean B' }];
    expect(_beanGroup({ beanId: 7, coffee: 'Bean A' }, beans))
      .toEqual({ key: 'id:7', label: 'Bean A', beanId: 7 });
    expect(_beanGroup({ beanId: 7, coffee: 'Bean A', beanMix: MIX }, beans)).toBeNull();
  });

  it('the bean ranking leaves mixed shots out of the bean shot count', () => {
    const rankingShots: RankShot[] = [
      { id: 1, timestamp: 1001, score: 90, annotation: { beanId: 7, coffee: 'Bean A' } },
      { id: 2, timestamp: 1002, score: 60, annotation: { beanId: 7, coffee: 'Bean A', beanMix: MIX } },
    ];
    const rows = _computeBeanRanking(rankingShots);
    expect(rows).toHaveLength(1);
    expect(at(rows, 0)).toMatchObject({ name: 'Bean A', shots: 1, avgScore: 90 });
  });

  it('best bean of the period ignores mixed shots, the counts keep them', () => {
    const now = Date.UTC(2024, 2, 20, 12);
    const summaryShot = (id: number, beanId: number, coffee: string, score: number, mix?: typeof MIX): SummaryShot => ({
      id,
      timestamp: Math.floor(now / 1000) - id * 60,
      score,
      annotation: mix ? { beanId, coffee, beanMix: mix } : { beanId, coffee },
    });
    const shots = [
      summaryShot(1, 7, 'Bean A', 70),
      summaryShot(2, 7, 'Bean A', 72),
      summaryShot(3, 8, 'Bean B', 60),
      // Would lift Bean A's average to 81 if a mix counted as Bean A.
      summaryShot(4, 7, 'Bean A', 100, MIX),
    ];

    const scoreOf = (s: SummaryShot): number | null => (typeof s.score === 'number' ? s.score : null);
    const line = summaryLine(shots, scoreOf, now);
    // Overall statistics still count the mixed shot.
    expect(line.verdict.shots).toBe(4);
    // The best bean averages only the single-bean Bean A shots.
    expect(line.context).toEqual({ name: 'Bean A', avgScore: 71 });
  });

  it('the bean rating ignores the rating a mixed shot carries', () => {
    S.shots = [
      { id: 1, timestamp: 1001, annotation: { beanId: 7, coffee: 'Bean A', rating: '4' } },
      { id: 2, timestamp: 1002, annotation: { beanId: 7, coffee: 'Bean A', rating: '1', beanMix: MIX } },
    ];
    const bean: BeanCardRow = { id: 7, name: 'Bean A', bags: [] };

    // Only the single-bean 4-star shot counts, so the card shows 4.0, not 2.5.
    expect(renderBeanCard(bean, [bean])).toContain('lib-rating-num">4.0<');

    // A mix-only history leaves the bean unrated.
    S.shots = [
      { id: 2, timestamp: 1002, annotation: { beanId: 7, coffee: 'Bean A', rating: '1', beanMix: MIX } },
    ];
    expect(renderBeanCard(bean, [bean])).not.toContain('lib-rating-row');
  });

  it('the bean card shows the last single-bean grind, not a later mixed one', () => {
    S.shots = [
      { id: 1, timestamp: 1001, score: 90, annotation: { beanId: 7, coffee: 'Bean A', grinder: 'Niche Zero', grindSetting: '18' } },
      { id: 2, timestamp: 1002, score: 60, annotation: { beanId: 7, coffee: 'Bean A', grinder: 'Niche Zero', grindSetting: '14', beanMix: MIX } },
    ];
    const bean: BeanCardRow = {
      id: 7, name: 'Bean A', roastDate: '2024-01-01', bags: [],
    };

    const card = renderBeanCard(bean, [bean]);
    expect(card).toContain('Niche Zero @ 18');
    expect(card).not.toContain('Niche Zero @ 14');
  });
});
