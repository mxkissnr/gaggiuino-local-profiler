// Type shim for the not-yet-migrated flavor-data.js (TypeScript migration
// package A4, #1113). Only the symbols consumed by components/ are declared;
// delete this file once the module is converted.
export interface FlavorNode {
  id: string;
  en: string;
  de: string;
  it: string;
  fr: string;
  es: string;
  nl: string;
  children?: FlavorNode[];
  // Set by flavor-match.js's markLit() while rendering the wheel.
  _lit?: boolean;
}

export const FLAVOR_WHEEL: FlavorNode[];
export const FLAVOR_ALIASES: Record<string, string>;
