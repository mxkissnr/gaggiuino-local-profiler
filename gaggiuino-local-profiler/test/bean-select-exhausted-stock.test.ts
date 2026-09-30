import { describe, it, expect, beforeEach } from 'vitest';
import { installFakeOptionDom } from './helpers/fake-option-dom.js';
import type { FakeOption, FakeSelect } from './helpers/fake-option-dom.js';

// Same module-load stubbing as bean-select-by-id.test.js.
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };
g.navigator    ??= { language: 'en-US' };

const { S } = await import('../public-src/state/index.js');
const { t } = await import('../public-src/i18n.js');
const { _renderBeanSelect } = await import('../public-src/views/shots/annotation.js');

// fake-option-dom types each select's captured options as unknown[]; narrow
// them back to the FakeOption instances the render path actually created.
const optionsOf = (select: FakeSelect): FakeOption[] => (select.options ?? []) as FakeOption[];

// installFakeOptionDom() returns a Record, so with noUncheckedIndexedAccess a
// looked-up id is possibly-undefined. The helper always installs the ids it is
// given, so make a miss fail loudly instead of asserting.
function at(selects: Record<string, FakeSelect>, id: string): FakeSelect {
  const el = selects[id];
  if (el === undefined) throw new Error(`fake select #${id} was not installed`);
  return el;
}

let selectEl: FakeSelect;

beforeEach(() => {
  selectEl = at(installFakeOptionDom(['annCoffee']), 'annCoffee');
  S.shots = [];
});

function optionValues(): string[] {
  return optionsOf(selectEl).map(o => o.value);
}

function selectedOption(): FakeOption {
  return optionsOf(selectEl).find(o => o.selected)!;
}

describe('_renderBeanSelect — exhausted (zero-stock) beans (#915, superseded by #933; classified from server remainingG by #1225)', () => {
  it('keeps a bean with zero remaining stock selectable, sorted after in-stock beans and labelled Empty (#933)', () => {
    S.coffeeLibrary = {
      beans: [
        { id: 1, name: 'Fresh Bean', remainingG: 250 },
        { id: 2, name: 'Empty Bean', remainingG: 0 },
      ],
    } as unknown as typeof S.coffeeLibrary;
    _renderBeanSelect(null, null);
    const values = optionValues();
    expect(values).toContain('Fresh Bean');
    expect(values).toContain('Empty Bean');
    expect(values.indexOf('Fresh Bean')).toBeLessThan(values.indexOf('Empty Bean'));
    expect(optionsOf(selectEl).find(o => o.value === 'Empty Bean')!.text).toBe(`Empty Bean (${t('lib_milk_empty')})`);
  });

  it('keeps a bean with untracked (no remainingG) stock, treating it as unlimited', () => {
    S.coffeeLibrary = { beans: [{ id: 1, name: 'Untracked Bean' }] } as unknown as typeof S.coffeeLibrary;
    _renderBeanSelect(null, null);
    expect(optionValues()).toContain('Untracked Bean');
  });

  it('keeps the already-selected bean visible even after it becomes exhausted', () => {
    S.coffeeLibrary = { beans: [{ id: 2, name: 'Empty Bean', remainingG: 0 }] } as unknown as typeof S.coffeeLibrary;
    _renderBeanSelect('Empty Bean', 2);
    const opt = selectedOption();
    expect(opt.value).toBe('Empty Bean');
    expect(opt.dataset.beanId).toBe(2);
  });
});
