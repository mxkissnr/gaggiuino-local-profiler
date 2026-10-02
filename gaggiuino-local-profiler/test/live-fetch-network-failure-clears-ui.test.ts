// #913: fetchLiveData()'s catch block (a network-level failure, e.g. the
// machine lost power and dropped off the network entirely -- not just an
// HTTP error) used to only flip the status badge, leaving the previously
// rendered live values (preheat countdown, pressure/weight, machine-icon
// state) frozen on screen indefinitely. It must now drive the same
// "unreachable" UI state handleLiveData()'s explicit
// msg.machineReachable === false branch already produces. Same
// apiFetch-mocking/fake-document harness as
// test/live-stream-sse-fallback-gating.test.ts.
import { describe, it, expect, beforeEach, vi } from 'vitest';

// vitest's node environment has no browser globals; stub them through a loose
// view of globalThis (the same bridge the sibling live tests use).
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };
g.navigator ??= { language: 'en-US' };

const apiFetchMock = vi.fn();
vi.mock('../public-src/api/transport.js', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args) as unknown,
}));

const { S } = await import('../public-src/state/index.js');
const { fetchLiveData } = await import('../public-src/views/live.js');

// The DOM stand-in these tests touch: only the members the live view reads
// off each element.
interface FakeElement {
  className: string;
  textContent: string;
  style: Record<string, string>;
  classList: { add: () => void; remove: () => void; contains: () => boolean };
  querySelector: () => null;
}

function makeFakeDocument() {
  const registry = new Map<string, FakeElement>();
  function makeElement(): FakeElement {
    return {
      className: '', textContent: '', style: {},
      classList: { add() {}, remove() {}, contains: () => false },
      querySelector: () => null,
    };
  }
  return {
    getElementById: (id: string): FakeElement => {
      if (!registry.has(id)) registry.set(id, makeElement());
      return registry.get(id)!;
    },
  };
}

describe('fetchLiveData() catch block on a network-level failure (#913)', () => {
  let doc: ReturnType<typeof makeFakeDocument>;

  beforeEach(() => {
    apiFetchMock.mockReset();
    doc = makeFakeDocument();
    g.document = doc;
    S.activeMachineId = null;
    S.machines = [];
    S.currentLang = 'en';
    S.livePollInterval = null;
    S.liveWasLive = false;
  });

  it('clears live content and shows the unreachable idle state, same as an explicit machineReachable:false message', async () => {
    // Simulate stale live values already on screen from a prior successful poll.
    doc.getElementById('live-content').style.display = '';
    doc.getElementById('live-idle').style.display = 'none';
    doc.getElementById('liveIdleTemp').textContent = '93.2°';
    doc.getElementById('liveIdlePressure').textContent = '9.1 bar';

    apiFetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await fetchLiveData();

    expect(doc.getElementById('live-content').style.display).toBe('none');
    expect(doc.getElementById('live-idle').style.display).toBe('flex');
    expect(doc.getElementById('liveIdleTemp').textContent).toBe('–');
    expect(doc.getElementById('liveIdlePressure').textContent).toBe('–');
    expect(doc.getElementById('live-status-badge').className).toContain('unreachable');
  });
});
