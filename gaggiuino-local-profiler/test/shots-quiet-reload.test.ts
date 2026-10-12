import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ShotMeta } from '../public-src/state/index.js';

// #1614 slice 4: a quiet reload (live-sync refreshShots(null)) used to cut the
// shot list back to page 1 and, when it raced an earlier meta walk, could leave
// it cut there for good. These tests pin the two behaviours: the older shots
// stay visible until the walk confirms them, and a quiet reload started mid-walk
// still loads every page.
//
// shots/index.js's import chain touches state/i18n and reads localStorage/
// navigator at load, so the minimum browser globals are stubbed (same pattern as
// test/shots-load-data-race.test.ts); sidebar rendering is mocked so the walk's
// DOM rebuild is countable without a real sidebar.
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };
g.navigator ??= { language: 'en-US' };
g.window ??= {};

const renderSidebarSpy = vi.fn();
vi.mock('../public-src/components/sidebar.js', () => ({ renderSidebar: renderSidebarSpy }));

const { S } = await import('../public-src/state/index.js');
const apiModule = await import('../public-src/api/transport.js');
const fetchSpy = vi.spyOn(apiModule, 'apiFetch');
const { loadData } = await import('../public-src/views/shots/index.js');

interface FakeEl { innerHTML?: string; style?: Record<string, unknown> }

function fakeDocument() {
  const els: Record<string, FakeEl> = {
    shots:         { innerHTML: '' },
    'empty-state': { style: {} },
    'chart-area':  { style: {} },
  };
  // Every other id (banner/onboarding nodes) stays absent, so those code paths
  // take their "element missing" branch exactly like the other shots tests.
  return { getElementById: (id: string) => els[id], querySelectorAll: () => [] };
}

function shot(id: number): ShotMeta {
  return { id, machineId: 1, timestamp: id * 1000 };
}

// One api/shots page body, newest-first like the real endpoint.
function page(shots: ShotMeta[], nextCursor: string | null, hasMore: boolean): Response {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve({ shots, nextCursor, hasMore }),
  } as unknown as Response;
}

async function flushPromises(times = 10): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

function ids(): number[] {
  return (S.allShots as ShotMeta[]).map(s => s.id);
}

beforeEach(() => {
  fetchSpy.mockReset();
  renderSidebarSpy.mockClear();
  S.allShots = [];
  S.shots = [];
  S.activeMachineId = 999; // filter S.shots empty -> no chart-render path
  S.shotsPageCursor = null;
  S.shotsHasMore = false;
  S.allShotsLoaded = false;
  g.document = fakeDocument();
});

describe('quiet reload keeps older shots (#1614 slice 4)', () => {
  it('shows the older entries until the walk confirms them, then drops the ones the fresh pages lack', async () => {
    S.allShots = [1, 2, 3, 4, 5].map(shot);
    S.allShotsLoaded = true;

    let resolveC1!: (r: Response) => void;
    let resolveC2!: (r: Response) => void;
    fetchSpy.mockImplementation((url: string) => {
      if (url.includes('trash=1')) return Promise.resolve({ ok: false, status: 500 } as unknown as Response);
      if (url.includes('cursor=c1')) return new Promise<Response>(res => { resolveC1 = res; });
      if (url.includes('cursor=c2')) return new Promise<Response>(res => { resolveC2 = res; });
      return Promise.resolve(page([shot(5), shot(4)], 'c1', true)); // page 1, newest-first
    });

    await loadData({ quiet: true });

    // Right after page 1 resolved the older shots are still in the list.
    expect(ids()).toEqual([1, 2, 3, 4, 5]);

    resolveC1(page([shot(3), shot(2)], 'c2', true)); // an older page, newest-first
    await flushPromises();
    expect(ids()).toEqual([1, 2, 3, 4, 5]);

    resolveC2(page([], null, false)); // shot 1 is gone from every fresh page
    await flushPromises();
    expect(ids()).toEqual([2, 3, 4, 5]);
    expect(S.allShotsLoaded).toBe(true);
  });

  it('a quiet reload started while an earlier walk is pending still loads every page', async () => {
    const c1Resolvers: Array<(r: Response) => void> = [];
    fetchSpy.mockImplementation((url: string) => {
      if (url.includes('trash=1')) return Promise.resolve({ ok: false, status: 500 } as unknown as Response);
      if (url.includes('cursor=c1')) return new Promise<Response>(res => c1Resolvers.push(res));
      if (url.includes('cursor=c2')) return Promise.resolve(page([shot(1)], null, false));
      return Promise.resolve(page([shot(5), shot(4)], 'c1', true));
    });

    const first = loadData({ quiet: true });
    await first;
    expect(c1Resolvers.length).toBe(1); // the first walk is holding page 2

    const second = loadData({ quiet: true });
    await second;
    expect(c1Resolvers.length).toBe(2); // the second walk owns its own fetch

    // The superseded walk gets its page but must write nothing.
    c1Resolvers[0]!(page([shot(3), shot(2)], 'c2', true));
    await flushPromises();
    expect(ids()).toEqual([4, 5]);

    // The live walk continues to the end and marks the list fully loaded.
    c1Resolvers[1]!(page([shot(3), shot(2)], 'c2', true));
    await flushPromises();
    expect(ids()).toEqual([1, 2, 3, 4, 5]);
    expect(S.allShotsLoaded).toBe(true);
  });
});
