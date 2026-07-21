import { describe, it, expect, beforeEach, vi } from 'vitest';

// bottom-nav.js's import chain touches state.js/i18n.js (localStorage/
// navigator at module load time) — stub the minimum browser globals so the
// module graph can be imported under vitest's node environment, same
// pattern as test/milk-deduct-gate.test.js and test/sidebar-month-toggle.test.js.
// Unlike those, we need a *real* backing store (not an always-null stub)
// since this whole feature is localStorage-driven — a small in-memory
// Map-backed implementation, reset per test in beforeEach.
const _store = new Map();
globalThis.localStorage = {
  getItem: k => (_store.has(k) ? _store.get(k) : null),
  setItem: (k, v) => { _store.set(k, String(v)); },
  removeItem: k => { _store.delete(k); },
};
globalThis.navigator ??= { language: 'en-US' };

const { S } = await import('../public-src/state.js');
const {
  STORAGE_KEY, MAX_MAIN_BAR, DEFAULT_MAIN_BAR, ALL_IDS,
  getBottomNavConfig, setBottomNavConfig, computeSettingsRows, renderBottomNav,
} = await import('../public-src/components/bottom-nav.js');
const { updatePowerButton } = await import('../public-src/components/status.js');

beforeEach(() => {
  _store.clear();
  S.currentMode = 'shots';
});

describe('getBottomNavConfig — parse/fallback (#443)', () => {
  it('reproduces exactly today\'s fixed set when the key is missing', () => {
    expect(getBottomNavConfig()).toEqual(['shots', 'live', 'library', 'analytics']);
    expect(getBottomNavConfig()).toEqual(DEFAULT_MAIN_BAR);
  });

  it('reproduces the default set when the stored value is an empty array', () => {
    _store.set(STORAGE_KEY, JSON.stringify([]));
    expect(getBottomNavConfig()).toEqual(DEFAULT_MAIN_BAR);
  });

  it('reproduces the default set when the stored value is corrupted JSON', () => {
    _store.set(STORAGE_KEY, '{not valid json[');
    expect(getBottomNavConfig()).toEqual(DEFAULT_MAIN_BAR);
  });

  it('reproduces the default set when the stored value is valid JSON but not an array', () => {
    _store.set(STORAGE_KEY, JSON.stringify({ shots: true }));
    expect(getBottomNavConfig()).toEqual(DEFAULT_MAIN_BAR);
  });

  it('reproduces the default set when the stored array contains only unknown ids', () => {
    _store.set(STORAGE_KEY, JSON.stringify(['frobnicate', 'wat']));
    expect(getBottomNavConfig()).toEqual(DEFAULT_MAIN_BAR);
  });

  it('parses a valid custom selection as-is (shots already first)', () => {
    _store.set(STORAGE_KEY, JSON.stringify(['shots', 'maintenance', 'orders', 'settings']));
    expect(getBottomNavConfig()).toEqual(['shots', 'maintenance', 'orders', 'settings']);
  });

  it('drops unknown ids and duplicates while keeping the valid, deduped order', () => {
    _store.set(STORAGE_KEY, JSON.stringify(['shots', 'bogus', 'library', 'library', 'analytics']));
    expect(getBottomNavConfig()).toEqual(['shots', 'library', 'analytics']);
  });

  it('shots is always present and first, even if the stored config omits it', () => {
    _store.set(STORAGE_KEY, JSON.stringify(['maintenance', 'orders', 'settings']));
    expect(getBottomNavConfig()).toEqual(['shots', 'maintenance', 'orders', 'settings']);
  });

  it('shots is always forced to first, even if stored elsewhere in the array', () => {
    _store.set(STORAGE_KEY, JSON.stringify(['library', 'shots', 'analytics']));
    expect(getBottomNavConfig()[0]).toBe('shots');
  });

  it('truncates a stored selection longer than 4 to MAX_MAIN_BAR, shots first', () => {
    _store.set(STORAGE_KEY, JSON.stringify(['shots', 'live', 'library', 'analytics', 'dialin', 'maintenance']));
    const config = getBottomNavConfig();
    expect(config).toHaveLength(MAX_MAIN_BAR);
    expect(config).toEqual(['shots', 'live', 'library', 'analytics']);
  });
});

