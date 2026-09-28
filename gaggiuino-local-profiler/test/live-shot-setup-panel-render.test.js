// Covers renderLiveShotSetupPanel(): it must (1) reflect a persisted draft
// into the dose/grind-setting inputs and the bean/basket/puckscreen/recipe
// selects on every call, and (2) wire each field's change/input listener
// exactly once (the _lsWired guard) so re-renders don't pile up duplicate
// listeners that would each independently write the same draft key. Same
// fake-document harness as the sibling live.js test files.
import { describe, it, expect, beforeEach, vi } from 'vitest';

globalThis.localStorage ??= { getItem: () => null, setItem: () => {} };
globalThis.navigator ??= { language: 'en-US' };

const renderBeanSelectMock = vi.fn();
vi.mock('../public-src/views/shots/annotation.js', () => ({
  renderGrinderField: vi.fn(),
  getGrinderFieldValue: () => '',
  handleGrinderFieldChange: () => {},
  _renderBeanSelect: (...args) => renderBeanSelectMock(...args),
  _renderBasketSelect: () => {},
  _renderPuckScreenSelect: () => {},
  _renderRecipeSelect: () => {},
}));

function makeFakeDocument() {
  const registry = new Map();
  function makeElement() {
    const listeners = {};
    return {
      className: '', textContent: '', style: {}, value: '',
      classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
      querySelector: () => null,
      selectedOptions: [],
      addEventListener(type, cb) { listeners[type] = cb; },
      removeEventListener() {},
      _fire(type) { listeners[type]?.(); },
    };
  }
  return {
    getElementById: id => {
      if (!registry.has(id)) registry.set(id, makeElement());
      return registry.get(id);
    },
  };
}

describe('renderLiveShotSetupPanel()', () => {
  let doc;
  let draftStore;
  let S;
  let renderLiveShotSetupPanel;

  // renderLiveShotSetupPanel wires its DOM listeners exactly once per
  // module instance (the _lsWired module-level guard). vi.resetModules()
  // plus a fresh dynamic import of both live.js AND state/index.js gives
  // each test its own _lsWired and its own S — re-importing only live.js
  // would leave it reading a stale S instance from before the reset,
  // silently no-op-ing every S.activeMachineId assignment a test makes.
  beforeEach(async () => {
    renderBeanSelectMock.mockClear();
    draftStore = {};
    globalThis.localStorage = {
      getItem: key => (key in draftStore ? draftStore[key] : null),
      setItem: (key, value) => { draftStore[key] = value; },
      removeItem: key => { delete draftStore[key]; },
    };
    doc = makeFakeDocument();
    globalThis.document = doc;

    vi.resetModules();
    ({ S } = await import('../public-src/state/index.js'));
    ({ renderLiveShotSetupPanel } = await import('../public-src/views/live.js'));
    S.activeMachineId = 1;
    S.currentLang = 'en';
  });

  it('reflects a persisted draft into the dose/grind-setting inputs and the bean select', () => {
    draftStore['glp_live_shot_setup_1'] = JSON.stringify({
      coffee: 'Ethiopia Yirgacheffe', beanId: 42, dose: 18.2, grindSetting: '4.5',
    });

    renderLiveShotSetupPanel();

    expect(doc.getElementById('lsDose').value).toBe(18.2);
    expect(doc.getElementById('lsGrindSetting').value).toBe('4.5');
    expect(renderBeanSelectMock).toHaveBeenCalledWith('Ethiopia Yirgacheffe', 42, 'lsBean');
  });

  it('an empty draft clears the inputs back to blank rather than leaving stale values', () => {
    renderLiveShotSetupPanel();

    expect(doc.getElementById('lsDose').value).toBe('');
    expect(doc.getElementById('lsGrindSetting').value).toBe('');
    expect(renderBeanSelectMock).toHaveBeenCalledWith('', null, 'lsBean');
  });

  it('wires the grind-setting input listener once and persists edits to the per-machine draft key', () => {
    renderLiveShotSetupPanel();
    renderLiveShotSetupPanel(); // second render must not double-wire

    const grindEl = doc.getElementById('lsGrindSetting');
    grindEl.value = '5.0';
    grindEl._fire('input');

    const saved = JSON.parse(draftStore['glp_live_shot_setup_1']);
    expect(saved.grindSetting).toBe('5.0');
  });

  it('scopes the draft storage key to the active machine', () => {
    draftStore['glp_live_shot_setup_2'] = JSON.stringify({ dose: 16 });
    S.activeMachineId = 2;

    renderLiveShotSetupPanel();

    expect(doc.getElementById('lsDose').value).toBe(16);
  });
});
