// #691: Settings -> "Shot logging defaults" grinder field (#sdGrinder) was a
// plain text input with no suggestions, unlike the real annotation panel's
// #annGrinder (which has attachAutocomplete() wired to S.coffeeLibrary.grinders,
// see main.js). renderShotDefaultsSettingsCard() now attaches the same
// autocomplete. Mocks attachAutocomplete itself rather than rebuilding its
// internal fake-DOM harness (see test/autocomplete.test.js for that) -- this
// test only needs to prove the wiring, not attachAutocomplete's own behavior.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { CoffeeLibrary } from '../public-src/state/index.js';

// vitest's node environment has no browser globals; stub them through a loose
// view of globalThis (the same bridge test/annotation-basket-puckscreen-save.ts
// uses) so the minimal fakes need not satisfy the full Storage/Navigator shapes.
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };
g.navigator ??= { language: 'en-US' };

const attachAutocompleteMock = vi.fn();
vi.mock('../public-src/components/autocomplete.js', () => ({
  attachAutocomplete: attachAutocompleteMock,
}));
vi.mock('../public-src/views/shots/annotation.js', () => ({
  loadShotDefaults: vi.fn(),
  loadDrinkMenu: vi.fn(),
}));

const { S } = await import('../public-src/state/index.js');
const { renderShotDefaultsSettingsCard } = await import('../public-src/components/shot-defaults-settings.js');

// The only element shape these tests need: the grinder <input> the mock
// records and the card's getOptions callback reads from.
interface FakeInput { value: string }
interface FakeDocument { getElementById: (id: string) => FakeInput | undefined }

function makeFakeDocument(fields: Record<string, FakeInput>): FakeDocument {
  const registry = new Map<string, FakeInput>(Object.entries(fields));
  return { getElementById: id => registry.get(id) };
}

describe('shot defaults grinder autocomplete (#691)', () => {
  let grinderInput: FakeInput;

  beforeEach(() => {
    attachAutocompleteMock.mockClear();
    grinderInput = { value: '' };
    g.document = makeFakeDocument({ sdGrinder: grinderInput });
    S.shotDefaults = {};
  });

  it('attaches autocomplete to #sdGrinder on render', () => {
    renderShotDefaultsSettingsCard();
    expect(attachAutocompleteMock).toHaveBeenCalledTimes(1);
    expect(attachAutocompleteMock.mock.calls[0][0]).toBe(grinderInput);
  });

  it('the attached getOptions callback returns grinder names from the coffee library', () => {
    S.coffeeLibrary = { beans: [], grinders: [{ name: 'Niche Zero' }, { name: 'Kingrinder K6' }] };
    renderShotDefaultsSettingsCard();
    const getOptions = attachAutocompleteMock.mock.calls[0][1] as () => unknown;
    expect(getOptions()).toEqual(['Niche Zero', 'Kingrinder K6']);
  });

  it('the getOptions callback does not throw when the coffee library has no grinders yet', () => {
    S.coffeeLibrary = {} as CoffeeLibrary;
    renderShotDefaultsSettingsCard();
    const getOptions = attachAutocompleteMock.mock.calls[0][1] as () => unknown;
    expect(getOptions()).toEqual([]);
  });
});
