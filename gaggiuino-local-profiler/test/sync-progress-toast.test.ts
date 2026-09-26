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
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ShotMeta } from '../public-src/state/index.js';

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

// status.ts reaches all three through the global `window`, which is globalThis
// in this environment.
interface FakeWindow {
  showToast?: (msg: string) => void;
  updateFlapCounter?: (n: number) => void;
  loadData?: () => void | Promise<void>;
}
const win = g.window as FakeWindow;

const { S } = await import('../public-src/state/index.js');
const { updateStatus, handleSyncProgressEvent, handleSyncCompleteEvent } = await import('../public-src/components/status.js');

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

describe('SSE push: handleSyncProgressEvent()/handleSyncCompleteEvent() (#735)', () => {
  let doc: ReturnType<typeof makeFakeDocument>;
  let toastCalls: string[];

  beforeEach(() => {
    doc = makeFakeDocument();
    ['syncProgressBar', 'syncProgressLabel'].forEach(id => doc._preRegister(id));
    g.document = doc;
    S.activeMachineId = null;
    S.currentLang = 'en';

    toastCalls = [];
    win.showToast = msg => toastCalls.push(msg);
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

describe('SSE push: shot-counter live update via handleSyncProgressEvent()/handleSyncCompleteEvent() (#742)', () => {
  let doc: ReturnType<typeof makeFakeDocument>;
  let loadDataCalls: number;

  beforeEach(() => {
    doc = makeFakeDocument();
    ['syncProgressBar', 'syncProgressLabel'].forEach(id => doc._preRegister(id));
    g.document = doc;
    S.activeMachineId = null;
    S.currentLang = 'en';
    S.shots = new Array<ShotMeta>(37); // baseline shot count before any backfill starts

    win.showToast = () => {};
    win.updateFlapCounter = vi.fn();
    loadDataCalls = 0;
    win.loadData = () => { loadDataCalls++; };
  });

  // status.js's _midSyncCurrent/_globalBaseline are module-scoped, not reset
  // between tests -- every test below must leave them empty again (complete
  // every machineId it started) so the next test's first event reliably
  // resamples S.shots.length instead of inheriting stale state.
  afterEach(() => {
    handleSyncCompleteEvent({ machineId: 1, total: 0, success: false });
    handleSyncCompleteEvent({ machineId: 2, total: 0, success: false });
  });

  it('shows baseline + current on the first progress event of a new backfill', () => {
    handleSyncProgressEvent({ machineId: 1, current: 3, total: 10 });
    expect(win.updateFlapCounter).toHaveBeenLastCalledWith(40); // 37 + 3
  });

  it('keeps advancing the same baseline on later ticks of the same sequence', () => {
    handleSyncProgressEvent({ machineId: 1, current: 1, total: 10 });
    handleSyncProgressEvent({ machineId: 1, current: 5, total: 10 });
    handleSyncProgressEvent({ machineId: 1, current: 10, total: 10 });
    expect(win.updateFlapCounter).toHaveBeenLastCalledWith(47); // 37 + 10
  });

  it('does not call window.loadData() per tick -- too expensive at this cadence', () => {
    handleSyncProgressEvent({ machineId: 1, current: 1, total: 10 });
    handleSyncProgressEvent({ machineId: 1, current: 2, total: 10 });
    expect(loadDataCalls).toBe(0);
  });

  // #742 review: an earlier version simply re-baselined from S.shots.length
  // here, which made the display drop from 47 back to 38 -- a visible
  // regression, since bumpSyncProgress() (lib/sync.js) only fires per
  // shot actually saved to the DB, so those first 10 shots were never lost.
  // The restarted sequence's prior progress is now folded into the shared
  // base instead, so the total only ever goes forward.
  it('folds a machine\'s prior progress into the shared base when it restarts its own sequence without ever completing', () => {
    handleSyncProgressEvent({ machineId: 1, current: 10, total: 10 });
    expect(win.updateFlapCounter).toHaveBeenLastCalledWith(47); // 37 + 10

    handleSyncProgressEvent({ machineId: 1, current: 1, total: 5 });
    expect(win.updateFlapCounter).toHaveBeenLastCalledWith(48); // (37 + 10) + 1, not 37 + 1
  });

  // #742 review regression guard: an earlier version tracked a baseline PER
  // machine and displayed "that machine's own baseline + current" on every
  // event -- with two machines backfilling concurrently (not mutually
  // exclusive, see lib/sync.js's syncShots()/syncMachineShots()), the shared
  // header flickered/regressed between each machine's independent total
  // (42 -> 39 -> ...) instead of showing one consistent combined count. Same
  // global/scalar-instead-of-per-machine-keyed bug class already fixed in
  // #730/#732 -- except inverted here: S.shots.length is a single global
  // count, so there can only be ONE shared base, with each machine
  // contributing its own `current` on top of it.
  it('combines concurrent machines into one shared total instead of flickering between separate per-machine baselines', () => {
    handleSyncProgressEvent({ machineId: 1, current: 5, total: 10 });
    expect(win.updateFlapCounter).toHaveBeenLastCalledWith(42); // 37 + 5

    // Machine 2 joins in -- must ADD to the shared total, not replace it
    // with its own independent baseline.
    handleSyncProgressEvent({ machineId: 2, current: 2, total: 8 });
    expect(win.updateFlapCounter).toHaveBeenLastCalledWith(44); // 37 + 5 + 2

    handleSyncProgressEvent({ machineId: 1, current: 8, total: 10 });
    expect(win.updateFlapCounter).toHaveBeenLastCalledWith(47); // 37 + 8 + 2

    handleSyncProgressEvent({ machineId: 2, current: 4, total: 8 });
    expect(win.updateFlapCounter).toHaveBeenLastCalledWith(49); // 37 + 8 + 4
  });

  // #742 review: a machine finishing (success or failure) must not make the
  // displayed total visibly drop -- its final `current` is folded into the
  // shared base instead of simply being dropped from the sum.
  it('a machine finishing does not drop the displayed total while another is still mid-sync', () => {
    handleSyncProgressEvent({ machineId: 1, current: 5, total: 10 });
    handleSyncProgressEvent({ machineId: 2, current: 3, total: 8 });
    expect(win.updateFlapCounter).toHaveBeenLastCalledWith(45); // 37 + 5 + 3

    handleSyncCompleteEvent({ machineId: 1, total: 10, success: false });
    expect(win.updateFlapCounter).toHaveBeenLastCalledWith(45); // unchanged -- machine 1's 5 folded into the base
  });

  it('reconciles via window.loadData() on a successful completion', () => {
    handleSyncProgressEvent({ machineId: 1, current: 10, total: 10 });
    handleSyncCompleteEvent({ machineId: 1, total: 10, success: true });
    expect(loadDataCalls).toBe(1);
  });

  it('does not call window.loadData() on a failed completion -- nothing new was actually synced', () => {
    handleSyncProgressEvent({ machineId: 1, current: 10, total: 10 });
    handleSyncCompleteEvent({ machineId: 1, total: 10, success: false });
    expect(loadDataCalls).toBe(0);
  });

  it('a machine that starts backfilling again after completing gets a fresh baseline off the reconciled S.shots.length', () => {
    handleSyncProgressEvent({ machineId: 1, current: 10, total: 10 });
    handleSyncCompleteEvent({ machineId: 1, total: 10, success: true });

    // Simulate window.loadData() (mocked above, doesn't really touch
    // S.shots) having reconciled the real count.
    S.shots = new Array<ShotMeta>(47);

    handleSyncProgressEvent({ machineId: 1, current: 1, total: 5 });
    expect(win.updateFlapCounter).toHaveBeenLastCalledWith(48); // 47 + 1, not 37 + 10 + 1
  });
});

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
