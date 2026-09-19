// Type shim for the not-yet-migrated dialin-convergence.js (TypeScript
// migration package A5, #1115). Only the symbols consumed by
// views/dialin-wizard.ts are declared; delete this file once the module is
// converted.

// One dialed-in shot in a session, as stored in S.dialinSession.rounds.
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

export function isConverged(rounds: DialinRound[] | null | undefined): boolean;
export function calcNextGrindSuggestion(rounds: DialinRound[] | null | undefined): DialinSuggestion;
