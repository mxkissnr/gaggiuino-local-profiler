import { describe, it, expect, beforeEach } from 'vitest';
import { installFakeOptionDom } from './helpers/fake-option-dom.js';

// #946: the annotation library <select>s are built via the DOM API
// (new Option / DocumentFragment / replaceChildren) instead of an innerHTML
// string, to kill the recurring CodeQL js/xss-through-dom false positive.
// These tests pin the resulting option contract: value, data-* id attribute,
// selected flag, and — crucially — that the visible label is set as text,
// never parsed as markup.

globalThis.localStorage ??= { getItem: () => null, setItem: () => {} };
globalThis.navigator    ??= { language: 'en-US' };

const { S } = await import('../public-src/state.js');
const { _renderBasketSelect, _renderPuckScreenSelect, _renderRecipeSelect, _renderBeanSelect } =
  await import('../public-src/views/shots/annotation.js');

let selects;
beforeEach(() => {
  selects = installFakeOptionDom(
    ['annCoffee', 'annBasket', 'annPuckScreen', 'annRecipe'],
    { recipeField: { style: {} } },
  );
  S.shots = [];
  S.coffeeLibrary = { beans: [], baskets: [], puckScreens: [], recipes: [] };
});

describe('#946 annotation selects built via DOM API', () => {
  it('basket options carry value + data-basket-id and mark the selected one', () => {
    S.coffeeLibrary.baskets = [{ id: 5, name: 'IMS Precision' }, { id: 7, name: 'VST 18g' }];
    _renderBasketSelect(7);
    const opts = selects.annBasket.options;
    expect(opts[0].value).toBe('');           // "none" entry
    expect(opts[1].value).toBe('5');
    expect(opts[1].dataset.basketId).toBe(5);
    expect(opts[1].selected).toBe(false);
    expect(opts[2].dataset.basketId).toBe(7);
    expect(opts[2].selected).toBe(true);
  });

  it('puck screen options use the puckscreenId dataset key _buildAnnotationPayload reads', () => {
    S.coffeeLibrary.puckScreens = [{ id: 9, name: 'Slayer mesh' }];
    _renderPuckScreenSelect(9);
    expect(selects.annPuckScreen.options[1].dataset.puckscreenId).toBe(9);
    expect(selects.annPuckScreen.options[1].selected).toBe(true);
  });

  it('recipe options carry no data attribute (payload reads annRecipe.value)', () => {
    S.coffeeLibrary.recipes = [{ id: 3, name: 'Ratio 1:2' }];
    _renderRecipeSelect(3);
    const opt = selects.annRecipe.options[1];
    expect(opt.value).toBe('3');
    expect(opt.selected).toBe(true);
    expect(Object.keys(opt.dataset)).toHaveLength(0);
  });

  it('a bean name with HTML metacharacters becomes option text, never markup', () => {
    S.coffeeLibrary.beans = [{ id: 1, name: '<img src=x onerror=alert(1)> "Ácme"' }];
    _renderBeanSelect('<img src=x onerror=alert(1)> "Ácme"', 1);
    const opt = selects.annCoffee.options[1];
    expect(opt.text).toBe('<img src=x onerror=alert(1)> "Ácme"');
    expect(opt.value).toBe('<img src=x onerror=alert(1)> "Ácme"');
    expect(opt.dataset.beanId).toBe(1);
    expect(opt.selected).toBe(true);
  });
});
