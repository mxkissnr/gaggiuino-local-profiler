import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { GrindShot, GrindAdvice } from '../public-src/views/shots/grind.js';
import type { ShotSeries } from '../public-src/utils.js';

// Taste tags (#1957, slice 3): a shot's own tag steers the two pieces of
// advice in the shot view — the single-shot time advice and the comparative
// advice against its siblings. A shot without a tag must read exactly as
// before, because nothing can set a tag from the UI until the next slice.

type GrindModule = typeof import('../public-src/views/shots/grind.js');
type I18nModule = typeof import('../public-src/i18n.js');
type StateModule = typeof import('../public-src/state/index.js');

let tasteTagOf: GrindModule['tasteTagOf'];
let calcGrindAdvice: GrindModule['calcGrindAdvice'];
let calcComparativeGrindAdvice: GrindModule['calcComparativeGrindAdvice'];
let TASTE_TAGS: GrindModule['TASTE_TAGS'];
let t: I18nModule['t'];
let S: StateModule['S'];

// grind.ts pulls in state/index.ts and i18n.ts, which read localStorage and
// navigator at module load — same stub as bean-mix-learning.test.ts.
beforeAll(async () => {
  Object.defineProperty(globalThis, 'localStorage', {
    value: { getItem: () => null, setItem: () => {} },
    configurable: true, writable: true,
  });
  Object.defineProperty(globalThis, 'navigator', {
    value: { language: 'en' },
    configurable: true, writable: true,
  });
  Object.defineProperty(globalThis, 'window', {
    value: {
      calcShotScore: (shot: { score?: number | null }) => shot.score ?? null,
      getShotData: () => ({}),
    },
    configurable: true, writable: true,
  });
  ({ tasteTagOf, calcGrindAdvice, calcComparativeGrindAdvice, TASTE_TAGS } =
    await import('../public-src/views/shots/grind.js'));
  ({ t } = await import('../public-src/i18n.js'));
  ({ S } = await import('../public-src/state/index.js'));
});

beforeEach(() => { S.currentLang = 'en'; });

// A flat 9-bar extraction; the weight curve stays empty unless a ratio
// warning is under test.
function series(weight: { x: number; y: number }[] = [], pressures: number[] = [9, 9, 9, 9, 9, 9]): ShotSeries {
  return {
    pressure: pressures.map((y, i) => ({ x: i, y })),
    weight,
  } as unknown as ShotSeries;
}

// Duration is in tenths of a second, as the shot rows store it.
function singleShot(duration: number, tag?: string | null): GrindShot {
  return {
    id: 1,
    duration,
    annotation: tag === undefined ? {} : { tasteTag: tag },
  };
}

interface Expectation { type: string; key?: string; args?: unknown[]; text?: string }

function expectAdvice(advice: GrindAdvice | null | undefined, expected: Expectation): void {
  const label = expected.key ?? expected.text ?? '';
  expect(advice).not.toBeNull();
  expect(advice?.type, label + ' type').toBe(expected.type);
  const want = expected.key !== undefined ? t(expected.key, ...(expected.args ?? [])) : expected.text;
  expect(advice?.text, label + ' text').toBe(want);
}

describe('tasteTagOf', () => {
  it('returns every valid tag', () => {
    for (const tag of TASTE_TAGS) expect(tasteTagOf({ tasteTag: tag })).toBe(tag);
  });

  it('treats absent and unknown values as no tag', () => {
    expect(tasteTagOf({})).toBeNull();
    expect(tasteTagOf({ tasteTag: '' })).toBeNull();
    expect(tasteTagOf({ tasteTag: 3 })).toBeNull();
    expect(tasteTagOf({ tasteTag: 'astringent' })).toBeNull();
    expect(tasteTagOf(null)).toBeNull();
    expect(tasteTagOf(undefined)).toBeNull();
  });
});

