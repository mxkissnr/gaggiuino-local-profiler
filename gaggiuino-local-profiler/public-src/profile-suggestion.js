// Bean → machine-profile suggestion (#307).
//
// Max's own "Sertao Decaf" profile (score-98 shots, already running on his
// machine) has a structure he explicitly wants reused as-is for every bean:
// adaptive preinfusion (stops on time/pressure/volume, whichever comes
// first), a bloom pause, a linear pressure ramp, then a declining-flow
// finish. Only the *parameters* — temperature, target pressure, preinfusion
// duration, ratio — vary per bean, never the 4-phase skeleton itself.
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
        name: 'Bloom',
        type: 'PRESSURE',
        target: { start: 0, end: 0, curve: 'INSTANT' },
        stopConditions: { time: 5000 },
      },
      {
        name: 'Ramp',
        type: 'PRESSURE',
        target: { start: 0, end: rampPressure, curve: 'LINEAR', time: 4000 },
        stopConditions: { time: 4000 },
      },
      {
        name: 'Decline Flow',
        type: 'FLOW',
        target: { end: 1.6, curve: 'LINEAR', time: 25000 },
        restriction: rampPressure,
      },
    ],
    globalStopConditions: {
      weight: coffeeIn * (bean?.brewRatio ? 2.2 : 2),
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
