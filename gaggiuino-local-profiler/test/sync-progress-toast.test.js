// status.js's updateStatus() — #731: a short toast when an active shot-
// import (state.syncProgress, surfaced via /api/status's syncProgress list)
// finishes, i.e. the poll where a previously-active entry is gone. Must not
// fire on the very first poll (no prior state to compare against) and must
// not repeat on every subsequent poll once it has already fired once.
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
});
