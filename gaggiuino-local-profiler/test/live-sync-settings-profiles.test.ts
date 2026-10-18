import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { LiveSyncHandlerDeps } from '../public-src/live-sync-handlers.js';

// #1539 slice 5: the Settings and machine-profiles live-sync handlers, driven
// through the real handler map (createLiveSyncHandlers) instead of a
// hand-written copy of main.ts's registrations. The loaders render the DOM and
// hit the network, so they are stubbed here (kept real everywhere else through
// importOriginal); the main.ts-local settings loader arrives through `deps` as a
// spy. live-sync keeps its state (seen revisions, handlers, listeners) at module
// scope, so every test loads a fresh instance through vi.resetModules().

const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
g.navigator ??= { language: 'en-US' };
g.window ??= {};

const loaders = vi.hoisted(() => ({
  loadSettingsState: vi.fn<() => Promise<void>>(),
  loadMachineProfileList: vi.fn<() => Promise<void>>(),
  loadLibrary: vi.fn<() => Promise<void>>(),
  invalidateImageKeys: vi.fn<(keys?: readonly string[] | null) => void>(),
  refreshShots: vi.fn<(ids: string[] | null) => Promise<void>>(),
  shotsLoadInProgress: vi.fn<() => boolean>(),
  annotationBusy: vi.fn<() => boolean>(),
  loadDrinkMenu: vi.fn<() => Promise<void>>(),
  ordersDraftOpen: vi.fn<() => boolean>(),
  loadOrdersView: vi.fn<() => Promise<void>>(),
  refreshMaintenanceView: vi.fn<() => Promise<void>>(),
  loadUiPrefsFromServer: vi.fn<() => Promise<boolean>>(),
}));

vi.mock('../public-src/bean-image.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../public-src/bean-image.js')>()),
  invalidateImageKeys: loaders.invalidateImageKeys,
}));

vi.mock('../public-src/ui-prefs.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../public-src/ui-prefs.js')>()),
  loadUiPrefsFromServer: loaders.loadUiPrefsFromServer,
}));

vi.mock('../public-src/views/library.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../public-src/views/library.js')>()),
  loadLibrary: loaders.loadLibrary,
}));

vi.mock('../public-src/views/shots.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../public-src/views/shots.js')>()),
  refreshShots: loaders.refreshShots,
  shotsLoadInProgress: loaders.shotsLoadInProgress,
  annotationBusy: loaders.annotationBusy,
  loadDrinkMenu: loaders.loadDrinkMenu,
}));

vi.mock('../public-src/views/orders.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../public-src/views/orders.js')>()),
  ordersDraftOpen: loaders.ordersDraftOpen,
  loadOrdersView: loaders.loadOrdersView,
}));

vi.mock('../public-src/views/maintenance.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../public-src/views/maintenance.js')>()),
  refreshMaintenanceView: loaders.refreshMaintenanceView,
}));

vi.mock('../public-src/views/library-profile-editor.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../public-src/views/library-profile-editor.js')>()),
  loadMachineProfileList: loaders.loadMachineProfileList,
}));

function mkDeps(): LiveSyncHandlerDeps {
  return {
    loadSettingsState: loaders.loadSettingsState,
    applyServerUiPrefs: vi.fn<(includeMachine?: boolean, keepShelfQuery?: boolean) => void>(),
    maintenanceCanRefetch: vi.fn<() => boolean>(() => true),
  };
}

async function loadRuntime() {
  vi.resetModules();
  const { createLiveSyncHandlers } = await import('../public-src/live-sync-handlers.js');
  const { S } = await import('../public-src/state/index.js');
  const live = await import('../public-src/live-sync.js');
  return { createLiveSyncHandlers, S, live };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('settings live refresh (#1539 slice 5)', () => {
  it('defers while on Settings and runs on the scheduler retry after leaving', async () => {
    const { createLiveSyncHandlers, S, live } = await loadRuntime();
    live.initLiveSync(createLiveSyncHandlers(mkDeps()));

    S.currentMode = 'settings';
    live.handleDataChanged({ kind: 'settings', rev: 1 });
    await vi.advanceTimersByTimeAsync(300); // debounce fires, canRun holds it back
    await vi.advanceTimersByTimeAsync(2000); // the scheduler's canRun retry still holds
    expect(loaders.loadSettingsState).not.toHaveBeenCalled();

    // Leaving Settings lifts the guard. No explicit flush is needed: the
    // scheduler's own 2s canRun retry runs it.
    S.currentMode = 'shots';
    await vi.advanceTimersByTimeAsync(2000);
    expect(loaders.loadSettingsState).toHaveBeenCalledTimes(1);
  });

  it('runs immediately when not on Settings', async () => {
    const { createLiveSyncHandlers, S, live } = await loadRuntime();
    live.initLiveSync(createLiveSyncHandlers(mkDeps()));

    S.currentMode = 'shots';
    live.handleDataChanged({ kind: 'settings', rev: 1 });
    await vi.advanceTimersByTimeAsync(400);
    expect(loaders.loadSettingsState).toHaveBeenCalledTimes(1);
  });
});

describe('profiles live refresh (#1539 slice 5)', () => {
  it('calls loadMachineProfileList on a profiles event', async () => {
    const { createLiveSyncHandlers, live } = await loadRuntime();
    live.initLiveSync(createLiveSyncHandlers(mkDeps()));

    live.handleDataChanged({ kind: 'profiles', rev: 1 });
    await vi.advanceTimersByTimeAsync(400);
    expect(loaders.loadMachineProfileList).toHaveBeenCalledTimes(1);
  });

  it('coalesces a burst of profiles events into one reload', async () => {
    const { createLiveSyncHandlers, live } = await loadRuntime();
    live.initLiveSync(createLiveSyncHandlers(mkDeps()));

    live.handleDataChanged({ kind: 'profiles', rev: 1 });
    live.handleDataChanged({ kind: 'profiles', rev: 2 });
    await vi.advanceTimersByTimeAsync(400);
    expect(loaders.loadMachineProfileList).toHaveBeenCalledTimes(1);
  });
});

// The kinds live-sync will dispatch are its REGISTERED_KINDS list. Driving the
// real settings/profiles handlers through handleDataChanged proves those two are
// registered; an event for a kind that is not in the list must stay inert.
describe('registered live-sync kinds (#1539 slice 5)', () => {
  it('dispatches settings and profiles, and ignores an unregistered kind', async () => {
    const { createLiveSyncHandlers, S, live } = await loadRuntime();
    live.initLiveSync(createLiveSyncHandlers(mkDeps()));
    S.currentMode = 'shots';

    live.handleDataChanged({ kind: 'settings', rev: 1 });
    live.handleDataChanged({ kind: 'profiles', rev: 1 });
    await vi.advanceTimersByTimeAsync(400);
    expect(loaders.loadSettingsState).toHaveBeenCalledTimes(1);
    expect(loaders.loadMachineProfileList).toHaveBeenCalledTimes(1);

    live.handleDataChanged({ kind: 'not-a-registered-kind', rev: 1 });
    await vi.advanceTimersByTimeAsync(400);
    expect(loaders.loadSettingsState).toHaveBeenCalledTimes(1);
    expect(loaders.loadMachineProfileList).toHaveBeenCalledTimes(1);
  });
});
