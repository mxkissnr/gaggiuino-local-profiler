// Guided Dial-In convergence logic (#310) — pure, no DOM/state/i18n.
//
// A "round" is one dialed-in shot in a dial-in session:
//   { grindSetting: number, seconds: number, ratio?: number|null,
//     channeling?: boolean, score?: number|null }
//
// The extraction-time target band is 25–32s (mid 28.5s, the point step-size
// scaling is anchored to). A ±1s dead zone around the mid counts as "hold" —
// close enough that further grind changes would be chasing noise. Step size
// starts proportional to how far off the first round is, then behaves like a
// binary search: overshoot the band (direction flips) → halve the step;
// keep going the same direction → keep the step. Below the 0.3 floor (finer
// than most grinders can reliably resolve) further halving is pointless, so
// that's treated as converged too.

const BAND       = { low: 25, high: 32 };
const BAND_MID   = 28.5;
const DEAD_ZONE  = 1;
const STEP_FLOOR = 0.3;
const MAX_ROUNDS = 6;
const HIGH_SCORE = 80;
const HIGH_SCORE_GRIND_DIFF = 0.5;

function _classify(round) {
  if (round?.channeling) return { direction: 'channeling', error: null };
  const secs  = round?.seconds ?? 0;
  const error = secs - BAND_MID;
  const direction = Math.abs(error) <= DEAD_ZONE ? 'hold' : (error < 0 ? 'finer' : 'coarser');
  return { direction, error };
}

function _hasConsecutiveHolds(classified) {
  if (classified.length < 2) return false;
  const a = classified[classified.length - 2];
  const b = classified[classified.length - 1];
  return a.direction === 'hold' && b.direction === 'hold';
}

function _hasConsecutiveHighScores(rounds) {
  if (rounds.length < 2) return false;
  const a = rounds[rounds.length - 2];
  const b = rounds[rounds.length - 1];
  if (a?.score == null || b?.score == null) return false;
  if (a.score < HIGH_SCORE || b.score < HIGH_SCORE) return false;
  const ga = a.grindSetting, gb = b.grindSetting;
  if (typeof ga !== 'number' || typeof gb !== 'number') return false;
  return Math.abs(ga - gb) <= HIGH_SCORE_GRIND_DIFF;
}

// Replays the round history to derive the step size for the *next*
// suggestion. Channeling rounds are skipped (no direction, no step update).
function _computeStepSize(rounds, classified) {
  let step = null;
  let prevDirection = null;
  for (let i = 0; i < classified.length; i++) {
    const cls = classified[i];
    if (cls.direction === 'channeling') continue;
    if (step === null) {
      step = Math.min(2.0, Math.max(0.5, Math.abs(cls.error) / 6));
    } else if (cls.direction !== 'hold' && prevDirection && prevDirection !== 'hold' && cls.direction !== prevDirection) {
      step = step / 2;
    }
    if (cls.direction !== 'hold') prevDirection = cls.direction;
  }
  return step ?? 0.5;
}

export function isConverged(rounds) {
  if (!Array.isArray(rounds) || rounds.length === 0) return false;
  const classified = rounds.map(_classify);
  if (_hasConsecutiveHolds(classified) || _hasConsecutiveHighScores(rounds)) return true;
  const last = classified[classified.length - 1];
  if (last.direction !== 'channeling') {
    const step = _computeStepSize(rounds, classified);
    if (step < STEP_FLOOR) return true;
  }
  return rounds.length >= MAX_ROUNDS;
}

export function calcNextGrindSuggestion(rounds) {
  if (!Array.isArray(rounds) || rounds.length === 0) {
    return { type: 'insufficient-data', nextGrind: null, delta: 0, reason: 'dialin_no_rounds', band: BAND };
  }

  const classified = rounds.map(_classify);
  const lastRound  = rounds[rounds.length - 1];
  const last       = classified[classified.length - 1];

  if (_hasConsecutiveHolds(classified)) {
    return { type: 'converged', nextGrind: lastRound.grindSetting, delta: 0, reason: 'dialin_converged_hold', band: BAND };
  }
  if (_hasConsecutiveHighScores(rounds)) {
    return { type: 'converged', nextGrind: lastRound.grindSetting, delta: 0, reason: 'dialin_converged_score', band: BAND };
  }

  if (last.direction === 'channeling') {
    return { type: 'hold', nextGrind: lastRound.grindSetting, delta: 0, reason: 'dialin_channeling', band: BAND };
  }

  const step = _computeStepSize(rounds, classified);
  if (step < STEP_FLOOR) {
    return { type: 'converged', nextGrind: lastRound.grindSetting, delta: 0, reason: 'dialin_step_floor', band: BAND };
  }

  if (rounds.length >= MAX_ROUNDS) {
    return { type: 'insufficient-data', nextGrind: null, delta: 0, reason: 'dialin_safety_valve', band: BAND };
  }

  if (last.direction === 'hold') {
    return { type: 'hold', nextGrind: lastRound.grindSetting, delta: 0, reason: 'dialin_hold_repeat', band: BAND };
  }

  const delta     = last.direction === 'finer' ? -step : step;
  const nextGrind = Math.round((lastRound.grindSetting + delta) * 10) / 10;
  return {
    type: last.direction,
    nextGrind,
    delta: Math.round(delta * 10) / 10,
    reason: last.direction === 'finer' ? 'dialin_suggest_finer' : 'dialin_suggest_coarser',
    band: BAND,
  };
}
