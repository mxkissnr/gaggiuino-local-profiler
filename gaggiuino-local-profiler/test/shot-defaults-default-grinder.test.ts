// #1954 slice 5: the Shot logging defaults card's Grinder field is a dropdown
// over the library, and it drives the library's single default-grinder flag
// instead of storing a name. These tests pin both halves: changing the setting
// changes what a new shot and the bean suggestion use, and a name saved before
// the flag existed is migrated once without ever being lost silently.
//
// Same fake-DOM + module-mock convention as test/write-failures-surface.test.ts;
// only the two API calls are replaced, so the real _applyShotDefaults() and
// suggestGrindDoseForBean() run.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { CoffeeLibrary } from '../public-src/state/index.js';
import type { GrindShot } from '../public-src/views/shots/grind.js';

// vitest's node environment has no browser globals; stub them through a loose
// view of globalThis so the minimal fakes need not satisfy the full
// Storage/Navigator/Window shapes.
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
g.navigator ??= { language: 'en-US' };

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
g.document = { getElementById: (id: string) => docEls.get(id) };

const showToast = vi.fn();
g.window = { showToast };

const mocks = vi.hoisted(() => ({
  saveShotDefaults: vi.fn(),
  saveGrinder: vi.fn(),
}));

vi.mock('../public-src/api/shots.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../public-src/api/shots.js')>()),
  saveShotDefaults: mocks.saveShotDefaults,
}));

vi.mock('../public-src/api/library.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../public-src/api/library.js')>()),
  saveGrinder: mocks.saveGrinder,
}));

const { S } = await import('../public-src/state/index.js');
const { renderShotDefaultsSettingsCard, saveShotDefaultsSettings } =
  await import('../public-src/components/shot-defaults-settings.js');
const { _applyShotDefaults } = await import('../public-src/views/shots/annotation.js');
const { suggestGrindDoseForBean } = await import('../public-src/views/shots/grind.js');

// The migration runs behind two API calls and a re-render, so a render's
// writes are only observable after the microtask queue has drained.
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function library(grinders: { id: number; name: string; isDefault?: boolean }[]): CoffeeLibrary {
  return { beans: [{ id: 1, name: 'Bean A' }], grinders };
}

// One shot on Old only: with no default grinder the suggestion follows it, and
// with New flagged it must not borrow Old's grind setting.
const beanShots: GrindShot[] = [
  { timestamp: 100, score: 90, annotation: { coffee: 'Bean A', grinder: 'Old', grindSetting: '12', dose: '18' } },
];

// Called exactly as the app calls it, off S.coffeeLibrary.
function suggestion(): string {
  return suggestGrindDoseForBean('Bean A', S.coffeeLibrary, beanShots).grinder;
}

function savedDefaults(grinder = ''): Record<string, unknown> {
  return { drinkType: 'espresso', coffee: 'Bean A', beanId: 1, basketId: 3, puckScreenId: 5, grinder, dose: 18.5 };
}

function grinderSelect(): FakeEl {
  const el = docEls.get('sdGrinder');
  if (!el) throw new Error('missing #sdGrinder');
  return el;
}

// S.coffeeLibrary.grinders is typed as loose rows; the assertions below read
// the same three fields this component writes.
type GrinderRow = { id: number; name: string; isDefault?: boolean };
function grinderRows(): GrinderRow[] {
  return S.coffeeLibrary.grinders as unknown as GrinderRow[];
}