describe('setBottomNavConfig — same validation, persisted', () => {
  it('persists a valid selection and returns the normalized array', () => {
    const result = setBottomNavConfig(['shots', 'dialin', 'settings']);
    expect(result).toEqual(['shots', 'dialin', 'settings']);
    expect(getBottomNavConfig()).toEqual(['shots', 'dialin', 'settings']);
  });

  it('enforces max 4 even if the caller passes more', () => {
    const result = setBottomNavConfig(['shots', 'live', 'library', 'analytics', 'dialin']);
    expect(result).toHaveLength(MAX_MAIN_BAR);
  });

  it('forces shots to slot 1 even if the caller omits or misplaces it', () => {
    expect(setBottomNavConfig(['library', 'analytics'])[0]).toBe('shots');
    expect(setBottomNavConfig(['library', 'shots', 'analytics'])[0]).toBe('shots');
  });
});

describe('computeSettingsRows — max-4 enforcement + reorder boundaries (#443)', () => {
  it('disables every unselected checkbox once 4 are already selected', () => {
    const rows = computeSettingsRows(['shots', 'live', 'library', 'analytics']);
    const unselected = rows.filter(r => !r.isSelected);
    expect(unselected).toHaveLength(ALL_IDS.length - MAX_MAIN_BAR);
    expect(unselected.every(r => r.checkDisabled)).toBe(true);
  });

  it('leaves unselected checkboxes enabled when there is room', () => {
    const rows = computeSettingsRows(['shots', 'library']);
    const unselected = rows.filter(r => !r.isSelected);
    expect(unselected.every(r => r.checkDisabled)).toBe(false);
  });

  it('shots\' own checkbox is always disabled (mandatory, always slot 1)', () => {
    const rows = computeSettingsRows(['shots']);
    const shotsRow = rows.find(r => r.id === 'shots');
    expect(shotsRow.isSelected).toBe(true);
    expect(shotsRow.checkDisabled).toBe(true);
  });

  it('shots can never move up or down', () => {
    const rows = computeSettingsRows(['shots', 'live', 'library']);
    const shotsRow = rows.find(r => r.id === 'shots');
    expect(shotsRow.canMoveUp).toBe(false);
    expect(shotsRow.canMoveDown).toBe(false);
  });

  it('the first selected item after shots cannot move up (would swap into the shots slot)', () => {
    const rows = computeSettingsRows(['shots', 'live', 'library']);
    expect(rows.find(r => r.id === 'live').canMoveUp).toBe(false);
    expect(rows.find(r => r.id === 'live').canMoveDown).toBe(true);
  });

  it('the last selected item cannot move down', () => {
    const rows = computeSettingsRows(['shots', 'live', 'library']);
    expect(rows.find(r => r.id === 'library').canMoveDown).toBe(false);
    expect(rows.find(r => r.id === 'library').canMoveUp).toBe(true);
  });
});

// ── Minimal fake DOM for renderBottomNav()/status.js interaction tests ─────
// This repo has no jsdom/happy-dom dependency (vitest runs with
// environment: 'node') — build just enough of a DOM to support the
// createElement/appendChild/classList/style/setAttribute calls
// renderBottomNav() and status.js's updatePowerButton() actually make,
// mirroring the "fake minimal document" convention already used in
// test/sidebar-month-toggle.test.js and test/library-profile-editor.test.js.
function makeFakeDocument() {
  const registry = new Map();
  function makeElement() {
    const el = {
      className: '',
      style: {},
      dataset: {},
      _attrs: {},
      _listeners: {},
      set id(v) { this._id = v; registry.set(v, el); },
      get id() { return this._id; },
      set innerHTML(v) { this._innerHTML = v; },
      get innerHTML() { return this._innerHTML; },
      appendChild(child) { (el._children ||= []).push(child); return child; },
      setAttribute(k, v) { el._attrs[k] = v; },
      getAttribute(k) { return el._attrs[k]; },
      addEventListener(evt, fn) { (el._listeners[evt] ||= []).push(fn); },
      click() { (el._listeners.click || []).forEach(fn => fn({})); },
      classList: {
        _set: new Set(),
        toggle(cls, force) {
          const on = force === undefined ? !this._set.has(cls) : !!force;
          if (on) this._set.add(cls); else this._set.delete(cls);
          return on;
        },
        contains(cls) { return this._set.has(cls); },
      },
    };
    return el;
  }
  return {
    _registry: registry,
    createElement: makeElement,
    getElementById: id => registry.get(id),
    _preRegister(id) {
      const el = makeElement();
      el.id = id;
      return el;
    },
  };
}

