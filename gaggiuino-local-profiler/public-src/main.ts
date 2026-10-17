import './style.css';

// One-time cleanup for the v1.102.0 service worker (reverted in v1.102.1):
// a client that already registered it keeps it active indefinitely — the
// server no longer trying to re-register does nothing for those clients.
//
// IMPORTANT — the ingress-origin trap (#387): when GLP is loaded through HA
// Ingress, this page's origin IS Home Assistant's own origin, and
// getRegistrations() returns every service worker registered for that
// origin — including HA frontend's own. Unregistering unconditionally used
// to also unregister HA's SW; HA re-registers it and clients.claim() fires
// a controllerchange event that made HA's frontend reload every open tab.
// Only ever touch GLP's own registration (matched by its exact script URL),
// never anything else sharing the origin.
if ('serviceWorker' in navigator) {
  const ownScriptURL = new URL('sw.js', location.href).href;
  navigator.serviceWorker.getRegistrations()
    .then(regs => Promise.all(
      regs
        .filter(r => [r.active, r.waiting, r.installing].some(w => w?.scriptURL === ownScriptURL))
        .map(r => r.unregister())
    ))
    .catch(() => {});
}

// Installable PWA (v1.112.0): register the app-shell service worker, but only
// when the server actually injected the manifest link into this page — see
// the backend's ingress-trust check (go/internal/auth) and SPA index route. Requests arriving through
// HA Ingress (the Companion App's embedded WebView) never get that link, so
// this branch never runs there, which is the structural fix for the
// v1.102.0 regression (that SW's fetch interception broke the Companion
// App's live shot graph — see CHANGELOG).
if ('serviceWorker' in navigator && document.querySelector('link[rel="manifest"]')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

import { t, applyTranslations } from './i18n.js';
import { THEME_CHANGE_EVENT } from './utils.js';
import { watchSystemTheme } from './theme.js';
import { renderSidebar, updateMobileShotSidebarVisibility, selectShot } from './components/sidebar.js';
import { updateStatus } from './components/status.js';
import { switchMode, goToShot } from './components/mode.js';
import { initTopbarNavFade } from './components/topbar-nav-fade.js';
import { showToast } from './components/toast.js';
import { calcShotScore, loadData, trashShot, flushAutoSave, updateView } from './views/shots.js';
import { getShotCurve, ensureCurves, getRawCurve, getCachedShotData } from './shot-curves.js';
import { populateRefSelector, connectLiveStream, disconnectLiveStream } from './views/live.js';
import { initAnalytics } from './views/analytics.js';
import { loadMaintenanceView } from './views/maintenance.js';
import { loadAchievementsView } from './views/achievements.js';
import { closeFlavorWheel } from './components/flavor-wheel.js';
import { loadOrdersView, startOrdersPolling, stopOrdersPolling } from './views/orders.js';
import { loadLibrary, renderBeanList, renderGrinderList, closeBeanSheet } from './views/library.js';
import { renderDialin } from './views/dialin.js';
import { renderMachinesList } from './components/machines-settings.js';
import { safeLocalStorage } from './storage.js';
import { runStep } from './boot/run-step.js';
import { wireAnnotationPanel } from './boot/annotation.js';
import { wireAppShell } from './boot/shell.js';
import { wireAppearance } from './boot/appearance.js';
import { wireShotDetail } from './boot/shot-detail.js';
import { wireViews } from './boot/views.js';
import { wireLibrary } from './boot/library.js';
import { wireSettings } from './boot/settings.js';
import { wireDelegation } from './boot/delegation.js';
import { bootData } from './boot/data.js';

// #1018: live re-resolution while 'auto' is selected -- see theme.js.
watchSystemTheme();

// ── Cross-module entry points on window ───────────────────────────────────
// Only what another module reads as `window.X` to stay off a direct import
// (import cycles, see window-globals.d.ts). There are no inline HTML
// handlers; test/window-exports.test.ts pins this list (#1615).
Object.assign(window, {
  t,
  setAccentTheme: (name: string) => {
    safeLocalStorage.setItem('glp_accent_theme', name);
    // #1019: the only thing that still applies --accent-* now -- the
    // [data-accent="..."] CSS blocks that used to pick this up on their own
    // are retired, so a manual pick has to be pushed through the same
    // inline-var mechanism the active machine's own theme uses (and which
    // takes priority over this pick when the active machine has a theme set).
    // #1021: this dispatch is what applies it -- the onThemeChange()
    // listener registered below already calls applyActiveMachineAccentTheme()
    // synchronously in response, so no separate direct call is needed here.
    window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT));  // #814, see theme.js's applyTheme()
    // Still recorded on <html> even though no CSS reads it any more (#1019
    // retired the [data-accent] selectors) -- shareCard() (views/shots/
    // index.js, #462) reads this to match the exported card to whatever
    // preset the user actually picked, independent of this DOM attribute's
    // now-defunct original CSS purpose.
    document.documentElement.dataset.accent = name;
    document.querySelectorAll<HTMLElement>('.accent-swatch').forEach(b =>
      b.classList.toggle('active', b.dataset.presetKey === name));
  },
  renderSidebar,
  selectShot,
  switchMode,
  goToShot,

  // shots view
  calcShotScore,
  // #957 curve cache
  getShotCurve,
  ensureCurves,
  getRawCurve,
  getShotDataById: getCachedShotData,
  loadData,
  trashShot,
  flushAutoSave,
  updateView,

  // live view
  populateRefSelector,
  connectLiveStream,
  disconnectLiveStream,

  // views mode.ts opens without importing the view graph
  initAnalytics,
  loadAchievementsView,
  loadMaintenanceView,
  loadOrdersView,
  startOrdersPolling,
  stopOrdersPolling,
  loadLibrary,
  renderBeanList,
  renderGrinderList,
  renderMachinesList,
  renderDialin,
  closeBeanSheet,
  // #1543: mode.js closes the wheel on a tab switch; exposed here like the
  // sheet's own close so the components/ tree never imports the view graph.
  closeFlavorWheel,

  showToast,
});

