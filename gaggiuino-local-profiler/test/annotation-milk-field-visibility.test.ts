import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// annotation.js imports state.js, which reads localStorage/navigator at
// module load time — same stubbing approach as annotation-select-dom.test.ts.
// vitest's node environment has no browser globals; stub them through a loose
// view of globalThis (the same bridge test/helpers/fake-option-dom.ts uses).
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };
g.navigator    ??= { language: 'en-US' };

const { S } = await import('../public-src/state/index.js');
const {
  _renderDrinkPills,
  _updateMilkFieldVisibility,
  selectDrinkType,
  selectMilkType,
} = await import('../public-src/views/shots/annotation.js');

// The annotation view reads/writes these nodes; a plain object per id stands
// in for the real element (style.display for the field, .value for the two
// hidden inputs, innerHTML for the pill containers the render helpers fill).
interface FakeEl { value?: string; innerHTML?: string; style: { display?: string } }

let els: Record<string, FakeEl>;

function el(id: string): FakeEl {
  const node = els[id];
  if (!node) throw new Error(`no fake element: ${id}`);
  return node;
}

beforeEach(() => {
  // selectDrinkType/selectMilkType schedule a debounced autosave; fake timers
  // keep that save from firing (and hitting the unstubbed DOM) after teardown.
  vi.useFakeTimers();
  els = {
    milkTypeField:       { value: '', innerHTML: '', style: {} },
    annDrinkType:        { value: '', innerHTML: '', style: {} },
    annMilkType:         { value: '', innerHTML: '', style: {} },
    drinkPillsContainer: { value: '', innerHTML: '', style: {} },
    milkPillsContainer:  { value: '', innerHTML: '', style: {} },
  };
  g.document = { getElementById: (id: string) => els[id] ?? null };
  S.drinkMenu = [
    { id: 'latte',    name: 'Latte',      milkMl: 150 },
    { id: 'flat',     name: 'Flat White', milkMl: 0 },
    { id: 'espresso', name: 'Espresso' },
  ];
  S.milkTypes = [{ id: 1, name: 'Whole' }, { id: 2, name: 'Oat' }];
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('#1453 milk field visibility follows the chosen drink', () => {
  it('shows the field when the drink uses milk and milk types exist', () => {
    el('annDrinkType').value = 'latte';
    _updateMilkFieldVisibility();
    expect(el('milkTypeField').style.display).toBe('');
  });

  it('hides the field for a drink with milkMl: 0', () => {
    el('annDrinkType').value = 'flat';
    _updateMilkFieldVisibility();
    expect(el('milkTypeField').style.display).toBe('none');
  });

  it('hides the field for a drink with no milkMl', () => {
    el('annDrinkType').value = 'espresso';
    _updateMilkFieldVisibility();
    expect(el('milkTypeField').style.display).toBe('none');
  });

  it('hides the field when no drink is selected', () => {
    el('annDrinkType').value = '';
    _updateMilkFieldVisibility();
    expect(el('milkTypeField').style.display).toBe('none');
  });

  it('hides the field and clears the milk selection when switching to a milk-free drink', () => {
    _renderDrinkPills('latte');
    _updateMilkFieldVisibility();
    expect(el('milkTypeField').style.display).toBe('');

    selectMilkType('1');
    expect(el('annMilkType').value).toBe('1');

    selectDrinkType('espresso');

    expect(el('annDrinkType').value).toBe('espresso');
    expect(el('milkTypeField').style.display).toBe('none');
    expect(el('annMilkType').value).toBe('');
  });
});