describe('renderBottomNav — renders exactly the configured set (#443)', () => {
  let doc;

  beforeEach(() => {
    doc = makeFakeDocument();
    doc._preRegister('bottom-nav');
    doc._preRegister('moreSheet');
    globalThis.document = doc;
  });

  it('an unusual combination (shots, maintenance, orders, settings) puts exactly those in the bar and the rest in Mehr', () => {
    setBottomNavConfig(['shots', 'maintenance', 'orders', 'settings']);
    renderBottomNav();

    const bar = doc.getElementById('bottom-nav');
    const barIds = bar._children.map(c => c.id);
    // bnMore is always appended after the configured main-bar items.
    expect(barIds).toEqual(['bnShots', 'bnMaintenance', 'bnOrders', 'bnSettings', 'bnMore']);

    const sheet = doc.getElementById('moreSheet');
    const sheetIds = sheet._children.map(c => c.id);
    expect(sheetIds).toEqual(['bnLive', 'bnLibrary', 'bnAnalytics', 'bnDialin']);
  });

  it('the default (untouched) config still produces today\'s exact bar/sheet split', () => {
    renderBottomNav();
    const barIds = doc.getElementById('bottom-nav')._children.map(c => c.id);
    const sheetIds = doc.getElementById('moreSheet')._children.map(c => c.id);
    expect(barIds).toEqual(['bnShots', 'bnLive', 'bnLibrary', 'bnAnalytics', 'bnMore']);
    expect(sheetIds).toEqual(['bnDialin', 'bnMaintenance', 'bnOrders', 'bnSettings']);
  });
});

describe('capability gate stays authoritative over the user\'s selection (#443)', () => {
  let doc;

  beforeEach(() => {
    doc = makeFakeDocument();
    doc._preRegister('bottom-nav');
    doc._preRegister('moreSheet');
    // Desktop topbar's own Live control — updatePowerButton() touches it
    // unconditionally; unrelated to this test but must exist or it throws.
    doc._preRegister('btnLive');
    doc._preRegister('powerBtn');
    globalThis.document = doc;
  });

  it('putting "live" in the main bar does not show it while the machine is off', () => {
    setBottomNavConfig(['shots', 'live', 'library', 'analytics']);
    renderBottomNav();
    const bnLive = doc.getElementById('bnLive');
    // Rendered hidden-by-default, same as the old static markup, until a
    // capability check says otherwise.
    expect(bnLive.style.display).toBe('none');

    updatePowerButton({ configured: true, state: false }); // machine off
    expect(bnLive.style.display).toBe('none');
  });

  it('the same bnLive node is shown once the machine turns on, with no bottom-nav re-render needed', () => {
    setBottomNavConfig(['shots', 'live', 'library', 'analytics']);
    renderBottomNav();
    const bnLive = doc.getElementById('bnLive');

    updatePowerButton({ configured: true, state: false });
    expect(bnLive.style.display).toBe('none');

    // status.js's own poll re-invokes updatePowerButton() on the *existing*
    // DOM node — no call to renderBottomNav() here, mirroring how the app
    // actually reacts to a ~30s status poll tick.
    updatePowerButton({ configured: true, state: true });
    expect(bnLive.style.display).toBe('');
  });

  it('"live" placed in the Mehr sheet (not the main bar) is gated identically — same id, different container', () => {
    setBottomNavConfig(['shots', 'maintenance', 'orders', 'settings']); // live falls into Mehr
    renderBottomNav();
    const bnLive = doc.getElementById('bnLive');
    expect(doc.getElementById('moreSheet')._children).toContain(bnLive);

    updatePowerButton({ configured: true, state: false });
    expect(bnLive.style.display).toBe('none');
    updatePowerButton({ configured: true, state: true });
    expect(bnLive.style.display).toBe('');
  });
});
