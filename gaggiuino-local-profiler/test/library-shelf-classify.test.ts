import { describe, it, expect } from 'vitest';

// shelf.js's import chain (bags.js -> views/library.js -> state/i18n) reads
// localStorage/navigator at module load time — stub the minimum browser
// globals so the module graph can be imported under vitest's node
// environment (same pattern as test/library-past-bags-toggle.test.ts).
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };
g.navigator ??= { language: 'en-US' };

interface ShelfBuckets {
  inUse: unknown[];
  stock: unknown[];
  emptyArchive: unknown[];
}
interface ShelfModule {
  classifyBeanShelf: (beans: readonly unknown[]) => ShelfBuckets;
  renderShelfTile: (b: unknown, opts: { muted: boolean; expanded?: boolean }) => string;
}
const { classifyBeanShelf, renderShelfTile } = (await import('../public-src/views/library/shelf.js')) as unknown as ShelfModule;

// Minimal bean/bag rows: only the fields classifyBeanShelf/renderShelfTile read.
function bean(over: Record<string, unknown>): Record<string, unknown> {
  return { id: 1, name: 'Bean', bags: [], ...over };
}
function bag(over: Record<string, unknown>): Record<string, unknown> {
  return { id: 1, ...over };
}
function ids(rows: readonly unknown[]): number[] {
  return rows.map(r => (r as { id: number }).id);
}

describe('classifyBeanShelf (#1329 shelf layout)', () => {
  it('keeps a bean with 0 g open but a portion still in the freezer in Stock', () => {
    const b = bean({
      id: 1,
      remainingG: 0,
      bags: [bag({
        stock_g: 250, consumedG: 250, remainingG: 0, current: true,
        frozenPortions: [{ id: 1, frozenAt: 1, portionCount: 4, portionWeight_g: 20, remainingCount: 2 }],
      })],
    });
    const { stock, emptyArchive } = classifyBeanShelf([b]);
    expect(ids(stock)).toEqual([1]);
    expect(emptyArchive).toEqual([]);
  });

  it('moves an out-of-stock bean with no freezer portion to Empty & archive', () => {
    const b = bean({ id: 2, remainingG: 0, bags: [bag({ stock_g: 250, consumedG: 250, remainingG: 0, current: true })] });
    const { stock, emptyArchive } = classifyBeanShelf([b]);
    expect(stock).toEqual([]);
    expect(ids(emptyArchive)).toEqual([2]);
  });

  it('treats a bean with only thawed portions as empty', () => {
    const b = bean({
      id: 3,
      remainingG: 0,
      bags: [bag({
        stock_g: 250, consumedG: 250, remainingG: 0, current: true,
        frozenPortions: [{ id: 1, frozenAt: 1, portionCount: 2, portionWeight_g: 20, remainingCount: 1, thawedAt: 2 }],
      })],
    });
    const { emptyArchive } = classifyBeanShelf([b]);
    expect(ids(emptyArchive)).toEqual([3]);
  });

  it('archives a disabled bean even while it still has stock', () => {
    const b = bean({ id: 4, enabled: false, remainingG: 250, bags: [bag({ stock_g: 250, consumedG: 0, remainingG: 250, current: true })] });
    const { inUse, stock, emptyArchive } = classifyBeanShelf([b]);
    expect(ids(emptyArchive)).toEqual([4]);
    expect(inUse).toEqual([]);
    expect(stock).toEqual([]);
  });

  it('puts a partly-consumed current bag in In use', () => {
    const b = bean({ id: 5, remainingG: 150, bags: [bag({ stock_g: 250, consumedG: 100, remainingG: 150, current: true })] });
    const { inUse, stock } = classifyBeanShelf([b]);
    expect(ids(inUse)).toEqual([5]);
    expect(stock).toEqual([]);
  });

  it('keeps a bean without tracked stock in Stock', () => {
    const b = bean({ id: 6, bags: [bag({ stock_g: 250 })] });
    const { stock } = classifyBeanShelf([b]);
    expect(ids(stock)).toEqual([6]);
  });

  it('keeps a full unopened current bag in Stock, not In use', () => {
    const b = bean({ id: 7, remainingG: 250, bags: [bag({ stock_g: 250, consumedG: 0, remainingG: 250, current: true })] });
    const { inUse, stock } = classifyBeanShelf([b]);
    expect(ids(stock)).toEqual([7]);
    expect(inUse).toEqual([]);
  });

  it('preserves the input order within each shelf', () => {
    const a = bean({ id: 10, remainingG: 200, bags: [bag({ stock_g: 250, consumedG: 50, remainingG: 200, current: true })] });
    const b = bean({ id: 11, remainingG: 300, bags: [bag({ stock_g: 300, consumedG: 0, remainingG: 300, current: true })] });
    const c = bean({ id: 12, remainingG: 100, bags: [bag({ stock_g: 250, consumedG: 150, remainingG: 100, current: true })] });
    const { inUse, stock } = classifyBeanShelf([a, b, c]);
    expect(ids(inUse)).toEqual([10, 12]);
    expect(ids(stock)).toEqual([11]);
  });
});

describe('renderShelfTile (#1329 shelf layout)', () => {
  it('renders the initials placeholder and escapes a malicious name', () => {
    const b = bean({ id: 20, name: '<img src=x onerror=alert(1)>', roaster: 'Sq<m>', bags: [] });
    const out = renderShelfTile(b, { muted: false });
    expect(out).toContain('lib-shelf-ph');
    expect(out).not.toContain('<img src=x');
    expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;');
    // One word, so a single initial from the roaster.
    expect(out).toContain('>S<');
    expect(out).toContain('aria-expanded="false"');
  });
});
