import { describe, it, expect, beforeAll } from 'vitest';

// maintenance.js pulls in state.js (localStorage/navigator at module load)
// and i18n.js — neither is available in the plain Node test environment, so
// stub the minimum before importing, same approach as best-grind-combo.test.js.
let _normalizeMaintTiles, _pickNextDueTile;

beforeAll(async () => {
  Object.defineProperty(globalThis, 'localStorage', {
    value: { getItem: () => null, setItem: () => {} },
    configurable: true, writable: true,
  });
  Object.defineProperty(globalThis, 'navigator', {
    value: { language: 'en' },
    configurable: true, writable: true,
  });
  ({ _normalizeMaintTiles, _pickNextDueTile } = await import('../public-src/views/maintenance.js'));
});

const task = (status, overrides = {}) => ({
  status, pct: status === 'ok' ? 0.2 : status === 'soon' ? 0.85 : 1,
  daysSince: null, shotsSince: 0, threshold_shots: null, threshold_days: null,
  ...overrides,
});

describe('_normalizeMaintTiles (#393)', () => {
  it('flattens a single-machine flat response into tiles, tagging global tasks', () => {
    const data = {
      descaling: task('due', { threshold_shots: 200, shotsSince: 210 }),
      backflush: task('ok', { threshold_shots: 20, shotsSince: 5 }),
      waterfilter: task('ok', { threshold_days: 90, daysSince: 10 }),
      grinder_1: task('never', { grinderName: 'Niche Zero' }),
    };
    const tiles = _normalizeMaintTiles(data, 1);
    expect(tiles).toHaveLength(4);
    expect(tiles.every(t => t.machineId === 1)).toBe(true);
    expect(tiles.find(t => t.task === 'descaling').isGlobal).toBe(false);
    expect(tiles.find(t => t.task === 'waterfilter').isGlobal).toBe(true);
    expect(tiles.find(t => t.task === 'grinder_1').isGlobal).toBe(true);
    // Single-machine scope never shows a per-machine name tag (nothing to
    // disambiguate against) — only the "shared" tag on global tasks.
    expect(tiles.every(t => t.showMachineTag === false)).toBe(true);
  });

  it('flattens the grouped "all machines" shape (#392) into one tile list, deduping global tasks', () => {
    const data = {
      all: true,
      machines: [
        { machineId: 1, machineName: 'Gaggiuino', tasks: { descaling: task('due', { threshold_shots: 200, shotsSince: 210 }) } },
        { machineId: 2, machineName: 'GaggiMate Sim', tasks: { descaling: task('never') } },
      ],
      global: { waterfilter: task('ok', { threshold_days: 90, daysSince: 10 }) },
    };
    const tiles = _normalizeMaintTiles(data, 'all');
    expect(tiles).toHaveLength(3); // 2 per-machine + 1 global, not duplicated per machine
    const descalingTiles = tiles.filter(t => t.task === 'descaling');
    expect(descalingTiles).toHaveLength(2);
    expect(descalingTiles.map(t => t.machineId).sort()).toEqual([1, 2]);
    const waterfilterTiles = tiles.filter(t => t.task === 'waterfilter');
    expect(waterfilterTiles).toHaveLength(1);
    expect(waterfilterTiles[0].isGlobal).toBe(true);
    // Global tile still needs a concrete machineId for its own done/threshold
    // writes (the backend ignores it for global tasks, but the URL needs one).
    expect(waterfilterTiles[0].machineId).toBe(1);
  });
});

describe('_pickNextDueTile (#393 — "Als Nächstes" banner target)', () => {
  it('returns null when nothing is due or never-done', () => {
    const tiles = [
      { task: 'backflush', d: task('ok') },
      { task: 'waterfilter', d: task('soon') },
    ];
    expect(_pickNextDueTile(tiles)).toBeNull();
  });

  it('picks the tile with the largest shots-overage among due tasks', () => {
    const tiles = [
      { task: 'backflush', d: task('due', { threshold_shots: 20, shotsSince: 23 }) }, // 3 over
      { task: 'descaling', d: task('due', { threshold_shots: 200, shotsSince: 178 }) }, // not actually over (pct<1 in reality, but status forced here)
      { task: 'grouphead', d: task('due', { threshold_days: 180, daysSince: 200 }) }, // 20 over
    ];
    const picked = _pickNextDueTile(tiles);
    expect(picked.task).toBe('grouphead');
  });

  it('treats a never-done task\'s total shot count as its overage, so an established machine\'s never-cleaned task outranks a barely-overdue one', () => {
    const tiles = [
      { task: 'backflush', d: task('due', { threshold_shots: 20, shotsSince: 22 }) }, // 2 over
      { task: 'descaling', d: task('never', { shotsSince: 500 }) },
    ];
    const picked = _pickNextDueTile(tiles);
    expect(picked.task).toBe('descaling');
  });
});
