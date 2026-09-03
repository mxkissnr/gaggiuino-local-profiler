import { describe, it, expect, beforeEach, vi } from 'vitest';

globalThis.localStorage ??= { getItem: () => null, setItem: () => {} };
globalThis.navigator    ??= { language: 'en-US' };

const { S } = await import('../public-src/state.js');
const apiModule = await import('../public-src/api.js');
const fetchSpy = vi.spyOn(apiModule, 'apiFetch');
const curves = await import('../public-src/shot-curves.js');
const { loadData } = await import('../public-src/views/shots/index.js');

function fakeDocument() {
  const els = { shots: { innerHTML: '' }, 'empty-state': { style: {} }, 'chart-area': { style: {} } };
  return { getElementById: id => els[id], querySelectorAll: () => [] };
}

const dumpShot = id => ({
  id, machineId: 1, timestamp: id * 1000, profileName: 'V60',
  datapoints: { timeInShot: [0, 10], pressure: [90, 90] },
});

describe('loadData /shots.json fallback on 404 (Node backend, #957)', () => {
  beforeEach(() => {
    fetchSpy.mockReset();
    curves.__resetCurveCacheForTests();
    S.allShots = []; S.shots = [];
    S.activeMachineId = 999;               // filter S.shots to empty -> no chart path
    S.machineReachable = null;
    S.shotsPageCursor = null; S.shotsHasMore = false; S.allShotsLoaded = false;
    globalThis.document = fakeDocument();
  });

  it('falls back to the full dump, seeds the curve cache, keeps Node row shape', async () => {
    fetchSpy.mockImplementation(url => {
      if (url.startsWith('api/shots?')) return Promise.resolve({ status: 404, ok: false });
      if (url === 'shots.json') return Promise.resolve({ ok: true, json: async () => [dumpShot(1), dumpShot(2), dumpShot(3)] });
      if (url === 'shots.json?trash=1') return Promise.resolve({ ok: true, json: async () => [] });
      throw new Error('unexpected url ' + url);
    });

    await loadData();

    // dump is oldest-first; S.allShots keeps that order
    expect(S.allShots.map(s => s.id)).toEqual([1, 2, 3]);
    // Node keeps datapoints on the row; the fallback just adds hasChartData
    expect(S.allShots.every(s => s.hasChartData === true)).toBe(true);
    // no pagination state left dangling
    expect(S.shotsHasMore).toBe(false);
    expect(S.allShotsLoaded).toBe(true);
    // curve cache is a pure hit now — getShotCurve resolves with no fetch
    fetchSpy.mockClear();
    expect(await curves.getShotCurve(2)).toEqual({ timeInShot: [0, 10], pressure: [90, 90] });
    expect(curves.getRawCurve(2)).toEqual({ timeInShot: [0, 10], pressure: [90, 90] });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
