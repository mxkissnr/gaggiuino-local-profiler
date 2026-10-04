import { describe, it, expect, beforeEach, vi } from 'vitest';

// shelf.js's import chain (bags.js -> views/library.js -> state/i18n) reads
// localStorage/navigator at module load time — stub the minimum browser
// globals so the module graph can be imported under vitest's node
// environment (same pattern as test/library-past-bags-toggle.test.ts).
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };
g.navigator ??= { language: 'en-US' };

// The staged-photo test drives saveBeanNoBag(), which calls into the API and
// the crop editor. Mock both before the dynamic imports below load the view
// (vi.hoisted keeps the spies out of the module factory's temporal dead zone).
const mocks = vi.hoisted(() => ({
  saveBean: vi.fn(),
  uploadBeanImage: vi.fn(),
  crop: vi.fn(),
}));
vi.mock('../public-src/api/library.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../public-src/api/library.js')>();
  return { ...actual, saveBean: mocks.saveBean, uploadBeanImage: mocks.uploadBeanImage };
});
vi.mock('../public-src/components/image-crop.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../public-src/components/image-crop.js')>();
  return { ...actual, openImageCropEditor: mocks.crop };
});

interface ShelfBuckets {
  inUse: unknown[];
  stock: unknown[];
  emptyArchive: unknown[];
}
type ShelfFilter = 'all' | 'espresso' | 'filter' | 'decaf';
type ShelfSort = 'fresh' | 'name' | 'remaining';
type ShelfView = 'shelf' | 'list';
interface ShelfStock {
  openG: number | null;
  pct: number | null;
  opened: boolean;
  sealedBags: number;
  frozenG: number;
}
interface ShelfPrefs {
  query: string;
  filter: ShelfFilter;
  sort: ShelfSort;
  view: ShelfView;
}
interface ShelfModule {
  classifyBeanShelf: (beans: readonly unknown[]) => ShelfBuckets;
  shelfStock: (b: unknown) => ShelfStock;
  renderShelfTile: (b: unknown, opts: { muted: boolean }) => string;
  renderShelfRow: (b: unknown, opts: { muted: boolean }) => string;
  matchesShelfQuery: (b: unknown, query: string) => boolean;
  matchesShelfFilter: (b: unknown, filter: ShelfFilter) => boolean;
  sortShelf: (beans: readonly unknown[], sort: ShelfSort) => unknown[];
  loadShelfPrefs: () => ShelfPrefs;
  saveShelfPrefs: (prefs: ShelfPrefs) => void;
}
const { classifyBeanShelf, shelfStock, renderShelfTile, renderShelfRow, matchesShelfQuery, matchesShelfFilter, sortShelf } =
  (await import('../public-src/views/library/shelf.js')) as unknown as ShelfModule;

const { S } = await import('../public-src/state/index.js');
interface LibraryModule {
  saveBeanNoBag: () => Promise<void>;
  closeBeanForm: () => void;
  stageNewBeanImage: (input: HTMLInputElement) => Promise<void>;
}
const library = (await import('../public-src/views/library.js')) as unknown as LibraryModule;

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

describe('shelfStock (#1330 one shelf)', () => {
  it('reports the open bag: grams, percent, opened flag', () => {
    const b = bean({ id: 1, bags: [bag({ id: 1, stock_g: 250, consumedG: 100, remainingG: 150, current: true })] });
    expect(shelfStock(b)).toEqual({ openG: 150, pct: 60, opened: true, sealedBags: 0, frozenG: 0 });
  });

  it('shows the first upcoming bag when nothing is open, counting the rest as sealed', () => {
    const b = bean({ id: 2, bags: [
      bag({ id: 1, stock_g: 250, remainingG: 250, sortOrder: 1 }),
      bag({ id: 2, stock_g: 250, remainingG: 250, sortOrder: 2 }),
    ] });
    expect(shelfStock(b)).toEqual({ openG: 250, pct: 100, opened: false, sealedBags: 1, frozenG: 0 });
  });

  it('counts every upcoming bag as sealed when a current bag exists', () => {
    const b = bean({ id: 3, bags: [
      bag({ id: 1, stock_g: 250, consumedG: 100, remainingG: 100, current: true }),
      bag({ id: 2, stock_g: 250, remainingG: 250, sortOrder: 2 }),
    ] });
    const s = shelfStock(b);
    expect(s.sealedBags).toBe(1);
    expect(s.openG).toBe(100);
    expect(s.opened).toBe(true);
  });

  it('leaves grams null for an untracked bean', () => {
    const b = bean({ id: 4, bags: [bag({ id: 1, stock_g: 250 })] });
    expect(shelfStock(b)).toEqual({ openG: null, pct: null, opened: false, sealedBags: 0, frozenG: 0 });
  });

  it('sums unthawed frozen portions and ignores thawed ones', () => {
    const b = bean({ id: 5, bags: [bag({
      id: 1, stock_g: 250, consumedG: 100, remainingG: 150, current: true,
      frozenPortions: [
        { id: 1, frozenAt: 1, portionCount: 4, portionWeight_g: 18, remainingCount: 2 },
        { id: 2, frozenAt: 1, portionCount: 2, portionWeight_g: 20, remainingCount: 1, thawedAt: 2 },
      ],
    })] });
    expect(shelfStock(b).frozenG).toBe(36);
  });
});

