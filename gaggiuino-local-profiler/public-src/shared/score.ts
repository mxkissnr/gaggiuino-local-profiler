// Frontend shot score (0–100). Mirrors the Go backend's own score
// implementation (go/internal/shots), which is served as `score` on each
// shot; kept here so the UI can rescore live/unsaved shots without a
// round-trip. Pure function — no DOM deps. Inputs are the raw shot object
// (×10 integer curves).

import { detectChanneling } from '../utils.js';
import type { ShotDatapoints } from '../utils.js';

/**
 * The raw shot fields this scorer reads. Callers hand it an untyped shot row
 * (state ShotMeta / views' local row interfaces), hence the cast in
 * calcShotScoreDetail() rather than a looser public parameter.
 */
interface ScorableShot {
  datapoints?: ShotDatapoints;
  duration?: number | null;
  annotation?: { dose?: number | null; tds?: number | null } | null;
  profile?: { phases?: Array<{ type?: string }> } | null;
}

/** Why the pressure part was scored the way it was (#1538). */
export type PressureNote = 'profile' | 'omitted';

/** calcShotScoreDetail's result — the score, the bean-target flag and, for a
 *  sub-5-bar shot, why the pressure part looks the way it does (#1538). */
export interface ScoreDetailResult {
  score: number | null;
  usedBeanTarget: boolean;
  pressureNote: PressureNote | null;
}

/** The bean fields (#450) the scorer reads — a CoffeeLibrary row, untyped. */
interface ScorableBean {
  brewTempC?: unknown;
  brewRatio?: unknown;
}

function _stddev(vals: number[]): number {
  if (vals.length < 2) return 0;
  const m = vals.reduce((a, b) => a + b, 0) / vals.length;
  return Math.sqrt(vals.reduce((a, b) => a + (b - m) ** 2, 0) / vals.length);
}

// "1:2.4" -> 2.4 — the bean form's own brewRatio convention (see
// sanitize-bean.js). Anything that doesn't match (empty, freeform notes,
// old data predating the field) yields null so callers fall back cleanly.
// This is the single brew-ratio parser (#1622): it must stay in parity with
// Go's parseBrewRatioTarget (go/internal/shots/score.go), so the profile
// suggestion and dial-in wizard reuse it rather than carrying their own.
export function parseBrewRatio(brewRatio: string | number | null | undefined): number | null {
  if (!brewRatio) return null;
  const m = String(brewRatio).match(/^\s*1\s*:\s*(\d+(?:\.\d+)?)\s*$/);
  const captured = m?.[1];
  return captured !== undefined ? parseFloat(captured) : null;
}

// #1538: maps the mean absolute error (bar) between a shot's pressure and its
// own targetPressure to a 0-100 part score: within 0.5 bar is full marks, then
// -20 per further bar, floored at 20. Mirrors Go's profilePressureScore.
function _profilePressureScore(mae: number): number {
  if (mae <= 0.5) return 100;
  return Math.max(20, 100 - 20 * (mae - 0.5));
}

// #1538: mean absolute error (bar) between the recorded pressure and the
// shot's own targetPressure, over the samples in a PRESSURE-type phase only (a
// FLOW phase's targetPressure is a limit, not a target). Returns null when
// there is no usable phase metadata, and the caller then leaves pressure out.
function _profilePressureMAE(
  d: ShotDatapoints,
  profile: ScorableShot['profile'],
  p: number[],
): { mae: number; samples: number } | null {
  const phases = profile?.phases;
  if (!phases || !phases.length) return null;
  const pressurePhases = new Set<number>();
  phases.forEach((ph, i) => { if (ph?.type === 'PRESSURE') pressurePhases.add(i); });
  if (!pressurePhases.size) return null;
  const target = d.targetPressure || [];
  const phaseIndex = d.phaseIndex || [];
  if (!target.length || !phaseIndex.length) return null;
  const n = Math.min(p.length, target.length, phaseIndex.length);
  let sum = 0, samples = 0;
  for (let i = 0; i < n; i++) {
    const phase = phaseIndex[i];
    const t = target[i];
    const actual = p[i];
    if (phase === undefined || t === undefined || actual === undefined) continue;
    // Go truncates phaseIndex toward zero with int(phaseIdx[i]); mirror that
    // exactly (real data is integral, but the parity must not silently drift).
    if (!pressurePhases.has(Math.trunc(phase)) || t <= 0) continue;
    sum += Math.abs(actual - t / 10);
    samples++;
  }
  if (!samples) return null;
  return { mae: sum / samples, samples };
}

