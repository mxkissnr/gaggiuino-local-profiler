package machines

// themePreset ports one entry of lib/machines/theme-presets.js's
// THEME_PRESETS array.
type themePreset struct {
	Key string
	A   string
	B   string
}

var themePresets = []themePreset{
	{"amber-americano", "#f59e0b", "#f59e0b"},
	{"ruby-ristretto", "#7f1d1d", "#7f1d1d"},
	{"copper-cortado", "#c2703d", "#e8b4a0"},
	{"twilight-turkish", "#0891b2", "#4338ca"},
	{"marbled-macchiato", "#f59e0b", "#ec4899"},
	{"ember-espresso", "#dc4a1f", "#f5a623"},
	{"mulberry-mocha", "#5b21b6", "#db2777"},
	{"frosty-flat-white", "#0f766e", "#38bdf8"},
}

func isThemePresetKey(key string) bool {
	for _, p := range themePresets {
		if p.Key == key {
			return true
		}
	}
	return false
}