describe('calcGrindAdvice without a tag pins today\'s advice', () => {
  // Durations 15 s, 20 s, 30 s, 45 s and 55 s, each in its own advice band.
  const cases: { duration: number; type: string; text: string }[] = [
    { duration: 150, type: 'finer',   text: 'Shot too short (15 s) — grind finer' },
    { duration: 200, type: 'finer',   text: 'Shot slightly short (20 s) — grind slightly finer' },
    { duration: 300, type: 'ok',      text: 'Grind setting is good – 30 s, 9.0 bar Ø' },
    { duration: 450, type: 'coarser', text: 'Shot slightly long (45 s) — grind slightly coarser' },
    { duration: 550, type: 'coarser', text: 'Shot too long (55 s) — grind coarser' },
  ];

  it('gives the untagged result for every duration', () => {
    for (const c of cases) expectAdvice(calcGrindAdvice(singleShot(c.duration), series()), c);
  });

  it('treats an unknown tag as no tag', () => {
    for (const c of cases) {
      expectAdvice(calcGrindAdvice(singleShot(c.duration, 'astringent'), series()), c);
    }
  });

  it('stays null under 8 s, with or without a tag', () => {
    expect(calcGrindAdvice(singleShot(70), series())).toBeNull();
    expect(calcGrindAdvice(singleShot(70, 'sour'), series())).toBeNull();
  });
});

describe('calcGrindAdvice applies the tag to the time advice', () => {
  // Every cell of the slice's single-shot table: duration band × tag.
  const table: { duration: number; sour: Expectation; bitter: Expectation; balanced: Expectation; thin: Expectation }[] = [
    {
      // finer, far off: a needed grind change wins over a disagreeing taste.
      duration: 150,
      sour:     { type: 'finer', key: 'grind_short', args: ['15'] },
      bitter:   { type: 'finer', key: 'grind_short', args: ['15'] },
      balanced: { type: 'ok',    key: 'grind_taste_balanced', args: ['15'] },
      thin:     { type: 'finer', key: 'grind_short', args: ['15'] },
    },
    {
      // finer, slightly off: bitter contradicts it, balanced holds.
      duration: 200,
      sour:     { type: 'finer',   key: 'grind_short_slight', args: ['20'] },
      bitter:   { type: 'warning', key: 'grind_taste_conflict', args: ['20'] },
      balanced: { type: 'ok',      key: 'grind_taste_balanced', args: ['20'] },
      thin:     { type: 'finer',   key: 'grind_short_slight', args: ['20'] },
    },
    {
      // ok: the taste alone picks the direction.
      duration: 300,
      sour:     { type: 'finer',   key: 'grind_taste_finer' },
      bitter:   { type: 'coarser', key: 'grind_taste_coarser' },
      balanced: { type: 'ok',      text: 'Grind setting is good – 30 s, 9.0 bar Ø' },
      thin:     { type: 'ok',      key: 'grind_taste_thin' },
    },
    {
      // coarser, slightly off: sour contradicts it, balanced holds.
      duration: 450,
      sour:     { type: 'warning', key: 'grind_taste_conflict', args: ['45'] },
      bitter:   { type: 'coarser', key: 'grind_long_slight', args: ['45'] },
      balanced: { type: 'ok',      key: 'grind_taste_balanced', args: ['45'] },
      thin:     { type: 'coarser', key: 'grind_long_slight', args: ['45'] },
    },
    {
      // coarser, far off: the needed grind change wins again.
      duration: 550,
      sour:     { type: 'coarser', key: 'grind_long', args: ['55'] },
      bitter:   { type: 'coarser', key: 'grind_long', args: ['55'] },
      balanced: { type: 'ok',      key: 'grind_taste_balanced', args: ['55'] },
      thin:     { type: 'coarser', key: 'grind_long', args: ['55'] },
    },
  ];

  it('follows the table for every duration and tag', () => {
    for (const row of table) {
      for (const tag of ['sour', 'bitter', 'balanced', 'thin'] as const) {
        const expected = row[tag];
        expectAdvice(calcGrindAdvice(singleShot(row.duration, tag), series()), expected);
      }
    }
  });

  it('never overrides the channeling warning', () => {
    // 9 → 6 bar within one second is channeling.
    const channeling = series([], [9, 9, 9, 9, 9, 6]);
    for (const tag of ['sour', 'bitter', 'balanced', 'thin'] as const) {
      expectAdvice(calcGrindAdvice(singleShot(300, tag), channeling),
        { type: 'warning', key: 'grind_channeling_full' });
    }
  });

  it('never overrides the ratio warning', () => {
    // 60 g out of 18 g in is 1:3.3, well above the window.
    const withTag = (tag: string): GrindShot => ({ id: 1, duration: 300, annotation: { dose: '18', tasteTag: tag } });
    for (const tag of ['sour', 'bitter', 'balanced', 'thin'] as const) {
      expectAdvice(calcGrindAdvice(withTag(tag), series([{ x: 30, y: 60 }])),
        { type: 'warning', key: 'dialin_ratio_high', args: ['3.3'] });
    }
  });
});

