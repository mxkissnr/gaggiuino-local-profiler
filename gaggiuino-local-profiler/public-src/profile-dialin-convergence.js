// Profile Dial-In convergence logic (#313) — pure, no DOM/state/i18n. Sibling
// to dialin-convergence.js (the grind wizard's engine), adapted for tuning
// machine-profile phases instead of a single grind number.
//
// v1 SCOPE DECISION (see ~/.claude/plans/glp-profile-dialin-phase2.md): the
// primary tuning signal is a manual taste-symptom pick per round (sour/
// balanced/bitter/watery/channeling), mapped to a concrete phase/field
// adjustment via the coffee-expert skill's symptom→cause table — NOT
// shot.profile.phases parsing, whose field shape is unverified against real
// hardware. calcShotScore(shot) (lib/score.js) is the objective secondary
// signal, used only for convergence detection, not for picking *which*
// field to adjust.
//
// A "round" is one dialed-in shot in a profile dial-in session:
//   { symptom: 'sour'|'balanced'|'bitter'|'watery'|'channeling', score: number|null,
//     appliedAdjustment: { phaseIndex: number|null, field: string, delta: number } | null }
//
// suggestPhaseAdjustment(symptom, currentProfile, roundHistory) computes the
// ONE adjustment for the round currently being reviewed — roundHistory here
// is the prior, already-accepted rounds (used only to find the previous
// step size for the same field, for the halve-on-reversal logic below).
// isProfileDialinConverged(roundHistory) is evaluated separately by the
// wizard, over rounds *including* the one just accepted (mirrors
// dialin-convergence.js's isConverged(s.rounds) called right after push).

const MAX_ROUNDS  = 6;
const HIGH_SCORE   = 80;

// Symptom severity, worst first — when multiple symptoms are selected in one
// round, only the single highest-priority one drives the (single) adjustment.
// Order per plan: channeling > bitter/sour (tied) > watery. balanced has no
// priority — it only "wins" when it's the only thing selected.
const SYMPTOM_PRIORITY = { channeling: 3, bitter: 2, sour: 2, watery: 1, balanced: 0 };

function _resolvePrimarySymptom(symptom) {
  const list = (Array.isArray(symptom) ? symptom : [symptom]).filter(Boolean);
  if (!list.length) return 'balanced';
  if (list.length === 1) return list[0];
  // Multiple picks: balanced never outranks a real symptom.
  const real = list.filter(s => s !== 'balanced');
  if (!real.length) return 'balanced';
  return real.reduce((best, s) => (SYMPTOM_PRIORITY[s] ?? 0) > (SYMPTOM_PRIORITY[best] ?? 0) ? s : best, real[0]);
}

// ── Phase lookup (name-based, with structural fallback) ────────────────────
// Real Gaggiuino profiles (see public-src/profile-suggestion.js, the
// community-derived skeleton) name phases 'Preinfusion' / 'Bloom' / 'Ramp' /
// 'Decline Flow' — match on that first; fall back to phase shape/position
// for hand-edited profiles that used different names.
function _locatePhase(phases, kind) {
  if (!Array.isArray(phases) || !phases.length) return null;
  if (kind === 'preinfusion') {
    const byName = phases.findIndex(p => /preinf/i.test(p?.name || ''));
    if (byName !== -1) return byName;
    return 0;
  }
  if (kind === 'ramp') {
    const byName = phases.findIndex(p => /ramp/i.test(p?.name || ''));
    if (byName !== -1) return byName;
    const rising = phases.findIndex(p => p?.type === 'PRESSURE' && (p?.target?.end ?? 0) > (p?.target?.start ?? 0));
    if (rising !== -1) return rising;
    return phases.length > 1 ? 1 : null;
  }
  if (kind === 'decline') {
    const byName = phases.findIndex(p => /declin|taper|finish/i.test(p?.name || ''));
    if (byName !== -1) return byName;
    const declining = phases.findIndex(p => (p?.target?.end ?? 0) < (p?.target?.start ?? p?.target?.end ?? 0));
    if (declining !== -1) return declining;
    return phases.length - 1;
  }
  return null;
}

function _getPath(obj, path) {
  return path.split('.').reduce((v, k) => (v == null ? v : v[k]), obj);
}

function _setPath(obj, path, value) {
  const keys = path.split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') return;
    if (cur[key] == null) cur[key] = {};
    cur = cur[key];
  }
  const lastKey = keys[keys.length - 1];
  if (lastKey === '__proto__' || lastKey === 'constructor' || lastKey === 'prototype') return;
  cur[lastKey] = value;
}

