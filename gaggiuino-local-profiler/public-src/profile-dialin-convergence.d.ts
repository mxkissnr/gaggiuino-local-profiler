// Type shim for the not-yet-migrated profile-dialin-convergence.js
// (TypeScript migration package A5, #1115). Only the symbols consumed by
// views/profile-dialin-wizard.ts are declared; delete this file once the
// module is converted.

// One round of the profile dial-in session, as stored in
// S.profileDialinSession.rounds.
export interface ProfileDialinRoundRow {
  symptom?: string;
  score?: number | null;
  shotId?: number;
  appliedAdjustment?: { phaseIndex: number | null; field: string | null; delta: number } | null;
}

// What suggestPhaseAdjustment() returns: either an actionable 'adjust', a
// 'hold'/'at-limit'/'insufficient-data' no-op, or the raw values when the
// caller only needs the reason key.
export interface ProfileSuggestion {
  type: string;
  symptom?: string;
  phaseIndex: number | null;
  phaseName: string | null;
  field: string | null;
  unit: string;
  oldValue: number | null;
  newValue: number | null;
  delta: number;
  reason: string;
}

export function suggestPhaseAdjustment(
  symptom: unknown,
  currentProfile: unknown,
  roundHistory: unknown,
): ProfileSuggestion;

export function applyPhaseAdjustment<T>(profile: T, suggestion: ProfileSuggestion | null | undefined): T;

export function isProfileDialinConverged(roundHistory: unknown): boolean;

export function profileDialinConvergenceReason(roundHistory: unknown): string;
