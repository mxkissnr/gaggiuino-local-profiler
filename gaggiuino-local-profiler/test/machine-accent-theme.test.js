// #604/#1019: the ACTIVE machine's per-machine colour theme (#594,
// previously icon-only) drives the whole app's --accent-* variables via
// applyActiveMachineAccentTheme() in components/machines-settings.js (#1019
// widened this from "only the default machine" to "whichever machine the
// topbar switcher currently has active", and added the fallback to the
// user's own persisted Farbschema pick when the active machine has none).
// Fake DOM below mirrors test/machines-settings-theme-form.test.js's
// pattern — just enough of documentElement/getElementById for the function
// under test to run without a real browser.
import { describe, it, expect, beforeEach } from 'vitest';

const _localStorageStore = {};
globalThis.localStorage ??= {
  getItem: (k) => (k in _localStorageStore ? _localStorageStore[k] : null),
  setItem: (k, v) => { _localStorageStore[k] = String(v); },
};
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
  toggle(c, force) {
    const on = force ?? !this._set.has(c);
    if (on) this._set.add(c); else this._set.delete(c);
  }
}
class FakeEl {
  constructor() { this.style = new FakeStyle(); this.classList = new FakeClassList(); this.innerHTML = ''; }
  // renderAccentSwatches() binds click listeners on its own querySelectorAll()
  // result -- irrelevant here since these tests assert on the rendered
  // innerHTML string directly rather than simulating a click (same pattern
  // test/machines-settings-theme-form.test.js uses for renderThemeSwatches()).
  querySelectorAll() { return []; }
}

const elements = {};
function fakeElement(id) { return (elements[id] ??= new FakeEl()); }
const root = new FakeEl();

globalThis.document = {
  documentElement: root,
  getElementById: fakeElement,
};

const { S } = await import('../public-src/state.js');
const { applyActiveMachineAccentTheme, renderAccentSwatches } = await import('../public-src/components/machines-settings.js');
const { migrateLegacyAccent } = await import('../public-src/theme.js');
const { t } = await import('../public-src/i18n.js');
const { THEME_PRESET_KEYS } = await import('../public-src/shared/theme-presets.js');

