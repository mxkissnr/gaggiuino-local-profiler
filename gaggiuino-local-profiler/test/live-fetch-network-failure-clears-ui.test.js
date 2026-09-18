// #913: fetchLiveData()'s catch block (a network-level failure, e.g. the
// machine lost power and dropped off the network entirely -- not just an
// HTTP error) used to only flip the status badge, leaving the previously
// rendered live values (preheat countdown, pressure/weight, machine-icon
// state) frozen on screen indefinitely. It must now drive the same
// "unreachable" UI state handleLiveData()'s explicit
// msg.machineReachable === false branch already produces. Same
// apiFetch-mocking/fake-document harness as
// test/live-stream-sse-fallback-gating.test.js.
import { describe, it, expect, beforeEach, vi } from 'vitest';

globalThis.localStorage ??= { getItem: () => null, setItem: () => {} };
globalThis.navigator ??= { language: 'en-US' };

const apiFetchMock = vi.fn();
vi.mock('../public-src/api.js', () => ({
  apiFetch: (...args) => apiFetchMock(...args),
}));

const { S } = await import('../public-src/state/index.js');
const { fetchLiveData } = await import('../public-src/views/live.js');

function makeFakeDocument() {
  const registry = new Map();
  function makeElement() {
    return {
      className: '', textContent: '', style: {},
      classList: { add() {}, remove() {}, contains: () => false },
      querySelector: () => null,
    };
  }
  return {
    getElementById: id => {
      if (!registry.has(id)) registry.set(id, makeElement());
      return registry.get(id);
    },
  };
}

describe('fetchLiveData() catch block on a network-level failure (#913)', () => {
  let doc;

  beforeEach(() => {
    apiFetchMock.mockReset();
    doc = makeFakeDocument();
    globalThis.document = doc;
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
