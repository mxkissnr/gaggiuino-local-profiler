// public-src/grind-scale.ts is the browser's copy of go/internal/grindscale —
// these cases mirror grindscale_test.go so the two cannot drift (#1961).
import { describe, it, expect } from 'vitest';
import {
  parseGrindScale, scaleForGrinder, inGrindRange, snapGrind, grindOnTarget,
  grindValues, numericGrind, normalizeGrindInput, prefillGrind, GRIND_REFERENCE_SPAN,
  parseGrind, formatGrind, grindPosition, storedGrindScale,
} from '../public-src/grind-scale.js';
import type { GrindScale } from '../public-src/grind-scale.js';

const STEPLESS_09: GrindScale = { type: 'stepless', min: 0, max: 9, step: 0.1 };
const STEPPED_60: GrindScale = { type: 'stepped', min: 0, max: 60, step: 1 };

describe('parseGrindScale', () => {
  const valid: Array<[string, unknown, unknown]> = [
    ['stepped', { type: 'stepped', min: 0, max: 60, step: 1 }, { type: 'stepped', min: 0, max: 60, step: 1 }],
    ['stepless', { type: 'stepless', min: 0, max: 9, step: 0.1 }, { type: 'stepless', min: 0, max: 9, step: 0.1 }],
    ['decimals in min', { type: 'stepless', min: 0.5, max: 9, step: 0.1 }, { type: 'stepless', min: 0.5, max: 9, step: 0.1 }],
    ['last span under the stepped cap', { type: 'stepped', min: 0, max: 499, step: 1 }, { type: 'stepped', min: 0, max: 499, step: 1 }],
  ];
  for (const [name, raw, want] of valid) {
    it(`accepts ${name}`, () => {
      expect(parseGrindScale(raw)).toEqual(want);
    });
  }

  const invalid: Array<[string, unknown]> = [
    ['not an object', 'stepped'],
    ['null', null],
    ['undefined', undefined],
    ['unknown type', { type: 'clicky', min: 0, max: 9, step: 0.1 }],
    ['missing type', { min: 0, max: 9, step: 0.1 }],
    ['missing min', { type: 'stepless', max: 9, step: 0.1 }],
    ['missing max', { type: 'stepless', min: 0, step: 0.1 }],
    ['missing step', { type: 'stepless', min: 0, max: 9 }],
    ['string number', { type: 'stepless', min: '0', max: 9, step: 0.1 }],
    ['negative min', { type: 'stepless', min: -1, max: 9, step: 0.1 }],
    ['max equals min', { type: 'stepless', min: 9, max: 9, step: 0.1 }],
    ['max below min', { type: 'stepless', min: 9, max: 0, step: 0.1 }],
    ['step zero', { type: 'stepless', min: 0, max: 9, step: 0 }],
    ['negative step', { type: 'stepless', min: 0, max: 9, step: -0.1 }],
    ['step larger than span', { type: 'stepless', min: 0, max: 1, step: 2 }],
    ['four decimals in step', { type: 'stepless', min: 0, max: 9, step: 0.0001 }],
    ['four decimals in min', { type: 'stepless', min: 0.0001, max: 9, step: 0.1 }],
    ['stepped span of 500 values', { type: 'stepped', min: 0, max: 500, step: 1 }],
    ['stepped span beyond 500 values', { type: 'stepped', min: 0, max: 1000, step: 1 }],
    ['NaN', { type: 'stepless', min: NaN, max: 9, step: 0.1 }],
    ['Infinity', { type: 'stepless', min: 0, max: Infinity, step: 0.1 }],
  ];
  for (const [name, raw] of invalid) {
    it(`rejects ${name}`, () => {
      expect(parseGrindScale(raw)).toBeNull();
    });
  }

  it('does not cap a stepless dial at 500 values', () => {
    expect(parseGrindScale({ type: 'stepless', min: 0, max: 1000, step: 0.1 })).not.toBeNull();
  });
});

describe('snapGrind', () => {
  it('rounds to the nearest valid setting and clamps to the range', () => {
    expect(snapGrind(STEPLESS_09, 8.34)).toBe(8.3);
    expect(snapGrind(STEPLESS_09, 8.36)).toBe(8.4);
    expect(snapGrind(STEPLESS_09, -1)).toBe(0);
    expect(snapGrind(STEPLESS_09, 12)).toBe(9);
  });

  it('honours a step that does not divide the span evenly', () => {
    expect(snapGrind({ type: 'stepped', min: 0, max: 9.5, step: 2 }, 9.4)).toBe(8);
  });

  it('never moves a value that is already valid', () => {
    for (const v of [0, 1, 33, 60]) expect(snapGrind(STEPPED_60, v)).toBe(v);
  });
});