// ── Field candidates per symptom ────────────────────────────────────────
// min/max are sane per-session limits (not machine hard limits) grounded in
// public-src/profile-suggestion.js's community-derived skeleton and the
// coffee-expert skill's symptom table. Step sizes: "±0.5-1 bar for pressure,
// ±1-2s for time" per plan (time fields are milliseconds on the wire — see
// project_gaggiuino_protocol memory — so 1-2s = 1000-2000).
function _candidateDefs(primary) {
  switch (primary) {
    case 'sour':
      // Underdeveloped: puck didn't saturate long enough, or ramp pressure
      // is too timid — lengthen preinfusion OR push the ramp harder.
      return [
        { phaseKind: 'preinfusion', field: 'stopConditions.time', direction: 1, min: 3000, max: 15000, baseStep: 1500, unit: 'ms' },
        { phaseKind: 'ramp',        field: 'target.end',          direction: 1, min: 5,    max: 9.5,   baseStep: 0.75, unit: 'bar' },
      ];
    case 'bitter':
      // Over-extracted: too hot, ramp pushed too hard, or the back half of
      // the shot lingers too long — cool it down / back off / shorten it.
      return [
        { phaseKind: null, profileField: 'waterTemperature', direction: -1, min: 85, max: 96, baseStep: 1,   unit: 'C' },
        { phaseKind: 'ramp',    field: 'target.end',          direction: -1, min: 5,  max: 9.5, baseStep: 0.75, unit: 'bar' },
        { phaseKind: 'decline', field: 'target.time',         direction: -1, min: 10000, max: 35000, baseStep: 2000, unit: 'ms' },
      ];
    case 'watery':
      // Too much water for the dose, or the decline phase lets flow run
      // unrestricted at the end — tighten the ratio or the decline ceiling.
      return [
        { phaseKind: null, profileField: 'recipe.ratio',       direction: -1, min: 1.5, max: 3.5, baseStep: 0.2, unit: 'ratio' },
        { phaseKind: 'decline', field: 'restriction',          direction: 1,  min: 1,   max: 6,    baseStep: 0.5, unit: '' },
      ];
    case 'channeling':
      // Water found a path of least resistance — the profile-side lever is
      // giving the puck more time/threshold to saturate evenly before ramp;
      // distribution/tamping is the other half and isn't fixable by a
      // profile change (surfaced in the reason text, not modeled here).
      return [
        { phaseKind: 'preinfusion', field: 'stopConditions.time',          direction: 1, min: 3000, max: 15000, baseStep: 1500, unit: 'ms' },
        { phaseKind: 'preinfusion', field: 'stopConditions.pressureAbove', direction: 1, min: 1,    max: 4,     baseStep: 0.5,  unit: 'bar' },
      ];
    default:
      return [];
  }
}

function _resolveCandidate(def, profile) {
  const phaseIndex = def.phaseKind ? _locatePhase(profile?.phases, def.phaseKind) : null;
  if (def.phaseKind && phaseIndex == null) return null;
  const field = def.field ?? def.profileField;
  const target = def.phaseKind ? profile.phases[phaseIndex] : profile;
  const currentValue = _getPath(target, field);
  if (typeof currentValue !== 'number') return null;
  return {
    phaseIndex,
    phaseName: def.phaseKind ? (profile.phases[phaseIndex]?.name || def.phaseKind) : null,
    field,
    direction: def.direction,
    min: def.min,
    max: def.max,
    baseStep: def.baseStep,
    unit: def.unit,
    currentValue,
  };
}

// Previous step size for this exact field (halve on direction reversal,
// otherwise keep it — same binary-search philosophy as dialin-convergence.js,
// just tracked per-field instead of for a single global grind number.
function _stepFor(candidate, roundHistory) {
  const prior = [...(roundHistory || [])].reverse().find(r =>
    r?.appliedAdjustment?.field === candidate.field && r.appliedAdjustment.phaseIndex === candidate.phaseIndex);
  if (!prior) return candidate.baseStep;
  const prevDelta = prior.appliedAdjustment.delta;
  if (!prevDelta) return candidate.baseStep;
  const prevSign = Math.sign(prevDelta);
  const reversed = prevSign !== 0 && prevSign !== candidate.direction;
  return Math.abs(prevDelta) / (reversed ? 2 : 1);
}

function _round(value, unit) {
  const precision = unit === 'ms' ? 100 : unit === 'ratio' ? 0.1 : 0.1;
  return Math.round(value / precision) * precision;
}

