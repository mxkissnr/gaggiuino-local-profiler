// Type shim for the not-yet-migrated bean-math.js (TypeScript migration
// package A5, #1115). Only the symbols consumed by views/shots/annotation.ts
// and views/library.ts are declared; delete this file once the module is
// converted.
type BeanRecord = Record<string, unknown>;
type DoseRow = Record<string, unknown>;

/** Bean-id-first, name-fallback dose-to-bean matcher shared with the backend. */
export function matchesBean(
  doseRow: DoseRow,
  bean: BeanRecord,
  idExists: Set<unknown>,
): boolean;

/** Which bag was open at the shot's timestamp (the most recent bag opened at or before it, else the oldest). */
export function resolveBagAtShotTime(
  bags: BeanRecord[],
  shotMs: number,
): BeanRecord | undefined;

/** Remaining stock in g, or null for an untracked/unlimited-stock bean. */
export function computeBeanRemaining(
  bean: BeanRecord,
  doseRows: DoseRow[] | null | undefined,
  allBeans: BeanRecord[] | null | undefined,
): number | null;
