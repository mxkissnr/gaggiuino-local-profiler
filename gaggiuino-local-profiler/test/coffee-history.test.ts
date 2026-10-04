import { describe, it, expect, vi } from 'vitest';

// The shelf must not fetch a bean photo that does not exist (the request would
// 404 and log a console error), so stub the image loader and count its calls.
vi.mock('../public-src/bean-image.js', () => ({
  loadBeanImageBlobUrl: vi.fn(() => Promise.resolve(null)),
  loadShotThumbBlobUrl: vi.fn(() => Promise.resolve(null)),
}));

import { loadBeanImageBlobUrl } from '../public-src/bean-image.js';

// coffee-history.ts reaches the library view (bag classification) and the
// image cache; both read localStorage/navigator at module load under vitest's
// node environment — same stub pattern as the sibling library tests.
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
g.navigator ??= { language: 'en-US' };

interface HistoryTile {
  id: number;
  hasPhoto: boolean;
  score: number | null;
  date: number;
  beanName: string;
}
interface ShelfBean {
  beanId: number | null;
  name: string;
}
interface HistoryModule {
  spiralPositions: (n: number, spacing: number) => { x: number; y: number }[];
  historyStats: (shots: readonly unknown[], beans: readonly unknown[]) => { shots: number; bags: number; kg: number };
  historyTiles: (shots: readonly unknown[], cap?: number) => HistoryTile[];
  shelfBeans: (shots: readonly unknown[], beans: readonly unknown[]) => ShelfBean[];
  renderCoffeeHistory: (host: HTMLElement) => () => void;
}
const { spiralPositions, historyStats, historyTiles, shelfBeans, renderCoffeeHistory } =
  (await import('../public-src/components/coffee-history.js')) as unknown as HistoryModule;
const { S } = await import('../public-src/state/index.js');

function shot(over: Record<string, unknown>): Record<string, unknown> {
  return { id: 0, timestamp: 0, ...over };
}

// renderCoffeeHistory builds its DOM with document.createElement; a minimal
// fake element is enough to reach the bag loop and count the loader calls.
function fakeEl() {
  const el = {
    children: [] as unknown[],
    className: '', title: '', textContent: '', alt: '', decoding: '', loading: '', src: '', type: '',
    style: {} as Record<string, string>,
    dataset: {} as Record<string, string>,
    classList: { add: (_c: string): void => {} },
    setAttribute: (_name: string, _value: string): void => {},
    appendChild(child: unknown): void { el.children.push(child); },
    append(...nodes: unknown[]): void { el.children.push(...nodes); },
    replaceChildren(...nodes: unknown[]): void { el.children = nodes; },
    addEventListener: (): void => {},
    removeEventListener: (): void => {},
  };
  return el;
}
g.document = { createElement: () => fakeEl(), getElementById: () => null };
g.requestAnimationFrame = () => 0;
g.cancelAnimationFrame = () => {};

describe('spiralPositions (#1351)', () => {
  it('returns exactly n points', () => {
    expect(spiralPositions(0, 10)).toEqual([]);
    expect(spiralPositions(5, 10)).toHaveLength(5);
  });

  it('starts near the centre and grows outwards', () => {
    const radii = spiralPositions(20, 12).map(p => Math.hypot(p.x, p.y));
    expect(radii[0]).toBeCloseTo(12, 6);
    let previous = 0;
    for (const radius of radii) {
      expect(radius).toBeGreaterThan(previous);
      previous = radius;
    }
  });
});

describe('historyStats (#1351)', () => {
  it('counts only emptied bags the server tracked stock for', () => {
    const beans = [{
      id: 1,
      name: 'Bean',
      bags: [
        { id: 11, stock_g: 250, consumedG: 250, remainingG: 0 },
        { id: 12, stock_g: 250, consumedG: 0, remainingG: 250 },
        { id: 13, stock_g: 250 },
        { id: 14, stock_g: 250, consumedG: 250, remainingG: 0, current: true },
      ],
    }];
    expect(historyStats([], beans).bags).toBe(1);
  });

  it('sums doses in kg rounded to 0.1 and ignores missing doses', () => {
    const shots = [
      shot({ id: 1, timestamp: 1, annotation: { dose: 1000 } }),
      shot({ id: 2, timestamp: 2, annotation: { dose: 480 } }),
      shot({ id: 3, timestamp: 3, annotation: { dose: null } }),
      shot({ id: 4, timestamp: 4 }),
    ];
    const stats = historyStats(shots, []);
    expect(stats.shots).toBe(4);
    expect(stats.kg).toBe(1.5);
  });
});