describe('renderShelfTile (#1330 one shelf)', () => {
  beforeEach(() => { S.currentLang = 'en'; });

  it('renders the initials placeholder and escapes a malicious name', () => {
    const b = bean({ id: 20, name: '<img src=x onerror=alert(1)>', roaster: 'Sq<m>', bags: [] });
    const out = renderShelfTile(b, { muted: false });
    expect(out).toContain('lib-shelf-ph');
    expect(out).not.toContain('<img src=x');
    expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;');
    // One word, so a single initial from the roaster.
    expect(out).toContain('>S<');
    expect(out).toContain('aria-haspopup="dialog"');
    // The old conic ring is gone.
    expect(out).not.toContain('lib-shelf-ring');
  });

  it('shows the stock bar, grams, sealed bags, frozen grams and the open state in the label', () => {
    const b = bean({
      id: 21,
      name: 'Red Brick',
      roaster: 'Square Mile',
      bags: [
        bag({
          id: 1, stock_g: 250, consumedG: 100, remainingG: 120, current: true,
          frozenPortions: [{ id: 1, frozenAt: 1, portionCount: 4, portionWeight_g: 18, remainingCount: 2 }],
        }),
        bag({ id: 2, stock_g: 250, remainingG: 250, sortOrder: 2 }),
      ],
    });
    const out = renderShelfTile(b, { muted: false });
    expect(out).toContain('lib-shelf-bar');
    expect(out).toContain('lib-shelf-bar-fill');
    expect(out).toContain('120 g');
    expect(out).toContain('+1 full');
    expect(out).toContain('lib-shelf-stack');
    expect(out).toContain('lib-shelf-sealed-badge');
    // The open badge left the photo; its word now lives in the tile's label.
    expect(out).not.toContain('lib-shelf-open-badge');
    expect(out).toContain('open, 120 g');
    expect(out).toContain('36 g');
  });
});

describe('renderShelfRow (#1330 list view)', () => {
  beforeEach(() => { S.currentLang = 'en'; });

  it('renders a compact expandable row with name, origin, stock and sealed bags', () => {
    const b = bean({
      id: 30,
      name: 'Red Brick',
      roaster: 'Square Mile',
      origins: [{ code: 'BR' }],
      bags: [
        bag({ id: 1, stock_g: 250, consumedG: 100, remainingG: 120, current: true }),
        bag({ id: 2, stock_g: 250, remainingG: 250, sortOrder: 2 }),
      ],
    });
    const out = renderShelfRow(b, { muted: false });
    expect(out).toContain('lib-shelf-row');
    expect(out).toContain('data-action="open-bean-sheet"');
    expect(out).toContain('aria-haspopup="dialog"');
    expect(out).toContain('Red Brick');
    expect(out).toContain('Square Mile');
    expect(out).toContain('Brazil');
    expect(out).toContain('120 g');
    expect(out).toContain('+1 full');
    expect(out).toContain('lib-shelf-open-badge');
    expect(out).toContain('lib-shelf-bar');
  });

  it('marks archive rows muted', () => {
    const b = bean({ id: 31, enabled: false, bags: [] });
    expect(renderShelfRow(b, { muted: true })).toContain('lib-shelf-row muted');
  });
});

