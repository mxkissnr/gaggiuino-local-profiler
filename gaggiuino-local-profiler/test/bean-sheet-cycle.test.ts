// #1479: bean-sheet.ts and views/library.ts import each other. In the bundle
// bean-sheet's module body can run before library.ts finishes initialising, so
// copying the library namespace into a module-level alias captures it while it
// is still undefined and every sheet render then throws on the first call. The
// namespace is safe only when dereferenced inside a function, at call time.
//
// This imports bean-sheet before the library view in a fresh module graph and
// then renders a sheet. renderBeanSheet ends by calling
// libraryView.loadBeanThumbnails() through the namespace binding, so a
// namespace that were undefined at call time would throw here.
import { describe, expect, it, vi } from 'vitest';

const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
g.navigator ??= { language: 'en-US' };
g.window ??= g;

interface FakeDoc {
  getElementById: (id: string) => FakeEl | null;
  createElement: () => FakeEl;
  querySelectorAll: () => FakeEl[];
  addEventListener: () => void;
  removeEventListener: () => void;
  contains: () => boolean;
  activeElement: null;
  body: FakeEl;
}

class FakeEl {
  id = '';
  innerHTML = '';
  textContent = '';
  className = '';
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  open = false;
  scrollTop = 0;
  readonly classList = {
    add: (_name: string): void => {},
    remove: (_name: string): void => {},
    contains: (_name: string): boolean => false,
    toggle: (_name: string, _on?: boolean): boolean => false,
  };
  addEventListener(_type: string, _fn: (...args: unknown[]) => void): void { /* no-op */ }
  removeEventListener(_type: string, _fn: (...args: unknown[]) => void): void { /* no-op */ }
  appendChild(_child: FakeEl): void { /* no-op */ }
  setAttribute(_name: string, _value: string): void { /* no-op */ }
  removeAttribute(_name: string): void { /* no-op */ }
  remove(): void { /* no-op */ }
  focus(): void { /* no-op */ }
  querySelector(_selector: string): null { return null; }
  querySelectorAll(): FakeEl[] { return []; }
}

function makeDocument(): { doc: FakeDoc; host: FakeEl } {
  const host = new FakeEl();
  host.id = 'beanSheet';
  const doc: FakeDoc = {
    getElementById: (id: string) => (id === 'beanSheet' ? host : null),
    createElement: () => new FakeEl(),
    querySelectorAll: () => [],
    addEventListener: () => {},
    removeEventListener: () => {},
    contains: () => true,
    activeElement: null,
    body: new FakeEl(),
  };
  return { doc, host };
}

describe('bean sheet / library import cycle (#1479)', () => {
  it('imports bean-sheet first, then the library view, and renders a sheet', async () => {
    vi.resetModules();
    const { doc, host } = makeDocument();
    g.document = doc;

    // bean-sheet before the library view — the order that exposes a module-level
    // namespace alias captured before library.ts has initialised.
    const beanSheet = await import('../public-src/views/library/bean-sheet.js');
    const library = await import('../public-src/views/library.js');

    const { S } = await import('../public-src/state/index.js');
    S.coffeeLibrary = {
      beans: [{ id: 7, name: 'Bean A', roaster: 'Roaster', enabled: true, bags: [], image: null }],
      recipes: [], milks: [], baskets: [], puckScreens: [],
    } as unknown as typeof S.coffeeLibrary;

    // renderBeanSheet dereferences libraryView.loadBeanThumbnails() at call
    // time; if the namespace were an undefined module-level alias this throws.
    expect(() => beanSheet.openBeanSheet(7)).not.toThrow();
    expect(host.innerHTML).not.toBe('');
    expect(typeof library.loadBeanThumbnails).toBe('function');
  });
});
