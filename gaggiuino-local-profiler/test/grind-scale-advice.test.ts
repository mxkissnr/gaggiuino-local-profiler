// #1961 slice 3: the comparative advice, the best-combo list and the per-bean
// prefill all follow a grinder's own scale, and stay exactly as before when the
// grinder has none.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { GrindShot, GrindSuggestion } from '../public-src/views/shots/grind.js';

type GrindModule = typeof import('../public-src/views/shots/grind.js');
type StateModule = typeof import('../public-src/state/index.js');

let calcComparativeGrindAdvice: GrindModule['calcComparativeGrindAdvice'];
let calcBestGrindCombosForBean: GrindModule['calcBestGrindCombosForBean'];
let suggestGrindDoseForBean: GrindModule['suggestGrindDoseForBean'];
let S: StateModule['S'];
interface TestGrinder { name: string; isDefault?: boolean; scale?: unknown }
interface TestLibrary {
  grinders: TestGrinder[];
  beans?: { id?: unknown; name?: unknown; knownGrindSettings?: { grinder: string; grindSetting: string }[] }[];
}

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
  ({ calcComparativeGrindAdvice, calcBestGrindCombosForBean, suggestGrindDoseForBean } =
    await import('../public-src/views/shots/grind.js'));
  ({ S } = await import('../public-src/state/index.js'));
});

beforeEach(() => { S.currentLang = 'en'; });

const GRINDER = 'Lagom';
const STEPLESS = { type: 'stepless', min: 0, max: 9, step: 0.1 };
const K6 = 'Kingrinder K6';
const STEPPED = { type: 'stepped', min: 0, max: 60, step: 1 };

function useGrinders(grinders: TestGrinder[]): void {
  S.coffeeLibrary = { grinders, beans: [] } as unknown as typeof S.coffeeLibrary;
}

const shot = (id: number, score: number, grindSetting: string, grinder = GRINDER): GrindShot => ({
  id,
  timestamp: 1000 + id,
  annotation: { beanId: 7, coffee: 'Bean A', grinder, grindSetting, dose: '18' },
  score,
});

const viewed = (grindSetting: string): GrindShot => shot(1, 50, grindSetting);

describe('calcComparativeGrindAdvice on a grinder scale', () => {
  it('reports the best setting the grinder can actually reach', () => {
    useGrinders([{ name: GRINDER, scale: STEPLESS }]);
    const siblings = [shot(2, 90, '8.4'), shot(3, 60, '7.9')];
    const advice = calcComparativeGrindAdvice(viewed('9'), siblings);
    expect(advice?.type).toBe('finer');
    expect(advice?.text).toContain('8.4');
    expect(advice?.text).not.toContain('8.5');
  });

  it('halves to 8.5 when the grinder has no scale', () => {
    useGrinders([{ name: GRINDER }]);
    const siblings = [shot(2, 90, '8.4'), shot(3, 60, '7.9')];
    const advice = calcComparativeGrindAdvice(viewed('9'), siblings);
    expect(advice?.text).toContain('8.5');
  });

  it('leaves a sibling outside the range out of the comparison', () => {
    useGrinders([{ name: GRINDER, scale: STEPLESS }]);
    const siblings = [shot(2, 95, '12'), shot(3, 70, '8.2')];
    const advice = calcComparativeGrindAdvice(viewed('8.2'), siblings);
    expect(advice?.type).toBe('ok');
    expect(advice?.shots).toHaveLength(1);
  });

  it('keeps the on-target tolerance of one step', () => {
    useGrinders([{ name: GRINDER, scale: STEPLESS }]);
    const siblings = [shot(2, 90, '8.4'), shot(3, 60, '7.9')];
    expect(calcComparativeGrindAdvice(viewed('8.3'), siblings)?.type).toBe('ok');
    expect(calcComparativeGrindAdvice(viewed('8.0'), siblings)?.type).toBe('coarser');
  });

  it('treats 8 and 8.0 as one setting', () => {
    useGrinders([{ name: GRINDER, scale: STEPLESS }]);
    const shots = [shot(2, 90, '8'), shot(3, 91, '8.0'), shot(4, 89, '8.0')];
    const combos = calcBestGrindCombosForBean('Bean A', shots);
    expect(combos).toHaveLength(1);
    expect(combos?.[0]).toMatchObject({ grindSetting: 8, shotCount: 3 });
  });
});

describe('calcBestGrindCombosForBean on a grinder scale', () => {
  it('groups 33 and 33.4 into one whole-click combo', () => {
    useGrinders([{ name: K6, scale: STEPPED }]);
    const shots = [
      shot(2, 90, '33', K6),
      shot(3, 80, '33', K6),
      shot(4, 88, '33.4', K6),
    ];
    const combos = calcBestGrindCombosForBean('Bean A', shots);
    expect(combos).toHaveLength(1);
    expect(combos?.[0]).toMatchObject({ grinder: K6, grindSetting: 33, shotCount: 3 });
  });

  it('drops a combo outside the range', () => {
    useGrinders([{ name: K6, scale: STEPPED }]);
    const shots = Array.from({ length: 3 }, (_, i) => shot(10 + i, 95, '70', K6));
    expect(calcBestGrindCombosForBean('Bean A', shots)).toBeNull();
  });
});

describe('suggestGrindDoseForBean on a grinder scale', () => {
  function library(grinders: TestGrinder[], known: string): TestLibrary {
    return {
      grinders,
      beans: [{ id: 1, name: 'Bean A', knownGrindSettings: [{ grinder: grinders[0]?.name ?? '', grindSetting: known }] }],
    };
  }

  const suggest = (lib: TestLibrary): GrindSuggestion => suggestGrindDoseForBean('Bean A', lib, []);

  it('snaps a known setting to the default stepped grinder', () => {
    expect(suggest(library([{ name: K6, isDefault: true, scale: STEPPED }], '33.5')).grindSetting).toBe('34');
  });

  it('leaves a known setting empty when it is off the scale', () => {
    expect(suggest(library([{ name: K6, isDefault: true, scale: STEPPED }], '70')).grindSetting).toBe('');
  });

  it('reads the first number of a stored "8 clicks" on a stepless dial', () => {
    expect(suggest(library([{ name: GRINDER, isDefault: true, scale: STEPLESS }], '8 clicks')).grindSetting).toBe('8');
  });

  it('leaves a non-numeric known setting empty on a scaled grinder', () => {
    expect(suggest(library([{ name: GRINDER, isDefault: true, scale: STEPLESS }], 'abc')).grindSetting).toBe('');
  });

  it('returns the stored text untouched without a scale', () => {
    expect(suggest(library([{ name: K6, isDefault: true }], '33.5')).grindSetting).toBe('33.5');
    expect(suggest(library([{ name: GRINDER, isDefault: true }], '1.2.3')).grindSetting).toBe('1.2.3');
  });
});
