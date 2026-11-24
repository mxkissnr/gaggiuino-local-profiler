import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// #2119: the bean comparison reachable from the library: the sheet's menu
// entry, the click delegation, the page host and its layout rules, and the
// library re-render that closes a page whose bean is gone.
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };
g.navigator ??= { language: 'en-US' };
g.window = {
  calcShotScore: (shot: { score?: number | null }) => shot.score ?? null,
  matchMedia: () => ({ matches: true }),
};

const { S } = await import('../public-src/state/index.js');
interface LibraryModule {
  openBeanSheet: (id: number) => void;
  renderBeanList: () => void;
  startBeanCompare: (id: number) => void;
  chooseBeanCompare: (id: number) => void;
  beanCompareOpen: () => boolean;
}
const library = (await import('../public-src/views/library.js')) as unknown as LibraryModule;

const SRC = join(import.meta.dirname, '..', 'public-src');
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8');

class FakeEl {
  id = '';
  className = '';
  innerHTML = '';
  hidden = false;
  scrollTop = 0;
  value = '';
  readonly attrs = new Map<string, string>();
  readonly classList = {
    add: (_c: string): void => {},
    remove: (_c: string): void => {},
    contains: (_c: string): boolean => false,
    toggle: (_c: string, _on?: boolean): boolean => false,
  };
  querySelector(_s: string): null { return null; }
  querySelectorAll(_s: string): FakeEl[] { return []; }
  setAttribute(name: string, value: string): void { this.attrs.set(name, value); }
  removeAttribute(name: string): void { this.attrs.delete(name); }
  hasAttribute(name: string): boolean { return this.attrs.has(name); }
  addEventListener(): void { /* no-op */ }
  removeEventListener(): void { /* no-op */ }
  focus(): void { /* no-op */ }
}

const ALPHA = { id: 1, name: 'Alpha Ethiopia', bags: [] };
const BETA = { id: 2, name: 'Beta Kenya', bags: [] };

let host = new FakeEl();
let elements: Record<string, FakeEl> = {};

function setup(beans: Record<string, unknown>[]): void {
  host = new FakeEl();
  host.hidden = true;
  elements = { 'library-view': new FakeEl(), libCompare: host, beanListUI: new FakeEl() };
  g.document = {
    getElementById: (id: string) => elements[id] ?? null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => new FakeEl(),
    body: {
      classList: { add: () => {}, remove: () => {} },
      appendChild: (el: FakeEl) => { elements[el.id] = el; },
    },
    activeElement: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    contains: () => true,
  };
  S.currentLang = 'en';
  S.shots = [];
  S.coffeeLibrary = { beans, grinders: [] };
}

describe('bean comparison wiring (#2119)', () => {
  it('the bean sheet menu offers Compare once the library has a second bean', () => {
    setup([ALPHA, BETA]);
    library.openBeanSheet(1);
    expect(elements.beanSheet?.innerHTML).toContain('data-action="compare-bean"');

    setup([ALPHA]);
    library.openBeanSheet(1);
    expect(elements.beanSheet?.innerHTML).not.toContain('data-action="compare-bean"');
  });

  it('a library re-render closes the page when one of its beans is gone', () => {
    setup([ALPHA, BETA]);
    library.startBeanCompare(1);
    library.chooseBeanCompare(2);
    expect(library.beanCompareOpen()).toBe(true);
    expect(host.hidden).toBe(false);

    S.coffeeLibrary = { beans: [ALPHA], grinders: [] };
    library.renderBeanList();
    expect(library.beanCompareOpen()).toBe(false);
    expect(host.hidden).toBe(true);
  });

  it('routes the five compare actions through the click delegation', () => {
    const src = read('boot/delegation.ts');
    for (const action of ['compare-bean', 'compare-pick-bean', 'compare-pick-other', 'compare-swap', 'compare-back']) {
      expect(src).toContain(`case '${action}':`);
    }
    expect(src).toContain("case 'compare-bean':       closeBeanSheet(); startBeanCompare(numId()); break;");
  });

  it('hosts the page in the library and hides the tabs and lists while it is open', () => {
    expect(read('index.html')).toContain('<div id="libCompare" class="lib-compare" hidden></div>');
    expect(read('style.css')).toContain('#library-view[data-compare] .lib-tabs, #library-view[data-compare] .lib-body { display: none; }');
  });
});
