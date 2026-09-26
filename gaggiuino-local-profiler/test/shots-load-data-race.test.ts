import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ShotMeta } from '../public-src/state/index.js';

// shots/index.js's import chain touches state.js/i18n.js, which read
// localStorage/navigator at module load time — stub the minimum browser
// globals so the module graph can be imported under vitest's node
// environment (same pattern as test/library-profile-editor.test.js and
// test/library-load-render-race.test.js). vitest's node environment has no
// browser globals, so the fakes go through a loose view of globalThis rather
// than satisfying the full Storage/Navigator/Document shapes (the same bridge
// test/shots-load-all-meta-throttle.test.ts uses).
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };
g.navigator    ??= { language: 'en-US' };

const { S } = await import('../public-src/state/index.js');
const apiModule = await import('../public-src/api/transport.js');
const fetchSpy = vi.spyOn(apiModule, 'apiFetch');
const { loadData } = await import('../public-src/views/shots/index.js');

// The few nodes the load path writes to; it sets either innerHTML or style on
// each of them, so both stay optional.
interface FakeShotsElement {
  innerHTML?: string;
  style?: Record<string, string>;
}

// Stub only the DOM the load path touches, same "fake minimal document"
// approach the other frontend tests use instead of pulling in jsdom.
function fakeDocument() {
  const elements: Record<string, FakeShotsElement> = {
    shots:          { innerHTML: '' },
    'empty-state':  { style: {} },
    'chart-area':   { style: {} },
  };
  return {
    elements,
    document: {
      getElementById: (id: string) => elements[id],
      querySelectorAll: () => [],
    },
  };
}

const shotA: ShotMeta = { id: 1, machineId: 1, timestamp: 1000, duration: 250 };
const shotB: ShotMeta = { id: 2, machineId: 1, timestamp: 2000, duration: 250 };

// One api/shots response body. A `json: async () => …` would trip
// @typescript-eslint/require-await, hence the explicit Promise.resolve.
function shotsResponse(shots: ShotMeta[]): Response {
  return { ok: true, json: () => Promise.resolve({ shots, nextCursor: null, hasMore: false }) } as unknown as Response;
}

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
    g.document = document;

    // Assigned by the promise executors below, so TS cannot prove they are
    // set before the explicit resolve calls further down.
    let resolveA!: (value: Response) => void;
    let resolveB!: (value: Response) => void;
    const pA = new Promise<Response>(res => { resolveA = res; });
    const pB = new Promise<Response>(res => { resolveB = res; });
    let shotsCallCount = 0;
    fetchSpy.mockImplementation((url: string) => {
      if (url.includes('trash=1')) return Promise.resolve({ ok: false } as unknown as Response);
      shotsCallCount++;
      return shotsCallCount === 1 ? pA : pB; // call A fired first, call B fired second
    });

    const callA = loadData(); // fired first
    const callB = loadData(); // fired second, while A is still pending

    // B (the later-fired call) resolves first...
    resolveB(shotsResponse([shotB]));
    await callB;
    // ...and A's stale response arrives after — it must not clobber B's data.
    resolveA(shotsResponse([shotA]));
    await callA;

    expect(S.allShots).toEqual([shotB]);
  });
});
