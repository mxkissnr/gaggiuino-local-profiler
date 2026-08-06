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
  annotation: { basketId: overrides.basketId, puckScreenId: overrides.puckScreenId },
});

const baskets     = [{ id: 1, name: 'IMS Precision' }, { id: 2, name: 'VST' }];
const puckScreens = [{ id: 5, name: 'Slayer mesh' }];

// #635/routes/library/baskets.js: basket/puck-screen names have no
// uniqueness constraint — two distinct library entries can share a name.
const duplicateNameBaskets = [{ id: 10, name: 'Standard' }, { id: 11, name: 'Standard' }];

describe('_computeEquipmentStats (#668)', () => {
  it('groups shots by basketId, resolving the name from the library', () => {
    const shots = [
      shot({ basketId: 1, score: 80 }),
      shot({ basketId: 1, score: 90 }),
      shot({ basketId: 2, score: 70 }),
    ];
    const rows = _computeEquipmentStats(shots, baskets, 'basketId');
    const ims = rows.find(r => r.name === 'IMS Precision');
    const vst = rows.find(r => r.name === 'VST');
    expect(ims).toMatchObject({ count: 2, avgScore: 85, bestScore: 90 });
    expect(vst).toMatchObject({ count: 1, avgScore: 70, bestScore: 70 });
  });

  it('groups shots by puckScreenId the same way', () => {
    const shots = [shot({ puckScreenId: 5, score: 92 }), shot({ puckScreenId: 5, score: 88 })];
    const rows = _computeEquipmentStats(shots, puckScreens, 'puckScreenId');
    expect(rows).toEqual([{ name: 'Slayer mesh', count: 2, avgScore: 90, bestScore: 92, avgDuration: 28 }]);
  });

  it('ignores shots with no basket/puck screen annotated', () => {
    const shots = [shot({ basketId: null, score: 90 }), shot({ score: 85 })];
    expect(_computeEquipmentStats(shots, baskets, 'basketId')).toEqual([]);
  });

  it('ignores a basketId that no longer resolves to a library entry (deleted basket)', () => {
    const shots = [shot({ basketId: 999, score: 90 })];
    expect(_computeEquipmentStats(shots, baskets, 'basketId')).toEqual([]);
  });

  it('sorts by shot count descending', () => {
    const shots = [
      shot({ basketId: 2, score: 80 }),
      shot({ basketId: 1, score: 80 }), shot({ basketId: 1, score: 80 }), shot({ basketId: 1, score: 80 }),
    ];
    const rows = _computeEquipmentStats(shots, baskets, 'basketId');
    expect(rows[0].name).toBe('IMS Precision');
    expect(rows[0].count).toBe(3);
  });

  it('returns null avgScore/bestScore/avgDuration for entries with no scored/timed shots', () => {
    const shots = [shot({ basketId: 1, score: undefined, duration: 2 })]; // duration 0.2s, filtered as noise
    const rows = _computeEquipmentStats(shots, baskets, 'basketId');
    expect(rows[0]).toMatchObject({ count: 1, avgScore: null, bestScore: null, avgDuration: null });
  });

  it('never touches calcShotScore\'s own formula — reuses it as-is via window.calcShotScore', () => {
    const shots = [shot({ basketId: 1, score: 77 })];
    const rows = _computeEquipmentStats(shots, baskets, 'basketId');
    expect(rows[0].avgScore).toBe(77);
  });

  it('keeps two same-named baskets as separate cards, grouped by id not by name', () => {
    const shots = [
      shot({ basketId: 10, score: 80 }),
      shot({ basketId: 11, score: 90 }), shot({ basketId: 11, score: 70 }),
    ];
    const rows = _computeEquipmentStats(shots, duplicateNameBaskets, 'basketId');
    expect(rows).toHaveLength(2);
    expect(rows.every(r => r.name === 'Standard')).toBe(true);
    expect(rows.map(r => r.count).sort()).toEqual([1, 2]);
  });
});
