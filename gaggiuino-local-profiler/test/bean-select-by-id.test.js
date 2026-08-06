import { describe, it, expect, beforeEach } from 'vitest';

// Same module-load stubbing as annotation-basket-puckscreen-save.test.js —
// annotation.js imports state.js, which reads localStorage/navigator at
// module load time.
globalThis.localStorage ??= { getItem: () => null, setItem: () => {} };
globalThis.navigator    ??= { language: 'en-US' };

const { S } = await import('../public-src/state.js');
const { _renderBeanSelect } = await import('../public-src/views/shots/annotation.js');

let selectEl;

beforeEach(() => {
  selectEl = { innerHTML: '' };
  globalThis.document = { getElementById: id => (id === 'annCoffee' ? selectEl : null) };
});

// Extracts the option string that has the selected attribute, from the HTML
// string _renderBeanSelect() wrote to selectEl.innerHTML.
function selectedOptionHtml() {
  return selectEl.innerHTML.split('<option').find(o => o.includes(' selected'));
}

describe('_renderBeanSelect — match by beanId, not just name (#654/#668 review)', () => {
  it('selects by beanId even when the given name is stale (bean renamed since)', () => {
    S.coffeeLibrary = { beans: [{ id: 7, name: 'Kenya AA (renamed)' }] };
    _renderBeanSelect('Kenya AA', 7); // "Kenya AA" no longer matches any current bean name
    const opt = selectedOptionHtml();
    expect(opt).toContain('value="Kenya AA (renamed)"');
    expect(opt).toContain('data-bean-id="7"');
  });

  it('falls back to matching by name when no beanId is given', () => {
    S.coffeeLibrary = { beans: [{ id: 7, name: 'Kenya AA' }] };
    _renderBeanSelect('Kenya AA', null);
    const opt = selectedOptionHtml();
    expect(opt).toContain('value="Kenya AA"');
    expect(opt).toContain('data-bean-id="7"');
  });

  it('falls back to matching by name when the given beanId no longer resolves (deleted bean)', () => {
    S.coffeeLibrary = { beans: [{ id: 7, name: 'Kenya AA' }] };
    _renderBeanSelect('Kenya AA', 999);
    const opt = selectedOptionHtml();
    expect(opt).toContain('value="Kenya AA"');
  });

  it('a fully unmatched stale name/id combination keeps the free-text option, with no data-bean-id (#456 preserved)', () => {
    S.coffeeLibrary = { beans: [{ id: 7, name: 'Kenya AA' }] };
    _renderBeanSelect('Deleted Bean', 999);
    const opt = selectedOptionHtml();
    expect(opt).toContain('value="Deleted Bean"');
    expect(opt).not.toContain('data-bean-id');
  });
});
