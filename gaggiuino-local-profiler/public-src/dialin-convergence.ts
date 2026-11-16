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
// that's treated as converged too. With a grinder scale (#1961) the steps are
// multiplied by the dial's span over 50, moved at least one valid step and
// snapped into range.

import { GRIND_REFERENCE_SPAN, snapGrind } from './grind-scale.js';
import type { GrindScale } from './grind-scale.js';

const BAND       = { low: 25, high: 32 };
const BAND_MID   = 28.5;
const DEAD_ZONE  = 1;
const STEP_FLOOR = 0.3;
const MAX_ROUNDS = 6;
const HIGH_SCORE = 80;
const HIGH_SCORE_GRIND_DIFF = 0.5;

// #1961: the fixed numbers below are in units of a 50-mark dial.
function _dialFactor(scale: GrindScale): number {
  return (scale.max - scale.min) / GRIND_REFERENCE_SPAN;
}

export interface DialinRound {
  grindSetting?: number | null;
  seconds?: number | null;
  ratio?: number | null;
  channeling?: boolean;
  score?: number | null;
}

export interface DialinSuggestion {
  type: string;
  nextGrind: number | null;
  delta: number;
  reason: string;
  band: { low: number; high: number };
}

/**
 * A round's direction plus how far off the 25-32s band it was. Channeling
 * rounds carry no error (they contribute no direction and no step update).
 */
type ClassifiedRound =
  | { direction: 'channeling'; error: null }
  | { direction: 'hold' | 'finer' | 'coarser'; error: number };

function _classify(round: DialinRound | null | undefined): ClassifiedRound {
  if (round?.channeling) return { direction: 'channeling', error: null };
  const secs  = round?.seconds ?? 0;
  const error = secs - BAND_MID;
  const direction = Math.abs(error) <= DEAD_ZONE ? 'hold' : (error < 0 ? 'finer' : 'coarser');
  return { direction, error };
}

function _hasConsecutiveHolds(classified: ClassifiedRound[]): boolean {
  if (classified.length < 2) return false;
  const a = classified[classified.length - 2];
  const b = classified[classified.length - 1];
  if (!a || !b) return false;
  return a.direction === 'hold' && b.direction === 'hold';
}

function _hasConsecutiveHighScores(rounds: DialinRound[], scale?: GrindScale | null): boolean {
  if (rounds.length < 2) return false;
  const a = rounds[rounds.length - 2];
  const b = rounds[rounds.length - 1];
  if (!a || !b) return false;
  if (a.score == null || b.score == null) return false;
  if (a.score < HIGH_SCORE || b.score < HIGH_SCORE) return false;
  const ga = a.grindSetting, gb = b.grindSetting;
  if (typeof ga !== 'number' || typeof gb !== 'number') return false;
  const limit = scale ? Math.max(HIGH_SCORE_GRIND_DIFF * _dialFactor(scale), scale.step) + 1e-9 : HIGH_SCORE_GRIND_DIFF;
  return Math.abs(ga - gb) <= limit;
}

// Replays the round history to derive the step size for the *next*
// suggestion. Channeling rounds are skipped (no direction, no step update).
function _computeStepSize(rounds: DialinRound[], classified: ClassifiedRound[]): number {
  let step: number | null = null;
  let prevDirection: string | null = null;
  for (const cls of classified) {
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

export function isConverged(rounds: DialinRound[] | null | undefined, scale?: GrindScale | null): boolean {
  if (!Array.isArray(rounds) || rounds.length === 0) return false;
  const classified = rounds.map(_classify);
  if (_hasConsecutiveHolds(classified) || _hasConsecutiveHighScores(rounds, scale)) return true;
  const last = classified.at(-1);
  if (!last) return false;
  if (last.direction !== 'channeling') {
    const step = _computeStepSize(rounds, classified);
    if (step < STEP_FLOOR) return true;
  }
  return rounds.length >= MAX_ROUNDS;
}

export function calcNextGrindSuggestion(rounds: DialinRound[] | null | undefined, scale?: GrindScale | null): DialinSuggestion {
  if (!Array.isArray(rounds) || rounds.length === 0) {
    return { type: 'insufficient-data', nextGrind: null, delta: 0, reason: 'dialin_no_rounds', band: BAND };
  }

  const classified = rounds.map(_classify);
  const lastRound  = rounds.at(-1);
  const last       = classified.at(-1);
  if (!lastRound || !last) return { type: 'insufficient-data', nextGrind: null, delta: 0, reason: 'dialin_no_rounds', band: BAND };
  // Rounds the wizard writes always carry a numeric grindSetting; DialinRound
  // marks it optional only because it also types the persisted session shape.
  const recorded   = lastRound.grindSetting as number;
  // #1961: every suggestion below names lastGrind or a step from it, so an old
  // round off the scale cannot produce an invalid value.
  const lastGrind  = scale ? snapGrind(scale, recorded) : recorded;

  if (_hasConsecutiveHolds(classified)) {
    return { type: 'converged', nextGrind: lastGrind, delta: 0, reason: 'dialin_converged_hold', band: BAND };
  }
  if (_hasConsecutiveHighScores(rounds, scale)) {
    return { type: 'converged', nextGrind: lastGrind, delta: 0, reason: 'dialin_converged_score', band: BAND };
  }

  if (last.direction === 'channeling') {
    return { type: 'hold', nextGrind: lastGrind, delta: 0, reason: 'dialin_channeling', band: BAND };
  }

  const step = _computeStepSize(rounds, classified);
  if (step < STEP_FLOOR) {
    return { type: 'converged', nextGrind: lastGrind, delta: 0, reason: 'dialin_step_floor', band: BAND };
  }

  if (rounds.length >= MAX_ROUNDS) {
    return { type: 'insufficient-data', nextGrind: null, delta: 0, reason: 'dialin_safety_valve', band: BAND };
  }

  if (last.direction === 'hold') {
    return { type: 'hold', nextGrind: lastGrind, delta: 0, reason: 'dialin_hold_repeat', band: BAND };
  }

  if (scale) {
    const move = Math.max(scale.step, step * _dialFactor(scale));
    const nextGrind = snapGrind(scale, last.direction === 'finer' ? lastGrind - move : lastGrind + move);
    // At the end of the range there is no further step in this direction.
    if (nextGrind === lastGrind) {
      return { type: 'hold', nextGrind: lastGrind, delta: 0, reason: 'dialin_hold_repeat', band: BAND };
    }
    return {
      type: last.direction,
      nextGrind,
      delta: Math.round((nextGrind - lastGrind) * 1000) / 1000,
      reason: last.direction === 'finer' ? 'dialin_suggest_finer' : 'dialin_suggest_coarser',
      band: BAND,
    };
  }

  const delta     = last.direction === 'finer' ? -step : step;
  const nextGrind = Math.round((lastGrind + delta) * 10) / 10;
  return {
    type: last.direction,
    nextGrind,
    delta: Math.round(delta * 10) / 10,
    reason: last.direction === 'finer' ? 'dialin_suggest_finer' : 'dialin_suggest_coarser',
    band: BAND,
  };
}
