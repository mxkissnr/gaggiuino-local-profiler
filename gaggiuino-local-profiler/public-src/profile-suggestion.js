// Bean → machine-profile suggestion (#307).
//
// Max's own "Sertao Decaf" profile (score-98 shots, already running on his
// machine) has a structure he explicitly wants reused as-is for every bean:
// adaptive preinfusion (stops on time/pressure/volume, whichever comes
// first), a bloom pause, a linear pressure ramp, then a flow-target finish
// phase (named "Decline Flow" for the pressure trend it produces — see
// below). Only the *parameters* — temperature, target pressure, preinfusion
// duration, ratio — vary per bean, never the 4-phase skeleton itself.
//
// #328: every phase below is checked field-by-field against Max's actual
// exported "Sertão Decaf.json" (gentle/decaf reference) and "Adaptive.json"
// (non-gentle reference) profiles, after #323's "fix" to the Decline Flow
// phase turned out to be a regression — it assumed a literal high-to-low
// flow *target* makes a "declining finish", but both of Max's real,
// hardware-verified profiles have `target.start: 0` on that phase too. The
// "Decline" in the name refers to the shot's PRESSURE trend: once the
// preceding PRESSURE-type Ramp phase hits its peak, this FLOW-type phase
// takes over and lets pressure fall naturally (puck resistance drops
// through the shot) while commanding a modest, RISING flow-target curve —
// not a declining one. `restriction` on this phase is a pressure ceiling
// (matches the Ramp phase's own peak pressure in both real profiles) so the
// transition between phases has no step.
//
// WHY the decaf/natural branch differs: decaffeination and natural
// (dry-processed) beans both leave a more porous, uneven puck than a washed
// bean — decaffeination strips cell structure, natural processing leaves
// more fines and unevenly-dried mucilage. A porous/uneven puck channels
// easily under a fast, high-pressure hit, so it gets a gentler treatment:
// a longer preinfusion (more time to saturate evenly before pressure
// builds), a lower target ramp pressure, and a lower brew temperature
// (porous pucks extract faster, so a lower temp avoids over-extraction).
export function suggestProfileFromBean(bean) {
  const gentle = !!(bean?.decaf || bean?.process?.toLowerCase() === 'natural');

  const ratio = _parseBrewRatio(bean?.brewRatio);
  const coffeeIn  = 18;
  const coffeeOut = ratio ? Math.round(coffeeIn * ratio * 10) / 10 : 36;

  const rampPressure = gentle ? 7 : 9;

  return {
    name: bean?.name ? `${bean.name} (Vorschlag)` : 'Neues Profil',
    waterTemperature: gentle ? 92 : 93,
    recipe: {
      coffeeIn,
      coffeeOut,
      ratio: ratio || 2,
    },
    phases: [
      {
        name: 'Preinfusion',
        type: 'FLOW',
        target: { end: 2, curve: 'INSTANT' },
        restriction: 2,
        stopConditions: {
          time: gentle ? 10000 : 7000,
          pressureAbove: 2,
          waterPumpedInPhase: 50,
        },
      },
      {
        // #328: real profiles use a plain fixed-time bloom, no pressure-based
        // early stop — reverted the speculative pressureBelow addition.
        name: 'Bloom',
        type: 'PRESSURE',
        target: { start: 0, end: 0, curve: 'INSTANT' },
        stopConditions: { time: 5000 },
      },
      {
        name: 'Ramp',
        type: 'PRESSURE',
        // #328: ramp duration is 4s in Sertão Decaf (gentle) and 5s in
        // Adaptive (non-gentle) — branching it matches both real profiles
        // exactly, same pattern as the existing rampPressure/waterTemperature
        // split. Neither real profile puts a flow-ceiling restriction on
        // this phase (#323 had speculatively added one) — reverted.
        target: { start: 0, end: rampPressure, curve: 'LINEAR', time: gentle ? 4000 : 5000 },
        stopConditions: { time: gentle ? 4000 : 5000 },
      },
      {
        name: 'Decline Flow',
        type: 'FLOW',
        // #328: target.start reverted to 0 (matches both real profiles —
        // see the file-level comment on why "Decline" refers to the
        // pressure trend, not this phase's own flow-target curve).
        // target.end is 1.6 in Sertão Decaf (gentle) and 2.5 in Adaptive
        // (non-gentle) — branched the same way as rampPressure.
        target: { start: 0, end: gentle ? 1.6 : 2.5, curve: 'LINEAR', time: 25000 },
        // restriction is a pressure ceiling on a FLOW phase — matches the
        // Ramp phase's own peak pressure in both real profiles, avoiding a
        // pressure step between phases.
        restriction: rampPressure,
      },
    ],
    globalStopConditions: {
      // #323: was `bean?.brewRatio ? 2.2 : 2`, ignoring the actually-parsed
      // ratio while recipe.coffeeOut above already uses it — now consistent.
      weight: coffeeIn * (ratio || 2),
    },
  };
}

// bean.brewRatio is a free-text field like "1:2.2" (see beanFormBrewRatio in
// index.html) — returns the numeric part after the colon, or null if it
// can't be parsed as "1:<number>".
function _parseBrewRatio(brewRatio) {
  if (!brewRatio) return null;
  const m = String(brewRatio).trim().match(/^1\s*:\s*([\d.]+)$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}
