// #2225: the comparative advice, the best-combo list, the per-bean prefill and
// the dial-in steps read a multi-part dial as positions in its smallest unit
// and write every setting back in the dial's own notation.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { GrindShot } from '../public-src/views/shots/grind.js';
import { calcNextGrindSuggestion } from '../public-src/dialin-convergence.js';
import { formatGrind, normalizeGrindInput, parseGrindScale } from '../public-src/grind-scale.js';
import type { GrindScale } from '../public-src/grind-scale.js';

type GrindModule = typeof import('../public-src/views/shots/grind.js');
type StateModule = typeof import('../public-src/state/index.js');

let calcComparativeGrindAdvice: GrindModule['calcComparativeGrindAdvice'];
let calcBestGrindCombosForBean: GrindModule['calcBestGrindCombosForBean'];
let suggestGrindDoseForBean: GrindModule['suggestGrindDoseForBean'];
let S: StateModule['S'];

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

const RING = 'Lagom P64';
const ringScale = (resolution: 1 | 2 | 4, stepless = true) =>
  ({ type: 'dial', parts: [{ count: null, start: 0 }, { count: 6, labels: 'number' }], min: '0.0', max: '12.5', stepless, resolution });
const SETTE = 'Sette 270';
const SETTE_SCALE = { type: 'dial', parts: [{ count: null, start: 1 }, { count: 9, labels: 'letter' }], min: '1A', max: '31I' };

function useGrinders(grinders: { name: string; isDefault?: boolean; scale?: unknown }[]): void {
  S.coffeeLibrary = { grinders, beans: [] };
}

const shot = (id: number, score: number, grindSetting: string, grinder = RING): GrindShot => ({
  id,
  timestamp: 1000 + id,
  annotation: { beanId: 7, coffee: 'Bean A', grinder, grindSetting, dose: '18' },
  score,
});

describe('comparative advice on a ring dial (#2225)', () => {
  it('sorts 8.3,5 between 8.3 and 8.4 and names the reading', () => {
    useGrinders([{ name: RING, scale: ringScale(2) }]);
    const advice = calcComparativeGrindAdvice(shot(1, 50, '9.0'), [shot(2, 70, '8.3'), shot(3, 95, '8.3,5'), shot(4, 72, '8.4')]);
    expect(advice?.type).toBe('finer');
    expect(advice?.text).toContain('8.3,5');
    expect(advice?.shots.map(s => s.grind)).toEqual(['8.3,5', '8.4', '8.3']);
  });

  it('skips a sibling whose setting is not a reading of the dial', () => {
    useGrinders([{ name: RING, scale: ringScale(2) }]);
    const advice = calcComparativeGrindAdvice(shot(1, 50, '9.0'), [shot(2, 95, '8.7'), shot(3, 80, '8.4')]);
    expect(advice?.shots.map(s => s.grind)).toEqual(['8.4']);
  });
});

describe('best combo and prefill on a dial (#2225)', () => {
  it('names the best combo in the dial notation', () => {
    useGrinders([{ name: SETTE, scale: SETTE_SCALE }]);
    const shots = [shot(2, 90, '12E', SETTE), shot(3, 92, '12e', SETTE), shot(4, 88, '12E', SETTE)];
    expect(calcBestGrindCombosForBean('Bean A', shots)?.[0]).toMatchObject({ grinder: SETTE, grindSetting: '12E', shotCount: 3 });
  });

  it('prefills 8.0 with its .0 and a half tick with its comma', () => {
    useGrinders([{ name: RING, isDefault: true, scale: ringScale(2) }]);
    expect(suggestGrindDoseForBean('Bean A', S.coffeeLibrary, [shot(2, 90, '8.0')], { preferMostRecent: true, beanId: 7 }).grindSetting).toBe('8.0');
    expect(suggestGrindDoseForBean('Bean A', S.coffeeLibrary, [shot(2, 90, '8.2,5')], { preferMostRecent: true, beanId: 7 }).grindSetting).toBe('8.2,5');
  });
});

describe('dial-in steps on a ring dial (#2225)', () => {
  // 20 s is far below the 25-32 s band, so the next round goes finer.
  const fast = [{ grindSetting: 51, seconds: 20, channeling: false }];
  const next = (scale: GrindScale): number => calcNextGrindSuggestion(fast, scale).nextGrind as number;

  it('moves in whole, half or quarter ticks as the grinder is set up', () => {
    const whole = parseGrindScale(ringScale(1, false)) as GrindScale;
    const half = parseGrindScale(ringScale(2)) as GrindScale;
    const quarter = parseGrindScale(ringScale(4)) as GrindScale;
    expect(Number.isInteger(next(whole))).toBe(true);
    expect(Number.isInteger(next(half) * 2)).toBe(true);
    expect(Number.isInteger(next(quarter) * 4)).toBe(true);
    for (const scale of [whole, half, quarter]) {
      expect(next(scale)).toBeLessThan(51);
      const text = formatGrind(scale, next(scale));
      expect(normalizeGrindInput(scale, text)).toBe(text);
    }
  });
});
