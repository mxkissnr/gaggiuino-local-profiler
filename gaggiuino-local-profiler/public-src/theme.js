// Theme resolution + application (#1018). Split out of main.js so this
// logic can be unit tested directly -- main.js's own import chain has heavy
// side effects at load time (service worker registration, a DOMContentLoaded
// bootstrap touching dozens of element ids) that make importing it in a test
// impractical; this module has none.
import { THEME_CHANGE_EVENT } from './utils.js';

export const THEME_STORAGE_KEY = 'glp_theme';

// 'auto' means "follow the OS/browser prefers-color-scheme" -- <html
// data-theme> only ever renders the two concrete values, never 'auto'
// itself. `prefersDark` is passed in rather than read here so this stays a
// pure function.
export function resolveTheme(theme, prefersDark) {
  return theme === 'auto' ? (prefersDark ? 'dark' : 'light') : theme;
}

// Applies `theme` (the raw stored/selected value -- 'auto' included) to the
// page: resolves and sets <html data-theme>, updates which
// #themeToggleGroup button carries .active (matched against the RAW value,
// so picking Auto highlights the Auto button even though the resolved
// concrete theme is whatever the OS currently reports), and fires
// THEME_CHANGE_EVENT (#814) so live Chart.js instances re-theme.
//
// Scoped to `#themeToggleGroup .theme-btn`, not the bare `.theme-btn` class
// -- #mqttTransportToggle (Settings -> Live-Verbindung) reuses that same
// class for its own WebSocket/MQTT toggle and has no data-theme-val. #1018's
// actual bug: an unscoped query also wired/matched those buttons, so
// clicking one called this with theme=undefined, which matches neither
// 'dark' nor 'light' and left both real buttons permanently un-highlighted.
export function applyTheme(theme, { doc = document, win = window } = {}) {
  const prefersDark = !!win.matchMedia?.('(prefers-color-scheme: dark)')?.matches;
  doc.documentElement.dataset.theme = resolveTheme(theme, prefersDark);
  doc.querySelectorAll('#themeToggleGroup .theme-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.themeVal === theme));
  // #814: Chart.js resolves its colours once, at construction. Setting the
  // theme attribute repaints everything CSS controls but leaves every chart
  // already on screen with the previous theme's legend, ticks and grid, so
  // the views holding a live Chart instance need telling.
  win.dispatchEvent(new win.CustomEvent(THEME_CHANGE_EVENT));
}

// Live re-resolution while 'auto' is selected: a standing listener that
// no-ops unless 'auto' is the currently stored choice is simpler than
// attaching/detaching one on every setTheme() call, and costs nothing while
// idle. Returns the MediaQueryList (or undefined in an environment without
// matchMedia) mainly so tests can drive it directly.
export function watchSystemTheme({ win = window, storage = localStorage } = {}) {
  const mq = win.matchMedia?.('(prefers-color-scheme: dark)');
  mq?.addEventListener('change', () => {
    if ((storage.getItem(THEME_STORAGE_KEY) || 'dark') === 'auto') applyTheme('auto', { win });
  });
  return mq;
}
