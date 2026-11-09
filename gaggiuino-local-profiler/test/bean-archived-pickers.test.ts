// #1958 slice 2: an archived (enabled === false) bean leaves every bean
// picker, unless it is the bean already chosen — an old shot, draft, recipe or
// saved default must never lose or rewrite its bean. A bean that is merely
// empty (#933) stays selectable and labelled Empty.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installFakeOptionDom } from './helpers/fake-option-dom.js';
import type { FakeOption, FakeSelect } from './helpers/fake-option-dom.js';

const g = globalThis as unknown as Record<string, unknown>;
g.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
g.navigator ??= { language: 'en-US' };

const mocks = vi.hoisted(() => ({
  annotateShot: vi.fn(),
  loadLibrary: vi.fn(),
}));

// The confirm path repaints the shot sidebar; that render is not what these
// tests are about, so it is stubbed out (same as test/shots-trash-undo.test.ts).
vi.mock('../public-src/components/sidebar.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../public-src/components/sidebar.js')>()),
  renderSidebar: vi.fn(),
  updateSidebarHighlighting: vi.fn(),
}));

vi.mock('../public-src/api/shots.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../public-src/api/shots.js')>()),
  annotateShot: mocks.annotateShot,
  // The wizard evaluates the confirmed shot through its lazy curve; no shot
  // data here means an empty curve, which is all these tests need.
  getShot: () => Promise.resolve(null),
}));

g.window = { loadLibrary: mocks.loadLibrary };

const { S } = await import('../public-src/state/index.js');
const { t } = await import('../public-src/i18n.js');
const { _renderBeanSelect } = await import('../public-src/views/shots/annotation.js');
const { renderShotDefaultsSettingsCard } = await import('../public-src/components/shot-defaults-settings.js');
const { dialinConfirmShot } = await import('../public-src/views/dialin-wizard.js');

const optionsOf = (select: FakeSelect): FakeOption[] => (select.options ?? []) as FakeOption[];

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

describe('_renderBeanSelect — archived beans leave the pickers (#1958)', () => {
  it('leaves an archived bean out of the list', () => {
    S.coffeeLibrary = {
      beans: [
        { id: 1, name: 'Fresh Bean' },
        { id: 2, name: 'Archived Bean', enabled: false },
      ],
    } as unknown as typeof S.coffeeLibrary;
    _renderBeanSelect(null, null);
    expect(optionValues()).toEqual(['', 'Fresh Bean']);
  });

  it('keeps an archived bean that is the chosen one by id, still selected', () => {
    S.coffeeLibrary = {
      beans: [{ id: 2, name: 'Archived Bean', enabled: false }],
    } as unknown as typeof S.coffeeLibrary;
    _renderBeanSelect('Archived Bean', 2);
    const opt = selectedOption();
    expect(opt.value).toBe('Archived Bean');
    expect(opt.dataset.beanId).toBe(2);
  });

  it('keeps an archived bean chosen by name when the id is null, still selected', () => {
    S.coffeeLibrary = {
      beans: [{ id: 2, name: 'Archived Bean', enabled: false }],
    } as unknown as typeof S.coffeeLibrary;
    _renderBeanSelect('Archived Bean', null);
    expect(selectedOption().value).toBe('Archived Bean');
  });

  it('keeps nothing when the chosen name is empty', () => {
    S.coffeeLibrary = {
      beans: [{ id: 2, name: 'Archived Bean', enabled: false }],
    } as unknown as typeof S.coffeeLibrary;
    _renderBeanSelect('', null);
    expect(optionValues()).toEqual(['']);
  });

  it('still offers an empty but non-archived bean, labelled Empty', () => {
    S.coffeeLibrary = {
      beans: [{ id: 1, name: 'Empty Bean', remainingG: 0 }],
    } as unknown as typeof S.coffeeLibrary;
    _renderBeanSelect(null, null);
    const opt = optionsOf(selectEl).find(o => o.value === 'Empty Bean')!;
    expect(opt.text).toBe(`Empty Bean (${t('lib_milk_empty')})`);
  });

  it('keeps a bean without the key and a bean with enabled: true', () => {
    S.coffeeLibrary = {
      beans: [
        { id: 1, name: 'No Key Bean' },
        { id: 2, name: 'Enabled Bean', enabled: true },
      ],
    } as unknown as typeof S.coffeeLibrary;
    _renderBeanSelect(null, null);
    expect(optionValues()).toEqual(['', 'No Key Bean', 'Enabled Bean']);
  });
});

