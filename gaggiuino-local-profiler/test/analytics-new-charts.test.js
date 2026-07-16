import { describe, it, expect, beforeAll } from 'vitest';

// analytics.js pulls in state.js/i18n.js (localStorage/navigator at module
// load, same as best-grind-combo.test.js) and calls window.calcShotScore /
// window.getShotData at runtime (mirroring main.js's real window-exposure
// pattern) — stub a minimal scoring window here so shots carrying a plain
// .score field resolve without needing real datapoints.
let _computeBeanRanking, _computeMachineComparison;

beforeAll(async () => {
  Object.defineProperty(globalThis, 'localStorage', {
    value: { getItem: () => null, setItem: () => {} },
    configurable: true, writable: true,
  });
  Object.defineProperty(globalThis, 'navigator', {
    value: { language: 'en' },
    configurable: true, writable: true,
  });
  Object.defineProperty(globalThis, 'window', {
    value: {
      calcShotScore: (shot) => shot.score ?? null,
      getShotData: () => ({}),
    },
    configurable: true, writable: true,
  });
  ({ _computeBeanRanking, _computeMachineComparison } = await import('../public-src/views/analytics.js'));
});

const shot = (overrides = {}) => ({
  id: overrides.id ?? 1,
  timestamp: overrides.timestamp ?? 0,
  duration: overrides.duration ?? 280, // 28.0s
  machineId: overrides.machineId,
  score: overrides.score,
  annotation: { coffee: overrides.coffee, grindSetting: overrides.grindSetting },
  datapoints: overrides.datapoints,
});

describe('_computeBeanRanking (#394)', () => {
  it('groups shots by bean, counting shots and averaging scores', () => {
    const shots = [
      shot({ coffee: 'Bean A', score: 80, timestamp: 100 }),
      shot({ coffee: 'Bean A', score: 90, timestamp: 200 }),
      shot({ coffee: 'Bean B', score: 70, timestamp: 150 }),
    ];
    const rows = _computeBeanRanking(shots);
    const a = rows.find(r => r.name === 'Bean A');
    const b = rows.find(r => r.name === 'Bean B');
    expect(a.shots).toBe(2);
    expect(a.avgScore).toBe(85);
    expect(b.shots).toBe(1);
    expect(b.avgScore).toBe(70);
  });

  it('ignores shots with no bean annotated', () => {
    const shots = [shot({ coffee: undefined, score: 90 })];
    expect(_computeBeanRanking(shots)).toEqual([]);
  });

  it('picks the most recent annotated shot\'s grind setting, not the first or best-scoring one', () => {
    const shots = [
      shot({ coffee: 'Bean A', grindSetting: '18', timestamp: 100, score: 95 }),
      shot({ coffee: 'Bean A', grindSetting: '19.5', timestamp: 300, score: 60 }),
      shot({ coffee: 'Bean A', grindSetting: undefined, timestamp: 200, score: 80 }),
    ];
    const [row] = _computeBeanRanking(shots);
    expect(row.lastGrind).toBe('19.5');
  });

  it('computes a null trend with fewer than 4 scored shots', () => {
    const shots = [
      shot({ coffee: 'Bean A', score: 80, timestamp: 1 }),
      shot({ coffee: 'Bean A', score: 82, timestamp: 2 }),
      shot({ coffee: 'Bean A', score: 84, timestamp: 3 }),
    ];
    expect(_computeBeanRanking(shots)[0].trend).toBeNull();
  });

  it('computes trend as last-5 average minus previous-5 average', () => {
    // 10 scored shots: first 5 average 70, last 5 average 90 -> trend +20
    const shots = [70, 70, 70, 70, 70, 90, 90, 90, 90, 90].map((score, i) =>
      shot({ coffee: 'Bean A', score, timestamp: i }));
    expect(_computeBeanRanking(shots)[0].trend).toBe(20);
  });
});

describe('_computeMachineComparison (#394)', () => {
  const machines = [{ id: 1, name: 'Gaggiuino' }, { id: 2, name: 'GaggiMate Sim' }];

  it('groups shots by machineId (defaulting missing machineId to 1)', () => {
    const shots = [
      shot({ machineId: 1, score: 80 }),
      shot({ machineId: undefined, score: 90 }), // legacy shot, no machineId -> machine 1
      shot({ machineId: 2, score: 70 }),
    ];
    const rows = _computeMachineComparison(shots, machines);
    const m1 = rows.find(r => r.name === 'Gaggiuino');
    const m2 = rows.find(r => r.name === 'GaggiMate Sim');
    expect(m1.count).toBe(2);
    expect(m1.avgScore).toBe(85);
    expect(m2.count).toBe(1);
    expect(m2.avgScore).toBe(70);
  });

  it('computes average duration in seconds, ignoring near-zero noise durations', () => {
    const shots = [
      shot({ machineId: 1, duration: 280 }), // 28.0s
      shot({ machineId: 1, duration: 320 }), // 32.0s
      shot({ machineId: 1, duration: 10 }),  // 1.0s, filtered out as noise
    ];
    const rows = _computeMachineComparison(shots, machines);
    expect(rows.find(r => r.name === 'Gaggiuino').avgDuration).toBe(30);
  });

  it('computes temperature stability as the mean absolute deviation from target, in whole degrees', () => {
    const shots = [
      shot({
        machineId: 1,
        datapoints: {
          temperature:       [930, 935, 940], // 93.0, 93.5, 94.0 (x10-scaled)
          targetTemperature: [930, 930, 930], // 93.0 target throughout
        },
      }),
    ];
    const rows = _computeMachineComparison(shots, machines);
    // deviations: 0, 0.5, 1.0 -> mean 0.5
    expect(rows.find(r => r.name === 'Gaggiuino').avgStability).toBe(0.5);
  });

  it('returns null stability/duration/score for a machine with no shots', () => {
    const shots = [shot({ machineId: 1, score: 80 })];
    const rows = _computeMachineComparison(shots, machines);
    const m2 = rows.find(r => r.name === 'GaggiMate Sim');
    expect(m2).toMatchObject({ count: 0, avgScore: null, avgDuration: null, avgStability: null });
  });
});