beforeEach(() => {
  vi.useFakeTimers();
  docEls.clear();
  for (const id of ['sdDrinkType', 'sdCoffee', 'sdBasket', 'sdPuckScreen', 'sdGrinder', 'sdDose']) {
    docEls.set(id, makeEl({ selectedOptions: [] }));
  }
  docEls.set('shotDefaultsSaveBtn', makeEl());

  showToast.mockReset();
  mocks.saveShotDefaults.mockReset();
  mocks.saveGrinder.mockReset();
  // Echo the body, as the server does for a successful POST.
  mocks.saveShotDefaults.mockImplementation((body: unknown) => Promise.resolve(body));
  mocks.saveGrinder.mockImplementation((id: number, payload: { isDefault?: boolean }) =>
    Promise.resolve({ id, name: `grinder ${id}`, isDefault: payload.isDefault }));

  S.coffeeLibrary = library([{ id: 1, name: 'Old' }, { id: 2, name: 'New' }]);
  S.shotDefaults = savedDefaults();
});

afterEach(() => { vi.useRealTimers(); });

describe('default grinder in shot defaults (#1954)', () => {
  it('changing the setting changes the new shot and the bean suggestion', async () => {
    expect(_applyShotDefaults({})?.grinder).toBe('');
    expect(suggestion()).toBe('Old');

    grinderSelect().value = '2';
    await saveShotDefaultsSettings();
    await flush();

    expect(mocks.saveGrinder).toHaveBeenCalledWith(2, { isDefault: true });
    expect(mocks.saveShotDefaults).toHaveBeenCalledWith(expect.objectContaining({ grinder: '' }));
    expect(_applyShotDefaults({})?.grinder).toBe('New');
    expect(suggestion()).toBe('New');

    mocks.saveGrinder.mockClear();
    grinderSelect().value = '';
    await saveShotDefaultsSettings();
    await flush();

    expect(mocks.saveGrinder).toHaveBeenCalledWith(2, { isDefault: false });
    expect(_applyShotDefaults({})?.grinder).toBe('');
    expect(suggestion()).toBe('Old');
  });

  it('switching from one default to another leaves only the new row flagged', async () => {
    S.coffeeLibrary = library([{ id: 1, name: 'Old', isDefault: true }, { id: 2, name: 'New' }]);
    grinderSelect().value = '2';

    await saveShotDefaultsSettings();

    expect(grinderRows().find(r => r.id === 1)?.isDefault).toBeUndefined();
    expect(grinderRows().find(r => r.id === 2)?.isDefault).toBe(true);
  });

  it('saving with the current default still selected sends no grinder write', async () => {
    S.coffeeLibrary = library([{ id: 1, name: 'Old' }, { id: 2, name: 'New', isDefault: true }]);
    grinderSelect().value = '2';

    await saveShotDefaultsSettings();

    expect(mocks.saveGrinder).not.toHaveBeenCalled();
    expect(mocks.saveShotDefaults).toHaveBeenCalledTimes(1);
  });

  it('a failed grinder write shows the toast, sends no POST and leaves the flags', async () => {
    mocks.saveGrinder.mockResolvedValue(null);
    grinderSelect().value = '2';

    await saveShotDefaultsSettings();

    expect(showToast).toHaveBeenCalledWith('Error: ');
    expect(mocks.saveShotDefaults).not.toHaveBeenCalled();
    expect(grinderRows().find(r => r.id === 2)?.isDefault).toBeUndefined();
    expect(docEls.get('shotDefaultsSaveBtn')?.innerHTML).not.toContain('Saved');
  });

  it('renders none first, ids as values and the flagged grinder selected', () => {
    S.coffeeLibrary = library([{ id: 1, name: 'Old', isDefault: true }, { id: 2, name: 'New' }]);
    S.shotDefaults = savedDefaults('New');

    renderShotDefaultsSettingsCard();

    const markup = grinderSelect().innerHTML;
    expect(markup.startsWith('<option value="">')).toBe(true);
    expect(markup).toContain('<option value="1" selected>Old</option>');
    expect(markup).toContain('<option value="2">New</option>');
  });

  it('keeps an unmatched saved name as a selected legacy option', async () => {
    S.shotDefaults = savedDefaults('K6');

    renderShotDefaultsSettingsCard();
    await flush();

    expect(grinderSelect().innerHTML).toContain('<option value="legacy" selected>K6</option>');
    expect(mocks.saveGrinder).not.toHaveBeenCalled();
    expect(mocks.saveShotDefaults).not.toHaveBeenCalled();
    expect(_applyShotDefaults({})?.grinder).toBe('K6');

    grinderSelect().value = 'legacy';
    await saveShotDefaultsSettings();

    expect(mocks.saveShotDefaults).toHaveBeenCalledWith(expect.objectContaining({ grinder: 'K6' }));
  });

  it('migrates a saved name that matches a library grinder once', async () => {
    S.shotDefaults = savedDefaults('  oLd  ');

    renderShotDefaultsSettingsCard();
    await flush();

    expect(mocks.saveGrinder).toHaveBeenCalledWith(1, { isDefault: true });
    expect(mocks.saveGrinder).toHaveBeenCalledTimes(1);
    expect(mocks.saveShotDefaults).toHaveBeenCalledWith({
      drinkType: 'espresso', coffee: 'Bean A', beanId: 1, basketId: 3, puckScreenId: 5, grinder: '', dose: 18.5,
    });
    expect(S.shotDefaults?.grinder).toBe('');
    expect(grinderRows().find(r => r.id === 1)?.isDefault).toBe(true);

    mocks.saveGrinder.mockClear();
    mocks.saveShotDefaults.mockClear();
    renderShotDefaultsSettingsCard();
    await flush();

    expect(mocks.saveGrinder).not.toHaveBeenCalled();
    expect(mocks.saveShotDefaults).not.toHaveBeenCalled();
  });

  it('does not migrate when a grinder is already flagged', async () => {
    S.coffeeLibrary = library([{ id: 1, name: 'Old' }, { id: 2, name: 'New', isDefault: true }]);
    S.shotDefaults = savedDefaults('Old');

    renderShotDefaultsSettingsCard();
    await flush();

    expect(mocks.saveGrinder).not.toHaveBeenCalled();
    expect(mocks.saveShotDefaults).not.toHaveBeenCalled();
  });

  it('does not migrate while the library has no grinders', async () => {
    S.coffeeLibrary = library([]);
    S.shotDefaults = savedDefaults('Old');

    renderShotDefaultsSettingsCard();
    await flush();

    expect(mocks.saveGrinder).not.toHaveBeenCalled();
    expect(S.shotDefaults?.grinder).toBe('Old');
  });

  it('does not migrate an empty saved name', async () => {
    renderShotDefaultsSettingsCard();
    await flush();

    expect(mocks.saveGrinder).not.toHaveBeenCalled();
    expect(mocks.saveShotDefaults).not.toHaveBeenCalled();
  });

  it('does not flag the grinder again after the migration and a switch to none', async () => {
    S.shotDefaults = savedDefaults('Old');
    renderShotDefaultsSettingsCard();
    await flush();
    expect(grinderRows().find(r => r.id === 1)?.isDefault).toBe(true);

    grinderSelect().value = '';
    await saveShotDefaultsSettings();
    await flush();
    expect(mocks.saveGrinder).toHaveBeenLastCalledWith(1, { isDefault: false });
    const writes = mocks.saveGrinder.mock.calls.length;

    renderShotDefaultsSettingsCard();
    await flush();

    expect(mocks.saveGrinder.mock.calls.length).toBe(writes);
    expect(grinderRows().find(r => r.id === 1)?.isDefault).toBeUndefined();
  });

  it('a failed migration write leaves the saved name and the flags alone', async () => {
    mocks.saveGrinder.mockResolvedValue(null);
    S.shotDefaults = savedDefaults('Old');

    renderShotDefaultsSettingsCard();
    await flush();

    expect(S.shotDefaults?.grinder).toBe('Old');
    expect(grinderRows().find(r => r.id === 1)?.isDefault).toBeUndefined();
    expect(mocks.saveShotDefaults).not.toHaveBeenCalled();
  });
});