// Weighted: pressure 25, temp stability 20, duration 20, brew ratio 20, channeling 15.
// `bean` (#450) is the coffee-library entry matching the shot's own
// annotation.coffee, resolved by the caller — optional. When absent, or when
// it has no brewTempC/brewRatio set, scoring is byte-identical to before
// #450 (generic fixed bands). When present, its own recommendation becomes
// the target instead of the generic band — but never overrides the shot's
// own recorded target-temperature curve, which stays the highest-priority
// source since it reflects what the profile actually asked for.
//
// calcShotScoreDetail (#457) is the actual implementation, returning both
// the score and whether the bean's own brewTempC/brewRatio recommendation
// was actually used for either factor (as opposed to the shot's own target
// curve or the generic fallback band) — powers the verdict header's "scored
// against this bean's target" hint. calcShotScore stays a thin wrapper
// around it so every existing caller that only wants the number (there are
// many, across both backend and frontend) is untouched.
function calcShotScoreDetail(shot: unknown, bean?: unknown): ScoreDetailResult {
  if (!shot) return { score: null, usedBeanTarget: false, pressureNote: null };
  const sh = shot as ScorableShot;
  const beanRec = bean as ScorableBean | null | undefined;
  const d = sh.datapoints || {};
  const p = (d.pressure || []).map(v => v / 10);
  const pVals = p.filter(v => v >= 5);
  // #1538: scoreable as soon as there is a pressure curve at all. A shot that
  // never reaches 5 bar is scored too — its pressure part against the profile's
  // own target when it has one, or left out when it doesn't. A shot with >=4
  // samples at/above 5 bar takes the unchanged fixed-band path.
  if (p.filter(v => v > 0).length < 4) return { score: null, usedBeanTarget: false, pressureNote: null };

  const scores: number[] = [], weights: number[] = [];
  let usedBeanTarget = false;
  let pressureNote: PressureNote | null = null;
  let s: number;

  if (pVals.length > 3) {
    const avgP = pVals.reduce((a, b) => a + b, 0) / pVals.length;
    s = avgP >= 7 && avgP <= 9.5 ? 100
      : avgP < 7                  ? Math.max(20, 100 - (7 - avgP) * 22)
                                  : Math.max(20, 100 - (avgP - 9.5) * 28);
    scores.push(Math.round(s)); weights.push(25);
  } else {
    const tracked = _profilePressureMAE(d, sh.profile, p);
    if (tracked) {
      scores.push(Math.round(_profilePressureScore(tracked.mae))); weights.push(25);
      pressureNote = 'profile';
    } else {
      pressureNote = 'omitted';
    }
  }

  const tVals = (d.temperature || []).map(v => v / 10);
  if (tVals.length > 5) {
    const sd = _stddev(tVals) || 0;
    const stab = sd <= 0.3 ? 100 : sd <= 0.7 ? 90 : sd <= 1.5 ? 72
      : sd <= 3 ? 50 : Math.max(15, 50 - (sd - 3) * 12);
    // accuracy vs. (in priority order) the shot's own target curve, the
    // bean's brewTempC recommendation (#450), or a fallback 90–96 °C band.
    const avgT = tVals.reduce((a, b) => a + b, 0) / tVals.length;
    const tgt  = (d.targetTemperature || []).map(v => v / 10).filter(v => v > 0);
    let acc: number;
    if (tgt.length) {
      const dev = Math.abs(avgT - tgt.reduce((a, b) => a + b, 0) / tgt.length);
      acc = dev <= 0.5 ? 100 : dev <= 1 ? 90 : dev <= 2 ? 75
          : dev <= 4 ? 50 : Math.max(15, 50 - (dev - 4) * 8);
    } else if (beanRec && typeof beanRec.brewTempC === 'number' && beanRec.brewTempC > 0) {
      const dev = Math.abs(avgT - beanRec.brewTempC);
      acc = dev <= 0.5 ? 100 : dev <= 1 ? 90 : dev <= 2 ? 75
          : dev <= 4 ? 50 : Math.max(15, 50 - (dev - 4) * 8);
      usedBeanTarget = true;
    } else {
      const off = avgT >= 90 && avgT <= 96 ? 0 : avgT < 90 ? 90 - avgT : avgT - 96;
      acc = off === 0 ? 100 : Math.max(15, 100 - off * 10);
    }
    s = Math.round((stab + acc) / 2);
    scores.push(s); weights.push(20);
  }

  const secs = (sh.duration || 0) / 10;
  if (secs > 5) {
    s = secs >= 25 && secs <= 35 ? 100
      : (secs >= 20 && secs < 25) || (secs > 35 && secs <= 42) ? 82
      : secs > 42 && secs <= 55   ? 62
      : secs < 20 ? Math.max(15, 70 - (20 - secs) * 5)
                  : Math.max(15, 62 - (secs - 55) * 3);
    scores.push(Math.round(s)); weights.push(20);
  }

  const ann    = sh.annotation || {};
  const wArr   = d.shotWeight || d.weight || [];
  const finalW = wArr.length ? Math.max(...wArr.map(v => v / 10)) : 0;
  if (ann.dose && ann.dose > 0 && finalW) {
    const r = finalW / ann.dose;
    // Bean's own brewRatio recommendation (#450) replaces the generic
    // 1.8–2.5 band as the target when set.
    const beanRatioTarget = beanRec ? parseBrewRatio(beanRec.brewRatio as string | number | undefined) : null;
    if (beanRatioTarget != null) {
      const dev = Math.abs(r - beanRatioTarget);
      s = dev <= 0.35 ? 100 : dev <= 0.75 ? 75 : Math.max(15, 75 - (dev - 0.75) * 30);
      usedBeanTarget = true;
    } else {
      s = r >= 1.8 && r <= 2.5 ? 100
        : (r >= 1.5 && r < 1.8) || (r > 2.5 && r <= 3.2) ? 75
        : r < 1.5 ? Math.max(15, 55 - (1.5 - r) * 40)
                  : Math.max(15, 60 - (r - 3.2) * 22);
    }
    scores.push(Math.round(s)); weights.push(20);
  }

  // Extraction Yield (SCA "Golden Cup" 18–22 %) — only when TDS + dose are known
  if (ann.dose && ann.dose > 0 && ann.tds && finalW) {
    const ey = (finalW * ann.tds) / ann.dose;
    s = ey >= 18 && ey <= 22 ? 100
      : (ey >= 16 && ey < 18) || (ey > 22 && ey <= 24) ? 75
      : ey < 16 ? Math.max(15, 60 - (16 - ey) * 10)
                : Math.max(15, 60 - (ey - 24) * 10);
    scores.push(Math.round(s)); weights.push(20);
  }

  const times = (d.timeInShot || []).map(v => v / 10);
  // Channeling uses the shared utils.detectChanneling — the one copy that
  // matches Go's sample-skipping on out-of-range times (#1622).
  scores.push(detectChanneling(times, p) ? 20 : 100); weights.push(15);

  const tw = weights.reduce((a, b) => a + b, 0);
  const score = tw ? Math.round(scores.reduce((acc, v, i) => acc + v * (weights[i] ?? 0), 0) / tw) : null;
  return { score, usedBeanTarget: score !== null && usedBeanTarget, pressureNote: score !== null ? pressureNote : null };
}

function calcShotScore(shot: unknown, bean?: unknown): number | null {
  return calcShotScoreDetail(shot, bean).score;
}

export { calcShotScore, calcShotScoreDetail };