// One Bean A sibling on the Niche Zero; the tag is optional.
function sibling(id: number, score: number, grindSetting: string, tag?: string, grinder = 'Niche Zero'): GrindShot {
  return {
    id,
    timestamp: 1000 + id,
    annotation: {
      beanId: 7, coffee: 'Bean A', grinder, grindSetting, dose: '18',
      ...(tag === undefined ? {} : { tasteTag: tag }),
    },
    score,
  };
}

// The shot being viewed: never part of its own comparison, so its score is
// irrelevant.
function viewed(grindSetting: string, tag?: string): GrindShot {
  return sibling(1, 50, grindSetting, tag);
}

// Two siblings that are comparable, both at dose 18 on the viewed shot's
// grinder: one best setting at grind 20 (score 90), one worse at 24 (score 60).
const BEST = 20;
const BEST_SCORE = 90;
const siblings = (): GrindShot[] => [sibling(2, BEST_SCORE, '20'), sibling(3, 60, '24')];

describe('calcComparativeGrindAdvice without a tag pins today\'s advice', () => {
  it('reports the finer, coarser and on-target cases as before', () => {
    expectAdvice(calcComparativeGrindAdvice(viewed('24'), siblings()),
      { type: 'finer', key: 'grind_comparative_finer', args: [2, BEST, BEST_SCORE] });
    expectAdvice(calcComparativeGrindAdvice(viewed('16'), siblings()),
      { type: 'coarser', key: 'grind_comparative_coarser', args: [2, BEST, BEST_SCORE] });
    expectAdvice(calcComparativeGrindAdvice(viewed('20'), siblings()),
      { type: 'ok', key: 'grind_comparative_ok', args: [2, BEST, BEST_SCORE] });
  });

  it('keeps grind_comparative_ok for a sour shot with no current grind setting', () => {
    expectAdvice(calcComparativeGrindAdvice(viewed('', 'sour'), siblings()),
      { type: 'ok', key: 'grind_comparative_ok', args: [2, BEST, BEST_SCORE] });
  });
});

