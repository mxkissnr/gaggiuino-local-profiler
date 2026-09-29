import { describe, it, expect, beforeEach } from 'vitest';
import { installFakeOptionDom } from './helpers/fake-option-dom.js';
import type { FakeOption, FakeSelect } from './helpers/fake-option-dom.js';

// Same module-load stubbing as bean-select-exhausted-stock.test.ts.
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };
g.navigator    ??= { language: 'en-US' };

const { S } = await import('../public-src/state/index.js');
const { t } = await import('../public-src/i18n.js');
const { _renderBeanSelect } = await import('../public-src/views/shots/annotation.js');

// fake-option-dom types each select's captured options as unknown[]; narrow
// them back to the FakeOption instances the render path actually created.
const optionsOf = (select: FakeSelect): FakeOption[] => (select.options ?? []) as FakeOption[];

let selectEl: FakeSelect;

beforeEach(() => {
  selectEl = installFakeOptionDom(['annCoffee']).annCoffee;
  S.shots = [];
});

function optionValues(): string[] {
  return optionsOf(selectEl).map(o => o.value);
}

// #1225: the bean picker classifies each bean from the server-computed
// remainingG, independent of which shots happen to be loaded in the browser
// (S.shots is empty here, yet the exhausted bean is still detected).
describe('_renderBeanSelect — server-computed remainingG (#1225)', () => {
  it('marks a bean with remainingG 0 exhausted and keeps the others in stock', () => {
    S.coffeeLibrary = {
      beans: [
        { id: 1, name: 'Exhausted Bean', remainingG: 0 },
        { id: 2, name: 'Tracked Bean', remainingG: 120 },
        { id: 3, name: 'Untracked Bean' },
      ],
    } as unknown as typeof S.coffeeLibrary;

    _renderBeanSelect(null, null);

    const opts = optionsOf(selectEl);
    const values = optionValues();
    // The exhausted bean stays selectable, after both in-stock beans, labelled Empty.
    expect(values).toContain('Exhausted Bean');
    expect(values.indexOf('Exhausted Bean')).toBeGreaterThan(values.indexOf('Tracked Bean'));
    expect(values.indexOf('Exhausted Bean')).toBeGreaterThan(values.indexOf('Untracked Bean'));
    expect(opts.find(o => o.value === 'Exhausted Bean')!.text).toBe(`Exhausted Bean (${t('lib_milk_empty')})`);
    // remainingG > 0 and a missing remainingG both count as in stock.
    expect(opts.find(o => o.value === 'Tracked Bean')!.text).toBe('Tracked Bean');
    expect(opts.find(o => o.value === 'Untracked Bean')!.text).toBe('Untracked Bean');
  });
});
