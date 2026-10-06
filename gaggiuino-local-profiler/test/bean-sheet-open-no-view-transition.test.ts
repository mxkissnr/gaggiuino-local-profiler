import { describe, it, expect, beforeEach, vi } from 'vitest';

// Same browser-global stubs as the other library tests: the state/i18n import
// chain reads localStorage/navigator at module load time.
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };
g.navigator ??= { language: 'en-US' };

const { S } = await import('../public-src/state/index.js');
const { openBeanSheet } = (await import('../public-src/views/library.js')) as unknown as {
  openBeanSheet: (id: number, onPainted?: () => void) => void;
};

interface FakeNode {
  id: string;
  className: string;
  innerHTML: string;
  querySelector: () => null;
  querySelectorAll: () => never[];
  classList: {
    add: (token: string) => void;
    remove: (token: string) => void;
    contains: (token: string) => boolean;
  };
  focus: () => void;
}

function makeNode(): FakeNode {
  const classes = new Set<string>();
  return {
    id: '', className: '', innerHTML: '',
    querySelector: () => null,
    querySelectorAll: () => [],
    classList: {
      add: (token: string) => { classes.add(token); },
      remove: (token: string) => { classes.delete(token); },
      contains: (token: string) => classes.has(token),
    },
    focus: () => {},
  };
}

// #1452: opening the bean sheet must not run a root view transition — with no
// view-transition-name on the sheet, the browser cross-faded a snapshot of the
// whole page, which looked like a full-screen reload. The sheet builds
// synchronously and its own `lib-sheet-enter` animation is the only transition.
describe('bean sheet open does not run a view transition (#1452)', () => {
  beforeEach(() => {
    S.shots = [];
    S.currentLang = 'en';
    S.coffeeLibrary = { beans: [{ id: 7, name: 'Kenya Nyeri', bags: [] }], grinders: [] };
  });

  it('builds the sheet synchronously without calling document.startViewTransition', () => {
    const startViewTransition = vi.fn();
    // Motion allowed, so the old code would have taken the view-transition
    // branch; the fix must skip it regardless.
    g.window = { matchMedia: () => ({ matches: false }) };
    const bodyClasses: string[] = [];
    const elements: Record<string, FakeNode> = { beanListUI: makeNode() };
    g.document = {
      getElementById: (id: string) => elements[id],
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: () => makeNode(),
      body: {
        classList: { add: (token: string) => { bodyClasses.push(token); }, remove: () => {} },
        appendChild: (el: FakeNode) => { elements[el.id] = el; },
      },
      activeElement: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      contains: () => true,
      startViewTransition,
    };
    const onPainted = vi.fn();

    openBeanSheet(7, onPainted);

    expect(startViewTransition).not.toHaveBeenCalled();
    // Painted on the same tick, not deferred behind a transition callback.
    expect(onPainted).toHaveBeenCalledTimes(1);
    const host = elements.beanSheet;
    expect(host).toBeDefined();
    expect(host.classList.contains('open')).toBe(true);
    expect(host.innerHTML).toContain('lib-sheet-enter');
    expect(bodyClasses).toContain('lib-sheet-open');
  });
});