function _computeAdjustment(candidate, roundHistory) {
  const step = _stepFor(candidate, roundHistory);
  const raw = candidate.currentValue + candidate.direction * step;
  const clamped = Math.min(candidate.max, Math.max(candidate.min, raw));
  const newValue = _round(clamped, candidate.unit);
  const delta = Math.round((newValue - candidate.currentValue) * 1000) / 1000;
  return { ...candidate, step, newValue, delta };
}

const REASON_KEY = {
  'sour|stopConditions.time':          'profile_dialin_reason_sour_preinf_time',
  'sour|target.end':                   'profile_dialin_reason_sour_ramp_pressure',
  'bitter|waterTemperature':           'profile_dialin_reason_bitter_temp',
  'bitter|target.end':                 'profile_dialin_reason_bitter_ramp_pressure',
  'bitter|target.time':                'profile_dialin_reason_bitter_decline_time',
  'watery|recipe.ratio':               'profile_dialin_reason_watery_ratio',
  'watery|restriction':                'profile_dialin_reason_watery_decline_restriction',
  'channeling|stopConditions.time':          'profile_dialin_reason_channeling_preinf_time',
  'channeling|stopConditions.pressureAbove': 'profile_dialin_reason_channeling_preinf_pressure',
};

export function suggestPhaseAdjustment(symptom, currentProfile, roundHistory) {
  const primary = _resolvePrimarySymptom(symptom);

  if (primary === 'balanced') {
    return {
      type: 'hold', symptom: primary, phaseIndex: null, phaseName: null, field: null,
      unit: '', oldValue: null, newValue: null, delta: 0, reason: 'profile_dialin_reason_balanced',
    };
  }

  const defs = _candidateDefs(primary);
  const candidates = defs.map(d => _resolveCandidate(d, currentProfile)).filter(Boolean);
  if (!candidates.length) {
    return {
      type: 'insufficient-data', symptom: primary, phaseIndex: null, phaseName: null, field: null,
      unit: '', oldValue: null, newValue: null, delta: 0, reason: 'profile_dialin_no_rounds',
    };
  }

  const computed = candidates.map(c => _computeAdjustment(c, roundHistory));
  const usable = computed.find(c => c.delta !== 0) || computed[0];

  return {
    type: usable.delta !== 0 ? 'adjust' : 'at-limit',
    symptom: primary,
    phaseIndex: usable.phaseIndex,
    phaseName: usable.phaseName,
    field: usable.field,
    unit: usable.unit,
    oldValue: usable.currentValue,
    newValue: usable.newValue,
    delta: usable.delta,
    reason: usable.delta !== 0
      ? (REASON_KEY[`${primary}|${usable.field}`] || 'profile_dialin_reason_balanced')
      : 'profile_dialin_reason_at_limit',
  };
}

// Applies an accepted suggestion to a profile, returning a NEW profile
// object (deep-cloned) — pure, no mutation of the input.
export function applyPhaseAdjustment(profile, suggestion) {
  const next = JSON.parse(JSON.stringify(profile || {}));
  if (!suggestion || suggestion.field == null) return next;
  const target = suggestion.phaseIndex != null ? next.phases?.[suggestion.phaseIndex] : next;
  if (!target) return next;
  _setPath(target, suggestion.field, suggestion.newValue);
  return next;
}

function _hasConsecutiveBalanced(rounds) {
  if (rounds.length < 2) return false;
  const a = rounds[rounds.length - 2], b = rounds[rounds.length - 1];
  return a?.symptom === 'balanced' && b?.symptom === 'balanced';
}

function _hasConsecutiveHighScores(rounds) {
  if (rounds.length < 2) return false;
  const a = rounds[rounds.length - 2], b = rounds[rounds.length - 1];
  return a?.score != null && b?.score != null && a.score >= HIGH_SCORE && b.score >= HIGH_SCORE;
}

export function isProfileDialinConverged(roundHistory) {
  const rounds = Array.isArray(roundHistory) ? roundHistory : [];
  if (!rounds.length) return false;
  if (_hasConsecutiveBalanced(rounds) || _hasConsecutiveHighScores(rounds)) return true;
  return rounds.length >= MAX_ROUNDS;
}

export function profileDialinConvergenceReason(roundHistory) {
  const rounds = Array.isArray(roundHistory) ? roundHistory : [];
  if (_hasConsecutiveBalanced(rounds)) return 'profile_dialin_converged_balanced';
  if (_hasConsecutiveHighScores(rounds)) return 'profile_dialin_converged_score';
  if (rounds.length >= MAX_ROUNDS) return 'profile_dialin_safety_valve';
  return 'profile_dialin_no_rounds';
}
