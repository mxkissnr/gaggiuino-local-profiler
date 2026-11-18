// #2118: a chip edit changes no form field, so the chips module tells the bean
// form with a bubbling change event — the same signal a committed field sends.
// The node test env has no DOM, so these fakes stand in for the four elements
// the module touches and record every event it dispatches.
import { describe, it, expect, beforeEach, vi } from 'vitest';

interface FakeElement {
  readonly id: string;
  value: string;
  innerHTML: string;
  className: string;
  readonly dispatched: Array<{ type: string; bubbles: boolean }>;
  addEventListener(type: string, fn: (e: unknown) => void): void;
  dispatchEvent(e: { type: string; bubbles?: boolean }): boolean;
  querySelectorAll(): unknown[];
  insertBefore(): void;
  appendChild(): void;
  remove(): void;
  fire(type: string, e: unknown): void;
}

const fake = vi.hoisted(() => {
  const els = new Map<string, FakeElement>();
  function make(id: string): FakeElement {
    const listeners = new Map<string, Array<(e: unknown) => void>>();
    const dispatched: Array<{ type: string; bubbles: boolean }> = [];
    return {
      id,
      value: '',
      innerHTML: '',
      className: '',
      dispatched,
      addEventListener(type: string, fn: (e: unknown) => void): void {
        const list = listeners.get(type) ?? [];
        list.push(fn);
        listeners.set(type, list);
      },
      dispatchEvent(e: { type: string; bubbles?: boolean }): boolean {
        dispatched.push({ type: e.type, bubbles: e.bubbles === true });
        return true;
      },
      querySelectorAll: () => [],
      insertBefore: () => {},
      appendChild: () => {},
      remove: () => {},
      fire(type: string, e: unknown): void {
        for (const fn of listeners.get(type) ?? []) fn(e);
      },
    };
  }
  return {
    get(id: string): FakeElement {
      const existing = els.get(id);
      if (existing) return existing;
      const el = make(id);
      els.set(id, el);
      return el;
    },
    reset(): void { els.clear(); },
  };
});

vi.mock('../public-src/views/library/bean-shared.js', () => ({
  _field: (id: string) => fake.get(id),
  _el: (id: string) => fake.get(id),
}));

type Chips = typeof import('../public-src/views/library/bean-form-chips.js');

// Fresh module instance per test so the module's _bound flags and working
// arrays start empty.
async function load(): Promise<Chips> {
  vi.resetModules();
  return import('../public-src/views/library/bean-form-chips.js');
}

const g = globalThis as unknown as Record<string, unknown>;
const CHANGE = [{ type: 'change', bubbles: true }];

beforeEach(() => {
  fake.reset();
  let created = 0;
  g.document = { createElement: () => fake.get(`chip-${String(created++)}`) };
});

describe('bean form chips notify the form of a chip edit (#2118)', () => {
  it('a committed aroma dispatches exactly one bubbling change', async () => {
    const mod = await load();
    const input = fake.get('beanFormFlavorInput');
    mod.bindFlavorInput();

    input.value = 'Kirsche';
    input.fire('keydown', { key: 'Enter', preventDefault: () => {} });

    expect(input.dispatched).toEqual(CHANGE);
    expect(mod.formFlavors()).toEqual(['Kirsche']);
  });

  it('an empty or duplicate aroma dispatches nothing', async () => {
    const mod = await load();
    const input = fake.get('beanFormFlavorInput');
    mod.bindFlavorInput();

    input.value = '   ';
    input.fire('keydown', { key: 'Enter', preventDefault: () => {} });
    expect(input.dispatched).toEqual([]);

    input.value = 'Kirsche';
    input.fire('keydown', { key: 'Enter', preventDefault: () => {} });
    input.dispatched.length = 0;

    input.value = 'kirsche';
    input.fire('keydown', { key: 'Enter', preventDefault: () => {} });
    expect(input.dispatched).toEqual([]);
    expect(mod.formFlavors()).toEqual(['Kirsche']);
  });

  it('removing an aroma with its remove button dispatches one bubbling change', async () => {
    const mod = await load();
    const wrap = fake.get('beanFormFlavorChips');
    mod.setFormFlavors(['a', 'b']);
    mod.bindFlavorInput();

    const btn = { dataset: { flavorIdx: '0' } };
    wrap.fire('click', { target: { closest: (sel: string) => (sel === '.flavor-chip-x' ? btn : null) } });

    expect(wrap.dispatched).toEqual(CHANGE);
    expect(mod.formFlavors()).toEqual(['b']);
  });

  it('Backspace on an empty aroma input dispatches one bubbling change', async () => {
    const mod = await load();
    const input = fake.get('beanFormFlavorInput');
    mod.setFormFlavors(['a']);
    mod.bindFlavorInput();

    input.value = '';
    input.fire('keydown', { key: 'Backspace', preventDefault: () => {} });

    expect(input.dispatched).toEqual(CHANGE);
    expect(mod.formFlavors()).toEqual([]);
  });

  it('removing an origin chip dispatches one bubbling change', async () => {
    const mod = await load();
    const wrap = fake.get('beanFormOriginChips');
    mod.setFormOrigins({ origins: [{ code: 'BR' }] });
    mod.bindOriginInput();

    const btn = { dataset: { originIdxRemove: '0' } };
    wrap.fire('click', { target: { closest: (sel: string) => (sel === '[data-origin-idx-remove]' ? btn : null) } });

    expect(wrap.dispatched).toEqual(CHANGE);
    expect(mod.formOrigins()).toEqual([]);
  });

  it('programmatic prefill stays silent', async () => {
    const mod = await load();

    mod.setFormFlavors(['a', 'b']);
    mod.setFormOrigins({ origins: [{ code: 'BR', percent: 60 }] });

    expect(fake.get('beanFormFlavorInput').dispatched).toEqual([]);
    expect(fake.get('beanFormFlavorChips').dispatched).toEqual([]);
    expect(fake.get('beanFormOrigin').dispatched).toEqual([]);
    expect(fake.get('beanFormOriginChips').dispatched).toEqual([]);
  });
});
