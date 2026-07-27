import { describe, it, expect, vi, beforeEach } from 'vitest';

// machines-settings.js's restoreActiveMachine() IIFE reads localStorage at
// *module import time* — set a persisted activeMachineId before the first
// import below, to simulate the returning-user case (#526) where
// S.activeMachineId is already set from a previous session, not left at
// its null default the way a brand-new session (or the screenshots.mjs
// browser context) would leave it.
globalThis.localStorage ??= {
  getItem: key => (key === 'glp_active_machine' ? '1' : null),
  setItem: () => {},
};
globalThis.navigator ??= { language: 'en-US' };
globalThis.window ??= globalThis;

const { S } = await import('../public-src/state.js');
const { loadMachines } = await import('../public-src/components/machines-settings.js');

// Generic permissive fetch stub — loadMachines()'s own applyActiveMachineChange()
// call fires a few unrelated, unawaited follow-up fetches (profile list,
// status poll); none of them matter to this test, they just need to resolve
// cleanly instead of rejecting into an unhandled promise.
function stubFetch(machines) {
  globalThis.fetch = async url => {
    if (String(url).includes('api/machines')) return { ok: true, json: async () => machines };
    return { ok: true, json: async () => ({}) };
  };
}

describe('loadMachines (#526 render race)', () => {
  beforeEach(() => {
    globalThis.document = { getElementById: () => undefined, querySelectorAll: () => [] };
    S.activeMachineId = 1; // persisted from the previous session, as restoreActiveMachine() set it
    S.allShots = [];
    globalThis.window.initAnalytics = vi.fn();
  });

  it('refreshes the Analytics view once >=2 machines finish loading, even though activeMachineId was already set (returning-user session)', async () => {
    S.currentMode = 'analytics'; // user already switched to Analytics before this fetch resolved
    stubFetch([
      { id: 1, name: 'Gaggiuino', isDefault: true },
      { id: 2, name: 'GaggiMate Sim', isDefault: false },
    ]);

    await loadMachines();

    expect(S.machines).toHaveLength(2);
    expect(globalThis.window.initAnalytics).toHaveBeenCalledTimes(1);
  });

  it('does not touch Analytics when the user is on a different view', async () => {
    S.currentMode = 'shots';
    stubFetch([
      { id: 1, name: 'Gaggiuino', isDefault: true },
      { id: 2, name: 'GaggiMate Sim', isDefault: false },
    ]);

    await loadMachines();

    expect(globalThis.window.initAnalytics).not.toHaveBeenCalled();
  });
});
