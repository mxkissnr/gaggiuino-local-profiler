import { describe, it, expect, beforeAll } from 'vitest';

// Same window/localStorage/navigator stubbing as analytics-new-charts.test.js
// — analytics.js calls window.calcShotScore/window.getShotData at runtime
// (main.js's real window-exposure pattern) and pulls in echarts transitively.
let _computeEquipmentStats;

beforeAll(async () => {
  Object.defineProperty(globalThis, 'localStorage', {
    value: { getItem: () => null, setItem: () => {} },
    configurable: true, writable: true,
  });
  Object.defineProperty(globalThis, 'navigator', {
    value: { language: 'en', userAgent: 'Node.js' },
    configurable: true, writable: true,
  });
  Object.defineProperty(globalThis, 'window', {
    value: {
      calcShotScore: (shot) => shot.score ?? null,
      getShotData: () => ({}),
    },
    configurable: true, writable: true,
  });
  ({ _computeEquipmentStats } = await import('../public-src/views/analytics.js'));
});

const shot = (overrides = {}) => ({
  id: overrides.id ?? 1,
  timestamp: overrides.timestamp ?? 0,
  duration: overrides.duration ?? 280, // 28.0s
  score: overrides.score,
  annotation: { basketId: overrides.basketId, puckScreenId: overrides.puckScreenId, grinder: overrides.grinder },
});

const baskets     = [{ id: 1, name: 'IMS Precision' }, { id: 2, name: 'VST' }];
const puckScreens = [{ id: 5, name: 'Slayer mesh' }];

// #635/routes/library/baskets.js: basket/puck-screen names have no
// uniqueness constraint — two distinct library entries can share a name.
const duplicateNameBaskets = [{ id: 10, name: 'Standard' }, { id: 11, name: 'Standard' }];

// #674: helpers mirroring buildBasketStats()/buildPuckScreenStats()'s own
// getKey/getName pair (views/analytics.js), so these tests exercise the
// same shape real callers use rather than a bespoke test-only convention.
const basketStats     = shots => _computeEquipmentStats(shots, s => s.annotation?.basketId, id => baskets.find(b => b.id === Number(id))?.name || null);
const puckScreenStats = shots => _computeEquipmentStats(shots, s => s.annotation?.puckScreenId, id => puckScreens.find(p => p.id === Number(id))?.name || null);
const duplicateBasketStats = shots => _computeEquipmentStats(shots, s => s.annotation?.basketId, id => duplicateNameBaskets.find(b => b.id === Number(id))?.name || null);
// Grinder: the key already is the display name (getName is identity), same
// as buildGrinderStats() itself.
const grinderStats = shots => _computeEquipmentStats(shots, s => s.annotation?.grinder || null, key => key);