describe('matchesShelfQuery (#1329 part 2)', () => {
  beforeEach(() => { S.currentLang = 'en'; });

  it('matches name, roaster, origin code and the origin display name', () => {
    const b = bean({ name: 'Yirgacheffe', roaster: 'Square Mile', origins: [{ code: 'BR' }] });
    expect(matchesShelfQuery(b, 'yirga')).toBe(true);
    expect(matchesShelfQuery(b, 'square')).toBe(true);
    expect(matchesShelfQuery(b, 'BR')).toBe(true);
    // countryName('BR', 'en') === 'Brazil'
    expect(matchesShelfQuery(b, 'brazil')).toBe(true);
    expect(matchesShelfQuery(b, 'robles')).toBe(false);
  });

  it('matches everything for an empty or whitespace query', () => {
    const b = bean({ name: 'Anything' });
    expect(matchesShelfQuery(b, '')).toBe(true);
    expect(matchesShelfQuery(b, '   ')).toBe(true);
  });

  it('falls back to the legacy singular origin field', () => {
    const b = bean({ name: 'X', origin: 'ET' });
    expect(matchesShelfQuery(b, 'ethiopia')).toBe(true);
  });
});

describe('matchesShelfFilter (#1329 part 2)', () => {
  it('treats omni as both espresso and filter', () => {
    const omni = bean({ roastType: 'omni' });
    expect(matchesShelfFilter(omni, 'espresso')).toBe(true);
    expect(matchesShelfFilter(omni, 'filter')).toBe(true);
    expect(matchesShelfFilter(omni, 'decaf')).toBe(false);
  });

  it('separates espresso-only from filter-only', () => {
    expect(matchesShelfFilter(bean({ roastType: 'espresso' }), 'espresso')).toBe(true);
    expect(matchesShelfFilter(bean({ roastType: 'espresso' }), 'filter')).toBe(false);
    expect(matchesShelfFilter(bean({ roastType: 'filter' }), 'filter')).toBe(true);
    expect(matchesShelfFilter(bean({ roastType: 'filter' }), 'espresso')).toBe(false);
  });

  it('matches decaf strictly and all always', () => {
    expect(matchesShelfFilter(bean({ decaf: true }), 'decaf')).toBe(true);
    expect(matchesShelfFilter(bean({ decaf: false }), 'decaf')).toBe(false);
    expect(matchesShelfFilter(bean({}), 'all')).toBe(true);
  });
});

describe('sortShelf (#1329 part 2)', () => {
  function daysAgo(n: number): string {
    const d = new Date(Date.now() - n * 86400000);
    const p = (x: number) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  it('fresh: youngest roast first, unknown age last', () => {
    const fresh = bean({ id: 1, roastDate: daysAgo(5) });
    const older = bean({ id: 2, roastDate: daysAgo(40) });
    const unknown = bean({ id: 3 });
    const out = sortShelf([unknown, older, fresh], 'fresh');
    expect(ids(out)).toEqual([1, 2, 3]);
  });

  it('remaining: highest grams first, null last', () => {
    const a = bean({ id: 1, remainingG: 50 });
    const b = bean({ id: 2, remainingG: 200 });
    const c = bean({ id: 3, remainingG: undefined });
    const out = sortShelf([a, b, c], 'remaining');
    expect(ids(out)).toEqual([2, 1, 3]);
  });

  it('name: localeCompare order', () => {
    const out = sortShelf([bean({ id: 1, name: 'Charlie' }), bean({ id: 2, name: 'Alpha' }), bean({ id: 3, name: 'Bravo' })], 'name');
    expect(ids(out)).toEqual([2, 3, 1]);
  });

  it('never mutates the input array', () => {
    const input = [bean({ id: 1, name: 'B' }), bean({ id: 2, name: 'A' })];
    const before = ids(input);
    const out = sortShelf(input, 'name');
    expect(out).not.toBe(input);
    expect(ids(input)).toEqual(before);
  });
});

describe('shelf prefs persistence (#1329 part 2, shared store #1375)', () => {
  // The module-load stub elsewhere in this file is a no-op store; persistence
  // needs a real (in-memory) one to round-trip. ui-prefs.ts memoises the
  // shared store at module load, so each test re-imports shelf.js against a
  // fresh store instead of relying on a per-test localStorage swap.
  let store: Map<string, string>;
  let shelfMod: ShelfModule;

  beforeEach(() => {
    store = new Map();
    g.localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
    };
  });

  async function freshShelf(): Promise<ShelfModule> {
    vi.resetModules();
    return (await import('../public-src/views/library/shelf.js')) as unknown as ShelfModule;
  }

  it('round-trips filter, sort and view but never the query', async () => {
    shelfMod = await freshShelf();
    shelfMod.saveShelfPrefs({ query: 'ethiopia', filter: 'decaf', sort: 'remaining', view: 'list' });
    const loaded = shelfMod.loadShelfPrefs();
    expect(loaded.filter).toBe('decaf');
    expect(loaded.sort).toBe('remaining');
    expect(loaded.view).toBe('list');
    expect(loaded.query).toBe('');
  });

  it('falls back to defaults when nothing is stored', async () => {
    shelfMod = await freshShelf();
    expect(shelfMod.loadShelfPrefs()).toEqual({ query: '', filter: 'all', sort: 'fresh', view: 'shelf' });
  });

  it('ignores an invalid stored view', async () => {
    store.set('glp_ui_prefs', JSON.stringify({ 'lib.shelf': { view: 'grid' } }));
    shelfMod = await freshShelf();
    expect(shelfMod.loadShelfPrefs().view).toBe('shelf');
  });
});

