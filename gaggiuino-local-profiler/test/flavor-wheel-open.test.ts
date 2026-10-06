import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

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
const { openFlavorWheel, closeFlavorWheel } = await import('../public-src/components/flavor-wheel.js');

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

  const startViewTransition = vi.fn();
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
    startViewTransition,
  };
  g.document = doc;
  // Motion allowed, so the old code would have taken its view-transition branch.
  g.window = { matchMedia: () => ({ matches: false }) };

  S.coffeeLibrary = { beans: [{ id: 1, name: 'Yirgacheffe Chelelektu', flavors: ['Jasmin'] }], grinders: [] };
  S.currentLang = 'en';
  return { doc, modal, insideMain, startViewTransition };
}

describe('flavour wheel open/close without View Transitions (#1482)', () => {
  beforeEach(() => {
    S.shots = [];
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the modal synchronously and moves it out of #main to <body>', async () => {
    const { doc, modal, insideMain, startViewTransition } = setup();
    // openFlavorWheel's synchronous prefix runs before the echarts chunk load;
    // the chart render is allowed to fail in this minimal DOM.
    const pending = openFlavorWheel(1).catch(() => {});

    // No view transition is requested (the fade is pure CSS), the overlay is
    // shown on this tick, and it moved out of #main to <body>.
    expect(startViewTransition).not.toHaveBeenCalled();
    expect(modal.parentElement).not.toBe(insideMain);
    expect(modal.parentElement).toBe(doc.body);
    expect(modal.style.display).toBe('flex');

    await pending;
  });

  it('closes without a view transition and hides after the fade', async () => {
    const { modal, startViewTransition } = setup();
    await openFlavorWheel(1).catch(() => {});

    closeFlavorWheel();

    expect(startViewTransition).not.toHaveBeenCalled();
    // The overlay stays visible while it fades out (class `is-closing`) and is
    // only hidden once the 140ms fade is over.
    expect(modal.classList.contains('is-closing')).toBe(true);
    expect(modal.style.display).toBe('flex');
    vi.advanceTimersByTime(140 + 60);
    expect(modal.style.display).toBe('none');
  });

  it('reopening during the close fade cancels it', async () => {
    const { modal } = setup();
    await openFlavorWheel(1).catch(() => {});

    closeFlavorWheel();
    expect(modal.classList.contains('is-closing')).toBe(true);

    await openFlavorWheel(1).catch(() => {});
    expect(modal.classList.contains('is-closing')).toBe(false);
    expect(modal.style.display).toBe('flex');
    // The cancelled close must not hide the modal behind the reopen.
    vi.advanceTimersByTime(140 + 60);
    expect(modal.style.display).toBe('flex');
  });
});

// #1452/#1482: the flavour wheel dropped its shared-element view transition —
// a view transition snapshots the whole page, which flashed on phones. Nothing
// in the frontend should call document.startViewTransition again.
describe('no View Transitions API left in public-src (#1452/#1482)', () => {
  it('does not mention startViewTransition anywhere in public-src', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'public-src');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (readFileSync(full, 'utf-8').includes('startViewTransition')) offenders.push(full);
      }
    };
    walk(root);
    expect(
      offenders,
      'the flavour wheel no longer uses the View Transitions API (#1452/#1482)',
    ).toEqual([]);
  });
});
