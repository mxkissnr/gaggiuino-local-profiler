import { describe, it, expect } from 'vitest';
import { suggestProfileFromBean } from '../public-src/profile-suggestion.js';

function findPhase(profile, name) {
  return profile.phases.find(p => p.name === name);
}

describe('suggestProfileFromBean', () => {
  it('always produces the fixed 4-phase Sertao skeleton', () => {
    const p = suggestProfileFromBean({ name: 'Washed Ethiopia' });
    expect(p.phases.map(ph => ph.name)).toEqual(['Preinfusion', 'Bloom', 'Ramp', 'Decline Flow']);
    expect(p.phases[0].type).toBe('FLOW');
    expect(p.phases[1].type).toBe('PRESSURE');
    expect(p.phases[2].type).toBe('PRESSURE');
    expect(p.phases[3].type).toBe('FLOW');
  });

  it('decaf beans get the longer 10s preinfusion, washed non-decaf gets 7s', () => {
    const decaf  = suggestProfileFromBean({ name: 'Sertao', decaf: true });
    const washed = suggestProfileFromBean({ name: 'Washed Bean', decaf: false, process: 'Washed' });
    expect(findPhase(decaf, 'Preinfusion').stopConditions.time).toBe(10000);
    expect(findPhase(washed, 'Preinfusion').stopConditions.time).toBe(7000);
  });

  it('natural process also gets the gentler 10s preinfusion (porous puck, same as decaf)', () => {
    const natural = suggestProfileFromBean({ name: 'Natural Bean', process: 'Natural' });
    expect(findPhase(natural, 'Preinfusion').stopConditions.time).toBe(10000);
  });

  it('decaf/natural beans get a lower ramp target pressure and lower water temperature', () => {
    const decaf = suggestProfileFromBean({ name: 'Sertao', decaf: true });
    const other = suggestProfileFromBean({ name: 'Standard Washed' });
    expect(findPhase(decaf, 'Ramp').target.end).toBe(7);
    expect(findPhase(other, 'Ramp').target.end).toBe(9);
    expect(findPhase(decaf, 'Decline Flow').restriction).toBe(7);
    expect(findPhase(other, 'Decline Flow').restriction).toBe(9);
    expect(decaf.waterTemperature).toBe(92);
    expect(other.waterTemperature).toBe(93);
  });

  it('uses default 18/36/2 recipe when the bean has no brewRatio', () => {
    const p = suggestProfileFromBean({ name: 'No Ratio Bean' });
    expect(p.recipe).toEqual({ coffeeIn: 18, coffeeOut: 36, ratio: 2 });
  });

  it('derives the recipe from bean.brewRatio when present', () => {
    const p = suggestProfileFromBean({ name: 'Ratio Bean', brewRatio: '1:2.2' });
    expect(p.recipe.ratio).toBe(2.2);
    expect(p.recipe.coffeeIn).toBe(18);
    expect(p.recipe.coffeeOut).toBeCloseTo(39.6, 5);
  });

  it('ignores an unparseable brewRatio and falls back to the default recipe', () => {
    const p = suggestProfileFromBean({ name: 'Weird Ratio Bean', brewRatio: 'strong' });
    expect(p.recipe).toEqual({ coffeeIn: 18, coffeeOut: 36, ratio: 2 });
  });

  // #323: globalStopConditions.weight used to hard-code a 2.2x multiplier
  // whenever brewRatio was set at all, ignoring its actual parsed value —
  // inconsistent with recipe.coffeeOut just above, which does use it.
  it('globalStopConditions weight uses the bean\'s own parsed ratio (coffeeIn * ratio), 2x default otherwise', () => {
    const withRatio    = suggestProfileFromBean({ name: 'A', brewRatio: '1:2.5' });
    const withoutRatio = suggestProfileFromBean({ name: 'B' });
    const unparseable   = suggestProfileFromBean({ name: 'C', brewRatio: 'strong' });
    expect(withRatio.globalStopConditions.weight).toBeCloseTo(18 * 2.5, 5);
    expect(withoutRatio.globalStopConditions.weight).toBe(18 * 2);
    expect(unparseable.globalStopConditions.weight).toBe(18 * 2);
  });

  // #328: #323's "fix" (target.start = Ramp restriction, declining numerically)
  // turned out to be a regression — Max's real "Sertão Decaf" and "Adaptive"
  // profiles both have target.start: 0 on this phase. Reverted; target.end
  // now branches 1.6 (gentle, matches Sertão Decaf) / 2.5 (else, matches
  // Adaptive), and restriction (a pressure ceiling on this FLOW phase) still
  // matches the Ramp phase's own peak pressure, per both real profiles.
  it('Decline Flow phase target.start is 0, target.end matches the real reference profiles', () => {
    const decaf = suggestProfileFromBean({ name: 'Sertao', decaf: true });
    const other = suggestProfileFromBean({ name: 'Standard Washed' });
    const decafDecline = findPhase(decaf, 'Decline Flow');
    const otherDecline = findPhase(other, 'Decline Flow');
    expect(decafDecline.target.start).toBe(0);
    expect(otherDecline.target.start).toBe(0);
    expect(decafDecline.target.end).toBe(1.6);
    expect(otherDecline.target.end).toBe(2.5);
    expect(decafDecline.restriction).toBe(findPhase(decaf, 'Ramp').target.end);
    expect(otherDecline.restriction).toBe(findPhase(other, 'Ramp').target.end);
  });

  // #328: reverted #323's speculative pressureBelow addition — neither real
  // reference profile has an adaptive/pressure-triggered bloom stop.
  it('Bloom phase is a plain fixed-time stop, no pressure trigger', () => {
    const p = suggestProfileFromBean({ name: 'Washed Ethiopia' });
    expect(findPhase(p, 'Bloom').stopConditions).toEqual({ time: 5000 });
  });

  // #328: reverted #323's speculative Ramp restriction — neither real
  // reference profile has a flow ceiling on the Ramp phase. Ramp duration
  // does genuinely differ between the two real profiles (4s gentle / 5s
  // else), so that's branched instead.
  it('Ramp phase has no flow-ceiling restriction; its duration matches the real reference profiles', () => {
    const decaf = suggestProfileFromBean({ name: 'Sertao', decaf: true });
    const other = suggestProfileFromBean({ name: 'Standard Washed' });
    expect(findPhase(decaf, 'Ramp').restriction).toBeUndefined();
    expect(findPhase(other, 'Ramp').restriction).toBeUndefined();
    expect(findPhase(decaf, 'Ramp').target.time).toBe(4000);
    expect(findPhase(other, 'Ramp').target.time).toBe(5000);
  });
});