describe('applyActiveMachineAccentTheme (#604/#1019)', () => {
  beforeEach(() => {
    for (const key of Object.keys(elements)) delete elements[key];
    for (const key of Object.keys(_localStorageStore)) delete _localStorageStore[key];
    root.style = new FakeStyle();
    root.classList = new FakeClassList();
    delete root.dataset;
    S.machines = [];
    S.activeMachineId = null;
  });

  it('falls back to the user\'s persisted Farbschema pick when the active (default) machine has no theme', () => {
    S.machines = [{ id: 1, isDefault: true, theme: null }];
    localStorage.setItem('glp_accent_theme', 'ruby-ristretto');
    applyActiveMachineAccentTheme();

    expect(root.style.getPropertyValue('--accent-from')).toBe('#7f1d1d');
    expect(fakeElement('accentSwatches').classList.contains('accent-swatches-disabled')).toBe(false);
    expect(fakeElement('accentMachineThemeNote').style.display).toBe('none');
  });

  it('falls back to the default preset (amber-americano) when no Farbschema pick is persisted at all', () => {
    S.machines = [{ id: 1, isDefault: true, theme: null }];
    applyActiveMachineAccentTheme();

    expect(root.style.getPropertyValue('--accent-from')).toBe('#f59e0b');
    expect(root.style.getPropertyValue('--accent-to')).toBe('#f59e0b');
  });

  it('migrates a legacy (pre-#1019) persisted value before resolving the fallback', () => {
    S.machines = [{ id: 1, isDefault: true, theme: null }];
    localStorage.setItem('glp_accent_theme', 'ember');
    applyActiveMachineAccentTheme();

    expect(root.style.getPropertyValue('--accent-from')).toBe('#dc4a1f');
    expect(root.style.getPropertyValue('--accent-to')).toBe('#f5a623');
  });

  it('applies a flat preset theme to --accent/-from/-to and picks black text for a light accent', () => {
    S.machines = [{ id: 1, isDefault: true, theme: { preset: 'amber-americano' } }];
    applyActiveMachineAccentTheme();

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
    applyActiveMachineAccentTheme();

    expect(root.style.getPropertyValue('--accent-text')).toBe('#fff');
  });

  it('picks black text for a gradient theme whose darker stop still clears the 0.179 crossover', () => {
    S.machines = [{ id: 1, isDefault: true, theme: { preset: 'ember-espresso' } }];
    applyActiveMachineAccentTheme();

    expect(root.style.getPropertyValue('--accent-text')).toBe('#000');
  });

  it('applies a custom {a,b} theme the same way as a preset', () => {
    S.machines = [{ id: 1, isDefault: true, theme: { a: '#111111', b: '#222222' } }];
    applyActiveMachineAccentTheme();

    expect(root.style.getPropertyValue('--accent-from')).toBe('#111111');
    expect(root.style.getPropertyValue('--accent-to')).toBe('#222222');
    expect(root.style.getPropertyValue('--accent-text')).toBe('#fff');
  });

  // #1019: inverted from the pre-#1019 test of the same shape, which
  // asserted the opposite (a non-default machine's theme was always
  // ignored) -- that was the old "only the default machine" scope this
  // issue widens.
  it('an active non-default machine\'s own theme wins over the default machine\'s theme', () => {
    S.machines = [
      { id: 1, isDefault: true, theme: { preset: 'amber-americano' } },
      { id: 2, isDefault: false, theme: { preset: 'twilight-turkish' } },
    ];
    S.activeMachineId = 2;
    applyActiveMachineAccentTheme();

    expect(root.style.getPropertyValue('--accent-from')).toBe('#0891b2');
    expect(root.style.getPropertyValue('--accent-to')).toBe('#4338ca');
    expect(fakeElement('accentSwatches').classList.contains('accent-swatches-disabled')).toBe(true);
  });

  it('activeMachineId of null falls back to the default machine', () => {
    S.machines = [
      { id: 1, isDefault: true, theme: { preset: 'twilight-turkish' } },
      { id: 2, isDefault: false, theme: { preset: 'mulberry-mocha' } },
    ];
    S.activeMachineId = null;
    applyActiveMachineAccentTheme();

    expect(root.style.getPropertyValue('--accent-from')).toBe('#0891b2');
  });

  it("activeMachineId of 'all' falls back to the default machine", () => {
    S.machines = [
      { id: 1, isDefault: true, theme: { preset: 'twilight-turkish' } },
      { id: 2, isDefault: false, theme: { preset: 'mulberry-mocha' } },
    ];
    S.activeMachineId = 'all';
    applyActiveMachineAccentTheme();

    expect(root.style.getPropertyValue('--accent-from')).toBe('#0891b2');
  });

  it('a stale/removed activeMachineId that matches no machine falls back to the default machine', () => {
    S.machines = [{ id: 1, isDefault: true, theme: { preset: 'twilight-turkish' } }];
    S.activeMachineId = 999;
    applyActiveMachineAccentTheme();

    expect(root.style.getPropertyValue('--accent-from')).toBe('#0891b2');
  });

  it('switching activeMachineId between two differently-themed machines resolves a different var set each time', () => {
    S.machines = [
      { id: 1, isDefault: true, theme: { preset: 'twilight-turkish' } },
      { id: 2, isDefault: false, theme: { preset: 'mulberry-mocha' } },
    ];
    S.activeMachineId = 1;
    applyActiveMachineAccentTheme();
    const firstFrom = root.style.getPropertyValue('--accent-from');

    S.activeMachineId = 2;
    applyActiveMachineAccentTheme();
    const secondFrom = root.style.getPropertyValue('--accent-from');

    expect(firstFrom).toBe('#0891b2');
    expect(secondFrom).toBe('#5b21b6');
    expect(firstFrom).not.toBe(secondFrom);
  });

  it('re-resolves to the fallback once the active machine\'s theme is removed', () => {
    S.machines = [{ id: 1, isDefault: true, theme: { preset: 'amber-americano' } }];
    applyActiveMachineAccentTheme();
    expect(root.style.getPropertyValue('--accent-from')).toBe('#f59e0b');
    expect(fakeElement('accentSwatches').classList.contains('accent-swatches-disabled')).toBe(true);

    S.machines = [{ id: 1, isDefault: true, theme: null }];
    localStorage.setItem('glp_accent_theme', 'twilight-turkish');
    applyActiveMachineAccentTheme();

    expect(root.style.getPropertyValue('--accent-from')).toBe('#0891b2');
    expect(root.style.getPropertyValue('--accent-to')).toBe('#4338ca');
    expect(fakeElement('accentSwatches').classList.contains('accent-swatches-disabled')).toBe(false);
    expect(fakeElement('accentMachineThemeNote').style.display).toBe('none');
  });

  it('does not throw when documentElement is unavailable (e.g. a bare test double for `document`)', () => {
    const savedDoc = globalThis.document;
    globalThis.document = { getElementById: () => undefined };
    S.machines = [{ id: 1, isDefault: true, theme: { preset: 'amber-americano' } }];
    expect(() => applyActiveMachineAccentTheme()).not.toThrow();
    globalThis.document = savedDoc;
  });

  // #1021: --accent-ink light-theme override -- root.dataset is left
  // undefined by FakeEl (no data-theme test double needed elsewhere), so
  // these tests set it directly the same way applyTheme() (theme.js) would
  // via documentElement.dataset.theme.
  describe('--accent-ink light-theme override (#1021)', () => {
    it('equals --accent (no override) in the dark theme, even for a preset with a light-theme override', () => {
      root.dataset = { theme: 'dark' };
      S.machines = [{ id: 1, isDefault: true, theme: { preset: 'amber-americano' } }];
      applyActiveMachineAccentTheme();

      expect(root.style.getPropertyValue('--accent-ink')).toBe('#f59e0b');
    });

    it('equals --accent (no override) when root.dataset is entirely absent (pre-applyTheme() boot state)', () => {
      delete root.dataset;
      S.machines = [{ id: 1, isDefault: true, theme: { preset: 'amber-americano' } }];
      applyActiveMachineAccentTheme();

      expect(root.style.getPropertyValue('--accent-ink')).toBe('#f59e0b');
    });

    it('applies the darkened override for a preset that fails raw in the light theme', () => {
      root.dataset = { theme: 'light' };
      S.machines = [{ id: 1, isDefault: true, theme: { preset: 'amber-americano' } }];
      applyActiveMachineAccentTheme();

      expect(root.style.getPropertyValue('--accent')).toBe('#f59e0b');
      expect(root.style.getPropertyValue('--accent-ink')).toBe('#905c06');
    });

    it('leaves an already-compliant preset unmodified in the light theme', () => {
      root.dataset = { theme: 'light' };
      S.machines = [{ id: 1, isDefault: true, theme: { preset: 'ruby-ristretto' } }];
      applyActiveMachineAccentTheme();

      expect(root.style.getPropertyValue('--accent-ink')).toBe('#7f1d1d');
    });

    it('falls back to --accent for a fully custom {a,b} machine theme in the light theme (no preset key to look up)', () => {
      root.dataset = { theme: 'light' };
      S.machines = [{ id: 1, isDefault: true, theme: { a: '#f59e0b', b: '#f59e0b' } }];
      applyActiveMachineAccentTheme();

      expect(root.style.getPropertyValue('--accent-ink')).toBe('#f59e0b');
    });

    it('resolves the user\'s persisted Farbschema pick\'s override when the active machine has no theme of its own', () => {
      root.dataset = { theme: 'light' };
      S.machines = [{ id: 1, isDefault: true, theme: null }];
      localStorage.setItem('glp_accent_theme', 'frosty-flat-white');
      applyActiveMachineAccentTheme();

      expect(root.style.getPropertyValue('--accent-ink')).toBe('#0f736b');
    });
  });
});

