// Boot step (#1615): theme, accent and language -- restores the saved theme
// and accent, keeps live charts in step with theme changes and wires the
// theme/language pickers. Moved verbatim out of main.ts's DOMContentLoaded
// handler; run through runStep() so a failure only skips this step.
import { S } from '../state/index.js';
import { setLang } from '../i18n.js';
import { onThemeChange, applyChartTheme } from '../utils.js';
import { THEME_STORAGE_KEY, applyTheme, migrateLegacyAccent } from '../theme.js';
import { applyActiveMachineAccentTheme, renderAccentSwatches } from '../components/machines-settings.js';
import { safeLocalStorage } from '../storage.js';

// Theme picker — called by the #themeToggleGroup wiring below.
function setTheme(theme: string): void {
  safeLocalStorage.setItem(THEME_STORAGE_KEY, theme);
  applyTheme(theme);
}

export function wireAppearance(): void {
  // ── Theme ──────────────────────────────────────────────────────────────
  // applyTheme()/resolveTheme() live in theme.ts (#1018), shared with
  // setTheme() and watchSystemTheme()'s OS prefers-color-scheme listener.
  // #814: one listener for every live Chart instance. Charts resolve their
  // chrome colours at construction, so without this a chart already on screen
  // keeps the previous theme's legend/ticks/grid until something else happens
  // to rebuild it. Listed explicitly rather than discovered, so a new chart
  // added later shows up as a missing entry here rather than silently keeping
  // stale colours.
  onThemeChange(() => {
    for (const key of ['chart', 'pqChart', 'fsChart', 'liveChart', 'trendChart',
                       'profileBarChart', 'profilePreviewChart', 'doseDistChart',
                       'ratioDistChart', 'timeOfDayChart', 'dialinProgressionChart'] as const) {
      applyChartTheme(S[key] as Parameters<typeof applyChartTheme>[0]);
    }
  });

  // #1021: --accent-ink now has a light-theme-only override table (see
  // machines-settings.ts), so toggling dark<->light (manually or via the OS
  // 'auto' listener in theme.ts, which also fires this event) has to
  // recompute it too, not just whenever the accent/machine choice itself
  // changes.
  onThemeChange(() => applyActiveMachineAccentTheme());

  applyTheme(safeLocalStorage.getItem(THEME_STORAGE_KEY) || 'dark');

  // #1019: migrates a pre-#1019 6-swatch value (amber/ocean/aurora/ember/
  // forest/crema) to its nearest of the 8 THEME_PRESETS, and is a no-op on
  // an already-migrated value -- written back so this doesn't silently
  // re-run every load (harmless if it did, but there's no reason to).
  const _savedAccent = migrateLegacyAccent(safeLocalStorage.getItem('glp_accent_theme')) || 'amber-americano';
  safeLocalStorage.setItem('glp_accent_theme', _savedAccent);
  document.documentElement.dataset.accent = _savedAccent;
  renderAccentSwatches();
  // #1018: scoped to #themeToggleGroup, not the bare .theme-btn class --
  // #mqttTransportToggle below reuses that same class for its own toggle and
  // has no data-theme-val, so an unscoped query used to also wire this click
  // handler onto it, calling setTheme(undefined) and silently corrupting the
  // stored theme (neither Dark nor Light showed .active afterwards).
  document.querySelectorAll<HTMLElement>('#themeToggleGroup .theme-btn').forEach(btn => {
    btn.addEventListener('click', () => setTheme(btn.dataset.themeVal!));
  });
  document.querySelectorAll<HTMLElement>('.lang-option-btn').forEach(btn => {
    btn.addEventListener('click', () => setLang(btn.dataset.lang!));
  });
}
