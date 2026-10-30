import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Bean mix (#1837): a mixed shot records 2-4 beans in one dose and names only
// its primary bean at the top level. The shot list, the detail view and the
// exports must therefore name every part, while the bean rating keeps ignoring
// mixed shots (they have no single bean to rate). The single-bean output is
// pinned as unchanged throughout.

const mock = vi.hoisted(() => ({ blob: null as Blob | null }));

// The download itself is not under test — the blob is captured instead (same
// approach as test/csv-export-formula.test.ts).
vi.mock('../public-src/utils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../public-src/utils.js')>()),
  shareOrDownloadBlob: vi.fn((blob: Blob) => { mock.blob = blob; return Promise.resolve(); }),
}));

// A minimal curve: the exports only need some sample series to read.
vi.mock('../public-src/shot-curves.js', () => ({
  getShotCurve: vi.fn(() => Promise.resolve({
    timeInShot: [0, 10, 20, 30],
    pressure: [0, 90, 90, 90],
    targetPressure: [0, 90, 90, 90],
    pumpFlow: [0, 20, 20, 20],
    shotWeight: [0, 100, 200, 360],
    temperature: [900, 900, 900, 900],
    targetTemperature: [900, 900, 900, 900],
  })),
  getCachedShotData: vi.fn(() => null),
  ensureCurves: vi.fn(() => Promise.resolve()),
  evictCurve: vi.fn(),
}));

// sidebar.ts / shots/index.ts import state/index.ts and i18n.ts, which read
// localStorage/navigator at module load — stub the minimum browser globals
// (same pattern as test/sidebar-bean-filter.test.ts).
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };
g.navigator    ??= { language: 'en-US' };
g.window       ??= {};

const { S } = await import('../public-src/state/index.js');
const { beanLabel } = await import('../public-src/shared/bean-mix.js');
const { calcBeanRating } = await import('../public-src/utils.js');
const { renderSidebar, filterShots, setBeanFilter, clearBeanFilter } =
  await import('../public-src/components/sidebar.js');
const { exportCSV, exportShot } = await import('../public-src/views/shots/export.js');

// A shot whose dose came from two beans; the top-level coffee/beanId name the
// primary (heaviest) part, exactly as the backend stores it.
const MIX: {
  coffee: string; beanId: number; dose: number; rating: string;
  beanMix: { beanId: number; coffee: string; grams: number }[];
} = {
  coffee: 'Ethiopia Guji',
  beanId: 1,
  dose: 18,
  rating: '5',
  beanMix: [
    { beanId: 1, coffee: 'Ethiopia Guji', grams: 10 },
    { beanId: 2, coffee: 'Brazil Santos', grams: 8 },
  ],
};

// ── Shot list ─────────────────────────────────────────────────────────────

// renderSidebar()/_buildShotWrapper() build real DOM nodes, so this needs a
// small node factory (classList/style/innerHTML plus the sibling links
// filterShots() walks) — same "fake minimal document" approach as
// test/sidebar-lazy-month-groups.test.ts, no jsdom.
interface FakeNode {
  tagName: string;
  id: string;
  className: string;
  dataset: Record<string, string>;
  style: Record<string, string>;
  children: FakeNode[];
  textContent: string;
  title: string;
  type: string;
  onclick: (() => void) | null;
  nextElementSibling: FakeNode | null;
  innerHTML: string;
  classList: {
    add: (...c: string[]) => void;
    remove: (...c: string[]) => void;
    contains: (c: string) => boolean;
    toggle: (c: string) => void;
  };
  appendChild: (c: FakeNode) => FakeNode;
}

function makeNode(tag: string): FakeNode {
  const classes = new Set<string>();
  let html = '';
  const node: FakeNode = {
    tagName: tag,
    id: '',
    dataset: {},
    style: {},
    children: [] as FakeNode[],
    textContent: '',
    title: '', type: '', onclick: null,
    nextElementSibling: null,
    get innerHTML() { return html; },
    set innerHTML(v: string) { html = String(v); if (v === '') node.children = []; },
    get className() { return [...classes].join(' '); },
    set className(v: string) { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach(c => classes.add(c)); },
    classList: {
      add: (...c: string[]) => c.forEach(x => classes.add(x)),
      remove: (...c: string[]) => c.forEach(x => classes.delete(x)),
      contains: (c: string) => classes.has(c),
      toggle: (c: string) => { if (classes.has(c)) classes.delete(c); else classes.add(c); },
    },
    appendChild(c: FakeNode) {
      const prev = node.children[node.children.length - 1];
      if (prev) prev.nextElementSibling = c;
      c.nextElementSibling = null;
      node.children.push(c);
      return c;
    },
  };
  return node;
}

