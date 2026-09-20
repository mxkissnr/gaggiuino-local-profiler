import { describe, it, expect } from 'vitest';
import { calcNextGrindSuggestion, isConverged } from '../public-src/dialin-convergence.js';

describe('calcNextGrindSuggestion / isConverged', () => {
  it('a single shot inside the +-1s dead zone around 28.5s is a hold, not converged yet', () => {
    const rounds = [{ grindSetting: 20, seconds: 28 }];
    const r = calcNextGrindSuggestion(rounds);
    expect(r.type).toBe('hold');
    expect(r.delta).toBe(0);
    expect(r.nextGrind).toBe(20);
    expect(isConverged(rounds)).toBe(false);
  });

  it('halves the step size when the direction flips (overshoot / binary search)', () => {
    const round1 = { grindSetting: 20, seconds: 20 }; // too fast -> finer, error -8.5, step ~1.4167
    const r1 = calcNextGrindSuggestion([round1]);
    expect(r1.type).toBe('finer');
    expect(r1.nextGrind).toBe(18.6);

    const round2 = { grindSetting: r1.nextGrind, seconds: 35 }; // now too slow -> coarser, direction flip
    const r2 = calcNextGrindSuggestion([round1, round2]);
    expect(r2.type).toBe('coarser');
    // step halved from ~1.4167 to ~0.7083
    expect(r2.delta).toBeCloseTo(0.7, 1);
    expect(r2.nextGrind).toBeCloseTo(19.3, 1);
  });

  it('keeps the step size when the direction repeats', () => {
    const round1 = { grindSetting: 20, seconds: 20 }; // finer, step ~1.4167
    const r1 = calcNextGrindSuggestion([round1]);
    const round2 = { grindSetting: r1.nextGrind, seconds: 24 }; // still finer, error -4.5
    const r2 = calcNextGrindSuggestion([round1, round2]);
    expect(r2.type).toBe('finer');
    // step unchanged (~1.4167), not halved
    expect(r2.delta).toBeCloseTo(-1.4, 1);
    expect(r2.nextGrind).toBeCloseTo(17.2, 1);
  });

  it('converges on two consecutive holds', () => {
    const rounds = [
      { grindSetting: 20, seconds: 28 },
      { grindSetting: 20, seconds: 29 },
    ];
    expect(isConverged(rounds)).toBe(true);
    const r = calcNextGrindSuggestion(rounds);
    expect(r.type).toBe('converged');
    expect(r.reason).toBe('dialin_converged_hold');
  });

  it('converges on two consecutive scores >=80 with grind diff <=0.5, even without holds', () => {
    const rounds = [
      { grindSetting: 20,   seconds: 20, score: 82 },
      { grindSetting: 20.3, seconds: 20, score: 85 },
    ];
    expect(isConverged(rounds)).toBe(true);
    const r = calcNextGrindSuggestion(rounds);
    expect(r.type).toBe('converged');
    expect(r.reason).toBe('dialin_converged_score');
  });

  it('does not converge on high scores if the grind setting moved too much between them', () => {
    const rounds = [
      { grindSetting: 20,  seconds: 20, score: 82 },
      { grindSetting: 21,  seconds: 20, score: 85 },
    ];
    expect(isConverged(rounds)).toBe(false);
  });

  it('trips the 6-round safety valve to insufficient-data when nothing else converges', () => {
    const rounds = Array.from({ length: 6 }, (_, i) => ({
      grindSetting: 20 - i * 0.1,
      seconds: 15,   // always well outside the band, same direction every round -> never halves, never holds
      score: 50,
    }));
    expect(rounds.length).toBe(6);
    expect(isConverged(rounds)).toBe(true);
    const r = calcNextGrindSuggestion(rounds);
    expect(r.type).toBe('insufficient-data');
    expect(r.reason).toBe('dialin_safety_valve');
    expect(r.nextGrind).toBeNull();
  });

  it('a channeling round yields no direction (hold, zero magnitude) and is skipped for step-size purposes', () => {
    const round = { grindSetting: 20, seconds: 20, channeling: true };
    const r = calcNextGrindSuggestion([round]);
    expect(r.type).toBe('hold');
    expect(r.delta).toBe(0);
    expect(r.nextGrind).toBe(20);
    expect(r.reason).toBe('dialin_channeling');
    expect(isConverged([round])).toBe(false);

    // a channeling round in the middle of the sequence doesn't reset the
    // binary search: the step size right before and right after it should
    // be treated as the same "previous direction" for halving purposes.
    const round1 = { grindSetting: 20, seconds: 20 };               // finer, step ~1.4167
    const round2 = { grindSetting: 18.6, seconds: 99, channeling: true };
    const round3 = { grindSetting: 18.6, seconds: 24 };             // still finer, error -4.5
    const r3 = calcNextGrindSuggestion([round1, round2, round3]);
    expect(r3.type).toBe('finer');
    expect(r3.delta).toBeCloseTo(-1.4, 1);
  });
});
