// Type shim for the not-yet-migrated shared/theme-presets.js (TypeScript
// migration package A4, #1113). Only the symbols consumed by components/ are
// declared; delete this file once the module is converted.
export interface ThemePreset {
  key: string;
  a: string;
  b: string;
}

export interface ThemeStops {
  a: string;
  b: string;
}

export const THEME_PRESETS: ThemePreset[];
export const THEME_PRESET_KEYS: string[];
export function getThemePreset(key: unknown): ThemePreset | null;
export function resolveTheme(theme: unknown): ThemeStops | null;
