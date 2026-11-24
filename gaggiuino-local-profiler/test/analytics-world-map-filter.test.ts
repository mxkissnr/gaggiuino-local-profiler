import { describe, it, expect } from 'vitest';
import type { SharedBean, ShotRow } from '../public-src/views/analytics/shared.js';

// #2200: the world map, its count and its points come from the filtered shots only.
// analytics/shared.ts and state/index.ts read localStorage/navigator at module
// load — same minimal stubs the other analytics test files use.
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };
g.navigator    ??= { language: 'en-US' };

const { collectWorldMapData } = await import('../public-src/views/analytics/world-map.js');
const { filterShotsByMachine } = await import('../public-src/state/index.js');

type TestShot = ShotRow & { machineId: number };

const beans: SharedBean[] = [
  { id: 1, name: 'Yirga', origin: 'ET' },
  { id: 2, name: 'Huila', origin: 'CO' },
  { id: 3, name: 'Cerrado', origin: 'BR' },
  { id: 4, name: 'Blend', origins: [{ code: 'ET', percent: 70 }, { code: 'KE', percent: 30 }] },
];

const shots: TestShot[] = [
  { id: 1, machineId: 1, timestamp: 1, annotation: { beanId: 1, coffee: 'Yirga' } },
  { id: 2, machineId: 1, timestamp: 2, annotation: { beanId: 1, coffee: 'Yirga' } },
  { id: 3, machineId: 1, timestamp: 3, annotation: { beanId: 3, coffee: 'Cerrado' } },
  { id: 4, machineId: 2, timestamp: 4, annotation: { beanId: 2, coffee: 'Huila' } },
  { id: 5, machineId: 2, timestamp: 5, annotation: { beanId: 4, coffee: 'Blend' } },
];

const scoreOf = () => null;

describe('collectWorldMapData (#2200 filtered shots only)', () => {
  it('count and plotted beans come from the same filtered shots', () => {
    const data = collectWorldMapData(beans, filterShotsByMachine(shots, 2), scoreOf);

    expect(data.countries).toEqual(['CO', 'ET', 'KE']);
    expect(Object.keys(data.byCode).sort()).toEqual([...data.countries].sort());
    expect(data.entries.map(e => e.bean.name)).toEqual(['Huila', 'Blend']);
    for (const entry of data.entries) {
      expect(data.countries).toContain(entry.origins[0]?.code);
    }
    expect([...(data.byCode.ET?.beans ?? [])]).toEqual(['Blend']);
    expect(data.byCode.BR).toBeUndefined();
  });

  it('a machine with no shot of a bean with an origin gives an empty map', () => {
    const data = collectWorldMapData(beans, filterShotsByMachine(shots, 3), scoreOf);

    expect(data.countries).toEqual([]);
    expect(data.entries).toEqual([]);
    expect(Object.keys(data.byCode)).toEqual([]);
  });

  it('all machines count every brewed bean\'s country', () => {
    const data = collectWorldMapData(beans, filterShotsByMachine(shots, 'all'), scoreOf);

    expect([...data.countries].sort()).toEqual(['BR', 'CO', 'ET', 'KE']);
    expect(data.entries).toHaveLength(4);
    const yirga = data.entries.find(e => e.bean.name === 'Yirga');
    expect(yirga ? data.shotCounts.get(yirga) : undefined).toBe(2);
  });
});