describe('inGrindRange', () => {
  it('includes both ends', () => {
    expect(inGrindRange(STEPLESS_09, 0)).toBe(true);
    expect(inGrindRange(STEPLESS_09, 9)).toBe(true);
    expect(inGrindRange(STEPLESS_09, -0.1)).toBe(false);
    expect(inGrindRange(STEPLESS_09, 9.1)).toBe(false);
  });
});

describe('grindOnTarget', () => {
  it('uses the old fixed 0.6 without a scale', () => {
    expect(grindOnTarget(null, 0.59)).toBe(true);
    expect(grindOnTarget(null, 0.6)).toBe(false);
  });

  it('scales the tolerance with the dial', () => {
    // 1.2 * 0.1 = 0.12 beats 0.6 * 9 / 50 = 0.108.
    expect(grindOnTarget(STEPLESS_09, 0.11)).toBe(true);
    expect(grindOnTarget(STEPLESS_09, 0.13)).toBe(false);
    // 1.2 * 1 = 1.2 beats 0.6 * 60 / 50 = 0.72.
    expect(grindOnTarget(STEPPED_60, 1.19)).toBe(true);
    expect(grindOnTarget(STEPPED_60, 1.21)).toBe(false);
  });
});

describe('grindValues', () => {
  it('lists every valid setting in the stored number format', () => {
    expect(grindValues({ type: 'stepped', min: 0, max: 3, step: 1 })).toEqual(['0', '1', '2', '3']);
  });

  it('has no float noise on a fractional step', () => {
    expect(grindValues({ type: 'stepless', min: 0, max: 0.3, step: 0.1 })).toEqual(['0.0', '0.1', '0.2', '0.3']);
  });
});

describe('numericGrind', () => {
  it('reads a whole-string number, comma accepted', () => {
    expect(numericGrind('8')).toBe(8);
    expect(numericGrind('8.3')).toBe(8.3);
    expect(numericGrind(' 8,3 ')).toBe(8.3);
  });

  it('is null for anything that is not only a number', () => {
    expect(numericGrind('')).toBeNull();
    expect(numericGrind('abc')).toBeNull();
    expect(numericGrind('1.2.3')).toBeNull();
    expect(numericGrind('8 clicks')).toBeNull();
  });
});

describe('normalizeGrindInput', () => {
  it('stores a valid setting in the one number format', () => {
    expect(normalizeGrindInput(STEPLESS_09, '8,3')).toBe('8.3');
    expect(normalizeGrindInput(STEPLESS_09, '8.0')).toBe('8.0');
    expect(normalizeGrindInput(STEPLESS_09, '8.30')).toBe('8.3');
  });

  it('keeps an empty input empty', () => {
    expect(normalizeGrindInput(STEPLESS_09, '')).toBe('');
    expect(normalizeGrindInput(STEPLESS_09, '   ')).toBe('');
  });

  it('rejects an out-of-range, off-grid or non-numeric input', () => {
    expect(normalizeGrindInput(STEPLESS_09, '9.1')).toBeNull();
    expect(normalizeGrindInput(STEPLESS_09, '8.35')).toBeNull();
    expect(normalizeGrindInput(STEPLESS_09, 'abc')).toBeNull();
    expect(normalizeGrindInput(STEPLESS_09, '1.2.3')).toBeNull();
    expect(normalizeGrindInput(STEPLESS_09, '8 clicks')).toBeNull();
  });
});

describe('prefillGrind', () => {
  it('snaps a suggestion to the scale', () => {
    expect(prefillGrind(STEPPED_60, 33.5)).toBe('34');
    expect(prefillGrind(STEPLESS_09, 8.34)).toBe('8.3');
  });

  it('is empty for a value the scale cannot hold', () => {
    expect(prefillGrind(STEPLESS_09, 70)).toBe('');
    expect(prefillGrind(STEPLESS_09, -1)).toBe('');
    expect(prefillGrind(STEPLESS_09, null)).toBe('');
  });
});