document.addEventListener('DOMContentLoaded', () => {
  // ── DOM wiring (#1615) ─────────────────────────────────────────────────
  // Independent steps: each one catches and logs its own failure, so one
  // missing element no longer aborts every later step's wiring.
  runStep('annotation panel', wireAnnotationPanel);
  runStep('app shell', wireAppShell);
  runStep('appearance', wireAppearance);
  runStep('shot detail', wireShotDetail);
  runStep('views', wireViews);
  runStep('library', wireLibrary);
  runStep('settings', wireSettings);
  runStep('delegation', wireDelegation);

  // ── Init sequence ──────────────────────────────────────────────────────
  applyTranslations();
  // #1516: after the labels are localized (their width decides the row's
  // scrollWidth). initTopbarNavFade re-syncs on scroll, resize and further
  // translation-driven label changes.
  initTopbarNavFade();

  // The data boot chain (#1615: dependency-aware tasks, see boot/data.ts).
  void bootData();

  setInterval(() => { void updateStatus(); }, 30000);
  updateMobileShotSidebarVisibility();
  let _lastViewportWidth = window.innerWidth;
  window.addEventListener('resize', () => {
    // Mobile virtual keyboards (Android Chrome etc.) fire a resize event on
    // open/close because viewport *height* changes — width stays the same.
    // updateMobileShotSidebarVisibility() force-closes the burger drawer
    // whenever width is still <=768, so that spurious resize was slamming
    // the drawer shut the instant a user focused #shotSearch and the
    // keyboard opened. Real breakpoint-relevant resizes (device rotation,
    // desktop window drag across 768px) always change width, so gate on
    // that instead of reacting to every resize blindly.
    const width = window.innerWidth;
    if (width === _lastViewportWidth) return;
    _lastViewportWidth = width;
    updateMobileShotSidebarVisibility();
  });

});
