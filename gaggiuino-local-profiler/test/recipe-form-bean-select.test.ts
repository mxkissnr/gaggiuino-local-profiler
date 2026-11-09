// #1960: the recipe form's bean field is a dropdown over the library, filled
// by the same _renderBeanSelect() the annotation panel and the dial-in wizard
// use. A recipe whose beanName is not in the library keeps that name as its
// own option, so editing and saving it does not silently drop the bean.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { installFakeOptionDom } from './helpers/fake-option-dom.js';
import type { FakeOption, FakeSelect } from './helpers/fake-option-dom.js';

// Same module-load stubbing as test/bean-select-by-id.test.ts: state/index.ts
// and i18n.ts read localStorage/navigator at module load.
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
g.navigator ??= { language: 'en-US' };

const mocks = vi.hoisted(() => ({
  attachAutocomplete: vi.fn(),
  saveRecipe: vi.fn(),
}));

vi.mock('../public-src/components/autocomplete.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../public-src/components/autocomplete.js')>()),
  attachAutocomplete: mocks.attachAutocomplete,
}));

vi.mock('../public-src/api/library.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../public-src/api/library.js')>()),
  saveRecipe: mocks.saveRecipe,
}));

interface FakeEl {
  value: string;
  innerHTML: string;
  style: Record<string, string>;
  classList: { add: () => void; remove: () => void };
  focus: () => void;
}

function makeEl(init: Partial<FakeEl> = {}): FakeEl {
  return {
    value: '',
    innerHTML: '',
    style: {},
    classList: { add() {}, remove() {} },
    focus() {},
    ...init,
  };
}

// Every other recipeForm* input openRecipeForm() writes to.
const FORM_FIELD_IDS = [
  'recipeFormName',
  'recipeFormBrewMethod',
  'recipeFormDrinkType',
  'recipeFormDose',
  'recipeFormYield',
  'recipeFormTime',
  'recipeFormWaterTemp',
  'recipeFormWaterG',
  'recipeFormIceG',
  'recipeFormGrind',
  'recipeFormSourceUrl',
  'recipeFormProfile',
  'recipeFormNotes',
];

interface FakeDoc {
  getElementById: (id: string) => FakeEl | null;
  querySelectorAll: () => unknown[];
}

function fakeDocument(): FakeDoc {
  return g.document as FakeDoc;
}

// The bean <select>: the shared helper's captured options plus the fields
// saveRecipe reads off a real HTMLSelectElement.
type BeanSelectEl = FakeSelect & FakeEl;

function installDom(): BeanSelectEl {
  const extras: Record<string, unknown> = {
    recipeAddForm: makeEl(),
    recipeAddTrigger: makeEl(),
    recipeStepsList: makeEl(),
  };
  for (const id of FORM_FIELD_IDS) extras[id] = makeEl();
  const selects = installFakeOptionDom(['recipeFormBean'], extras);
  // _collectSteps() queries the step rows; the fake document has none.
  fakeDocument().querySelectorAll = () => [];
  const select = selects.recipeFormBean;
  if (!select) throw new Error('fake select #recipeFormBean was not installed');
  return Object.assign(select, makeEl());
}

function optionsOf(select: FakeSelect): FakeOption[] {
  return (select.options ?? []) as FakeOption[];
}

const { S } = await import('../public-src/state/index.js');
const { openRecipeForm, saveRecipe } = await import('../public-src/views/library/recipes.js');

function library(): typeof S.coffeeLibrary {
  return {
    beans: [
      { id: 1, name: 'Bean A' },
      { id: 2, name: 'Bean B' },
    ],
    recipes: [],
  } as unknown as typeof S.coffeeLibrary;
}

beforeEach(() => {
  S.coffeeLibrary = library();
  mocks.attachAutocomplete.mockReset();
  mocks.saveRecipe.mockReset();
});

describe('recipe form bean dropdown (#1960)', () => {
  it('keeps a saved bean name that is outside the library, on edit and save', async () => {
    const select = installDom();
    mocks.saveRecipe.mockResolvedValue({ id: 7, name: 'Rec', beanName: 'Mystery Bean' });

    openRecipeForm({ id: 7, name: 'Rec', beanName: 'Mystery Bean' });

    expect(optionsOf(select).map(o => o.value)).toEqual(['', 'Bean A', 'Bean B', 'Mystery Bean']);
    expect(optionsOf(select).find(o => o.value === 'Mystery Bean')?.selected).toBe(true);

    // A real <select> carries the chosen option into .value.
    select.value = 'Mystery Bean';
    await saveRecipe();

    expect(mocks.saveRecipe).toHaveBeenCalledTimes(1);
    const payload = mocks.saveRecipe.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload.beanName).toBe('Mystery Bean');
  });

  it('keeps a library bean that is selected', async () => {
    const select = installDom();
    mocks.saveRecipe.mockResolvedValue({ id: 7, name: 'Rec', beanName: 'Bean B' });

    openRecipeForm({ id: 7, name: 'Rec', beanName: 'Bean B' });

    expect(optionsOf(select).find(o => o.value === 'Bean B')?.selected).toBe(true);

    select.value = 'Bean B';
    await saveRecipe();

    const payload = mocks.saveRecipe.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload.beanName).toBe('Bean B');
  });

  it('starts a new recipe on the blank option and posts an empty beanName', async () => {
    const select = installDom();
    mocks.saveRecipe.mockResolvedValue({ id: 9, name: 'New Rec', beanName: '' });

    openRecipeForm();

    expect(optionsOf(select)[0]?.value).toBe('');
    expect(optionsOf(select).slice(1).some(o => o.selected)).toBe(false);

    const nameInput = fakeDocument().getElementById('recipeFormName');
    if (nameInput) nameInput.value = 'New Rec';
    select.value = '';
    await saveRecipe();

    const payload = mocks.saveRecipe.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload.beanName).toBe('');
  });

  it('attaches autocomplete to the profile field only', () => {
    installDom();

    openRecipeForm({ id: 7, name: 'Rec' });

    expect(mocks.attachAutocomplete).toHaveBeenCalledTimes(1);
    expect(mocks.attachAutocomplete.mock.calls[0]?.[0]).toBe(fakeDocument().getElementById('recipeFormProfile'));
  });
});
