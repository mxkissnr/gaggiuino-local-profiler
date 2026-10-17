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

import { S } from './state/index.js';
import { getUiPref, loadUiPrefsFromServer } from './ui-prefs.js';
import { initToken } from './api/transport.js';
import { t, applyTranslations } from './i18n.js';
import { connectEvents, onEvent, EVENTS } from './sse.js';
import { initLiveSync, handleDataChanged, resyncAll } from './live-sync.js';
import { createLiveSyncHandlers } from './live-sync-handlers.js';
import { themeColor, THEME_CHANGE_EVENT } from './utils.js';
import { watchSystemTheme } from './theme.js';
import { renderSidebar, updateMobileShotSidebarVisibility, selectShot } from './components/sidebar.js';
import { updateStatus } from './components/status.js';
import { checkForUpdate } from './components/update-check.js';
import { switchMode, goToShot } from './components/mode.js';
import { initTopbarNavFade } from './components/topbar-nav-fade.js';
import { calcShotScore, loadData, trashShot, flushAutoSave, updateView, loadDrinkMenu, loadMilkTypes } from './views/shots.js';
import { getShotCurve, ensureCurves, getRawCurve, getCachedShotData } from './shot-curves.js';
import { populateRefSelector, connectLiveStream, disconnectLiveStream, handleLiveSnapshotEvent,
         handlePreheatUpdateEvent } from './views/live.js';
import { initAnalytics } from './views/analytics.js';
import { loadMaintenanceView } from './views/maintenance.js';
import { loadAchievementsView } from './views/achievements.js';
import { closeFlavorWheel } from './components/flavor-wheel.js';
import { loadOrdersView, startOrdersPolling, stopOrdersPolling } from './views/orders.js';
import { loadLibrary, renderBeanList, resetShelfPrefs, renderGrinderList, closeBeanSheet } from './views/library.js';
import { loadMachineProfileList } from './views/library-profile-editor.js';
import { renderDialin } from './views/dialin.js';
import { loadMachines, setActiveMachine, resolveActiveMachineId, renderMachinesList } from './components/machines-settings.js';
import { openSetupWizard, shouldOpenSetupWizard } from './views/setup-wizard.js';
import { handleTopbarLiveSnapshotEvent, handleTopbarPreheatUpdateEvent } from './components/topbar-machine-icon.js';
import { loadMqttSettings, renderMqttSettingsCard } from './components/mqtt-settings.js';
import { loadNotifySettingsCard } from './components/notify-settings.js';
import { loadMcpSettingsCard } from './components/mcp-settings.js';
import { loadMachineControlSetting } from './components/machine-control.js';
import { loadShotDefaultsSettingsCard } from './components/shot-defaults-settings.js';
import { safeLocalStorage } from './storage.js';
import { runStep } from './boot/run-step.js';
import { wireAnnotationPanel } from './boot/annotation.js';
import { wireAppShell } from './boot/shell.js';
import { wireAppearance } from './boot/appearance.js';
import { wireShotDetail } from './boot/shot-detail.js';
import { wireViews } from './boot/views.js';
import { wireLibrary } from './boot/library.js';
import { wireSettings, renderApiTokenCard } from './boot/settings.js';
import { wireDelegation } from './boot/delegation.js';

// #1375/#1539: apply the shared UI choices once they have been loaded from the
// server (boot) or a live ui-prefs change has arrived. `includeMachine` is
// false on the live path: each device keeps its own machine selection until
// reload, so a remote machine.active change must not yank this device's view
// (decided by the maintainer). `keepShelfQuery` is true on the live path too:
// the shelf search is session-only, so a remote change must not wipe it.
function applyServerUiPrefs(includeMachine = true, keepShelfQuery = false): void {
  resetShelfPrefs(keepShelfQuery);
  if (!includeMachine) return;
  const activeId = getUiPref<number | 'all'>('machine.active');
  if (activeId === undefined) return;
  const resolved = resolveActiveMachineId(activeId);
  if (resolved !== S.activeMachineId) setActiveMachine(resolved);
}