describe('scaleForGrinder', () => {
  const grinders = [
    { name: 'Kingrinder K6', scale: { type: 'stepped', min: 0, max: 60, step: 1 } },
    { name: 'Lagom', scale: { type: 'stepless', min: 0, max: 9, step: 0.1 } },
    { name: 'Old Grinder' },
    { name: 'Broken Grinder', scale: { type: 'stepped', min: 5, max: 5, step: 1 } },
  ];

  it('matches the name case-insensitively and with surrounding space', () => {
    expect(scaleForGrinder(grinders, 'lagom')).toEqual({ type: 'stepless', min: 0, max: 9, step: 0.1 });
    expect(scaleForGrinder(grinders, '  KINGRINDER k6 ')).toEqual({ type: 'stepped', min: 0, max: 60, step: 1 });
  });

  it('is null for a grinder without a scale, an unknown name or garbage', () => {
    expect(scaleForGrinder(grinders, 'Old Grinder')).toBeNull();
    expect(scaleForGrinder(grinders, 'Broken Grinder')).toBeNull();
    expect(scaleForGrinder(grinders, 'Nope')).toBeNull();
    expect(scaleForGrinder(grinders, '')).toBeNull();
    expect(scaleForGrinder(undefined, 'Lagom')).toBeNull();
  });

  it('keeps the reference span the fixed numbers were sized for', () => {
    expect(GRIND_REFERENCE_SPAN).toBe(50);
  });
});

// #2225: multi-part dials. Mirrors the dial cases in grindscale_test.go.
const RING = parseGrindScale({ type: 'dial', parts: [{ count: null, start: 0 }, { count: 6, labels: 'number' }], min: '0.0', max: '12.5', stepless: true, resolution: 2 }) as GrindScale;
const RING_QUARTER = parseGrindScale({ type: 'dial', parts: [{ count: null }, { count: 6 }], min: '0.0', max: '12.5', stepless: true, resolution: 4 }) as GrindScale;
const ROTATION = parseGrindScale({ type: 'dial', parts: [{ count: null }, { count: 10 }, { count: 10 }], min: '0.0.0', max: '4.9.9' }) as GrindScale;
const SETTE = parseGrindScale({ type: 'dial', parts: [{ count: null, start: 1 }, { count: 9, labels: 'letter' }], min: '1A', max: '31I' }) as GrindScale;
const next = (scale: GrindScale, setting: string): string => prefillGrind(scale, (parseGrind(scale, setting) as number) + 1);

