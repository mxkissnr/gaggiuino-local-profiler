// Type shim for the not-yet-migrated shared/score.js (TypeScript migration
// package A5, #1115). Only the symbols consumed by converted view modules are
// declared; delete this file once the module is converted.
export function calcShotScore(shot: unknown, bean?: unknown): number | null;
export function calcShotScoreDetail(
  shot: unknown,
  bean?: unknown,
): { score: number | null; usedBeanTarget: boolean };
