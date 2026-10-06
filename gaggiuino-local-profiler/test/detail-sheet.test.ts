import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// detail-sheet.js pulls in i18n.js/state.js, which read localStorage/navigator
// at module load time — the same minimal browser stubs the other component
// tests use.
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };
g.navigator ??= { language: 'en-US' };

const { openDetailSheet, closeDetailSheet } = await import('../public-src/components/detail-sheet.js');
const { html } = await import('../public-src/utils.js');

type KeyHandler = (e: KeyboardEvent) => void;

interface FakeClassList {
  add: (token: string) => void;
  remove: (token: string) => void;
  contains: (token: string) => boolean;
}

function makeClassList(): FakeClassList {
  const set = new Set<string>();
  return { add: (t) => { set.add(t); }, remove: (t) => { set.delete(t); }, contains: (t) => set.has(t) };
}

interface FakeHost {
  innerHTML: string;
  classList: FakeClassList;
  querySelector: (sel?: string) => unknown;
  style: Record<string, string>;
}

function makeHost(): FakeHost {
  return { innerHTML: '', classList: makeClassList(), querySelector: () => null, style: {} };
}

interface Dom {
  listeners: Record<string, KeyHandler[]>;
  bodyClasses: Set<string>;
}

function installDom(host: FakeHost, activeElement: unknown, desktop: boolean): Dom {
  const listeners: Record<string, KeyHandler[]> = {};
  const bodyClasses = new Set<string>();
  g.window = {
    matchMedia: (query: string) => ({ matches: query.includes('max-width') ? !desktop : desktop }),
    innerWidth: 1200,
    innerHeight: 800,
  };
  g.document = {
    getElementById: (id: string) => (id === 'detailSheet' ? host : undefined),
    body: {
      classList: {
        add: (t: string) => { bodyClasses.add(t); },
        remove: (t: string) => { bodyClasses.delete(t); },
        contains: (t: string) => bodyClasses.has(t),
      },
    },
    activeElement,
    contains: () => true,
    addEventListener: (type: string, fn: KeyHandler) => { (listeners[type] ||= []).push(fn); },
    removeEventListener: (type: string, fn: KeyHandler) => {
      const a = listeners[type];
      if (a) listeners[type] = a.filter(f => f !== fn);
    },
  };
  return { listeners, bodyClasses };
}

function pressEscape(listeners: Record<string, KeyHandler[]>): void {
  for (const fn of listeners.keydown || []) fn({ key: 'Escape', preventDefault: () => {} } as KeyboardEvent);
}

const anchor = { getBoundingClientRect: () => ({ right: 100, left: 50, top: 100, height: 20 }) } as unknown as HTMLElement;

describe('detail sheet (#1467)', () => {
  let host: FakeHost;
  beforeEach(() => { host = makeHost(); });
  // Reset the module's key-listener bookkeeping between tests.
  afterEach(() => { closeDetailSheet(); });

  it('renders the title, sub and body into #detailSheet as a modal dialog', () => {
    installDom(host, null, false);
    openDetailSheet({ title: '3 May 2026', sub: '4 Shots · Ø 88', body: html`<p class="body-marker">row</p>` });

    expect(host.innerHTML).toContain('3 May 2026');
    expect(host.innerHTML).toContain('4 Shots · Ø 88');
    expect(host.innerHTML).toContain('body-marker');
    expect(host.innerHTML).toContain('role="dialog"');
    expect(host.innerHTML).toContain('aria-modal="true"');
    expect(host.innerHTML).toContain('aria-labelledby="detailSheetTitle"');
    expect(host.classList.contains('open')).toBe(true);
  });

  it('closes on Escape and restores focus to the previously focused element', () => {
    const back = { focus: vi.fn() };
    const { listeners, bodyClasses } = installDom(host, back, false);
    openDetailSheet({ title: 'Day', body: html`` });
    expect(bodyClasses.has('lib-sheet-open')).toBe(true);

    pressEscape(listeners);

    expect(host.innerHTML).toBe('');
    expect(host.classList.contains('open')).toBe(false);
    expect(back.focus).toHaveBeenCalledTimes(1);
  });

  it('opening twice replaces the previous content', () => {
    installDom(host, null, false);
    openDetailSheet({ title: 'First', body: html`` });
    openDetailSheet({ title: 'Second', body: html`` });
    expect(host.innerHTML).toContain('Second');
    expect(host.innerHTML).not.toContain('First');
    expect(host.classList.contains('open')).toBe(true);
  });

  it('adds detail-pop on desktop with an anchor, but not on a phone', () => {
    installDom(host, null, true);
    openDetailSheet({ title: 'Day', body: html``, anchor });
    expect(host.innerHTML).toContain('detail-pop');

    const phone = makeHost();
    installDom(phone, null, false);
    openDetailSheet({ title: 'Day', body: html``, anchor });
    expect(phone.innerHTML).not.toContain('detail-pop');
  });

  it('treats a viewport point anchor as a zero-size rect at that point', () => {
    const sheet = {
      offsetWidth: 200,
      offsetHeight: 100,
      style: {} as Record<string, string>,
      querySelector: () => null,
    };
    host.querySelector = (sel?: string) => (sel === '.lib-sheet' ? sheet : null);
    installDom(host, null, true);
    openDetailSheet({ title: 'Point', body: html``, anchor: { x: 300, y: 200 } });
    expect(host.innerHTML).toContain('detail-pop');
    expect(sheet.style.left).toBe('312px'); // right edge (300) + 12
    expect(sheet.style.top).toBe('150px');  // 200 - height/2
  });
});
