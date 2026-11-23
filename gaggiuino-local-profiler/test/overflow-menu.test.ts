// #2165: one behaviour for every overflow menu in the shared pattern.
// Node environment, no DOM library: the menus, their lists and the document
// are hand-built fakes, styled after the deleted topbar-nav-fade test.
import { describe, it, expect, vi } from 'vitest';
import type { Mock } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { placeOverflowMenu, wireOverflowMenus } from '../public-src/components/overflow-menu.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(join(here, '../public-src', rel), 'utf8');

const g = globalThis as unknown as Record<string, unknown>;
const MENU = 'details.lib-sheet-more';
const UP = 'lib-sheet-menu-list--up';

interface FakeList {
  classList: { add: (c: string) => void; remove: (c: string) => void; contains: (c: string) => boolean };
  getBoundingClientRect: () => { bottom: number };
}

interface FakeSummary { focus: Mock }

interface FakeItem { closest: (s: string) => unknown }

interface FakeMenu {
  open: boolean;
  matches: (s: string) => boolean;
  contains: (n: unknown) => boolean;
  querySelector: (s: string) => unknown;
  summary: FakeSummary;
  list: FakeList;
  item: FakeItem;
}

function makeList(bottom: number): FakeList {
  const classes = new Set<string>();
  return {
    classList: {
      add: (c: string) => { classes.add(c); },
      remove: (c: string) => { classes.delete(c); },
      contains: (c: string) => classes.has(c),
    },
    getBoundingClientRect: () => ({ bottom }),
  };
}

function makeMenu(over: { open?: boolean; bottom?: number } = {}): FakeMenu {
  const summary: FakeSummary = { focus: vi.fn() };
  const list = makeList(over.bottom ?? 100);
  const item: FakeItem = {
    closest: (s: string) => (s === '.lib-sheet-menu-item' ? item : s === MENU ? menu : null),
  };
  const menu: FakeMenu = {
    open: over.open ?? true,
    matches: (s: string) => s === MENU,
    contains: (n: unknown) => n === menu || n === list || n === item || n === summary,
    querySelector: (s: string) => (s === 'summary' ? summary : s === '.lib-sheet-menu-list' ? list : null),
    summary,
    list,
    item,
  };
  return menu;
}

type Listener = (e: unknown) => void;

function installDom(menus: () => FakeMenu[]) {
  const listeners = new Map<string, Listener[]>();
  const document = {
    addEventListener: (type: string, fn: Listener, capture?: boolean) => {
      expect(capture).toBe(true);
      const list = listeners.get(type) ?? [];
      list.push(fn);
      listeners.set(type, list);
    },
    querySelectorAll: (sel: string) => (sel === `${MENU}[open]` ? menus().filter(m => m.open) : []),
    activeElement: null as unknown,
  };
  g.document = document;
  g.window = { innerHeight: 800 };
  const fire = (type: string, ev: unknown): void => {
    for (const fn of listeners.get(type) ?? []) fn(ev);
  };
  return { document, fire };
}

describe('overflow menu behaviour (#2165)', () => {
  it('keeps one menu open: opening a menu closes the other', () => {
    const a = makeMenu({ open: true });
    const b = makeMenu({ open: false });
    const { fire } = installDom(() => [a, b]);
    wireOverflowMenus();

    b.open = true;
    fire('toggle', { target: b });

    expect(a.open).toBe(false);
    expect(b.open).toBe(true);
  });

  it('opens the list upward only when it would end below the window', () => {
    const below = makeMenu({ bottom: 900 });
    placeOverflowMenu(below as unknown as HTMLDetailsElement, 800);
    expect(below.list.classList.contains(UP)).toBe(true);

    const above = makeMenu({ bottom: 500 });
    above.list.classList.add(UP);
    placeOverflowMenu(above as unknown as HTMLDetailsElement, 800);
    expect(above.list.classList.contains(UP)).toBe(false);
  });

  it('closes the menu after a pick and keeps the focus on its summary', () => {
    const menu = makeMenu({ open: true });
    const { document, fire } = installDom(() => [menu]);
    wireOverflowMenus();
    document.activeElement = menu.item;

    fire('click', { target: menu.item });

    expect(menu.open).toBe(false);
    expect(menu.summary.focus).toHaveBeenCalledTimes(1);
  });

  it('closes on a press outside and stays open on a press inside', () => {
    const menu = makeMenu({ open: true });
    const { fire } = installDom(() => [menu]);
    wireOverflowMenus();

    fire('pointerdown', { target: menu.item });
    expect(menu.open).toBe(true);

    fire('pointerdown', { target: { outside: true } });
    expect(menu.open).toBe(false);
  });

  it('Escape closes the open menu, focuses its summary and stops the event', () => {
    const menu = makeMenu({ open: true });
    const { fire } = installDom(() => [menu]);
    wireOverflowMenus();
    const ev = { key: 'Escape', preventDefault: vi.fn(), stopPropagation: vi.fn() };

    fire('keydown', ev);

    expect(menu.open).toBe(false);
    expect(menu.summary.focus).toHaveBeenCalledTimes(1);
    expect(ev.preventDefault).toHaveBeenCalledTimes(1);
    expect(ev.stopPropagation).toHaveBeenCalledTimes(1);
  });

  it('leaves Escape alone when no menu is open', () => {
    const menu = makeMenu({ open: false });
    const { fire } = installDom(() => [menu]);
    wireOverflowMenus();

    const escape = { key: 'Escape', preventDefault: vi.fn(), stopPropagation: vi.fn() };
    fire('keydown', escape);
    expect(escape.preventDefault).not.toHaveBeenCalled();
    expect(escape.stopPropagation).not.toHaveBeenCalled();

    menu.open = true;
    fire('keydown', { key: 'Enter', preventDefault: vi.fn(), stopPropagation: vi.fn() });
    expect(menu.open).toBe(true);
  });

  it("is wired once at boot and replaces the settings page's own fold", () => {
    const delegation = read('boot/delegation.ts');
    expect(delegation.split('wireOverflowMenus();').length - 1).toBe(1);

    const settingsPage = read('boot/settings-page.ts');
    expect(settingsPage).not.toContain('#settingsMore .lib-sheet-menu-item');
  });
});
