// Type shim for the not-yet-migrated views/shots/utils.js (TypeScript
// migration package A4, #1113). Only the symbol consumed by components/ is
// declared; delete this file once the module is converted.
export interface ResolvedBean {
  id: number;
  name?: string | null;
  [key: string]: unknown;
}

export function resolveBeanForAnnotation(annotation: unknown, beans?: unknown): ResolvedBean | null;
