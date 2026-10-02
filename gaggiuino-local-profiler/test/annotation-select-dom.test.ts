import { describe, it, expect, beforeEach } from 'vitest';
import { installFakeOptionDom } from './helpers/fake-option-dom.js';
import type { FakeOption, FakeSelect } from './helpers/fake-option-dom.js';

// #946: the annotation library <select>s are built via the DOM API
// (new Option / DocumentFragment / replaceChildren) instead of an innerHTML
// string, to kill the recurring CodeQL js/xss-through-dom false positive.
// These tests pin the resulting option contract: value, data-* id attribute,
// selected flag, and — crucially — that the visible label is set as text,
// never parsed as markup.

// vitest's node environment has no browser globals; stub them through a loose
// view of globalThis (the same bridge the fake-option-dom helper uses).
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };
g.navigator    ??= { language: 'en-US' };

const { S } = await import('../public-src/state/index.js');
const { _renderBasketSelect, _renderPuckScreenSelect, _renderRecipeSelect, _renderBeanSelect } =
  await import('../public-src/views/shots/annotation.js');

// S.coffeeLibrary is typed for beans/grinders only (state/index.ts) while the
// annotation view reads baskets/puckScreens/recipes off the same object.
interface CatalogRow { id: number; name: string }
interface Catalog { beans: CatalogRow[]; baskets: CatalogRow[]; puckScreens: CatalogRow[]; recipes: CatalogRow[] }

// fake-option-dom types each select's captured options as unknown[]; narrow
// them back to the FakeOption instances the render path actually created.
const optionsOf = (select: FakeSelect): FakeOption[] => (select.options ?? []) as FakeOption[];

// `selects` and `options` are plain Record/array, so `selects.x` / `opts[i]`
// are `| undefined` under noUncheckedIndexedAccess; these narrow them back and
// throw on a missing entry, matching the old code which would have crashed.
function at<T>(arr: readonly T[], i: number): T {
  const v = arr[i];
  if (v === undefined) throw new Error(`no element at index ${i}`);
  return v;
}
function sel(name: string): FakeSelect {
  const s = selects[name];
  if (s === undefined) throw new Error(`unknown select: ${name}`);
  return s;
}

let selects: Record<string, FakeSelect>;
let catalog: Catalog;
beforeEach(() => {
  selects = installFakeOptionDom(
    ['annCoffee', 'annBasket', 'annPuckScreen', 'annRecipe'],
    { recipeField: { style: {} } },
  );
  S.shots = [];
  catalog = { beans: [], baskets: [], puckScreens: [], recipes: [] };
  S.coffeeLibrary = catalog as unknown as typeof S.coffeeLibrary;
});

describe('#946 annotation selects built via DOM API', () => {
  it('basket options carry value + data-basket-id and mark the selected one', () => {
    catalog.baskets = [{ id: 5, name: 'IMS Precision' }, { id: 7, name: 'VST 18g' }];
    _renderBasketSelect(7);
    const opts = optionsOf(sel('annBasket'));
    expect(at(opts, 0).value).toBe('');           // "none" entry
    expect(at(opts, 1).value).toBe('5');
    expect(at(opts, 1).dataset.basketId).toBe(5);
    expect(at(opts, 1).selected).toBe(false);
    expect(at(opts, 2).dataset.basketId).toBe(7);
    expect(at(opts, 2).selected).toBe(true);
  });

  it('puck screen options use the puckscreenId dataset key _buildAnnotationPayload reads', () => {
    catalog.puckScreens = [{ id: 9, name: 'Slayer mesh' }];
    _renderPuckScreenSelect(9);
    expect(at(optionsOf(sel('annPuckScreen')), 1).dataset.puckscreenId).toBe(9);
    expect(at(optionsOf(sel('annPuckScreen')), 1).selected).toBe(true);
  });

  it('recipe options carry no data attribute (payload reads annRecipe.value)', () => {
    catalog.recipes = [{ id: 3, name: 'Ratio 1:2' }];
    _renderRecipeSelect(3);
    const opt = at(optionsOf(sel('annRecipe')), 1);
    expect(opt.value).toBe('3');
    expect(opt.selected).toBe(true);
    expect(Object.keys(opt.dataset)).toHaveLength(0);
  });

  it('a bean name with HTML metacharacters becomes option text, never markup', () => {
    catalog.beans = [{ id: 1, name: '<img src=x onerror=alert(1)> "Ácme"' }];
    _renderBeanSelect('<img src=x onerror=alert(1)> "Ácme"', 1);
    const opt = at(optionsOf(sel('annCoffee')), 1);
    expect(opt.text).toBe('<img src=x onerror=alert(1)> "Ácme"');
    expect(opt.value).toBe('<img src=x onerror=alert(1)> "Ácme"');
    expect(opt.dataset.beanId).toBe(1);
    expect(opt.selected).toBe(true);
  });
});