describe('calcComparativeGrindAdvice applies the tag', () => {
  // Every cell of the slice's comparative table: current tag × grind direction.
  const table: Record<string, { none: Expectation; finer: Expectation; coarser: Expectation }> = {
    sour: {
      none:    { type: 'finer', key: 'grind_comparative_taste_finer', args: [2, BEST, BEST_SCORE] },
      finer:   { type: 'finer', key: 'grind_comparative_finer', args: [2, BEST, BEST_SCORE] },
      coarser: { type: 'ok',    key: 'grind_comparative_taste_conflict', args: [2, BEST, BEST_SCORE] },
    },
    bitter: {
      none:    { type: 'coarser', key: 'grind_comparative_taste_coarser', args: [2, BEST, BEST_SCORE] },
      finer:   { type: 'ok',      key: 'grind_comparative_taste_conflict', args: [2, BEST, BEST_SCORE] },
      coarser: { type: 'coarser', key: 'grind_comparative_coarser', args: [2, BEST, BEST_SCORE] },
    },
    balanced: {
      none:    { type: 'ok', key: 'grind_comparative_ok', args: [2, BEST, BEST_SCORE] },
      finer:   { type: 'ok', key: 'grind_comparative_taste_hold', args: [2, BEST, BEST_SCORE] },
      coarser: { type: 'ok', key: 'grind_comparative_taste_hold', args: [2, BEST, BEST_SCORE] },
    },
    thin: {
      none:    { type: 'ok',      key: 'grind_comparative_ok', args: [2, BEST, BEST_SCORE] },
      finer:   { type: 'finer',   key: 'grind_comparative_finer', args: [2, BEST, BEST_SCORE] },
      coarser: { type: 'coarser', key: 'grind_comparative_coarser', args: [2, BEST, BEST_SCORE] },
    },
  };
  const dirGrind = { none: '20', finer: '24', coarser: '16' } as const;

  it('follows the table for every tag and direction', () => {
    for (const [tag, cells] of Object.entries(table)) {
      for (const dir of ['none', 'finer', 'coarser'] as const) {
        const advice = calcComparativeGrindAdvice(viewed(dirGrind[dir], tag), siblings());
        expectAdvice(advice, cells[dir]);
      }
    }
  });

  it('drops a sour sibling at the highest score from the ranking', () => {
    // Sibling ids 2 (sour, 99 at grind 18) and 3 (95 at grind 20) plus 4 (60 at
    // grind 22). Ranked, the best setting moves from 18 to 20 and both the
    // count and the thumbnail list lose the sour shot.
    const all = [sibling(2, 99, '18', 'sour'), sibling(3, 95, '20'), sibling(4, 60, '22')];
    const advice = calcComparativeGrindAdvice(viewed('20'), all);
    expectAdvice(advice, { type: 'ok', key: 'grind_comparative_ok', args: [2, 20, 95] });
    expect(advice?.shots.map(s => s.shot.id)).toEqual([3, 4]);
  });

  it('keeps balanced and thin siblings in the ranking', () => {
    const all = [sibling(2, 99, '18', 'balanced'), sibling(3, 60, '22', 'thin')];
    const advice = calcComparativeGrindAdvice(viewed('20'), all);
    expectAdvice(advice, { type: 'finer', key: 'grind_comparative_finer', args: [2, 18, 99] });
    expect(advice?.shots.map(s => s.shot.id)).toEqual([2, 3]);
  });

  it('falls back to every sibling when all of them are sour or bitter', () => {
    const tagged = [sibling(2, 99, '18', 'sour'), sibling(3, 60, '22', 'bitter')];
    const untagged = [sibling(2, 99, '18'), sibling(3, 60, '22')];
    const withTags = calcComparativeGrindAdvice(viewed('20'), tagged);
    const without = calcComparativeGrindAdvice(viewed('20'), untagged);
    expect(withTags?.type).toBe(without?.type);
    expect(withTags?.text).toBe(without?.text);
    expect(withTags?.shots).toHaveLength(2);
  });

  it('ignores a tagged sibling on another grinder', () => {
    // Another grinder's numbers are a different scale — the sibling was never
    // comparable, tagged or not.
    const onlyOther = [sibling(2, 99, '18', 'balanced', 'DF64')];
    expect(calcComparativeGrindAdvice(viewed('20', 'sour'), onlyOther)).toBeNull();

    const withOther = [...siblings(), ...onlyOther];
    const without = calcComparativeGrindAdvice(viewed('20', 'sour'), siblings());
    const advice = calcComparativeGrindAdvice(viewed('20', 'sour'), withOther);
    expect(advice?.type).toBe(without?.type);
    expect(advice?.text).toBe(without?.text);
    expect(advice?.shots).toHaveLength(2);
  });
});
