// #604: the default machine's per-machine colour theme (#594, previously
// icon-only) now drives the whole app's --accent-* variables via
// applyDefaultMachineAccentTheme() in components/machines-settings.js.
// Fake DOM below mirrors test/machines-settings-theme-form.test.js's
// pattern — just enough of documentElement/getElementById for the function
// under test to run without a real browser.
import { describe, it, expect, beforeEach } from 'vitest';

globalThis.localStorage ??= { getItem: () => null, setItem: () => {} };
globalThis.navigator ??= { language: 'en-US' };
globalThis.window ??= globalThis;

class FakeStyle {
  constructor() { this._props = {}; }
  setProperty(k, v) { this._props[k] = v; }
  removeProperty(k) { delete this._props[k]; }
  getPropertyValue(k) { return this._props[k] ?? ''; }
}
class FakeClassList {
  constructor() { this._set = new Set(); }
  add(c) { this._set.add(c); }
  remove(c) { this._set.delete(c); }
  contains(c) { return this._set.has(c); }
}
class FakeEl {
  constructor() { this.style = new FakeStyle(); this.classList = new FakeClassList(); }
}

const elements = {};
function fakeElement(id) { return (elements[id] ??= new FakeEl()); }
const root = new FakeEl();

globalThis.document = {
  documentElement: root,
  getElementById: fakeElement,
};

const { S } = await import('../public-src/state.js');
const { applyDefaultMachineAccentTheme } = await import('../public-src/components/machines-settings.js');

describe('applyDefaultMachineAccentTheme (#604)', () => {
  beforeEach(() => {
    for (const key of Object.keys(elements)) delete elements[key];
    root.style = new FakeStyle();
    root.classList = new FakeClassList();
    S.machines = [];
  });

  it('leaves the swatch-picker vars untouched and the note hidden when the default machine has no theme', () => {
    S.machines = [{ id: 1, isDefault: true, theme: null }];
    applyDefaultMachineAccentTheme();

    expect(root.style.getPropertyValue('--accent-from')).toBe('');
    expect(fakeElement('accentSwatches').classList.contains('accent-swatches-disabled')).toBe(false);
    expect(fakeElement('accentMachineThemeNote').style.display).toBe('none');
  });

  it('applies a flat preset theme to --accent/-from/-to and picks black text for a light accent', () => {
    S.machines = [{ id: 1, isDefault: true, theme: { preset: 'amber-americano' } }];
    applyDefaultMachineAccentTheme();

    expect(root.style.getPropertyValue('--accent')).toBe('#f59e0b');
    expect(root.style.getPropertyValue('--accent-from')).toBe('#f59e0b');
    expect(root.style.getPropertyValue('--accent-to')).toBe('#f59e0b');
    expect(root.style.getPropertyValue('--accent-text')).toBe('#000');
    expect(root.style.getPropertyValue('--accent-glow')).toBe('rgba(245,158,11,.15)');
    expect(fakeElement('accentSwatches').classList.contains('accent-swatches-disabled')).toBe(true);
    expect(fakeElement('accentMachineThemeNote').style.display).toBe('');
  });

  it('picks white text for a dark preset (worst-case darker of the two gradient stops)', () => {
    S.machines = [{ id: 1, isDefault: true, theme: { preset: 'ruby-ristretto' } }];
    applyDefaultMachineAccentTheme();

    expect(root.style.getPropertyValue('--accent-text')).toBe('#fff');
  });

  it('picks black text for a gradient theme whose darker stop still clears the 0.179 crossover', () => {
    S.machines = [{ id: 1, isDefault: true, theme: { preset: 'ember-espresso' } }];
    applyDefaultMachineAccentTheme();

    expect(root.style.getPropertyValue('--accent-text')).toBe('#000');
  });

  it('applies a custom {a,b} theme the same way as a preset', () => {
    S.machines = [{ id: 1, isDefault: true, theme: { a: '#111111', b: '#222222' } }];
    applyDefaultMachineAccentTheme();

    expect(root.style.getPropertyValue('--accent-from')).toBe('#111111');
    expect(root.style.getPropertyValue('--accent-to')).toBe('#222222');
    expect(root.style.getPropertyValue('--accent-text')).toBe('#fff');
  });

  it('ignores a non-default machine\'s theme even when it is the only machine with one set', () => {
    S.machines = [
      { id: 1, isDefault: true, theme: null },
      { id: 2, isDefault: false, theme: { preset: 'twilight-turkish' } },
    ];
    applyDefaultMachineAccentTheme();

    expect(root.style.getPropertyValue('--accent-from')).toBe('');
    expect(fakeElement('accentSwatches').classList.contains('accent-swatches-disabled')).toBe(false);
  });

  it('clears a previously-applied override once the default machine theme is removed', () => {
    S.machines = [{ id: 1, isDefault: true, theme: { preset: 'amber-americano' } }];
    applyDefaultMachineAccentTheme();
    expect(root.style.getPropertyValue('--accent-from')).toBe('#f59e0b');

    S.machines = [{ id: 1, isDefault: true, theme: null }];
    applyDefaultMachineAccentTheme();

    expect(root.style.getPropertyValue('--accent')).toBe('');
    expect(root.style.getPropertyValue('--accent-from')).toBe('');
    expect(root.style.getPropertyValue('--accent-to')).toBe('');
    expect(root.style.getPropertyValue('--accent-text')).toBe('');
    expect(root.style.getPropertyValue('--accent-glow')).toBe('');
    expect(fakeElement('accentSwatches').classList.contains('accent-swatches-disabled')).toBe(false);
  });

  it('does not throw when documentElement is unavailable (e.g. a bare test double for `document`)', () => {
    const savedDoc = globalThis.document;
    globalThis.document = { getElementById: () => undefined };
    S.machines = [{ id: 1, isDefault: true, theme: { preset: 'amber-americano' } }];
    expect(() => applyDefaultMachineAccentTheme()).not.toThrow();
    globalThis.document = savedDoc;
  });
});
