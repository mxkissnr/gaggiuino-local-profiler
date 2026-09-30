// status.js's polling fallback (pollSyncProgressFallback(), only exercised
// when S.sseActive is falsy), which preserves the original #731/#734
// regression coverage: a short toast when an active shot-import
// (state.syncProgress, surfaced via /api/status's syncProgress list)
// finishes, i.e. the poll where a previously-active entry is gone. Must not
// fire on the very first poll (no prior state to compare against), must not
// repeat on every subsequent poll once it has already fired once, and must
// be tracked per machineId (not a single scalar) since lib/state.js's
// syncProgress deliberately allows more than one machine to backfill at once.
//
// Same fake-document convention as test/status-update-machine-id.test.js.
import { describe, it, expect, beforeEach, vi } from 'vitest';
// vitest's node environment has no browser globals; stub them through a loose
// view of globalThis (the same bridge test/sse-frontend.test.ts uses) so the
// minimal fakes below need not satisfy the full Storage/Navigator/Window shapes.
const g = globalThis as unknown as Record<string, unknown>;

const _store = new Map<string, string>();
g.localStorage = {
  getItem: (k: string) => (_store.has(k) ? _store.get(k) : null),
  setItem: (k: string, v: unknown) => { _store.set(k, String(v)); },
  removeItem: (k: string) => { _store.delete(k); },
};
g.navigator ??= { language: 'en-US' };
g.window ??= globalThis;

// status.ts reaches window.showToast through the global `window`, which is
// globalThis in this environment.
interface FakeWindow {
  showToast?: (msg: string) => void;
}
const win = g.window as FakeWindow;

const { S } = await import('../public-src/state/index.js');
const { updateStatus } = await import('../public-src/components/status.js');

interface FakeElement {
  className: string;
  textContent: string;
  title: string;
  style: Record<string, string>;
  disabled: boolean;
  querySelector: () => FakeElement;
}

function makeFakeDocument() {
  const registry = new Map<string, FakeElement>();
  function makeElement(): FakeElement {
    return {
      className: '', textContent: '', title: '', style: {}, disabled: false,
      querySelector: () => makeElement(),
    };
  }
  return {
    getElementById: (id: string): FakeElement => registry.get(id)!,
    _preRegister(id: string): FakeElement {
      const el = makeElement();
      registry.set(id, el);
      return el;
    },
  };
}

type SyncProgressEntry = { machineId: number; current: number; total: number };
interface FakeResponse { ok: boolean; json: () => Promise<unknown> }

describe('Polling fallback: updateStatus() import-complete toast (#731, S.sseActive=false)', () => {
  let doc: ReturnType<typeof makeFakeDocument>;
  let toastCalls: string[];
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    doc = makeFakeDocument();
    ['statusDot', 'railStatusDot', 'syncTime', 'machineSubtitle', 'railMachineName',
     'glpVersionBadge', 'btnOrders', 'bnOrders', 'powerBtn', 'btnLive',
     'syncProgressBar', 'syncProgressLabel'].forEach(id => doc._preRegister(id));
    g.document = doc;
    S.primaryShotId = null;
    S.currentLang = 'en';
    // #735: this describe block exists specifically to exercise the
    // polling fallback -- forcing sseActive=false is what makes
    // updateStatus() call pollSyncProgressFallback() at all (see status.js).
    S.sseActive = false;

    toastCalls = [];
    win.showToast = msg => toastCalls.push(msg);
  });

  function mockStatus(syncProgress: SyncProgressEntry[]) {
    fetchMock = vi.fn((url: string | URL) => {
      if (String(url).startsWith('api/status')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ lastSync: '2026-01-01T00:00:00.000Z', syncProgress }),
        });
      }
      return Promise.resolve({ ok: false }); // api/switch
    });
    g.fetch = fetchMock;
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
    let resolveFetch!: (value: FakeResponse) => void;
    const pending = new Promise<FakeResponse>(res => { resolveFetch = res; });
    fetchMock = vi.fn((url: string | URL) => {
      if (String(url).startsWith('api/status')) return pending;
      return Promise.resolve({ ok: false });
    });
    g.fetch = fetchMock;

    const first = updateStatus();
    const second = updateStatus(); // fires while `first` is still awaiting the fetch above

    resolveFetch({ ok: true, json: () => Promise.resolve({ lastSync: '2026-01-01T00:00:00.000Z', syncProgress: [] }) });
    await Promise.all([first, second]);

    // Only the first call's fetch actually ran -- the second returned immediately.
    expect(fetchMock.mock.calls.filter((c: unknown[]) => String(c[0]).startsWith('api/status')).length).toBe(1);
  });
});
