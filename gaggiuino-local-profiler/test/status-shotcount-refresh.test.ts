// status.ts's rising-shotCount refresh: a new finished shot seen on the 30s
// status poll must refetch the shots list through live-sync's `shots` kind
// (markDirty), not by calling window.loadData() directly — the direct call
// bypassed the annotation/focus guards and could clobber in-progress text.
//
// Same fake-document + fetch-mock convention as test/status-update-inflight.test.ts.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const g = globalThis as unknown as Record<string, unknown>;

// status.ts imports markDirty/noteServerRevs from live-sync; mock them so the
// shot-count branch can be asserted without pulling in the scheduler.
const liveMock = vi.hoisted(() => ({ markDirty: vi.fn(), noteServerRevs: vi.fn() }));
vi.mock('../public-src/live-sync.js', () => ({
  markDirty: liveMock.markDirty,
  noteServerRevs: liveMock.noteServerRevs,
}));

const _store = new Map<string, string>();
g.localStorage = {
  getItem: (k: string) => (_store.has(k) ? _store.get(k) : null),
  setItem: (k: string, v: unknown) => { _store.set(k, String(v)); },
  removeItem: (k: string) => { _store.delete(k); },
};
// updateMachineBanner() reads sessionStorage
// before the shot-count block, so it must exist or the outer try swallows the
// reference error and the shot-count branch never runs.
g.sessionStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};
g.navigator ??= { language: 'en-US' };
g.window ??= globalThis;

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

const { updateStatus } = await import('../public-src/components/status.js');

describe('updateStatus() rising shotCount refresh', () => {
  let doc: ReturnType<typeof makeFakeDocument>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    liveMock.markDirty.mockReset();
    liveMock.noteServerRevs.mockReset();
    doc = makeFakeDocument();
    ['statusDot', 'railStatusDot', 'syncTime', 'machineSubtitle', 'railMachineName',
     'glpVersionBadge', 'btnOrders', 'bnOrders', 'powerBtn', 'btnLive'].forEach(id => doc._preRegister(id));
    g.document = doc;
    g.loadData = vi.fn();
    _store.clear();
  });

  it('marks the shots kind dirty and never calls window.loadData', async () => {
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
    expect(g.loadData).not.toHaveBeenCalled();
  });
});