interface FakeEl {
  textContent: string;
  innerHTML: string;
  value: string;
  style: Record<string, string>;
  selectedOptions?: { dataset: Record<string, string> }[];
}

function makeEl(init: Partial<FakeEl> = {}): FakeEl {
  return { textContent: '', innerHTML: '', value: '', style: {}, ...init };
}

const docEls = new Map<string, FakeEl>();

function installShotDefaultsDom(): void {
  docEls.clear();
  for (const id of ['sdDrinkType', 'sdCoffee', 'sdBasket', 'sdPuckScreen', 'sdGrinder', 'sdDose']) {
    docEls.set(id, makeEl({ selectedOptions: [] }));
  }
  g.document = { getElementById: (id: string) => docEls.get(id) ?? null };
}

function coffeeSelect(): FakeEl {
  const el = docEls.get('sdCoffee');
  if (!el) throw new Error('missing #sdCoffee');
  return el;
}

describe('renderShotDefaultsSettingsCard — archived beans (#1958)', () => {
  beforeEach(() => {
    installShotDefaultsDom();
    // No grinder in the library and no saved grinder name, so the #1954
    // migration never fires a write here.
    S.coffeeLibrary = {
      beans: [
        { id: 1, name: 'Fresh Bean' },
        { id: 2, name: 'Archived Bean', enabled: false },
      ],
      grinders: [],
    } as unknown as typeof S.coffeeLibrary;
    S.shotDefaults = { drinkType: 'espresso', coffee: 'Fresh Bean', beanId: 1 };
  });

  it('omits an archived bean from the default-coffee dropdown', () => {
    renderShotDefaultsSettingsCard();
    expect(coffeeSelect().innerHTML).toContain('Fresh Bean');
    expect(coffeeSelect().innerHTML).not.toContain('Archived Bean');
  });

  it('keeps the archived bean when it is the saved default', () => {
    S.shotDefaults = { drinkType: 'espresso', coffee: 'Archived Bean', beanId: 2 };
    renderShotDefaultsSettingsCard();
    expect(coffeeSelect().innerHTML).toContain('Archived Bean');
  });
});

function installDialinDom(): void {
  // renderDialinWizard() returns early without #dwBody, which is all the
  // confirm path needs from the page here.
  g.document = { getElementById: () => null };
}

function dialinSession(): Record<string, unknown> {
  return {
    id: 1,
    startedAt: 1,
    bean: 'Archived Bean',
    beanId: 2,
    grinder: 'Grinder',
    dose: '18',
    targetRatio: 2,
    recipeId: null,
    startGrind: 20,
    rounds: [],
    pendingGrind: 20,
    candidateShotId: null,
    reviewRound: null,
    awaitingShotSince: null,
    status: 'active',
  };
}

function dialinShot() {
  return { id: 7, timestamp: 100, duration: 280, score: 80, annotation: { coffee: 'Archived Bean', beanId: 2 } };
}

describe('dialinConfirmShot — reloads bean stock after an annotation save (#1958)', () => {
  beforeEach(() => {
    installDialinDom();
    mocks.annotateShot.mockReset();
    mocks.loadLibrary.mockReset();
    S.coffeeLibrary = { beans: [{ id: 2, name: 'Archived Bean', enabled: false }] } as unknown as typeof S.coffeeLibrary;
    S.dialinSession = dialinSession() as unknown as typeof S.dialinSession;
    S.shots = [dialinShot()] as unknown as typeof S.shots;
  });

  afterEach(() => {
    S.dialinSession = null;
    S.shots = [];
  });

  it('reloads the library once after a successful annotate', async () => {
    mocks.annotateShot.mockResolvedValue({ ok: true, status: 200 });
    await dialinConfirmShot(7, true);
    expect(mocks.annotateShot).toHaveBeenCalledTimes(1);
    expect(mocks.loadLibrary).toHaveBeenCalledTimes(1);
  });

  it('does not reload the library after a failed annotate', async () => {
    mocks.annotateShot.mockResolvedValue({ ok: false, status: 500 });
    await dialinConfirmShot(7, true);
    expect(mocks.annotateShot).toHaveBeenCalledTimes(1);
    expect(mocks.loadLibrary).not.toHaveBeenCalled();
  });
});
