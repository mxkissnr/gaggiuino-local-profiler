import { describe, it, expect, beforeEach } from 'vitest';
import { installFakeOptionDom } from './helpers/fake-option-dom.js';

// Same module-load stubbing as bean-select-by-id.test.js.
globalThis.localStorage ??= { getItem: () => null, setItem: () => {} };
globalThis.navigator    ??= { language: 'en-US' };

const { S } = await import('../public-src/state.js');
const { t } = await import('../public-src/i18n.js');
const { _renderBeanSelect } = await import('../public-src/views/shots/annotation.js');

let selectEl;

beforeEach(() => {
  selectEl = installFakeOptionDom(['annCoffee']).annCoffee;
  S.shots = [];
});

function optionValues() {
  return selectEl.options.map(o => o.value);
}

function selectedOption() {
  return selectEl.options.find(o => o.selected);
}

describe('_renderBeanSelect — exhausted (zero-stock) beans (#915, superseded by #933)', () => {
  it('keeps a bean with zero remaining stock selectable, sorted after in-stock beans and labelled Empty (#933)', () => {
    S.coffeeLibrary = {
      beans: [
        { id: 1, name: 'Fresh Bean', stock_g: 250 },
        { id: 2, name: 'Empty Bean', stock_g: 100 },
      ],
    };
    // Empty Bean fully consumed via one annotated dose.
    S.shots = [{ id: 1, timestamp: 1000, annotation: { coffee: 'Empty Bean', beanId: 2, dose: 100 } }];
    _renderBeanSelect(null, null);
    const values = optionValues();
    expect(values).toContain('Fresh Bean');
    expect(values).toContain('Empty Bean');
    expect(values.indexOf('Fresh Bean')).toBeLessThan(values.indexOf('Empty Bean'));
    expect(selectEl.options.find(o => o.value === 'Empty Bean').text).toBe(`Empty Bean (${t('lib_milk_empty')})`);
  });

  it('keeps a bean with untracked (no stock_g) stock, treating it as unlimited', () => {
    S.coffeeLibrary = { beans: [{ id: 1, name: 'Untracked Bean' }] };
    _renderBeanSelect(null, null);
    expect(optionValues()).toContain('Untracked Bean');
  });

  it('keeps the already-selected bean visible even after it becomes exhausted', () => {
    S.coffeeLibrary = { beans: [{ id: 2, name: 'Empty Bean', stock_g: 100 }] };
    S.shots = [{ id: 1, timestamp: 1000, annotation: { coffee: 'Empty Bean', beanId: 2, dose: 100 } }];
    _renderBeanSelect('Empty Bean', 2);
    const opt = selectedOption();
    expect(opt.value).toBe('Empty Bean');
    expect(opt.dataset.beanId).toBe(2);
  });
});
