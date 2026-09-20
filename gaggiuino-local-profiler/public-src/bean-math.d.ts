// Type shim for the not-yet-migrated bean-math.js (TypeScript migration
// package A5, #1115). Only the symbols consumed by views/shots/annotation.ts
// and views/library.ts are declared; delete this file once the module is
// converted.
type BeanRecord = Record<string, unknown>;
type DoseRow = Record<string, unknown>;

/** Remaining stock in g, or null for an untracked/unlimited-stock bean. */
export function computeBeanRemaining(
  bean: BeanRecord,
  doseRows: DoseRow[] | null | undefined,
  allBeans: BeanRecord[] | null | undefined,
): number | null;

/** Sum of annotated doses for a bean (optionally restricted to the active bag). */
export function sumConsumedDoses(
  bean: BeanRecord,
  doseRows: DoseRow[] | null | undefined,
  allBeans: BeanRecord[] | null | undefined,
  bags?: unknown[] | null,
): number;

/** Stock target + consumed, so a desired remaining amount can be entered in the form. */
export function remainingToStockG(
  bean: BeanRecord,
  doseRows: DoseRow[] | null | undefined,
  allBeans: BeanRecord[] | null | undefined,
  desiredRemaining: number,
): number;
