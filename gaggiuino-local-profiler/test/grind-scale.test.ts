// public-src/grind-scale.ts is the browser's copy of go/internal/grindscale —
// these cases mirror grindscale_test.go so the two cannot drift (#1961).
import { describe, it, expect } from 'vitest';
import {
  parseGrindScale, scaleForGrinder, inGrindRange, snapGrind, grindOnTarget,
  grindValues, numericGrind, normalizeGrindInput, prefillGrind, GRIND_REFERENCE_SPAN,
} from '../public-src/grind-scale.js';

const stepless09 = { type: 'stepless', min: 0, max: 9, step: 0.1 } as const;
const stepped060 = { type: 'stepped', min: 0, max: 60, step: 1 } as const;

describe('parseGrindScale', () => {
  it.each([
    ['stepped', { type: 'stepped', min: 0, max: 60, step: 1 }, { type: 'stepped', min: 0, max: 60, step: 1 }],
    ['stepless', { type: 'stepless', min: 0, max: 9, step: 0.1 }, { type: 'stepless', min: 0, max: 9, step: 0.1 }],
    ['decimals in min', { type: 'stepless', min: 0.5, max: 9, step: 0.1 }, { type: 'stepless', min: 0.5, max: 9, step: 0.1 }],
    ['last span under the stepped cap', { type: 'stepped', min: 0, max: 499, step: 1 }, { type: 'stepped', min: 0, max: 499, step: 1 }],
  ])('accepts %s', (_name, raw, want) => {
    expect(parseGrindScale(raw)).toEqual(want);
  });

  it.each([
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
  ])('rejects %s', (_name, raw) => {
    expect(parseGrindScale(raw)).toBeNull();
  });

  it('does not cap a stepless dial at 500 values', () => {
    expect(parseGrindScale({ type: 'stepless', min: 0, max: 1000, step: 0.1 })).not.toBeNull();
  });
});

describe('snapGrind', () => {
  it('rounds to the nearest valid setting and clamps to the range', () => {
    const s = stepless09);
    expect(snapGrind(s, 8.34)).toBe(8.3);
    expect(snapGrind(s, 8.36)).toBe(8.4);
    expect(snapGrind(s, -1)).toBe(0);
    expect(snapGrind(s, 12)).toBe(9);
  });

  it('honours a step that does not divide the span evenly', () => {
    expect(snapGrind({ type: 'stepped', min: 0, max: 9.5, step: 2 }), 9.4)).toBe(8);
  });

  it('never moves a value that is already valid', () => {
    const s = stepped060);
    for (const v of [0, 1, 33, 60]) expect(snapGrind(s, v)).toBe(v);
  });
});

describe('inGrindRange', () => {
  it('includes both ends', () => {
    const s = stepless09);
    expect(inGrindRange(s, 0)).toBe(true);
    expect(inGrindRange(s, 9)).toBe(true);
    expect(inGrindRange(s, -0.1)).toBe(false);
    expect(inGrindRange(s, 9.1)).toBe(false);
  });
});

describe('grindOnTarget', () => {
  it('uses the old fixed 0.6 without a scale', () => {
    expect(grindOnTarget(null, 0.59)).toBe(true);
    expect(grindOnTarget(null, 0.6)).toBe(false);
  });

  it('scales the tolerance with the dial', () => {
    // 1.2 * 0.1 = 0.12 vs 0.6 * 9 / 50 = 0.108 -> 0.12 wins
    const fine = stepless09);
    expect(grindOnTarget(fine, 0.11)).toBe(true);
    expect(grindOnTarget(fine, 0.13)).toBe(false);
    // 1.2 * 1 = 1.2 vs 0.6 * 60 / 50 = 0.72 -> 1.2 wins
    const coarse = stepped060);
    expect(grindOnTarget(coarse, 1.19)).toBe(true);
    expect(grindOnTarget(coarse, 1.21)).toBe(false);
  });
});

describe('grindValues', () => {
  it('lists every valid setting in the stored number format', () => {
    expect(grindValues({ type: 'stepped', min: 0, max: 3, step: 1 }))).toEqual(['0', '1', '2', '3']);
  });

  it('has no float noise on a fractional step', () => {
    expect(grindValues({ type: 'stepless', min: 0, max: 0.3, step: 0.1 }))).toEqual(['0', '0.1', '0.2', '0.3']);
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
    const s = stepless09);
    expect(normalizeGrindInput(s, '8,3')).toBe('8.3');
    expect(normalizeGrindInput(s, '8.0')).toBe('8');
    expect(normalizeGrindInput(s, '8.30')).toBe('8.3');
  });

  it('keeps an empty input empty', () => {
    expect(normalizeGrindInput(stepless09), '')).toBe('');
    expect(normalizeGrindInput(stepless09), '   ')).toBe('');
  });

  it('rejects an out-of-range, off-grid or non-numeric input', () => {
    const s = stepless09);
    expect(normalizeGrindInput(s, '9.1')).toBeNull();
    expect(normalizeGrindInput(s, '8.35')).toBeNull();
    expect(normalizeGrindInput(s, 'abc')).toBeNull();
    expect(normalizeGrindInput(s, '1.2.3')).toBeNull();
    expect(normalizeGrindInput(s, '8 clicks')).toBeNull();
  });
});

describe('prefillGrind', () => {
  it('snaps a suggestion to the scale', () => {
    expect(prefillGrind(stepped060), 33.5)).toBe('34');
    expect(prefillGrind(stepless09), 8.34)).toBe('8.3');
  });

  it('is empty for a value the scale cannot hold', () => {
    expect(prefillGrind(stepless09), 70)).toBe('');
    expect(prefillGrind(stepless09), -1)).toBe('');
    expect(prefillGrind(stepless09), null)).toBe('');
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
