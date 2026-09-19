// Type shim for the not-yet-migrated profile-suggestion.js (TypeScript
// migration package A5, #1115). Only the symbol and shape consumed by
// views/library-profile-editor.ts are declared; delete this file once the
// module is converted.
/** One phase of the suggested profile (phaseSchema-shaped). */
export interface ProfileSuggestionPhase {
  name: string;
  type: string;
  target?: { start?: number; end?: number; curve?: string; time?: number };
  restriction?: number;
  stopConditions?: Record<string, number>;
}

/** The machine-profile draft suggestProfileFromBean() builds for a bean. */
export interface ProfileSuggestion {
  name: string;
  waterTemperature: number;
  recipe: { coffeeIn: number; coffeeOut: number; ratio: number };
  phases: ProfileSuggestionPhase[];
  globalStopConditions: { weight: number };
}

/**
 * The bean fields profile-suggestion.js reads off its argument — typed as
 * unknown because callers hand it a state LibraryRow (Record<string, unknown>).
 */
export interface BeanSuggestionInput {
  name?: unknown;
  decaf?: unknown;
  process?: unknown;
  brewRatio?: unknown;
}

export function suggestProfileFromBean(bean: BeanSuggestionInput | null | undefined): ProfileSuggestion;