function collect(root: FakeNode, pred: (n: FakeNode) => boolean, acc: FakeNode[] = []): FakeNode[] {
  for (const ch of root.children) {
    if (pred(ch)) acc.push(ch);
    collect(ch, pred, acc);
  }
  return acc;
}

let shotsEl: FakeNode;

function installDocument(): void {
  shotsEl = makeNode('div');
  g.document = {
    createElement: makeNode,
    getElementById: (id: string) => (id === 'shots' ? shotsEl : collect(shotsEl, n => n.id === id)[0] || null),
    querySelectorAll: (sel: string) => {
      if (sel.includes('.shot-wrapper')) return collect(shotsEl, n => n.classList.contains('shot-wrapper'));
      return [];
    },
    querySelector: () => null,
  };
}

const wrapperHtml = (id: number): string => {
  const wrapper = collect(shotsEl, n => n.id === `wrapper-${id}`)[0];
  if (wrapper === undefined) throw new Error(`missing wrapper ${id}`);
  return wrapper.children.map(c => c.innerHTML).join('\n');
};

describe('shot list bean line (#1837)', () => {
  beforeEach(() => {
    installDocument();
    S._expandedMonths = new Set();
    S.currentFilter = '';
    S.beanFilter = null;
    S.machines = [];
    S.currentSort = 'newest';
    S.sortAsc = false;
    S.coffeeLibrary = {
      beans: [{ id: 1, name: 'Ethiopia Guji' }, { id: 2, name: 'Brazil Santos' }],
      grinders: [],
    };
  });

  it('names every bean of a mixed shot', () => {
    S.shots = [{ id: 1, timestamp: Math.floor(Date.now() / 1000), profile: { name: 'Espresso' }, annotation: MIX }];
    renderSidebar();
    expect(wrapperHtml(1)).toContain('Ethiopia Guji + Brazil Santos · 18.0 g');
  });

  it('leaves a single-bean shot on its plain coffee name', () => {
    S.shots = [{ id: 2, timestamp: Math.floor(Date.now() / 1000), profile: { name: 'Espresso' }, annotation: { coffee: 'Colombia Huila', beanId: 3, dose: 18 } }];
    renderSidebar();
    expect(wrapperHtml(2)).toContain('Colombia Huila · 18.0 g');
    expect(wrapperHtml(2)).not.toContain(' + ');
  });

  it('search matches a mixed shot through any of its beans', () => {
    S.shots = [
      { id: 1, timestamp: Math.floor(Date.now() / 1000), profile: { name: 'Espresso' }, annotation: MIX },
      { id: 2, timestamp: Math.floor(Date.now() / 1000), profile: { name: 'Espresso' }, annotation: { coffee: 'Colombia Huila', beanId: 3 } },
    ];
    renderSidebar();
    filterShots('brazil');
    const wrappers = collect(shotsEl, n => n.classList.contains('shot-wrapper'));
    const display = (id: number) => wrappers.find(w => w.id === `wrapper-${id}`)!.style.display;
    expect(display(1)).toBe('');
    expect(display(2)).toBe('none');
  });

  it('the bean filter matches a mixed shot through a non-primary bean', () => {
    S.shots = [
      { id: 1, timestamp: Math.floor(Date.now() / 1000), profile: { name: 'Espresso' }, annotation: MIX },
      { id: 2, timestamp: Math.floor(Date.now() / 1000), profile: { name: 'Espresso' }, annotation: { coffee: 'Colombia Huila', beanId: 3 } },
    ];
    renderSidebar();
    setBeanFilter(2, 'Brazil Santos');
    const wrappers = collect(shotsEl, n => n.classList.contains('shot-wrapper'));
    const display = (id: number) => wrappers.find(w => w.id === `wrapper-${id}`)!.style.display;
    expect(display(1)).toBe('');
    expect(display(2)).toBe('none');
    clearBeanFilter();
    expect(display(2)).toBe('');
  });
});

