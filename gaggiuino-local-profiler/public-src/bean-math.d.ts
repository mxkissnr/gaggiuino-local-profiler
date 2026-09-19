// Type shim for the not-yet-migrated bean-math.js (TypeScript migration
// package A5, #1115). Only the symbol consumed by views/shots/annotation.ts is
// declared; delete this file once the module is converted.
type BeanRecord = Record<string, unknown>;
type DoseRow = Record<string, unknown>;

/** Remaining stock in g, or null for an untracked/unlimited-stock bean. */
export function computeBeanRemaining(
  bean: BeanRecord,
  doseRows: DoseRow[] | null | undefined,
  allBeans: BeanRecord[] | null | undefined,
): number | null;
