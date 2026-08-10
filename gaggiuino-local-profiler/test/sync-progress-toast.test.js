// status.js's updateStatus() — #731: a short toast when an active shot-
// import (state.syncProgress, surfaced via /api/status's syncProgress list)
// finishes, i.e. the poll where a previously-active entry is gone. Must not
// fire on the very first poll (no prior state to compare against), must not
// repeat on every subsequent poll once it has already fired once, and must
// be tracked per machineId (not a single scalar) since lib/state.js's
// syncProgress deliberately allows more than one machine to backfill at
// once -- a code-review regression guard below covers a bug where a scalar
// tracker let one machine's completion toast go missing entirely whenever
// another machine was still active.
//
// Same fake-document convention as test/status-update-machine-id.test.js.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const _store = new Map();
globalThis.localStorage = {
  getItem: k => (_store.has(k) ? _store.get(k) : null),
  setItem: (k, v) => { _store.set(k, String(v)); },
  removeItem: k => { _store.delete(k); },
};
globalThis.navigator ??= { language: 'en-US' };
globalThis.window ??= globalThis;

const { S } = await import('../public-src/state.js');
const { updateStatus } = await import('../public-src/components/status.js');

function makeFakeDocument() {
  const registry = new Map();
  function makeElement() {
    const el = { className: '', textContent: '', title: '', style: {}, disabled: false };
    el.querySelector = () => makeElement();
    return el;
  }
  return {
    getElementById: id => registry.get(id),
    _preRegister(id) {
      const el = makeElement();
      registry.set(id, el);
      return el;
    },
  };
}

describe('updateStatus() import-complete toast (#731)', () => {
  let doc, toastCalls;

  beforeEach(() => {
    doc = makeFakeDocument();
    ['statusDot', 'railStatusDot', 'syncTime', 'machineSubtitle', 'railMachineName',
     'glpVersionBadge', 'btnOrders', 'bnOrders', 'powerBtn', 'btnLive',
     'syncProgressBar', 'syncProgressLabel'].forEach(id => doc._preRegister(id));
    globalThis.document = doc;
    S.primaryShotId = null;
    S.currentLang = 'en';

    toastCalls = [];
    globalThis.window.showToast = msg => toastCalls.push(msg);
  });

  function mockStatus(syncProgress) {
    globalThis.fetch = vi.fn(url => {
      if (String(url).startsWith('api/status')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ lastSync: '2026-01-01T00:00:00.000Z', syncProgress }),
        });
      }
      return Promise.resolve({ ok: false }); // api/switch
    });
  }

  it('does not toast on the very first poll, even with no active import', async () => {
    mockStatus([]);
    await updateStatus();
    expect(toastCalls).toEqual([]);
  });

  it('does not toast while an import is still active', async () => {
    mockStatus([{ machineId: 1, current: 3, total: 10 }]);
    await updateStatus();
    expect(toastCalls).toEqual([]);
  });

  it('toasts once, with the final shot count, when an active import disappears on a later poll', async () => {
    mockStatus([{ machineId: 1, current: 3, total: 10 }]);
    await updateStatus();
    mockStatus([]);
    await updateStatus();
    expect(toastCalls).toEqual(['Import complete: 10 shots']);
  });

  it('does not toast again on a further poll after the completion toast already fired', async () => {
    mockStatus([{ machineId: 1, current: 3, total: 10 }]);
    await updateStatus();
    mockStatus([]);
    await updateStatus();
    await updateStatus();
    expect(toastCalls).toEqual(['Import complete: 10 shots']);
  });

  // #731 code-review regression guard: a single scalar tracker (the original
  // version of this fix) let one machine's entry silently overwrite another's
  // in _lastSyncProgress, so whichever machine finished first never got its
  // own toast as long as the other was still active -- and misattributed its
  // total to the wrong machine once both were done. Each machineId must get
  // its own toast, at its own completion, independent of the others.
  it('#731 regression guard: two machines backfilling concurrently each get their own completion toast', async () => {
    // Machine 1 (100 shots) and machine 2 (50 shots) both actively backfilling.
    mockStatus([
      { machineId: 1, current: 10, total: 100 },
      { machineId: 2, current: 40, total: 50 },
    ]);
    await updateStatus();
    expect(toastCalls).toEqual([]);

    // Machine 2 finishes first -- its entry drops out of the list while
    // machine 1's is still there.
    mockStatus([{ machineId: 1, current: 20, total: 100 }]);
    await updateStatus();
    expect(toastCalls).toEqual(['Import complete: 50 shots']);

    // Machine 1 finishes later, on its own poll.
    mockStatus([]);
    await updateStatus();
    expect(toastCalls).toEqual(['Import complete: 50 shots', 'Import complete: 100 shots']);
  });
});