// ── Detail view ───────────────────────────────────────────────────────────
// updateView() needs the full chart/curve/DOM harness (~40 elements, Chart.js
// canvas) that test/i18n.test.ts documents as disproportionate, so the bean
// cell stays a source guard — its label itself is covered behaviourally below.
describe('shot detail bean value (#1837)', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../public-src/views/shots/index.ts'), 'utf8');

  it('shows the bean label with grams instead of the primary coffee alone', () => {
    expect(src).toMatch(/_el\('beanVal'\)\.textContent\s*=\s*beanLabel\(ann, true\)\s*\|\|\s*'–'/);
    expect(src).not.toMatch(/_el\('beanVal'\)\.textContent\s*=\s*ann\.coffee/);
  });

  it('the label it renders is the mixed one, with grams, while a single bean stays plain', () => {
    expect(beanLabel(MIX, true)).toBe('Ethiopia Guji 10 g + Brazil Santos 8 g');
    expect(beanLabel({ coffee: 'Colombia Huila' }, true)).toBe('Colombia Huila');
  });
});

// ── Exports ───────────────────────────────────────────────────────────────

describe('export bean column (#1837)', () => {
  beforeEach(() => {
    mock.blob = null;
    S.currentLang = 'en';
    S.coffeeLibrary = { beans: [], grinders: [] };
  });

  afterEach(() => { mock.blob = null; });

  it('the CSV Coffee column lists every bean with its grams', async () => {
    S.primaryShotId = 1;
    S.shots = [{ id: 1, timestamp: 1700000000, profileName: 'Espresso', annotation: MIX }];
    await exportCSV();
    const row = (await mock.blob!.text()).split('\r\n')[1]!;
    expect(row).toContain('"Ethiopia Guji 10 g + Brazil Santos 8 g"');
  });

  it('leaves a single-bean CSV row on the plain coffee name', async () => {
    S.primaryShotId = 2;
    S.shots = [{ id: 2, timestamp: 1700000000, profileName: 'Espresso', annotation: { coffee: 'Colombia Huila', beanId: 3, dose: 18 } }];
    await exportCSV();
    const row = (await mock.blob!.text()).split('\r\n')[1]!;
    expect(row).toContain('"Colombia Huila"');
  });

  it('the Visualizer description names every bean of a mixed shot', async () => {
    S.primaryShotId = 1;
    S.shots = [{ id: 1, timestamp: 1700000000, profileName: 'Espresso', annotation: MIX }];
    await exportShot();
    expect(await mock.blob!.text()).toContain('bean_desc {Ethiopia Guji 10 g + Brazil Santos 8 g}');
  });

  it('leaves a single-bean Visualizer description unchanged', async () => {
    S.primaryShotId = 2;
    S.shots = [{ id: 2, timestamp: 1700000000, profileName: 'Espresso', annotation: { coffee: 'Colombia Huila', beanId: 3 } }];
    await exportShot();
    expect(await mock.blob!.text()).toContain('bean_desc {Colombia Huila}');
  });
});

// ── Bean rating ───────────────────────────────────────────────────────────

describe('bean rating ignores mixed shots (#1837)', () => {
  const beans = [{ id: 1, name: 'Ethiopia Guji' }, { id: 2, name: 'Brazil Santos' }];

  it('does not count a mixed shot for its primary bean', () => {
    const shots = [
      { annotation: MIX },
      { annotation: { coffee: 'Ethiopia Guji', beanId: 1, rating: '3' } },
    ];
    expect(calcBeanRating(beans[0], shots, beans)).toEqual({ avg: 3, count: 1 });
  });

  it('counts every single-bean shot as before', () => {
    const shots = [
      { annotation: { coffee: 'Ethiopia Guji', beanId: 1, rating: '4' } },
      { annotation: { coffee: 'Ethiopia Guji', beanId: 1, rating: '2' } },
    ];
    expect(calcBeanRating(beans[0], shots, beans)).toEqual({ avg: 3, count: 2 });
  });

  it('does not count a mixed shot on the name-only fallback path either', () => {
    const shots = [{ annotation: MIX }];
    expect(calcBeanRating('Ethiopia Guji', shots, beans)).toBeNull();
  });
});
