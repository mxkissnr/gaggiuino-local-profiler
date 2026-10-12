// status.js's updateStatus() single-flight guard (#734 review): the function
// can be triggered from three independent places (the 30s setInterval, a
// machine switch, and #733's visibilitychange refocus handler) with no
// ordering guarantee between them, so a call arriving while one is already
// awaiting its fetch must be a no-op rather than a duplicate poll.
//
// Same fake-document convention as test/status-update-machine-id.test.ts.
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

// updateMachineBanner()/updateLegacyMachineOptionsBanner() read sessionStorage
// before the shot-count block, so it must exist or the outer try swallows the
// reference error and the shot-count branch never runs.
g.sessionStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

// status.js routes a rising shotCount through live-sync's markDirty; mock the
// module so the shot-count branch can be asserted without the scheduler.
const liveMock = vi.hoisted(() => ({ markDirty: vi.fn(), noteServerRevs: vi.fn() }));
vi.mock('../public-src/live-sync.js', () => ({
  markDirty: liveMock.markDirty,
  noteServerRevs: liveMock.noteServerRevs,
}));

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

interface FakeResponse { ok: boolean; json: () => Promise<unknown> }

const { updateStatus } = await import('../public-src/components/status.js');

describe('updateStatus() single-flight guard (#734)', () => {
  let doc: ReturnType<typeof makeFakeDocument>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    liveMock.markDirty.mockReset();
    liveMock.noteServerRevs.mockReset();
    doc = makeFakeDocument();
    ['statusDot', 'railStatusDot', 'syncTime', 'machineSubtitle', 'railMachineName',
     'glpVersionBadge', 'btnOrders', 'bnOrders', 'powerBtn', 'btnLive'].forEach(id => doc._preRegister(id));
    g.document = doc;
    _store.clear();
  });

  it('a second call while one is already in flight is a no-op, not a duplicate poll', async () => {
    let resolveFetch!: (value: FakeResponse) => void;
    const pending = new Promise<FakeResponse>(res => { resolveFetch = res; });
    fetchMock = vi.fn((url: string | URL) => {
      if (String(url).startsWith('api/status')) return pending;
      return Promise.resolve({ ok: false });
    });
    g.fetch = fetchMock;

    const first = updateStatus();
    const second = updateStatus(); // fires while `first` is still awaiting the fetch above

    resolveFetch({ ok: true, json: () => Promise.resolve({ lastSync: '2026-01-01T00:00:00.000Z' }) });
    await Promise.all([first, second]);

    // Only the first call's fetch actually ran -- the second returned immediately.
    expect(fetchMock.mock.calls.filter((c: unknown[]) => String(c[0]).startsWith('api/status')).length).toBe(1);
  });

  // #1614: a newly-finished shot seen on the status poll must refetch the shots
  // list through live-sync's `shots` kind (markDirty), not by calling
  // window.loadData() directly -- the direct call bypassed the annotation/focus
  // guards and could clobber in-progress text.
  it('routes a rising shotCount through live-sync, not a direct reload', async () => {
    let call = 0;
    fetchMock = vi.fn((url: string | URL) => {
      if (String(url).startsWith('api/status')) {
        call += 1;
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ shotCount: call === 1 ? 5 : 6 }) });
      }
      return Promise.resolve({ ok: false });
    });
    g.fetch = fetchMock;

    await updateStatus(); // baseline: records the first shot count
    expect(liveMock.markDirty).not.toHaveBeenCalled();

    await updateStatus(); // the count rose -> refetch the shots list via live-sync
    expect(liveMock.markDirty).toHaveBeenCalledWith('shots', null);
  });
});