describe('dial scales (#2225)', () => {
  it('reads a dial scale as linear positions in its smallest unit', () => {
    expect(RING).toMatchObject({ type: 'dial', min: 0, max: 77, step: 0.5 });
    expect(ROTATION).toMatchObject({ type: 'dial', min: 0, max: 499, step: 1 });
    expect(SETTE).toMatchObject({ type: 'dial', min: 0, max: 278, step: 1 });
    expect(parseGrind(RING, '8.3,5')).toBe(51.5);
  });

  it('rejects a broken dial scale', () => {
    const parts = [{ count: null }, { count: 6 }];
    for (const raw of [
      { type: 'dial', parts: [{ count: null }], min: '0', max: '9' },
      { type: 'dial', parts: [{ count: 6 }, { count: 6 }], min: '0.0', max: '9.5' },
      { type: 'dial', parts: [{ count: null }, { count: 1 }], min: '0.0', max: '9.0' },
      { type: 'dial', parts: [{ count: null }, { count: 27, labels: 'letter' }], min: '0A', max: '9A' },
      { type: 'dial', parts, min: '9.0', max: '0.0' },
      { type: 'dial', parts, min: '0.0', max: '9.6' },
      { type: 'dial', parts, min: 0, max: 9 },
      { type: 'dial', parts, min: '0.0', max: '9.0', stepless: true, resolution: 3 },
    ]) expect(parseGrindScale(raw)).toBeNull();
  });

  it('steps a ring scale tick by tick: 8.5 is followed by 9.0', () => {
    expect(next(RING, '8.5')).toBe('9.0');
    expect(next(RING, '8.0')).toBe('8.1');
  });

  it('rejects a tick at or above the tick count', () => {
    expect(normalizeGrindInput(RING, '8.6')).toBeNull();
    expect(normalizeGrindInput(RING, '8.7')).toBeNull();
    expect(normalizeGrindInput(RING, '12.6')).toBeNull();
  });

  it('rewrites 8.25 on a stepless ring to 8.2,5', () => {
    expect(normalizeGrindInput(RING, '8.25')).toBe('8.2,5');
    expect(normalizeGrindInput(RING, '8.2,5')).toBe('8.2,5');
    expect(normalizeGrindInput(RING, '8')).toBe('8.0');
    expect(normalizeGrindInput(RING, '8.0')).toBe('8.0');
  });

  it('honours the resolution: half and quarter ticks', () => {
    expect(normalizeGrindInput(RING, '8.2,25')).toBeNull();
    expect(normalizeGrindInput(RING_QUARTER, '8.2,25')).toBe('8.2,25');
    expect(snapGrind(RING, 49.3)).toBe(49.5);
    expect(snapGrind(RING_QUARTER, 49.3)).toBe(49.25);
    expect(normalizeGrindInput(ROTATION, '1.2.3,5')).toBeNull();
  });

  it('carries a click into the next number and rotation: 1.9.9 is followed by 2.0.0', () => {
    expect(next(ROTATION, '1.9.9')).toBe('2.0.0');
    expect(normalizeGrindInput(ROTATION, '1.2')).toBe('1.2.0');
  });

  it('carries a letter into the next number: 12I is followed by 13A', () => {
    expect(next(SETTE, '12I')).toBe('13A');
    expect(normalizeGrindInput(SETTE, '12e')).toBe('12E');
    expect(normalizeGrindInput(SETTE, '12J')).toBeNull();
    expect(normalizeGrindInput(SETTE, '0I')).toBeNull();
    expect(normalizeGrindInput(SETTE, '12')).toBeNull();
  });

  it('sorts 8.3,5 between 8.3 and 8.4', () => {
    const order = ['8.4', '8.3,5', '8.3'].sort((a, b) => (parseGrind(RING, a) as number) - (parseGrind(RING, b) as number));
    expect(order).toEqual(['8.3', '8.3,5', '8.4']);
  });

  it('lists every reading of a dial in its stored form', () => {
    const small = parseGrindScale({ type: 'dial', parts: [{ count: null }, { count: 3 }], min: '1.1', max: '2.1', stepless: true, resolution: 2 }) as GrindScale;
    expect(grindValues(small)).toEqual(['1.1', '1.1,5', '1.2', '1.2,5', '2.0', '2.0,5', '2.1']);
  });

  it('stores a dial scale in its notation and an old scale unchanged', () => {
    expect(storedGrindScale(RING)).toEqual({ type: 'dial', parts: [{ count: null, start: 0 }, { count: 6, labels: 'number' }], min: '0.0', max: '12.5', stepless: true, resolution: 2 });
    expect(storedGrindScale(STEPLESS_09)).toEqual({ type: 'stepless', min: 0, max: 9, step: 0.1 });
    expect(parseGrindScale(storedGrindScale(SETTE))).toEqual(SETTE);
  });
});

describe('8.0 keeps its .0 (#2225)', () => {
  it('formats a one-part scale with the decimals of its step', () => {
    expect(formatGrind(STEPLESS_09, 8)).toBe('8.0');
    expect(prefillGrind(STEPLESS_09, 8)).toBe('8.0');
    expect(formatGrind(STEPPED_60, 8)).toBe('8');
  });

  it('writes every stepped part of a dial', () => {
    expect(prefillGrind(RING, 48)).toBe('8.0');
    expect(formatGrind(ROTATION, 100)).toBe('1.0.0');
  });
});

describe('grindPosition (#2225)', () => {
  it('reads free text as before without a scale or on a one-part scale', () => {
    expect(grindPosition(null, 'Setting 3.5')).toBe(3.5);
    expect(grindPosition(null, '8.2,5')).toBe(8.2);
    expect(grindPosition(STEPLESS_09, '8 clicks')).toBe(8);
    expect(grindPosition(null, 0)).toBe(0);
    expect(grindPosition(null, '  ')).toBeNull();
    expect(grindPosition(undefined, null)).toBeNull();
  });

  it('reads a dial setting through the scale first, with no free-text fallback', () => {
    expect(grindPosition(RING, '8.3,5')).toBe(51.5);
    expect(grindPosition(RING, 8.3)).toBe(51);
    expect(grindPosition(RING, 'Setting 8.3')).toBeNull();
    expect(grindPosition(SETTE, '13A')).toBe(108);
  });
});
