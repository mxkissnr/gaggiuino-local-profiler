// #1539 slice 3: the per-kind live-sync refetch handlers, moved out of main.ts
// so their behaviour is importable and testable instead of only readable as
// source text. The loaders that already live in their own modules are imported
// here directly; the few that are still local to boot/data.ts (the shared
// Settings-page loader, the server ui-prefs applier and the maintenance refetch
// guard) arrive through `deps`.
import { S } from './state/index.js';
import { invalidateImageKeys } from './bean-image.js';
import { loadUiPrefsFromServer } from './ui-prefs.js';
import { loadLibrary } from './views/library.js';
import { refreshShots, shotsLoadInProgress, annotationBusy, loadDrinkMenu } from './views/shots.js';
import { ordersDraftOpen, loadOrdersView } from './views/orders.js';
import { refreshMaintenanceView } from './views/maintenance.js';
import { loadMachineProfileList } from './views/library-profile-editor.js';
import { reloadBlocked, type LiveSyncHandlers } from './live-sync.js';

// The functions the handler map needs that are still local to boot/data.ts; every
// other loader is imported from its own module above. Declared as properties
// (not methods) so they can be passed by reference without a `this` binding.
export interface LiveSyncHandlerDeps {
  loadSettingsState: () => Promise<void>;
  applyServerUiPrefs: (includeMachine?: boolean, keepShelfQuery?: boolean) => void;
  maintenanceCanRefetch: () => boolean;
}

export function createLiveSyncHandlers(deps: LiveSyncHandlerDeps): LiveSyncHandlers {
  return {
    library: {
      // A library change is usually a stock change derived from a shot, which
      // does not touch the photos, so the cache is left alone here.
      run: async () => { await loadLibrary(); },
    },
    'library-image': {
      // An image write addresses its cache key (bean:<id>, grinder:<id>, ...),
      // so drop those entries (null drops every library photo) and reload the
      // library once.
      run: async ids => { invalidateImageKeys(ids); await loadLibrary(); },
    },
    shot: {
      // One shot's own write (annotation or photo). refreshShots() patches the
      // loaded row in place; the library refetch an annotation also triggers is
      // handled by the `library` kind the server publishes alongside it.
      // Deferred, not dropped, while this page is saving an edit or (re)loading
      // the list -- the scheduler retries once the guard clears.
      canRun: () => !annotationBusy() && !shotsLoadInProgress(),
      run: ids => refreshShots(ids),
    },
    shots: {
      // A shot-list change (trash/restore/delete). No single id to patch, so
      // the whole list is re-fetched quietly, deferred on the same guards.
      canRun: () => !annotationBusy() && !shotsLoadInProgress(),
      run: () => refreshShots(null),
    },
    orders: {
      // Deferred, not dropped, while the orders view holds uncommitted text
      // (a focused field or an open decline row); the scheduler retries once
      // it clears.
      canRun: () => !ordersDraftOpen(),
      run: async () => {
        await Promise.all([loadDrinkMenu(), S.currentMode === 'orders' ? loadOrdersView() : undefined]);
      },
    },
    maintenance: {
      // refreshMaintenanceView() restores the card the user had expanded, so
      // the refetch no longer needs to be held back while one is open.
      run: async () => { if (S.currentMode === 'maintenance') await refreshMaintenanceView(); },
      canRun: () => deps.maintenanceCanRefetch(),
    },
    'ui-prefs': {
      run: async () => {
        const changed = await loadUiPrefsFromServer();
        if (changed) deps.applyServerUiPrefs(false, true);
      },
    },
    profiles: {
      // The machine's profile list changed on the server — a profile write,
      // or the profile-sync sweep publishing the kind. loadMachineProfileList()
      // re-renders the list and its autocomplete from the current state.
      run: () => loadMachineProfileList(),
    },
    settings: {
      // The shot defaults, machine registry and broker/MCP/control options.
      // Held back while the user is on the Settings page so a remote change
      // never re-renders a form mid-edit; the scheduler retries it once the
      // page is left.
      canRun: () => S.currentMode !== 'settings',
      run: deps.loadSettingsState,
    },
    all: {
      // A whole-database change (restore, DB import, demo seed/end): reload
      // through the live-sync pipeline, so it honours the focus and
      // hidden-tab guards like any other run.
      run: () => { location.reload(); },
      // ...but a reload discards more than focus alone protects: an open
      // bottom sheet or dialog (e.g. the bean form) must hold it back too,
      // even after focus has left its fields. The scheduler retries until
      // the sheet closes.
      canRun: () => !reloadBlocked(),
    },
  };
}
