// Boot step (#1615): the data boot chain -- token, live events, settings,
// library, shots, machines, status, setup wizard -- as tasks with explicit
// dependencies (see runBootTasks()). Moved out of main.ts's DOMContentLoaded
// handler, where it was one promise chain: a rejection anywhere silently
// skipped everything after it, related or not. Now a failed task skips only
// the tasks that need it; independent branches still run, in the same order.
import { S } from '../state/index.js';
import { getUiPref, loadUiPrefsFromServer } from '../ui-prefs.js';
import { initToken } from '../api/transport.js';
import { connectEvents, onEvent, EVENTS } from '../sse.js';
import { initLiveSync, handleDataChanged, resyncAll } from '../live-sync.js';
import { createLiveSyncHandlers } from '../live-sync-handlers.js';
import { updateStatus } from '../components/status.js';
import { checkForUpdate } from '../components/update-check.js';
import { loadData, loadDrinkMenu, loadMilkTypes } from '../views/shots.js';
import { handleLiveSnapshotEvent, handlePreheatUpdateEvent } from '../views/live.js';
import { loadLibrary, resetShelfPrefs } from '../views/library.js';
import { loadMachineProfileList } from '../views/library-profile-editor.js';
import { loadMachines, setActiveMachine, resolveActiveMachineId, renderMachinesList } from '../components/machines-settings.js';
import { openSetupWizard, shouldOpenSetupWizard } from '../views/setup-wizard.js';
import { handleTopbarLiveSnapshotEvent, handleTopbarPreheatUpdateEvent } from '../components/topbar-machine-icon.js';
import { loadMqttSettings, renderMqttSettingsCard } from '../components/mqtt-settings.js';
import { loadNotifySettingsCard } from '../components/notify-settings.js';
import { loadMcpSettingsCard } from '../components/mcp-settings.js';
import { loadMachineControlSetting } from '../components/machine-control.js';
import { loadShotDefaultsSettingsCard } from '../components/shot-defaults-settings.js';
import { renderBeanFreshnessSettings } from '../components/bean-freshness-settings.js';
import { renderApiTokenCard } from './settings.js';
import { runBootTasks } from './run-step.js';
import type { BootOutcome } from './run-step.js';

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
  renderBeanFreshnessSettings();
  await loadShotDefaultsSettingsCard();
}