describe('historyTiles (#1351)', () => {
  const shots = [
    shot({ id: 1, timestamp: 100, image: 'a.jpg', score: 80, annotation: { coffee: 'A' } }),
    shot({ id: 2, timestamp: 200, image: 'b.jpg', score: 90, annotation: { coffee: 'B' } }),
    shot({ id: 3, timestamp: 300, image: null, annotation: { coffee: 'C' } }),
    shot({ id: 4, timestamp: 400, image: 'd.jpg', annotation: { coffee: 'D', score: 70 } }),
    shot({ id: 5, timestamp: 500, image: 'e.jpg', score: 95, annotation: { coffee: 'E' } }),
  ];

  it('lists shots oldest first with date, bean name and score', () => {
    const tiles = historyTiles(shots);
    expect(tiles.map(t => t.id)).toEqual([1, 2, 3, 4, 5]);
    expect(tiles[0]).toMatchObject({ id: 1, beanName: 'A', date: 100000, score: 80 });
    expect(tiles[3]).toMatchObject({ id: 4, beanName: 'D', score: 70 });
  });

  it('keeps photos only on the newest cap photo shots', () => {
    expect(historyTiles(shots, 2).map(t => t.hasPhoto)).toEqual([false, false, false, true, true]);
  });

  it('falls back to a crema tile for shots without a photo', () => {
    const tiles = historyTiles([shot({ id: 9, timestamp: 1, image: null, annotation: {} })]);
    expect(tiles[0]?.hasPhoto).toBe(false);
    expect(tiles[0]?.beanName).toBe('');
    expect(tiles[0]?.score).toBeNull();
  });
});

describe('shelfBeans (#1351)', () => {
  it('returns each used bean once, ordered by its first shot', () => {
    const beans = [
      { id: 1, name: 'Old' },
      { id: 2, name: 'New' },
    ];
    const shots = [
      shot({ id: 1, timestamp: 300, annotation: { beanId: 2 } }),
      shot({ id: 2, timestamp: 100, annotation: { beanId: 1 } }),
      shot({ id: 3, timestamp: 200, annotation: { beanId: 1 } }),
    ];
    expect(shelfBeans(shots, beans)).toEqual([
      { beanId: 1, name: 'Old' },
      { beanId: 2, name: 'New' },
    ]);
  });

  it('appends a bean whose only bag is emptied and was never shot', () => {
    const beans = [
      { id: 1, name: 'Used' },
      { id: 2, name: 'Shelf only', bags: [{ remainingG: 0 }] },
      { id: 3, name: 'Still full', bags: [{ remainingG: 250 }] },
    ];
    const shots = [shot({ id: 1, timestamp: 10, annotation: { beanId: 1 } })];
    expect(shelfBeans(shots, beans)).toEqual([
      { beanId: 1, name: 'Used' },
      { beanId: 2, name: 'Shelf only' },
    ]);
  });

  it('ignores shots with a missing or unknown beanId', () => {
    const beans = [{ id: 1, name: 'Only' }];
    const shots = [
      shot({ id: 1, timestamp: 1, annotation: {} }),
      shot({ id: 2, timestamp: 2, annotation: { beanId: null } }),
      shot({ id: 3, timestamp: 3, annotation: { beanId: 99 } }),
      shot({ id: 4, timestamp: 4 }),
      shot({ id: 5, timestamp: 5, annotation: { beanId: 1 } }),
    ];
    expect(shelfBeans(shots, beans)).toEqual([{ beanId: 1, name: 'Only' }]);
  });
});

describe('renderCoffeeHistory shelf photos (#1351)', () => {
  it('loads a bean photo only for a bean that has one', () => {
    const loadBeanPhoto = vi.mocked(loadBeanImageBlobUrl);
    loadBeanPhoto.mockClear();
    S.allShots = [
      shot({ id: 1, timestamp: 1, annotation: { beanId: 1 } }),
      shot({ id: 2, timestamp: 2, annotation: { beanId: 2 } }),
    ] as unknown as typeof S.allShots;
    S.coffeeLibrary = {
      beans: [
        { id: 1, name: 'No photo' },
        { id: 2, name: 'Photo', image: 'photo.jpg' },
      ],
      grinders: [],
    };

    renderCoffeeHistory(fakeEl() as unknown as HTMLElement);

    expect(loadBeanPhoto).toHaveBeenCalledTimes(1);
    expect(loadBeanPhoto).toHaveBeenCalledWith(2);
  });
});