describe('migrateLegacyAccent (#1019)', () => {
  it('is idempotent on an already-valid preset key', () => {
    for (const key of ['amber-americano', 'ruby-ristretto', 'copper-cortado', 'twilight-turkish',
                        'marbled-macchiato', 'ember-espresso', 'mulberry-mocha', 'frosty-flat-white']) {
      expect(migrateLegacyAccent(key)).toBe(key);
    }
  });

  it('maps every legacy 6-swatch value to its nearest new preset', () => {
    expect(migrateLegacyAccent('amber')).toBe('amber-americano');
    expect(migrateLegacyAccent('ember')).toBe('ember-espresso');
    expect(migrateLegacyAccent('crema')).toBe('copper-cortado');
    expect(migrateLegacyAccent('ocean')).toBe('frosty-flat-white');
    expect(migrateLegacyAccent('forest')).toBe('frosty-flat-white');
    expect(migrateLegacyAccent('aurora')).toBe('mulberry-mocha');
  });

  it('returns null for an unrecognized or unset value', () => {
    expect(migrateLegacyAccent(null)).toBeNull();
    expect(migrateLegacyAccent(undefined)).toBeNull();
    expect(migrateLegacyAccent('')).toBeNull();
    expect(migrateLegacyAccent('not-a-real-value')).toBeNull();
  });
});

describe('renderAccentSwatches (#1019)', () => {
  beforeEach(() => {
    for (const key of Object.keys(elements)) delete elements[key];
    for (const key of Object.keys(_localStorageStore)) delete _localStorageStore[key];
  });

  it('renders exactly 8 buttons, one per THEME_PRESET_KEYS entry', () => {
    renderAccentSwatches();
    const html = fakeElement('accentSwatches').innerHTML;
    const keysInHtml = [...html.matchAll(/data-preset-key="([^"]+)"/g)].map(m => m[1]);
    expect(keysInHtml).toEqual(THEME_PRESET_KEYS);
  });

  it('marks the currently-persisted preset as active', () => {
    localStorage.setItem('glp_accent_theme', 'twilight-turkish');
    renderAccentSwatches();
    const html = fakeElement('accentSwatches').innerHTML;
    const twilightBtn = html.match(/<button[^>]*data-preset-key="twilight-turkish"[^>]*>/)[0];
    const amberBtn = html.match(/<button[^>]*data-preset-key="amber-americano"[^>]*>/)[0];
    expect(twilightBtn).toContain('active');
    expect(amberBtn).not.toContain('active');
  });

  it('defaults to amber-americano marked active when nothing is persisted', () => {
    renderAccentSwatches();
    const html = fakeElement('accentSwatches').innerHTML;
    const amberBtn = html.match(/<button[^>]*data-preset-key="amber-americano"[^>]*>/)[0];
    expect(amberBtn).toContain('active');
  });

  it('each button carries the correct theme_preset_* tooltip', () => {
    renderAccentSwatches();
    const html = fakeElement('accentSwatches').innerHTML;
    for (const key of THEME_PRESET_KEYS) {
      const label = t(`theme_preset_${key.replace(/-/g, '_')}`);
      const btn = html.match(new RegExp(`<button[^>]*data-preset-key="${key}"[^>]*>`))[0];
      expect(btn).toContain(`title="${label}"`);
    }
  });
});
