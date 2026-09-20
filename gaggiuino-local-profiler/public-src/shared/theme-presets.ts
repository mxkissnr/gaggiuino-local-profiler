// Machine colour theme presets (#594). Frontend copy for the theme picker
// UI; the Go backend validates the stored theme value independently
// (go/internal/machines). Pure data, no DOM deps.
//
// Each preset has a stable `key` (the value stored in machines.theme) plus
// a two-stop gradient `a`/`b`. A
// flat-colour preset just repeats the same hex in both stops. i18n label
// keys follow the `theme_preset_<key with _ instead of ->` convention, added
// to all six public-src/i18n/*.js files.
export interface ThemePreset {
    key: string;
    a: string;
    b: string;
}

export interface ThemeStops {
    a: string;
    b: string;
}

const THEME_PRESETS: ThemePreset[] = [
    { key: 'amber-americano',   a: '#f59e0b', b: '#f59e0b' },
    { key: 'ruby-ristretto',    a: '#7f1d1d', b: '#7f1d1d' },
    { key: 'copper-cortado',    a: '#c2703d', b: '#e8b4a0' },
    { key: 'twilight-turkish',  a: '#0891b2', b: '#4338ca' },
    { key: 'marbled-macchiato', a: '#f59e0b', b: '#ec4899' },
    { key: 'ember-espresso',    a: '#dc4a1f', b: '#f5a623' },
    { key: 'mulberry-mocha',    a: '#5b21b6', b: '#db2777' },
    { key: 'frosty-flat-white', a: '#0f766e', b: '#38bdf8' },
];

const THEME_PRESET_KEYS = THEME_PRESETS.map(p => p.key);

function getThemePreset(key: unknown): ThemePreset | null {
    return THEME_PRESETS.find(p => p.key === key) || null;
}

// Resolves a stored machines.theme value (see lib/db.js) to concrete {a,b}
// hex stops, or null if unset/unknown. Used wherever the actual colour is
// needed (icon rendering, list swatches) rather than the raw stored shape.
function resolveTheme(theme: unknown): ThemeStops | null {
    if (!theme) return null;
    const t = theme as { preset?: string; a?: string; b?: string };
    if (t.preset) {
        const preset = getThemePreset(t.preset);
        return preset ? { a: preset.a, b: preset.b } : null;
    }
    if (t.a && t.b) return { a: t.a, b: t.b };
    return null;
}

export { THEME_PRESETS, THEME_PRESET_KEYS, getThemePreset, resolveTheme };