describe('_computeEquipmentStats (#668, generalized in #674 for grinder too)', () => {
  it('groups shots by basketId, resolving the name from the library', () => {
    const shots = [
      shot({ basketId: 1, score: 80 }),
      shot({ basketId: 1, score: 90 }),
      shot({ basketId: 2, score: 70 }),
    ];
    const rows = basketStats(shots);
    const ims = rows.find(r => r.name === 'IMS Precision');
    const vst = rows.find(r => r.name === 'VST');
    expect(ims).toMatchObject({ count: 2, avgScore: 85, bestScore: 90 });
    expect(vst).toMatchObject({ count: 1, avgScore: 70, bestScore: 70 });
  });

  it('groups shots by puckScreenId the same way', () => {
    const shots = [shot({ puckScreenId: 5, score: 92 }), shot({ puckScreenId: 5, score: 88 })];
    const rows = puckScreenStats(shots);
    expect(rows).toEqual([{ name: 'Slayer mesh', count: 2, avgScore: 90, bestScore: 92, avgDuration: 28 }]);
  });

  it('ignores shots with no basket/puck screen annotated', () => {
    const shots = [shot({ basketId: null, score: 90 }), shot({ score: 85 })];
    expect(basketStats(shots)).toEqual([]);
  });

  it('ignores a basketId that no longer resolves to a library entry (deleted basket)', () => {
    const shots = [shot({ basketId: 999, score: 90 })];
    expect(basketStats(shots)).toEqual([]);
  });

  it('sorts by shot count descending', () => {
    const shots = [
      shot({ basketId: 2, score: 80 }),
      shot({ basketId: 1, score: 80 }), shot({ basketId: 1, score: 80 }), shot({ basketId: 1, score: 80 }),
    ];
    const rows = basketStats(shots);
    expect(rows[0].name).toBe('IMS Precision');
    expect(rows[0].count).toBe(3);
  });

  it('returns null avgScore/bestScore/avgDuration for entries with no scored/timed shots', () => {
    const shots = [shot({ basketId: 1, score: undefined, duration: 2 })]; // duration 0.2s, filtered as noise
    const rows = basketStats(shots);
    expect(rows[0]).toMatchObject({ count: 1, avgScore: null, bestScore: null, avgDuration: null });
  });

  it('never touches calcShotScore\'s own formula — reuses it as-is via window.calcShotScore', () => {
    const shots = [shot({ basketId: 1, score: 77 })];
    const rows = basketStats(shots);
    expect(rows[0].avgScore).toBe(77);
  });

  it('keeps two same-named baskets as separate cards, grouped by id not by name', () => {
    const shots = [
      shot({ basketId: 10, score: 80 }),
      shot({ basketId: 11, score: 90 }), shot({ basketId: 11, score: 70 }),
    ];
    const rows = duplicateBasketStats(shots);
    expect(rows).toHaveLength(2);
    expect(rows.every(r => r.name === 'Standard')).toBe(true);
    expect(rows.map(r => r.count).sort()).toEqual([1, 2]);
  });

  // ── Grinder path (#674) — free-text key, getName is identity ──────────────
  describe('grinder (free-text key, no library lookup)', () => {
    it('groups shots by grinder name directly', () => {
      const shots = [
        shot({ grinder: 'Niche Zero', score: 80 }),
        shot({ grinder: 'Niche Zero', score: 90 }),
        shot({ grinder: 'Kingrinder K6', score: 70 }),
      ];
      const rows = grinderStats(shots);
      const niche = rows.find(r => r.name === 'Niche Zero');
      const king  = rows.find(r => r.name === 'Kingrinder K6');
      expect(niche).toMatchObject({ count: 2, avgScore: 85, bestScore: 90 });
      expect(king).toMatchObject({ count: 1, avgScore: 70, bestScore: 70 });
    });

    it('ignores shots with no grinder annotated', () => {
      const shots = [shot({ grinder: '', score: 90 }), shot({ score: 85 })];
      expect(grinderStats(shots)).toEqual([]);
    });

    // #674's documented drift: buildGrinderStats() used to produce a string
    // (.toFixed(1)) here while the shared helper always produced a number
    // (Math.round(x*10)/10) for basket/puck screen. Now unified on the
    // shared helper's number type for every equipment kind.
    it('avgDuration is a number, not a string (fixes the pre-#674 type drift)', () => {
      const shots = [shot({ grinder: 'Niche Zero', duration: 283 }), shot({ grinder: 'Niche Zero', duration: 277 })]; // 28.3s, 27.7s
      const rows = grinderStats(shots);
      expect(rows[0].avgDuration).toBe(28);
      expect(typeof rows[0].avgDuration).toBe('number');
    });

    it('sorts by shot count descending, same as basket/puck screen', () => {
      const shots = [
        shot({ grinder: 'Kingrinder K6', score: 80 }),
        shot({ grinder: 'Niche Zero', score: 80 }), shot({ grinder: 'Niche Zero', score: 80 }),
      ];
      const rows = grinderStats(shots);
      expect(rows[0].name).toBe('Niche Zero');
      expect(rows[0].count).toBe(2);
    });
  });
});
