import { describe, it, expect, vi, beforeEach } from 'vitest';

// machines-settings.js's restoreActiveMachine() IIFE reads localStorage at
// *module import time* — set a persisted activeMachineId before the first
// import below, to simulate the returning-user case (#526) where
// S.activeMachineId is already set from a previous session, not left at
// its null default the way a brand-new session (or the screenshots.mjs
// browser context) would leave it.
// vitest's node environment has no browser globals; stub them through a loose
// view of globalThis so the minimal fakes below need not satisfy the full
// Storage/Navigator/Window shapes.
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= {
  getItem: (key: string): string | null => (key === 'glp_active_machine' ? '1' : null),
  setItem: () => {},
};
g.navigator ??= { language: 'en-US' };
g.window ??= globalThis;

// initAnalytics is called on window (which is globalThis here); a typed bridge
// keeps the mock's assertions lint-safe.
const win = globalThis as unknown as { initAnalytics: ReturnType<typeof vi.fn> };

const { S } = await import('../public-src/state/index.js');
const { loadMachines } = await import('../public-src/components/machines-settings.js');

// Generic permissive fetch stub — loadMachines()'s own applyActiveMachineChange()
// call fires a few unrelated, unawaited follow-up fetches (profile list,
// status poll); none of them matter to this test, they just need to resolve
// cleanly instead of rejecting into an unhandled promise.
interface MachineFixture { id: number; name: string; isDefault: boolean }
function stubFetch(machines: MachineFixture[]): void {
  g.fetch = (url: string) => {
    if (String(url).includes('api/machines')) return Promise.resolve({ ok: true, json: () => Promise.resolve(machines) });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  };
}

describe('loadMachines (#526 render race)', () => {
  beforeEach(() => {
    g.document = { getElementById: () => undefined, querySelectorAll: () => [] };
    S.activeMachineId = 1; // persisted from the previous session, as restoreActiveMachine() set it
    S.allShots = [];
    win.initAnalytics = vi.fn();
  });

  it('refreshes the Analytics view once >=2 machines finish loading, even though activeMachineId was already set (returning-user session)', async () => {
    S.currentMode = 'analytics'; // user already switched to Analytics before this fetch resolved
    stubFetch([
      { id: 1, name: 'Gaggiuino', isDefault: true },
      { id: 2, name: 'GaggiMate Sim', isDefault: false },
    ]);

    await loadMachines();

    expect(S.machines).toHaveLength(2);
    expect(win.initAnalytics).toHaveBeenCalledTimes(1);
  });

  it('does not touch Analytics when the user is on a different view', async () => {
    S.currentMode = 'shots';
    stubFetch([
      { id: 1, name: 'Gaggiuino', isDefault: true },
      { id: 2, name: 'GaggiMate Sim', isDefault: false },
    ]);

    await loadMachines();

    expect(win.initAnalytics).not.toHaveBeenCalled();
  });
});
