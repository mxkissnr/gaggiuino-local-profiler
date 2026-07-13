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

  // #323: a missing target.start on the Decline Flow phase defaulted to 0,
  // making it render/run as an ASCENDING 0 -> 1.6 ml/s ramp instead of a
  // declining finish. start must now be a real flow value above end, taken
  // from the Ramp phase's own flow ceiling (its restriction).
  it('Decline Flow phase actually declines: target.start is above target.end, matching the Ramp restriction', () => {
    const decaf = suggestProfileFromBean({ name: 'Sertao', decaf: true });
    const other = suggestProfileFromBean({ name: 'Standard Washed' });
    const decafDecline = findPhase(decaf, 'Decline Flow');
    const otherDecline = findPhase(other, 'Decline Flow');
    expect(decafDecline.target.start).toBeGreaterThan(decafDecline.target.end);
    expect(otherDecline.target.start).toBeGreaterThan(otherDecline.target.end);
    expect(decafDecline.target.start).toBe(findPhase(decaf, 'Ramp').restriction);
    expect(otherDecline.target.start).toBe(findPhase(other, 'Ramp').restriction);
    expect(decafDecline.target.end).toBe(1.6);
    expect(otherDecline.target.end).toBe(1.6);
  });

  it('Bloom phase is adaptive: stops on pressureBelow 1.5 bar in addition to the 5s safety-net timeout', () => {
    const p = suggestProfileFromBean({ name: 'Washed Ethiopia' });
    expect(findPhase(p, 'Bloom').stopConditions).toEqual({ time: 5000, pressureBelow: 1.5 });
  });

  it('Ramp phase gets a channeling-protection restriction, tighter for gentle (decaf/natural) beans', () => {
    const decaf = suggestProfileFromBean({ name: 'Sertao', decaf: true });
    const other = suggestProfileFromBean({ name: 'Standard Washed' });
    expect(findPhase(decaf, 'Ramp').restriction).toBe(2);
    expect(findPhase(other, 'Ramp').restriction).toBe(3);
  });
});