// Universal stand-in element: saveBeanInternal reads ~20 form fields plus a
// handful of chrome nodes, so a permissive object beats enumerating each id.
function fakeLibraryDom(beanNameArg: string) {
  interface FakeEl {
    value: string; checked: boolean; files?: unknown[] | undefined;
    style: Record<string, string>; dataset: Record<string, string>;
    innerHTML: string;
    classList: { add(): void; remove(): void; toggle(): void; contains(): boolean };
    focus(): void; addEventListener(): void; removeEventListener(): void;
    appendChild(): void; insertBefore(): void; remove(): void;
    querySelectorAll(): never[]; setAttribute(): void; getAttribute(): null;
  }
  const makeEl = (over: Partial<FakeEl> = {}): FakeEl => ({
    value: '', checked: false, files: undefined, style: {}, dataset: {}, innerHTML: '',
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    focus() {}, addEventListener() {}, removeEventListener() {},
    appendChild() {}, insertBefore() {}, remove() {},
    querySelectorAll: () => [], setAttribute() {}, getAttribute: () => null,
    ...over,
  });
  const nodes: Record<string, FakeEl> = {
    beanFormName: makeEl({ value: beanNameArg }),
    beanListUI: makeEl(),
  };
  const doc = {
    getElementById: (id: string): FakeEl => (nodes[id] ??= makeEl()),
    querySelector: () => null,
    querySelectorAll: () => [] as never[],
    body: makeEl(),
  };
  return { doc, nodes };
}

describe('staged new-bean photo (#1329 part 2)', () => {
  beforeEach(() => {
    mocks.saveBean.mockReset();
    mocks.uploadBeanImage.mockReset();
    mocks.crop.mockReset();
    S.beanEditId = null;
    S.coffeeLibrary = { beans: [], recipes: [], grinders: [] };
    S._urlImportSource = null;
  });

  it('uploads a staged photo after the bean is created', async () => {
    const { doc } = fakeLibraryDom('New Bean');
    g.document = doc;
    mocks.crop.mockResolvedValue({});
    mocks.saveBean.mockResolvedValue({ id: 42, name: 'New Bean', bags: [] });
    mocks.uploadBeanImage.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: 42, name: 'New Bean', image: 'jpg', bags: [] }),
    });

    const input = { files: [{}], value: 'x' } as unknown as HTMLInputElement;
    await library.stageNewBeanImage(input);
    await library.saveBeanNoBag();

    expect(mocks.uploadBeanImage).toHaveBeenCalledTimes(1);
    expect(mocks.uploadBeanImage.mock.calls[0]?.[0]).toBe(42);
  });

  it('does not upload after closeBeanForm() cleared the staged photo', async () => {
    const { doc } = fakeLibraryDom('Another Bean');
    g.document = doc;
    mocks.crop.mockResolvedValue({});
    mocks.saveBean.mockResolvedValue({ id: 43, name: 'Another Bean', bags: [] });

    const input = { files: [{}], value: 'x' } as unknown as HTMLInputElement;
    await library.stageNewBeanImage(input);
    library.closeBeanForm();
    await library.saveBeanNoBag();

    expect(mocks.uploadBeanImage).not.toHaveBeenCalled();
  });
});

