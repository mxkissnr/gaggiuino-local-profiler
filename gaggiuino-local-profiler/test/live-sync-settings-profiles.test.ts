import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';

// #1539 slice 5: the Settings and machine-profiles live-sync handlers. The
// scheduler is driven with handlers that mirror main.ts's registrations (the
// real loaders render the DOM and hit the network, so they are stubbed the same
// way live-sync-shots.test.ts stubs its reload); the boot wiring itself (which
// kinds main.ts registers, and that the settings reloader also reloads the
// machine list) is pinned from source, the established pattern for it.
//
// live-sync keeps its state (seen revisions, handlers, listeners) at module
// scope, so every test loads a fresh instance through vi.resetModules(). The
// minimum browser globals the import chain (state.js/ui-prefs.js) needs are
// stubbed first.

const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
g.navigator ??= { language: 'en-US' };
g.window ??= {};

async function loadRuntime() {
  vi.resetModules();
  const { S } = await import('../public-src/state/index.js');
  const live = await import('../public-src/live-sync.js');
  return { S, live };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('settings live refresh (#1539 slice 5)', () => {
  it('defers while on Settings and runs on the scheduler retry after leaving', async () => {
    const { S, live } = await loadRuntime();
    const run = vi.fn();

    // Mirrors main.ts's `settings` registration.
    live.initLiveSync({ settings: { canRun: () => S.currentMode !== 'settings', run } });

    S.currentMode = 'settings';
    live.handleDataChanged({ kind: 'settings', rev: 1 });
    await vi.advanceTimersByTimeAsync(300); // debounce fires, canRun holds it back
    await vi.advanceTimersByTimeAsync(2000); // the scheduler's canRun retry still holds
    expect(run).not.toHaveBeenCalled();

    // Leaving Settings lifts the guard. No explicit flush is needed: the
    // scheduler's own 2s canRun retry runs it.
    S.currentMode = 'shots';
    await vi.advanceTimersByTimeAsync(2000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('runs immediately when not on Settings', async () => {
    const { S, live } = await loadRuntime();
    const run = vi.fn();
    live.initLiveSync({ settings: { canRun: () => S.currentMode !== 'settings', run } });

    S.currentMode = 'shots';
    live.handleDataChanged({ kind: 'settings', rev: 1 });
    await vi.advanceTimersByTimeAsync(400);
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('profiles live refresh (#1539 slice 5)', () => {
  it('calls loadMachineProfileList on a profiles event', async () => {
    const { live } = await loadRuntime();
    const loadMachineProfileList = vi.fn();

    // Mirrors main.ts's `profiles` registration.
    live.initLiveSync({ profiles: { run: () => { loadMachineProfileList(); } } });

    live.handleDataChanged({ kind: 'profiles', rev: 1 });
    await vi.advanceTimersByTimeAsync(400);
    expect(loadMachineProfileList).toHaveBeenCalledTimes(1);
  });

  it('coalesces a burst of profiles events into one reload', async () => {
    const { live } = await loadRuntime();
    const loadMachineProfileList = vi.fn();
    live.initLiveSync({ profiles: { run: () => { loadMachineProfileList(); } } });

    live.handleDataChanged({ kind: 'profiles', rev: 1 });
    live.handleDataChanged({ kind: 'profiles', rev: 2 });
    await vi.advanceTimersByTimeAsync(400);
    expect(loadMachineProfileList).toHaveBeenCalledTimes(1);
  });
});

describe('boot wiring (#1539 slice 5)', () => {
  it('registers the settings and profiles kinds in main.ts', () => {
    const src = readFileSync(new URL('../public-src/main.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/settings:\s*\{[\s\S]*?canRun: \(\) => S\.currentMode !== 'settings'[\s\S]*?run: loadSettingsState/);
    expect(src).toMatch(/profiles:\s*\{[\s\S]*?run: \(\) => loadMachineProfileList\(\)/);
  });

  it('extracts loadSettingsState and reuses it at boot', () => {
    const src = readFileSync(new URL('../public-src/main.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/async function loadSettingsState\(\): Promise<void>/);
    // Reused at boot: the promise is held and awaited before loadData() runs.
    expect(src).toMatch(/const settingsState = loadSettingsState\(\);/);
    expect(src).toMatch(/await settingsState;/);
    // The shot-defaults card is loaded inside loadSettingsState, not also at the
    // boot call site (which would double-fetch it).
    const callSites = src.match(/await loadShotDefaultsSettingsCard\(\);/g) ?? [];
    expect(callSites).toHaveLength(1);
  });

  it('reloads the machine list with the settings state', () => {
    const src = readFileSync(new URL('../public-src/main.ts', import.meta.url), 'utf8');
    // The machine-registry routes publish "settings" too, so the shared settings
    // reloader must reload the machine list, not just the shot defaults.
    expect(src).toMatch(/async function loadSettingsState\(\): Promise<void> \{[\s\S]*?void loadMachines\(\);[\s\S]*?await loadShotDefaultsSettingsCard\(\);\n\}/);
  });

  it('lists settings and profiles among the registered live-sync kinds', () => {
    const src = readFileSync(new URL('../public-src/live-sync.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/const REGISTERED_KINDS: readonly DataKind\[\] = \[[\s\S]*?'settings', 'profiles',[\s\S]*?\];/);
    expect(src).toMatch(/\| 'settings'[\s\S]*?\| 'profiles';/);
  });
});
