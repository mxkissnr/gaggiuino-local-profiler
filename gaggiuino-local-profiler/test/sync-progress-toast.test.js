// status.js's shot-import progress bar/toast. Two independent paths feed it
// (#735): SSE push (handleSyncProgressEvent/handleSyncCompleteEvent, no
// fetch-mocking needed -- the backend tells the frontend directly) and the
// pre-SSE polling fallback (pollSyncProgressFallback(), only exercised when
// S.sseActive is falsy), which preserves the original #731/#734 regression
// coverage: a short toast when an active shot-import (state.syncProgress,
// surfaced via /api/status's syncProgress list) finishes, i.e. the poll
// where a previously-active entry is gone. Must not fire on the very first
// poll (no prior state to compare against), must not repeat on every
// subsequent poll once it has already fired once, and must be tracked per
// machineId (not a single scalar) since lib/state.js's syncProgress
// deliberately allows more than one machine to backfill at once.
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
const { updateStatus, handleSyncProgressEvent, handleSyncCompleteEvent } = await import('../public-src/components/status.js');

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

describe('SSE push: handleSyncProgressEvent()/handleSyncCompleteEvent() (#735)', () => {
  let doc, toastCalls;

  beforeEach(() => {
    doc = makeFakeDocument();
    ['syncProgressBar', 'syncProgressLabel'].forEach(id => doc._preRegister(id));
    globalThis.document = doc;
    S.activeMachineId = null;
    S.currentLang = 'en';

    toastCalls = [];
    globalThis.window.showToast = msg => toastCalls.push(msg);
  });

  it('renders the bar directly from a progress push, no fetch involved', () => {
    handleSyncProgressEvent({ machineId: 1, current: 3, total: 10 });
    const bar = doc.getElementById('syncProgressBar');
    expect(bar.style.display).toBe('');
    expect(doc.getElementById('syncProgressLabel').textContent).toBe('Import 3/10');
  });

  it('#737 review: toasts a failure message (not the completion one) when success is false', () => {
    handleSyncProgressEvent({ machineId: 1, current: 10, total: 10 });
    handleSyncCompleteEvent({ machineId: 1, total: 10, success: false });
    expect(toastCalls).toEqual(['Import failed -- some shots may be missing']);
    expect(doc.getElementById('syncProgressBar').style.display).toBe('none');
  });

  it('toasts with the final count when success is true', () => {
    handleSyncProgressEvent({ machineId: 1, current: 10, total: 10 });
    handleSyncCompleteEvent({ machineId: 1, total: 10, success: true });
    expect(toastCalls).toEqual(['Import complete: 10 shots']);
    expect(doc.getElementById('syncProgressBar').style.display).toBe('none');
  });

  // #731 regression guard, structural now instead of poll-diff-based: two
  // machines pushing concurrently each get their own completion toast, and
  // finishing one doesn't hide the other's still-active bar state.
  it('two machines backfilling concurrently each get their own completion toast', () => {
    handleSyncProgressEvent({ machineId: 1, current: 10, total: 100 });
    handleSyncProgressEvent({ machineId: 2, current: 40, total: 50 });
    expect(toastCalls).toEqual([]);

    handleSyncCompleteEvent({ machineId: 2, total: 50, success: true });
    expect(toastCalls).toEqual(['Import complete: 50 shots']);

    handleSyncCompleteEvent({ machineId: 1, total: 100, success: true });
    expect(toastCalls).toEqual(['Import complete: 50 shots', 'Import complete: 100 shots']);
  });
});

describe('Polling fallback: updateStatus() import-complete toast (#731, S.sseActive=false)', () => {
  let doc, toastCalls;

  beforeEach(() => {
    doc = makeFakeDocument();
    ['statusDot', 'railStatusDot', 'syncTime', 'machineSubtitle', 'railMachineName',
     'glpVersionBadge', 'btnOrders', 'bnOrders', 'powerBtn', 'btnLive',
     'syncProgressBar', 'syncProgressLabel'].forEach(id => doc._preRegister(id));
    globalThis.document = doc;
    S.primaryShotId = null;
    S.currentLang = 'en';
    // #735: this describe block exists specifically to exercise the
    // polling fallback -- forcing sseActive=false is what makes
    // updateStatus() call pollSyncProgressFallback() at all (see status.js).
    S.sseActive = false;

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

  // #734 review: updateStatus() can now be triggered from three independent
  // places (the 30s interval, a machine switch, and #733's visibilitychange
  // refocus handler) with no ordering guarantee between them -- two
  // overlapping in-flight calls both reading+mutating the shared
  // _lastSyncProgress map could otherwise both observe the same
  // just-finished import and double-fire its completion toast.
  it('#734 regression guard: a second updateStatus() call while one is already in flight is a no-op, not a duplicate poll', async () => {
    let resolveFetch;
    const pending = new Promise(res => { resolveFetch = res; });
    globalThis.fetch = vi.fn(url => {
      if (String(url).startsWith('api/status')) return pending;
      return Promise.resolve({ ok: false });
    });

    const first = updateStatus();
    const second = updateStatus(); // fires while `first` is still awaiting the fetch above

    resolveFetch({ ok: true, json: async () => ({ lastSync: '2026-01-01T00:00:00.000Z', syncProgress: [] }) });
    await Promise.all([first, second]);

    // Only the first call's fetch actually ran -- the second returned immediately.
    expect(globalThis.fetch.mock.calls.filter(c => String(c[0]).startsWith('api/status')).length).toBe(1);
  });
});
