import { describe, it, expect, beforeEach, vi } from 'vitest';

// state.js/i18n.js touch localStorage/navigator at module load — stub them
// so the module graph imports under vitest's node environment (same pattern
// as test/shots-load-data-race.test.js).
globalThis.localStorage ??= { getItem: () => null, setItem: () => {} };
globalThis.navigator    ??= { language: 'en-US' };

const apiModule = await import('../public-src/api.js');
const fetchSpy = vi.spyOn(apiModule, 'apiFetch');
const curves = await import('../public-src/shot-curves.js');

const dp = id => ({ timeInShot: [0, 10, 20], pressure: [90, 90, 90], __id: id });

beforeEach(() => {
  fetchSpy.mockReset();
  curves.__resetCurveCacheForTests();
});

describe('shot-curves cache (#957)', () => {
  it('memoises: one fetch per id no matter how many callers', async () => {
    fetchSpy.mockImplementation(url => {
      const id = Number(url.split('/').pop());
      return Promise.resolve({ ok: true, json: async () => ({ id, datapoints: dp(id) }) });
    });

    const [a, b, c] = await Promise.all([
      curves.getShotCurve(7), curves.getShotCurve(7), curves.getShotCurve(7),
    ]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(a.__id).toBe(7);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    await curves.getShotCurve(7); // still cached
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('ensureCurves caps concurrency at 6', async () => {
    let inFlight = 0, peak = 0;
    fetchSpy.mockImplementation(async url => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise(r => setTimeout(r, 5));
      inFlight--;
      const id = Number(url.split('/').pop());
      return { ok: true, json: async () => ({ id, datapoints: dp(id) }) };
    });

    await curves.ensureCurves([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(peak).toBeLessThanOrEqual(6);
    expect(fetchSpy).toHaveBeenCalledTimes(12);
  });

  it('primeCurve seeds the cache with no fetch, readable synchronously', async () => {
    curves.primeCurve(42, dp(42));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await curves.getShotCurve(42)).toEqual(dp(42));
    expect(curves.getRawCurve(42)).toEqual(dp(42));
    expect(curves.getCachedShotData(42).pressure.length).toBe(3);
  });

  it('evictCurve drops the entry so the next get refetches', async () => {
    fetchSpy.mockImplementation(url => {
      const id = Number(url.split('/').pop());
      return Promise.resolve({ ok: true, json: async () => ({ id, datapoints: dp(id) }) });
    });
    await curves.getShotCurve(5);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(curves.getRawCurve(5)).not.toBeNull();

    curves.evictCurve(5);
    expect(curves.getRawCurve(5)).toBeNull();
    await curves.getShotCurve(5);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('a failed fetch is not cached (retries next call) and resolves to {}', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false });
    expect(await curves.getShotCurve(9)).toEqual({});
    fetchSpy.mockResolvedValueOnce({ ok: true, json: async () => ({ id: 9, datapoints: dp(9) }) });
    expect(await curves.getShotCurve(9)).toEqual(dp(9));
  });

  it('seeds the previousShot the detail endpoint ships alongside', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 20, datapoints: dp(20), previousShot: { id: 19, datapoints: dp(19) } }),
    });
    await curves.getShotCurve(20);
    // 19 should now be cached without its own fetch
    expect(curves.getRawCurve(19)).toEqual(dp(19));
    await curves.getShotCurve(19);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