// Runs the data boot chain; resolves with each task's outcome once all have
// settled (main.ts does not wait for it).
export function bootData(): Promise<Map<string, BootOutcome>> {
  return runBootTasks([
    // Every request below needs the session token (or its absence settled):
    // initToken() populates S.glpToken for the X-GLP-Token header and the
    // SSE stream ticket (#1626).
    { name: 'token', run: initToken },
    {
      name: 'live events', requires: ['token'],
      run: () => {
        // #735: opened once at app bootstrap, not per view-switch -- SSE-driven
        // updates must keep arriving regardless of which view/tab is currently
        // open, same reasoning as the 30s updateStatus() interval in main.ts.
        // Needs S.glpToken to already be populated (to request the stream
        // ticket EventSource itself can't send as a header), hence after initToken()
        // resolves. `onFallback` is a no-op here -- the PR 2 follow-up (Live
        // view over the same stream) extends it.
        // #736: Live view telemetry/preheat push -- same bootstrap-time wiring
        // as above.
        onEvent(EVENTS.LIVE_SNAPSHOT, data => handleLiveSnapshotEvent(data as Parameters<typeof handleLiveSnapshotEvent>[0]));
        onEvent(EVENTS.PREHEAT_UPDATE, data => handlePreheatUpdateEvent(data as Parameters<typeof handlePreheatUpdateEvent>[0]));
        // #837: the topbar's ambient machine icon -- a second, independent
        // listener for the same two event types (see components/
        // topbar-machine-icon.ts's module doc comment for why it doesn't just
        // reuse live.ts's own handlers).
        onEvent(EVENTS.LIVE_SNAPSHOT, handleTopbarLiveSnapshotEvent);
        onEvent(EVENTS.PREHEAT_UPDATE, handleTopbarPreheatUpdateEvent);
        // #1539 slice 3: react to the server's data-changed pushes. Registered
        // before the stream opens so no early event is missed.
        onEvent(EVENTS.DATA_CHANGED, handleDataChanged);
        // #1539 slice 3: the per-kind refetch handlers live in live-sync-handlers.ts
        // so tests can drive the real map; the three local helpers the map needs
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
      },
    },
    // #390 — loadMachines() calls the token-gated /api/machines; it used to
    // fire before initToken() ever ran, so its X-GLP-Token header was always
    // empty and the request 401ed for any non-Ingress session (Ingress
    // bypasses the token check, which is why this went unnoticed there).
    // S.machines never populated, so the machine switcher stayed hidden and
    // the restored S.activeMachineId had nothing to display itself against.
    // Now runs once the token is ready, same as loadData()/loadLibrary().
    { name: 'machines', requires: ['token'], run: loadMachines },
    // #1375: the shared UI choices live on this instance's own server, so the
    // stable and dev apps no longer overwrite each other through the shared
    // browser origin — the localStorage copy is only a cache. Not blocking the
    // first render; a change re-reads the shelf prefs and applies the shared
    // machine selection through the same validation loadMachines() uses, so a
    // stale id from the server cannot filter the history to nothing (#1323)
    // whichever of the two requests finishes first.
    {
      name: 'ui prefs', requires: ['token'],
      run: async () => {
        if (await loadUiPrefsFromServer()) applyServerUiPrefs();
      },
    },
    // The Settings-page loaders (#1539 slice 5) are shared with the live-sync
    // "settings" handler. The library waits for them: loadData() can render
    // the annotation panel for the initially-selected shot synchronously once
    // it resolves (updateView() -> renderAnnotationPanel()), which reads
    // S.shotDefaults directly — on a slow connection, firing the shot-defaults
    // load unawaited could let that first render see S.shotDefaults still null
    // with nothing to re-render it once the fetch actually completes. The other
    // cards stay fire-and-forget as before.
    //
    // Ordered after "ui prefs": the bean-freshness card is pre-filled from the
    // shared preferences, and rendering it before the merge would show a fresh
    // device the defaults instead of the configured set.
    { name: 'settings', requires: ['token'], after: ['ui prefs'], run: loadSettingsState },
    { name: 'notify settings', requires: ['token'], run: loadNotifySettingsCard },
    { name: 'drink menu', requires: ['token'], run: loadDrinkMenu },
    { name: 'milk types', requires: ['token'], run: loadMilkTypes },
    // #700: same class of bug as above — renderAnnotationPanel() also reads
    // S.coffeeLibrary.baskets/puckScreens (via _renderBasketSelect/
    // _renderPuckScreenSelect). Firing loadLibrary() unawaited let the first
    // render of the initially-selected shot run against an empty library,
    // so Basket/Puck Screen showed "No basket"/"No puck screen" until the
    // user navigated to another shot and back (which re-runs the render
    // after loadLibrary() had since resolved).
    { name: 'library', requires: ['settings'], run: loadLibrary },
    { name: 'shots', requires: ['library'], run: loadData },
    // #733: same class of bug as #700 above, one level removed — renderMachinesList()
    // (inside loadMachines()) computes each machine's shot count from S.allShots, but
    // loadMachines() was fired unawaited before loadData() populated S.allShots, so the
    // very first render always saw an empty shot list and nothing ever re-rendered it
    // once the real shots arrived. Re-render once both are guaranteed to be ready
    // (or the shots load has given up: a machine list without counts beats none).
    {
      name: 'machine list', requires: ['machines'], after: ['shots'],
      run: () => {
        renderMqttSettingsCard();
        renderMachinesList();
      },
    },
    { name: 'machine profiles', requires: ['machines'], after: ['shots'], run: loadMachineProfileList },
    // #750: the setup-wizard check below waits for this so the installId
    // comparison inside updateStatus() -> syncInstallId() has a chance to
    // clear a stale setup-wizard-completed flag first -- see utils.ts's
    // syncInstallId() comment. Ordered after the shots and machines loads as
    // before (it reads S.primaryShotId and S.activeMachineId), but not
    // dependent on them succeeding.
    { name: 'status', requires: ['token'], after: ['shots', 'machines'], run: () => updateStatus() },
    { name: 'update check', requires: ['token'], after: ['status'], run: checkForUpdate },
    // Reads S.apiPortExposed, which the status poll sets.
    { name: 'api token card', requires: ['token'], after: ['status'], run: renderApiTokenCard },
    // #744: first-run setup wizard — auto-opens once S.machines is actually
    // known (after the machines load), not before, so a returning
    // multi-machine user never sees a false-positive flash of it.
    {
      name: 'setup wizard', requires: ['status', 'machines'],
      run: () => { if (shouldOpenSetupWizard(S.machines)) openSetupWizard(); },
    },
  ]);
}
