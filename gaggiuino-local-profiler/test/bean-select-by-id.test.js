import { describe, it, expect, beforeEach } from 'vitest';
import { installFakeOptionDom } from './helpers/fake-option-dom.js';

// Same module-load stubbing as annotation-basket-puckscreen-save.test.js —
// annotation.js imports state.js, which reads localStorage/navigator at
// module load time.
globalThis.localStorage ??= { getItem: () => null, setItem: () => {} };
globalThis.navigator    ??= { language: 'en-US' };

const { S } = await import('../public-src/state.js');
const { _renderBeanSelect } = await import('../public-src/views/shots/annotation.js');

let selectEl;

beforeEach(() => {
  selectEl = installFakeOptionDom(['annCoffee']).annCoffee;
});

// The single option _renderBeanSelect() marked selected (#946: option
// objects now, not an HTML string).
function selectedOption() {
  return selectEl.options.find(o => o.selected);
}

describe('_renderBeanSelect — match by beanId, not just name (#654/#668 review)', () => {
  it('selects by beanId even when the given name is stale (bean renamed since)', () => {
    S.coffeeLibrary = { beans: [{ id: 7, name: 'Kenya AA (renamed)' }] };
    _renderBeanSelect('Kenya AA', 7); // "Kenya AA" no longer matches any current bean name
    const opt = selectedOption();
    expect(opt.value).toBe('Kenya AA (renamed)');
    expect(opt.dataset.beanId).toBe(7);
  });

  it('falls back to matching by name when no beanId is given', () => {
    S.coffeeLibrary = { beans: [{ id: 7, name: 'Kenya AA' }] };
    _renderBeanSelect('Kenya AA', null);
    const opt = selectedOption();
    expect(opt.value).toBe('Kenya AA');
    expect(opt.dataset.beanId).toBe(7);
  });

  it('falls back to matching by name when the given beanId no longer resolves (deleted bean)', () => {
    S.coffeeLibrary = { beans: [{ id: 7, name: 'Kenya AA' }] };
    _renderBeanSelect('Kenya AA', 999);
    expect(selectedOption().value).toBe('Kenya AA');
  });

  it('a fully unmatched stale name/id combination keeps the free-text option, with no data-bean-id (#456 preserved)', () => {
    S.coffeeLibrary = { beans: [{ id: 7, name: 'Kenya AA' }] };
    _renderBeanSelect('Deleted Bean', 999);
    const opt = selectedOption();
    expect(opt.value).toBe('Deleted Bean');
    expect(opt.dataset.beanId).toBeUndefined();
  });
});
