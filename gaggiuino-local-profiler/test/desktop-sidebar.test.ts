import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// #2056: on desktop the shot list is a Shots-page-only panel. It is open when
// Shots is entered (also after it was folded), a picked shot folds it away, and
// every other page hides it entirely. Nothing is stored, so a reload starts
// open. The click paths are exercised on a fake DOM, same minimal-node approach
// as test/bean-mix-display.test.ts (rows are built imperatively), with the
// `classList.toggle(token, force)` semantics of test/mode-switch-closes-sheet.test.ts.

const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
g.navigator ??= { language: 'en-US' };
g.window ??= globalThis;

const { S } = await import('../public-src/state/index.js');
const { renderSidebar, setDesktopSidebarCollapsed, toggleDesktopSidebar, selectShot } =
  await import('../public-src/components/sidebar.js');
const { switchMode, goToShot } = await import('../public-src/components/mode.js');

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
  onclick: ((e?: { ctrlKey?: boolean; metaKey?: boolean; stopPropagation?: () => void }) => void) | null;
  nextElementSibling: FakeNode | null;
  innerHTML: string;
  classList: {
    add: (...c: string[]) => void;
    remove: (...c: string[]) => void;
    contains: (c: string) => boolean;
    toggle: (c: string, force?: boolean) => void;
  };
  appendChild: (c: FakeNode) => FakeNode;
  setAttribute: () => void;
  addEventListener: () => void;
  closest: () => null;
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
      toggle: (c: string, force?: boolean) => {
        if (force === undefined ? classes.has(c) : !force) classes.delete(c);
        else classes.add(c);
      },
    },
    appendChild(c: FakeNode) {
      const prev = node.children[node.children.length - 1];
      if (prev) prev.nextElementSibling = c;
      c.nextElementSibling = null;
      node.children.push(c);
      return c;
    },
    setAttribute: () => {},
    addEventListener: () => {},
    closest: () => null,
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

// Every id switchMode() dereferences directly (btn* + #*-view), plus the
// sidebar elements under test.
const DIRECT_IDS = [
  'btnShots', 'btnLive', 'btnAnalytics', 'btnDialin', 'btnLibrary',
  'btnMaintenance', 'btnAchievements', 'btnOrders', 'btnSettings',
  'shots-view', 'live-view', 'analytics-view', 'dialin-view', 'library-view',
  'maintenance-view', 'achievements-view', 'orders-view', 'settings-view',
  'sidebar', 'expandSidebarBtn', 'collapseBtn',
];

let nodes: Record<string, FakeNode>;
let shotsEl: FakeNode;

function installDocument(): void {
  nodes = {};
  for (const id of DIRECT_IDS) nodes[id] = makeNode('div');
  shotsEl = makeNode('div');
  shotsEl.id = 'shots';
  nodes.shots = shotsEl;
  g.document = {
    createElement: makeNode,
    getElementById: (id: string) => nodes[id] ?? collect(shotsEl, n => n.id === id)[0] ?? null,
    querySelectorAll: (sel: string) => {
      if (sel.includes('.shot-wrapper')) return collect(shotsEl, n => n.classList.contains('shot-wrapper'));
      return [];
    },
    querySelector: () => null,
  };
}

function row(id: number): FakeNode {
  const wrapper = collect(shotsEl, n => n.id === `wrapper-${id}`)[0];
  if (wrapper === undefined) throw new Error(`missing wrapper ${id}`);
  return wrapper.children[0]!;
}

function click(id: number, mods: { ctrlKey: boolean; metaKey: boolean } = { ctrlKey: false, metaKey: false }): void {
  row(id).onclick?.({ ...mods, stopPropagation: () => {} });
}

const sidebar = (): FakeNode => nodes.sidebar!;
const expanded = (): boolean => nodes.expandSidebarBtn!.classList.contains('visible');
let updateView = vi.fn();

describe('desktop shot list (#2056)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    installDocument();
    const target = g.window as Record<string, unknown>;
    target.innerWidth = 1280;
    updateView = vi.fn();
    target.updateView = updateView;
    target.flushAutoSave = vi.fn();
    target.selectShot = selectShot;
    target.closeBeanSheet = vi.fn();
    target.closeFlavorWheel = vi.fn();
    S._expandedMonths = new Set();
    S.currentFilter = '';
    S.beanFilter = null;
    S.machines = [];
    S.currentSort = 'newest';
    S.sortAsc = false;
    S.coffeeLibrary = { beans: [], grinders: [] };
    S.currentMode = 'shots';
    S.primaryShotId = 1;
    S.compareShotId = null;
    const now = Math.floor(Date.now() / 1000);
    S.shots = [
      { id: 1, timestamp: now, profile: { name: 'Espresso' }, annotation: { coffee: 'Ethiopia Guji', beanId: 1 } },
      { id: 2, timestamp: now - 60, profile: { name: 'Espresso' }, annotation: { coffee: 'Brazil Santos', beanId: 2 } },
    ];
    renderSidebar();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('hides the shot list on every other page', () => {
    for (const mode of ['live', 'analytics', 'dialin', 'library', 'maintenance', 'achievements', 'orders', 'settings']) {
      switchMode(mode);
      expect(sidebar().style.display, mode).toBe('none');
      expect(expanded(), mode).toBe(false);
    }
  });

  it('opens the list when Shots is entered, also after it was folded', () => {
    setDesktopSidebarCollapsed(true);
    switchMode('library');
    switchMode('shots');
    expect(sidebar().style.display).toBe('');
    expect(sidebar().classList.contains('desktop-collapsed')).toBe(false);
    expect(expanded()).toBe(false);
  });

  it('a second click on the Shots tab opens the folded list again', () => {
    setDesktopSidebarCollapsed(true);
    switchMode('shots');
    expect(sidebar().classList.contains('desktop-collapsed')).toBe(false);
    expect(expanded()).toBe(false);
  });

  it('picking a shot in the list folds it away', () => {
    click(2);
    expect(sidebar().classList.contains('desktop-collapsed')).toBe(true);
    expect(expanded()).toBe(true);
    expect(S.primaryShotId).toBe(2);
    expect(updateView).toHaveBeenCalled();
  });

  it('a compare click keeps the list open', () => {
    S.primaryShotId = 1;
    click(2, { ctrlKey: true, metaKey: false });
    expect(sidebar().classList.contains('desktop-collapsed')).toBe(false);
    expect(S.compareShotId).toBe(2);
  });

  it('the expand button opens it again and the collapse button folds it', () => {
    click(2);
    toggleDesktopSidebar();
    expect(sidebar().classList.contains('desktop-collapsed')).toBe(false);
    expect(expanded()).toBe(false);
    toggleDesktopSidebar();
    expect(sidebar().classList.contains('desktop-collapsed')).toBe(true);
  });

  it('opening a shot from another page folds the list', () => {
    switchMode('dialin');
    goToShot(2);
    expect(S.currentMode).toBe('shots');
    expect(sidebar().style.display).toBe('');
    expect(sidebar().classList.contains('desktop-collapsed')).toBe(true);
    expect(expanded()).toBe(true);
    expect(S.primaryShotId).toBe(2);
  });

  it('the arrow keys keep the list as it is', () => {
    selectShot(2);
    expect(sidebar().classList.contains('desktop-collapsed')).toBe(false);
  });

  it('phones keep their drawer behaviour', () => {
    (g.window as unknown as Record<string, unknown>).innerWidth = 390;
    click(2);
    expect(sidebar().classList.contains('desktop-collapsed')).toBe(false);
    switchMode('library');
    expect(sidebar().style.display).toBe('none');
  });
});
