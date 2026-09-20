import { describe, it, expect } from 'vitest';
import { suggestPhaseAdjustment, isProfileDialinConverged, applyPhaseAdjustment,
         profileDialinConvergenceReason } from '../public-src/profile-dialin-convergence.js';

function _profile() {
  return {
    name: 'Test',
    waterTemperature: 93,
    recipe: { coffeeIn: 18, coffeeOut: 36, ratio: 2 },
    phases: [
      { name: 'Preinfusion', type: 'FLOW', target: { end: 2, curve: 'INSTANT' }, restriction: 2,
        stopConditions: { time: 7000, pressureAbove: 2 } },
      { name: 'Ramp', type: 'PRESSURE', target: { start: 0, end: 9, curve: 'LINEAR', time: 4000 },
        restriction: 3, stopConditions: { time: 4000 } },
      { name: 'Decline Flow', type: 'FLOW', target: { end: 1.6, curve: 'LINEAR', time: 25000 },
        restriction: 9 },
    ],
  };
}

describe('suggestPhaseAdjustment', () => {
  it('balanced yields a hold with no field change', () => {
    const r = suggestPhaseAdjustment('balanced', _profile(), []);
    expect(r.type).toBe('hold');
    expect(r.field).toBeNull();
    expect(r.delta).toBe(0);
  });

  it('sour lengthens Preinfusion stop time first', () => {
    const r = suggestPhaseAdjustment('sour', _profile(), []);
    expect(r.type).toBe('adjust');
    expect(r.phaseName).toBe('Preinfusion');
    expect(r.field).toBe('stopConditions.time');
    expect(r.oldValue).toBe(7000);
    expect(r.newValue).toBe(8500);
    expect(r.delta).toBe(1500);
  });

  it('sour falls through to the Ramp pressure once preinfusion time is maxed', () => {
    const profile = _profile();
    profile.phases[0].stopConditions.time = 15000; // already at the sane limit
    const r = suggestPhaseAdjustment('sour', profile, []);
    expect(r.phaseName).toBe('Ramp');
    expect(r.field).toBe('target.end');
    expect(r.newValue).toBeGreaterThan(9); // clamps to max 9.5
  });

  it('bitter lowers waterTemperature first', () => {
    const r = suggestPhaseAdjustment('bitter', _profile(), []);
    expect(r.field).toBe('waterTemperature');
    expect(r.newValue).toBe(92);
    expect(r.delta).toBe(-1);
  });

  it('watery lowers recipe.ratio first', () => {
    const r = suggestPhaseAdjustment('watery', _profile(), []);
    expect(r.field).toBe('recipe.ratio');
    expect(r.newValue).toBeCloseTo(1.8, 5);
  });

  it('channeling lengthens Preinfusion stop time', () => {
    const r = suggestPhaseAdjustment('channeling', _profile(), []);
    expect(r.phaseName).toBe('Preinfusion');
    expect(r.field).toBe('stopConditions.time');
    expect(r.reason).toBe('profile_dialin_reason_channeling_preinf_time');
  });

  it('picks the single highest-priority symptom when multiple are selected (channeling > bitter/sour > watery)', () => {
    const r = suggestPhaseAdjustment(['watery', 'bitter', 'channeling'], _profile(), []);
    expect(r.symptom).toBe('channeling');
    expect(r.field).toBe('stopConditions.time');
  });

  it('bitter/sour tie resolves to a single symptom, still one adjustment', () => {
    const r = suggestPhaseAdjustment(['sour', 'bitter'], _profile(), []);
    expect(['sour', 'bitter']).toContain(r.symptom);
    expect(r.field).not.toBeNull();
  });

  it('a real symptom always outranks balanced when both are selected', () => {
    const r = suggestPhaseAdjustment(['balanced', 'watery'], _profile(), []);
    expect(r.symptom).toBe('watery');
  });

  // Both scenarios below force the ramp-pressure candidate (target.end) by
  // maxing out preinfusion time (for 'sour') or waterTemperature (for
  // 'bitter') so the field under test is each symptom's *second*-priority
  // candidate, with plenty of headroom left before its own min/max.
  it('halves the step size when the direction reverses vs. the previous round targeting the same field', () => {
    const p1 = _profile();
    p1.phases[0].stopConditions.time = 15000; // maxed -> sour falls through to ramp
    p1.phases[1].target.end = 7;
    const round1 = suggestPhaseAdjustment('sour', p1, []);
    expect(round1.field).toBe('target.end');
    expect(round1.delta).toBeCloseTo(0.8, 1); // baseStep 0.75, rounded to 0.1 precision
    const history = [{ symptom: 'sour', score: 60, appliedAdjustment: round1 }];

    const p2 = _profile();
    p2.waterTemperature = 85; // maxed -> bitter falls through to ramp
    p2.phases[1].target.end = round1.newValue;
    const round2 = suggestPhaseAdjustment('bitter', p2, history);
    expect(round2.field).toBe('target.end');
    expect(round2.delta).toBeLessThan(0); // bitter pushes ramp pressure DOWN — direction reversed
    expect(Math.abs(round2.delta)).toBeCloseTo(round1.delta / 2, 1); // halved
  });

  it('keeps the step size when the direction repeats for the same field', () => {
    const p1 = _profile();
    p1.phases[0].stopConditions.time = 15000;
    p1.phases[1].target.end = 7;
    const round1 = suggestPhaseAdjustment('sour', p1, []);
    expect(round1.field).toBe('target.end');

    const p2 = _profile();
    p2.phases[0].stopConditions.time = 15000;
    p2.phases[1].target.end = round1.newValue;
    const history = [{ symptom: 'sour', score: 60, appliedAdjustment: round1 }];
    const round2 = suggestPhaseAdjustment('sour', p2, history);
    expect(round2.field).toBe('target.end');
    expect(round2.delta).toBeCloseTo(round1.delta, 5);
  });

  it('returns at-limit when every candidate for the symptom is already maxed', () => {
    const p = _profile();
    p.phases[0].stopConditions.time = 15000;
    p.phases[1].target.end = 9.5;
    const r = suggestPhaseAdjustment('sour', p, []);
    expect(r.type).toBe('at-limit');
    expect(r.delta).toBe(0);
    expect(r.reason).toBe('profile_dialin_reason_at_limit');
  });
});

