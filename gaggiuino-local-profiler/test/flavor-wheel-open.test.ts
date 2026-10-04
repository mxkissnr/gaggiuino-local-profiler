import { describe, it, expect, beforeEach, vi } from 'vitest';

// The open path only needs the chart to initialize; stub echarts so the test
// neither downloads the real 370 kB chunk nor depends on a real canvas.
vi.mock('echarts', () => ({
  init: () => ({ dispose: () => {}, setOption: () => {}, dispatchAction: () => {}, off: () => {}, on: () => {} }),
}));

// flavor-wheel.js's import chain reads localStorage/navigator at module load —
// stub the minimum browser globals (same pattern as the other frontend tests).
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };
g.navigator ??= { language: 'en-US' };

const { S } = await import('../public-src/state/index.js');
const { openFlavorWheel, shouldGrowWheelFrom } = await import('../public-src/components/flavor-wheel.js');

class FakeEl {
  id = '';
  className = '';
  innerHTML = '';
  textContent = '';
  style: Record<string, string> = {};
  parentElement: FakeEl | null = null;
  setAttribute(): void {}
  removeAttribute(): void {}
  addEventListener(): void {}
  querySelector(): FakeEl | null { return null; }
  querySelectorAll(): FakeEl[] { return []; }
  appendChild(child: FakeEl): FakeEl { child.parentElement = this; return child; }
}

function setup() {
  const nodes: Record<string, FakeEl> = {};
  const make = (id: string): FakeEl => {
    const el = new FakeEl();
    el.id = id;
    nodes[id] = el;
    return el;
  };
  const modal = make('flavorWheelModal');
  const insideMain = new FakeEl(); // the overlay starts inside #main in index.html
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
    querySelector: () => null, // no small wheel in the sheet -> direct open
    querySelectorAll: () => [],
    createElement: () => new FakeEl(),
    addEventListener: () => {},
    removeEventListener: () => {},
    contains: () => true,
    activeElement: null,
  };
  g.document = doc;

  S.coffeeLibrary = { beans: [{ id: 1, name: 'Yirgacheffe Chelelektu', flavors: ['Jasmin'] }] };
  S.currentLang = 'en';
  return { doc, modal, insideMain };
}

describe('flavour wheel open without View Transitions (#1374)', () => {
  beforeEach(() => {
    S.shots = [];
  });

  it('shows the modal directly and moves it out of #main to <body>', async () => {
    const { doc, modal, insideMain } = setup();
    // openFlavorWheel's synchronous prefix runs before the echarts chunk load;
    // the chart render is allowed to fail in this minimal DOM.
    const pending = openFlavorWheel(1).catch(() => {});

    expect(modal.parentElement).not.toBe(insideMain);
    expect(modal.parentElement).toBe(doc.body);
    expect(modal.style.display).toBe('flex');

    await pending;
  });

  it('calls for a transition only with View Transitions, motion allowed and a small wheel', () => {
    expect(shouldGrowWheelFrom(true, true, true)).toBe(true);
    expect(shouldGrowWheelFrom(false, true, true)).toBe(false);
    expect(shouldGrowWheelFrom(true, false, true)).toBe(false);
    expect(shouldGrowWheelFrom(true, true, false)).toBe(false);
  });
});
