import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// #1543: the large flavour wheel ignored Escape. Same minimal fake-DOM
// approach as test/flavor-wheel-open.test.ts — stub echarts (no real 370 kB
// chunk / canvas) and the localStorage/navigator globals the import chain
// reads at module load.
vi.mock('echarts', () => ({
  init: () => ({ dispose: () => {}, setOption: () => {}, dispatchAction: () => {}, off: () => {}, on: () => {} }),
}));

const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };
g.navigator ??= { language: 'en-US' };

const { S } = await import('../public-src/state/index.js');
const { openFlavorWheel, wrapWheelLabel } = await import('../public-src/components/flavor-wheel.js');

class FakeEl {
  id = '';
  className = '';
  innerHTML = '';
  textContent = '';
  style: Record<string, string> = {};
  parentElement: FakeEl | null = null;
  classes = new Set<string>();
  classList = {
    add: (token: string): void => { this.classes.add(token); },
    remove: (token: string): void => { this.classes.delete(token); },
    contains: (token: string): boolean => this.classes.has(token),
  };
  setAttribute(): void {}
  removeAttribute(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
  closest(): FakeEl | null { return null; }
  querySelector(): FakeEl | null { return null; }
  querySelectorAll(): FakeEl[] { return []; }
  appendChild(child: FakeEl): FakeEl { child.parentElement = this; return child; }
}

// Fake document that also records the keydown listeners the wheel wires, so a
// test can dispatch Escape the way the browser would.
function setup() {
  const nodes: Record<string, FakeEl> = {};
  const listeners = new Map<string, Set<(e: unknown) => void>>();
  const make = (id: string): FakeEl => {
    const el = new FakeEl();
    el.id = id;
    nodes[id] = el;
    return el;
  };
  const modal = make('flavorWheelModal');
  const insideMain = new FakeEl();
  modal.parentElement = insideMain;
  make('flavorWheelTitle');
  make('flavorWheelUnmatched');
  make('flavorWheelCanvas');
  make('flavorWheelBreadcrumb');
  make('flavorWheelLegend');

  const body = new FakeEl();
  const doc = {
    body,
    getElementById: (id: string) => nodes[id] ?? null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => new FakeEl(),
    addEventListener: (type: string, handler: (e: unknown) => void): void => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)?.add(handler);
    },
    removeEventListener: (type: string, handler: (e: unknown) => void): void => {
      listeners.get(type)?.delete(handler);
    },
    contains: () => true,
    activeElement: null,
  };
  g.document = doc;
  g.window = { matchMedia: () => ({ matches: false }) };

  S.coffeeLibrary = { beans: [{ id: 1, name: 'Yirgacheffe Chelelektu', flavors: ['Jasmin'] }], grinders: [] };
  S.currentLang = 'en';

  const keydownCount = (): number => listeners.get('keydown')?.size ?? 0;
  const fireEscape = (): { preventDefault: ReturnType<typeof vi.fn>; stopPropagation: ReturnType<typeof vi.fn> } => {
    const event = { key: 'Escape', preventDefault: vi.fn(), stopPropagation: vi.fn() };
    for (const handler of [...(listeners.get('keydown') ?? [])]) handler(event);
    return event;
  };
  return { doc, modal, insideMain, keydownCount, fireEscape };
}

describe('flavour wheel Escape to close (#1543)', () => {
  beforeEach(() => {
    S.shots = [];
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('closes an open wheel on Escape and removes the listener', async () => {
    const { modal, keydownCount, fireEscape } = setup();
    await openFlavorWheel(1).catch(() => {});
    expect(keydownCount()).toBe(1);

    const event = fireEscape();
    expect(event.preventDefault).toHaveBeenCalled();
    // Closes the wheel (fade path) rather than the bean sheet underneath.
    expect(modal.classList.contains('is-closing')).toBe(true);
    // The listener is gone at once, so a second Escape does nothing.
    expect(keydownCount()).toBe(0);

    vi.advanceTimersByTime(140 + 60);
    expect(modal.style.display).toBe('none');
  });

  it('does nothing on Escape when no wheel is open', () => {
    const { modal, keydownCount, fireEscape } = setup();
    expect(keydownCount()).toBe(0);
    fireEscape();
    expect(modal.style.display).not.toBe('none');
    expect(keydownCount()).toBe(0);
  });
});

describe('large wheel label wrapping never splits a word (#1543)', () => {
  it('wraps "Säuerlich / Fermentiert" at the slash and keeps both words whole', () => {
    const layout = wrapWheelLabel('Säuerlich / Fermentiert', 64, 12);
    const lines = layout.text.split('\n');

    // Every line is a sequence of whole input words (the slash may ride along
    // at the end of one, but nothing is cut in half).
    const allowed = new Set(['Säuerlich', '/', 'Fermentiert']);
    for (const line of lines) {
      for (const token of line.split(' ')) expect(allowed.has(token)).toBe(true);
    }
    expect(lines.join(' ')).toBe('Säuerlich / Fermentiert');
    expect(lines.some(l => l.includes('Fermentiert'))).toBe(true);
    // A word that no longer fits shrinks the font instead of being broken.
    expect(layout.fontSize).toBeLessThanOrEqual(12);
    expect(layout.fontSize).toBeGreaterThanOrEqual(8);
  });

  it('shrinks a single over-long word instead of breaking it', () => {
    const word = 'Fermentiertextra';
    const layout = wrapWheelLabel(word, 64, 12);
    expect(layout.text).toBe(word);
    expect(layout.fontSize).toBeLessThan(12);
  });
});
