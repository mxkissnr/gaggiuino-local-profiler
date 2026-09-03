import { describe, it, expect, beforeEach, vi } from 'vitest';

// shots/index.js's import chain touches state.js/i18n.js, which read
// localStorage/navigator at module load time — stub the minimum browser
// globals so the module graph can be imported under vitest's node
// environment (same pattern as test/library-profile-editor.test.js and
// test/library-load-render-race.test.js).
globalThis.localStorage ??= { getItem: () => null, setItem: () => {} };
globalThis.navigator    ??= { language: 'en-US' };

const { S } = await import('../public-src/state.js');
const apiModule = await import('../public-src/api.js');
const fetchSpy = vi.spyOn(apiModule, 'apiFetch');
const { loadData } = await import('../public-src/views/shots/index.js');

// Stub only the DOM the load path touches, same "fake minimal document"
// approach the other frontend tests use instead of pulling in jsdom.
function fakeDocument() {
  const elements = {
    shots:          { innerHTML: '' },
    'empty-state':  { style: {} },
    'chart-area':   { style: {} },
  };
  return {
    elements,
    document: {
      getElementById: id => elements[id],
      querySelectorAll: () => [],
    },
  };
}

const shotA = { id: 1, machineId: 1, timestamp: 1000, duration: 250 };
const shotB = { id: 2, machineId: 1, timestamp: 2000, duration: 250 };

describe('loadData (#644 race)', () => {
  beforeEach(() => {
    fetchSpy.mockReset();
    S.allShots = [];
    S.shots = [];
    S.machineReachable = null;
    S.currentSort = 'newest';
    // Filters every shot out of S.shots regardless of which fetch resolves
    // (no machine registered with this id) — keeps the assertion focused on
    // the race guard itself rather than pulling in the full chart-rendering
    // path (updateView()), which only runs when S.shots is non-empty.
    S.activeMachineId = 999;
  });

  it('the later-fired call wins even when its response resolves before the earlier call\'s', async () => {
    const { document } = fakeDocument();
    globalThis.document = document;

    let resolveA, resolveB;
    const pA = new Promise(res => { resolveA = res; });
    const pB = new Promise(res => { resolveB = res; });
    let shotsCallCount = 0;
    fetchSpy.mockImplementation(url => {
      if (url.includes('trash=1')) return Promise.resolve({ ok: false });
      shotsCallCount++;
      return shotsCallCount === 1 ? pA : pB; // call A fired first, call B fired second
    });

    const callA = loadData(); // fired first
    const callB = loadData(); // fired second, while A is still pending

    // B (the later-fired call) resolves first...
    resolveB({ ok: true, json: async () => ({ shots: [shotB], nextCursor: null, hasMore: false }) });
    await callB;
    // ...and A's stale response arrives after — it must not clobber B's data.
    resolveA({ ok: true, json: async () => ({ shots: [shotA], nextCursor: null, hasMore: false }) });
    await callA;

    expect(S.allShots).toEqual([shotB]);
  });
});
