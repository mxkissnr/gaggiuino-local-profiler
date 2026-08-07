// #691: Settings -> "Shot logging defaults" grinder field (#sdGrinder) was a
// plain text input with no suggestions, unlike the real annotation panel's
// #annGrinder (which has attachAutocomplete() wired to S.coffeeLibrary.grinders,
// see main.js). renderShotDefaultsSettingsCard() now attaches the same
// autocomplete. Mocks attachAutocomplete itself rather than rebuilding its
// internal fake-DOM harness (see test/autocomplete.test.js for that) -- this
// test only needs to prove the wiring, not attachAutocomplete's own behavior.
import { describe, it, expect, beforeEach, vi } from 'vitest';

globalThis.localStorage ??= { getItem: () => null, setItem: () => {} };
globalThis.navigator ??= { language: 'en-US' };

const attachAutocompleteMock = vi.fn();
vi.mock('../public-src/components/autocomplete.js', () => ({
  attachAutocomplete: attachAutocompleteMock,
}));
vi.mock('../public-src/views/shots/annotation.js', () => ({
  loadShotDefaults: vi.fn(),
  loadDrinkMenu: vi.fn(),
}));

const { S } = await import('../public-src/state.js');
const { renderShotDefaultsSettingsCard } = await import('../public-src/components/shot-defaults-settings.js');

function makeFakeDocument(fields) {
  const registry = new Map(Object.entries(fields));
  return { getElementById: id => registry.get(id) };
}

describe('shot defaults grinder autocomplete (#691)', () => {
  let grinderInput;

  beforeEach(() => {
    attachAutocompleteMock.mockClear();
    grinderInput = { value: '' };
    globalThis.document = makeFakeDocument({ sdGrinder: grinderInput });
    S.shotDefaults = {};
  });

  it('attaches autocomplete to #sdGrinder on render', () => {
    renderShotDefaultsSettingsCard();
    expect(attachAutocompleteMock).toHaveBeenCalledTimes(1);
    expect(attachAutocompleteMock.mock.calls[0][0]).toBe(grinderInput);
  });

  it('the attached getOptions callback returns grinder names from the coffee library', () => {
    S.coffeeLibrary = { grinders: [{ name: 'Niche Zero' }, { name: 'Kingrinder K6' }] };
    renderShotDefaultsSettingsCard();
    const getOptions = attachAutocompleteMock.mock.calls[0][1];
    expect(getOptions()).toEqual(['Niche Zero', 'Kingrinder K6']);
  });

  it('the getOptions callback does not throw when the coffee library has no grinders yet', () => {
    S.coffeeLibrary = {};
    renderShotDefaultsSettingsCard();
    const getOptions = attachAutocompleteMock.mock.calls[0][1];
    expect(getOptions()).toEqual([]);
  });
});
