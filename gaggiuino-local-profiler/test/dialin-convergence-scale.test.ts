// #1961: with a grinder scale the dial-in steps are in that grinder's clicks —
// a 0..60 stepped dial moves 1..2 clicks per round, a 0..9 dial in 0.1 steps,
// and no scale keeps the old fixed numbers exactly (#1961, slice 3).
import { describe, it, expect } from 'vitest';
import { calcNextGrindSuggestion, isConverged } from '../public-src/dialin-convergence.js';
import type { DialinRound } from '../public-src/dialin-convergence.js';
import type { GrindScale } from '../public-src/grind-scale.js';

const stepped060: GrindScale = { type: 'stepped', min: 0, max: 60, step: 1 };
const stepless09: GrindScale = { type: 'stepless', min: 0, max: 9, step: 0.1 };

const fast = (grindSetting: number): DialinRound => ({ grindSetting, seconds: 20 });
const slow = (grindSetting: number): DialinRound => ({ grindSetting, seconds: 35 });

function onGrid(scale: GrindScale, v: number): boolean {
  const steps = (v - scale.min) / scale.step;
  return Math.abs(steps - Math.round(steps)) < 1e-9;
}

describe('calcNextGrindSuggestion on a grinder scale', () => {
  it('moves a 0..60 stepped dial in whole clicks inside its range', () => {
    const rounds: DialinRound[] = [fast(33)];
    for (let i = 0; i < 4; i++) {
      const r = calcNextGrindSuggestion(rounds, stepped060);
      expect(r.nextGrind).not.toBeNull();
      const next = r.nextGrind as number;
      expect(Number.isInteger(next)).toBe(true);
      expect(next).toBeGreaterThanOrEqual(0);
      expect(next).toBeLessThanOrEqual(60);
      // First move is around two clicks (1.2 * 1.4167 = 1.7), never below one.
      expect(Math.abs(r.delta)).toBeGreaterThanOrEqual(1);
      rounds.push({ grindSetting: next, seconds: 20 });
    }
  });

  it('moves a 0..9 dial in 0.1 steps and never by half a mark for a mild error', () => {
    const rounds: DialinRound[] = [fast(8.3)];
    for (let i = 0; i < 4; i++) {
      const r = calcNextGrindSuggestion(rounds, stepless09);
      const next = r.nextGrind as number;
      expect(onGrid(stepless09, next)).toBe(true);
      expect(Math.abs(next - (rounds.at(-1)?.grindSetting as number))).toBeGreaterThanOrEqual(0.1 - 1e-9);
      rounds.push({ grindSetting: next, seconds: 20 });
    }

    // 30 s is a mild error: the step is the old 0.5 unit, which on this dial is
    // under one mark, so it moves exactly one.
    const mild = calcNextGrindSuggestion([{ grindSetting: 8.3, seconds: 30 }], stepless09);
    expect(mild.delta).toBe(0.1);
    expect(mild.nextGrind).toBe(8.4);
  });

  it('gives three different answers to the same round on three dials', () => {
    const rounds = [fast(8.3)];
    const none = calcNextGrindSuggestion(rounds).nextGrind;
    const fine = calcNextGrindSuggestion(rounds, stepless09).nextGrind;
    const coarse = calcNextGrindSuggestion(rounds, stepped060).nextGrind;
    expect(new Set([none, fine, coarse]).size).toBe(3);
    expect(none).toBe(6.9);
    expect(fine).toBe(8);
    expect(coarse).toBe(6);
  });

  it('without a scale equals calling without the argument, field by field', () => {
    const sequences: DialinRound[][] = [
      [fast(20)],
      [fast(20), slow(18.6)],
      [fast(20), { grindSetting: 18.6, seconds: 24 }],
      [{ grindSetting: 20, seconds: 28 }, { grindSetting: 20, seconds: 29 }],
      [{ grindSetting: 20, seconds: 20, channeling: true }],
      [fast(20), slow(18.6), { grindSetting: 19, seconds: 29 }, { grindSetting: 19, seconds: 31 }],
    ];
    for (const rounds of sequences) {
      expect(calcNextGrindSuggestion(rounds, null)).toEqual(calcNextGrindSuggestion(rounds));
      expect(isConverged(rounds, null)).toBe(isConverged(rounds));
    }
  });

  it('holds at either end of the range instead of stepping past it', () => {
    const atMin = calcNextGrindSuggestion([{ grindSetting: 0, seconds: 20 }], stepless09);
    expect(atMin).toMatchObject({ type: 'hold', delta: 0, nextGrind: 0, reason: 'dialin_hold_repeat' });

    const atMax = calcNextGrindSuggestion([{ grindSetting: 9, seconds: 35 }], stepless09);
    expect(atMax).toMatchObject({ type: 'hold', delta: 0, nextGrind: 9, reason: 'dialin_hold_repeat' });
  });

  it('keeps an old round off the scale inside the range', () => {
    expect(calcNextGrindSuggestion([fast(12)], stepless09).nextGrind).toBeLessThanOrEqual(9);
    const offGrid = calcNextGrindSuggestion([fast(8.34)], stepless09).nextGrind as number;
    expect(onGrid(stepless09, offGrid)).toBe(true);
  });

  it('keeps the channeling, double-hold and safety-valve answers', () => {
    expect(calcNextGrindSuggestion([{ grindSetting: 8.3, seconds: 20, channeling: true }], stepless09).type).toBe('hold');
    expect(calcNextGrindSuggestion([
      { grindSetting: 8.3, seconds: 28 },
      { grindSetting: 8.3, seconds: 29 },
    ], stepless09).type).toBe('converged');
    const long = [10, 9, 8, 7, 6, 5].map(g => fast(g));
    const valve = calcNextGrindSuggestion(long, stepped060);
    expect(valve.type).toBe('insufficient-data');
    expect(valve.reason).toBe('dialin_safety_valve');
  });

  it('converges on two high scores one step apart, not on three steps apart', () => {
    const oneApart: DialinRound[] = [
      { grindSetting: 8.3, seconds: 20, score: 85 },
      { grindSetting: 8.4, seconds: 20, score: 85 },
    ];
    expect(isConverged(oneApart, stepless09)).toBe(true);

    const threeApart: DialinRound[] = [
      { grindSetting: 8.3, seconds: 20, score: 85 },
      { grindSetting: 8.6, seconds: 20, score: 85 },
    ];
    expect(isConverged(threeApart, stepless09)).toBe(false);
  });
});