// #1539: a maintenance refetch must not tear down an editor the user has open.
// Outside the maintenance view the run is a no-op (the view reloads on entry),
// so the guard only applies inside it, and then only to an open inline edit
// (not the "disabled tasks" details). An expanded card is no longer a guard:
// the run restores it itself through refreshMaintenanceView().
function _maintenanceCanRefetch(): boolean {
  if (S.currentMode !== 'maintenance') return true;
  const view = document.getElementById('maintenance-view');
  if (!view) return true;
  if (view.querySelector('[contenteditable="true"]')) return false;
  const logForm = document.getElementById('maintLogForm');
  return !logForm || logForm.style.display === 'none';
}

// #1539 slice 5: the Settings-page state the server's "settings" kind covers,
// extracted so the live-sync handler and the boot share one loader. The
// shot-defaults card is awaited (the first shot render reads S.shotDefaults
// directly); the others stay fire-and-forget exactly as at boot, and the
// machine list reloads because the machine-registry routes publish "settings"
// too. A remote refresh of this state is held back while the user is on the
// Settings page (the handler's canRun) so it never re-renders a form mid-edit;
// the scheduler's own canRun retry runs it once the page is left.
async function loadSettingsState(): Promise<void> {
  void loadMqttSettings();
  void loadMcpSettingsCard();
  void loadMachineControlSetting();
  void loadMachines();
  await loadShotDefaultsSettingsCard();
}