describe('applyPhaseAdjustment', () => {
  it('applies a phase-level field without mutating the input profile', () => {
    const profile = _profile();
    const suggestion = suggestPhaseAdjustment('sour', profile, []);
    const next = applyPhaseAdjustment(profile, suggestion);
    expect(profile.phases[0].stopConditions.time).toBe(7000);
    expect(next.phases[0].stopConditions.time).toBe(8500);
  });

  it('applies a profile-level field (waterTemperature)', () => {
    const profile = _profile();
    const suggestion = suggestPhaseAdjustment('bitter', profile, []);
    const next = applyPhaseAdjustment(profile, suggestion);
    expect(next.waterTemperature).toBe(92);
    expect(profile.waterTemperature).toBe(93);
  });
});

describe('isProfileDialinConverged / profileDialinConvergenceReason', () => {
  it('does not converge on an empty history', () => {
    expect(isProfileDialinConverged([])).toBe(false);
  });

  it('converges on two consecutive balanced rounds', () => {
    const rounds = [{ symptom: 'balanced', score: 70 }, { symptom: 'balanced', score: 72 }];
    expect(isProfileDialinConverged(rounds)).toBe(true);
    expect(profileDialinConvergenceReason(rounds)).toBe('profile_dialin_converged_balanced');
  });

  it('converges on two consecutive scores >=80, even with real symptoms', () => {
    const rounds = [{ symptom: 'sour', score: 81 }, { symptom: 'watery', score: 85 }];
    expect(isProfileDialinConverged(rounds)).toBe(true);
    expect(profileDialinConvergenceReason(rounds)).toBe('profile_dialin_converged_score');
  });

  it('does not converge on a single high score', () => {
    const rounds = [{ symptom: 'sour', score: 50 }, { symptom: 'bitter', score: 82 }];
    expect(isProfileDialinConverged(rounds)).toBe(false);
  });

  it('trips the 6-round safety valve when nothing else converges', () => {
    const rounds = Array.from({ length: 6 }, () => ({ symptom: 'bitter', score: 40 }));
    expect(isProfileDialinConverged(rounds)).toBe(true);
    expect(profileDialinConvergenceReason(rounds)).toBe('profile_dialin_safety_valve');
  });

  it('does not converge at 5 rounds without a balanced/score streak', () => {
    const rounds = Array.from({ length: 5 }, () => ({ symptom: 'bitter', score: 40 }));
    expect(isProfileDialinConverged(rounds)).toBe(false);
  });
});
