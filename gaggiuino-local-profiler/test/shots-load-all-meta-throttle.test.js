import { describe, it, expect, beforeEach, vi } from 'vitest';

// shots/index.js's import chain touches state.js/i18n.js, which read
// localStorage/navigator at module load time — stub the minimum browser
// globals so the module graph can be imported under vitest's node
// environment (same pattern as test/shots-load-data-race.test.js).
globalThis.localStorage ??= { getItem: () => null, setItem: () => {} };
globalThis.navigator    ??= { language: 'en-US' };
globalThis.window       ??= {};

// #969: loadAllShotMeta() calls renderSidebar() after every page of its
// background walk — mock it out so the assertions below can count calls
// without needing a real DOM (the module import chain would otherwise
// require stubbing everything _buildShotWrapper() touches, same concern
// test/sidebar-lazy-month-groups.test.js takes on separately).
const renderSidebarSpy = vi.fn();
vi.mock('../public-src/components/sidebar.js', () => ({ renderSidebar: renderSidebarSpy }));

const { S } = await import('../public-src/state.js');
const apiModule = await import('../public-src/api.js');
const fetchSpy = vi.spyOn(apiModule, 'apiFetch');
const { loadAllShotMeta } = await import('../public-src/views/shots/index.js');

// Builds a fake api/shots?cursor=... response for one page.
function pageResponse(shots, { nextCursor, hasMore }) {
  return { ok: true, json: async () => ({ shots, nextCursor, hasMore }) };
}

describe('loadAllShotMeta render throttle (#969)', () => {
  beforeEach(() => {
    renderSidebarSpy.mockClear();
    fetchSpy.mockReset();
    S.allShots = [];
    S.shots = [];
    S.activeMachineId = 'all';
  });

  it('does not call renderSidebar once per page for a long background walk', async () => {
    // 5 pages, each immediately resolved (no real network delay) — without
    // the throttle this would be 5 renderSidebar() calls, one per page.
    const PAGES = 5;
    let call = 0;
    fetchSpy.mockImplementation(() => {
      call++;
      const shots = [{ id: call, machineId: 1, timestamp: call, duration: 100 }];
      const hasMore = call < PAGES;
      return Promise.resolve(pageResponse(shots, { nextCursor: hasMore ? `c${call}` : null, hasMore }));
    });

    // Module-local _loadDataReqToken starts at 0 and this test never calls
    // loadData(), so token 0 is the "current" one loadAllShotMeta checks
    // against on every iteration.
    await loadAllShotMeta(0, 'c0');

    expect(fetchSpy).toHaveBeenCalledTimes(PAGES);
    // First page renders immediately (nothing rendered yet); the rest land
    // inside the 400ms throttle window since they resolve back-to-back, so
    // the only other render is the trailing one once the walk finishes.
    expect(renderSidebarSpy).toHaveBeenCalledTimes(2);
    // The full history still ends up in S.allShots regardless of how many
    // times the DOM was actually rebuilt along the way.
    expect(S.allShots.map(s => s.id)).toEqual([5, 4, 3, 2, 1]);
  });

  it('does not render at all if the walk is superseded before any page lands', async () => {
    fetchSpy.mockImplementation(() => new Promise(() => {})); // never resolves
    const walk = loadAllShotMeta(1, 'c0'); // token 1 does not match the current token (0)
    await Promise.race([walk, new Promise(res => setTimeout(res, 10))]);
    expect(renderSidebarSpy).not.toHaveBeenCalled();
  });
});