// ── Toast helper ──────────────────────────────────────────────────────────
function showToast(msg: string, duration = 3000) {
  let el = document.getElementById('glpToast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'glpToast';
    el.style.cssText = [
      'position:fixed', 'bottom:24px', 'left:50%', 'transform:translateX(-50%)',
      // #814: was a hardcoded #27272a/#e4e4e7 — a dark chip on a light page.
      `background:${themeColor('--raised', '#27272a')}`, `color:${themeColor('--gray-200', '#e4e4e7')}`,
      'padding:10px 20px', 'border-radius:8px',
      'font-size:.85rem', 'z-index:9999', 'box-shadow:0 4px 12px rgba(0,0,0,.4)',
      'transition:opacity .3s', 'pointer-events:none', 'white-space:nowrap',
    ].join(';');
    document.body.appendChild(el);
  }
  const toast = el as HTMLElement & { _t?: ReturnType<typeof setTimeout> };
  toast.textContent = msg;
  toast.style.opacity = '1';
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { toast.style.opacity = '0'; }, duration);
}

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

  void initToken().then(async () => {
    // #735: opened once at app bootstrap, not per view-switch -- SSE-driven
    // updates must keep arriving regardless of which view/tab is currently
    // open, same reasoning as the 30s updateStatus() interval below. Needs
    // S.glpToken to already be populated (for the ?token= fallback
    // EventSource itself can't send as a header), hence after initToken()
    // resolves. `onFallback` is a no-op here -- the PR 2 follow-up (Live
    // view over the same stream) extends it.
    // #736: Live view telemetry/preheat push -- same bootstrap-time wiring
    // as above.
    onEvent(EVENTS.LIVE_SNAPSHOT, data => handleLiveSnapshotEvent(data as Parameters<typeof handleLiveSnapshotEvent>[0]));
    onEvent(EVENTS.PREHEAT_UPDATE, data => handlePreheatUpdateEvent(data as Parameters<typeof handlePreheatUpdateEvent>[0]));
    // #837: the topbar's ambient machine icon -- a second, independent
    // listener for the same two event types (see components/
    // topbar-machine-icon.js's module doc comment for why it doesn't just
    // reuse live.js's own handlers).
    onEvent(EVENTS.LIVE_SNAPSHOT, handleTopbarLiveSnapshotEvent);
    onEvent(EVENTS.PREHEAT_UPDATE, handleTopbarPreheatUpdateEvent);
    // #1539 slice 3: react to the server's data-changed pushes. Registered
    // before the stream opens so no early event is missed.
    onEvent(EVENTS.DATA_CHANGED, handleDataChanged);
    // #1539 slice 3: the per-kind refetch handlers live in live-sync-handlers.ts
    // so tests can drive the real map; the three main-local helpers the map needs
    // are passed in here.
    initLiveSync(createLiveSyncHandlers({
      loadSettingsState,
      applyServerUiPrefs,
      maintenanceCanRefetch: _maintenanceCanRefetch,
    }));
    // #1539 slice 3: recover refetches that failed or were missed while
    // offline -- a browser online event or an SSE reconnect resyncs every kind.
    connectEvents(() => {}, resyncAll);
    window.addEventListener('online', resyncAll);

    // #390 — loadMachines() calls the token-gated /api/machines; it used to
    // fire straight from this handler (before initToken() ever ran), so its
    // X-GLP-Token header was always empty and the request 401ed for any
    // non-Ingress session (Ingress bypasses the token check, which is why
    // this went unnoticed there). S.machines never populated, so the
    // machine switcher stayed hidden and the restored S.activeMachineId had
    // nothing to display itself against. Now runs once the token is ready,
    // same as loadData()/loadLibrary() below.
    const machinesPromise = loadMachines();
    // #1375: the shared UI choices live on this instance's own server, so the
    // stable and dev apps no longer overwrite each other through the shared
    // browser origin — the localStorage copy is only a cache. Fired without
    // blocking the first render; a change re-reads the shelf prefs and applies
    // the shared machine selection through the same validation loadMachines()
    // uses, so a stale id from the server cannot filter the history to nothing
    // (#1323) whichever of the two requests finishes first.
    void loadUiPrefsFromServer().then(changed => {
      if (!changed) return;
      applyServerUiPrefs();
    });
    // The Settings-page loaders (#1539 slice 5) are shared with the live-sync
    // "settings" handler. The returned promise is awaited below: loadData() can
    // render the annotation panel for the initially-selected shot synchronously
    // once it resolves (updateView() -> renderAnnotationPanel()), which reads
    // S.shotDefaults directly — on a slow connection, firing the shot-defaults
    // load unawaited could let that first render see S.shotDefaults still null
    // with nothing to re-render it once the fetch actually completes. The other
    // cards stay fire-and-forget as before.
    const settingsState = loadSettingsState();
    void loadNotifySettingsCard();
    void loadDrinkMenu();
    void loadMilkTypes();
    await settingsState;
    // #700: same class of bug as above — renderAnnotationPanel() also reads
    // S.coffeeLibrary.baskets/puckScreens (via _renderBasketSelect/
    // _renderPuckScreenSelect). Firing loadLibrary() unawaited let the first
    // render of the initially-selected shot run against an empty library,
    // so Basket/Puck Screen showed "No basket"/"No puck screen" until the
    // user navigated to another shot and back (which re-runs the render
    // after loadLibrary() had since resolved).
    await loadLibrary();
    await loadData();
    // #733: same class of bug as #700 above, one level removed — renderMachinesList()
    // (inside loadMachines()) computes each machine's shot count from S.allShots, but
    // loadMachines() was fired unawaited before loadData() populated S.allShots, so the
    // very first render always saw an empty shot list and nothing ever re-rendered it
    // once the real shots arrived. Re-render once both are guaranteed to be ready.
    await machinesPromise;
    renderMqttSettingsCard();
    renderMachinesList();
    void loadMachineProfileList();
    // #750: awaited (was fire-and-forget) so the installId comparison inside
    // updateStatus() -> syncInstallId() has a chance to clear a stale
    // setup-wizard-completed flag before the shouldOpenSetupWizard() check
    // below runs -- see utils.js's syncInstallId() comment.
    await updateStatus();
    void checkForUpdate();
    renderApiTokenCard();
    // #744: first-run setup wizard — auto-opens once S.machines is actually
    // known (after machinesPromise resolves), not before, so a returning
    // multi-machine user never sees a false-positive flash of it.
    if (shouldOpenSetupWizard(S.machines)) openSetupWizard();
  });

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
