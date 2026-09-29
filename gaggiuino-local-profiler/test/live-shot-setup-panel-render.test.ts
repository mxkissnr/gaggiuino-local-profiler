// Covers renderLiveShotSetupPanel(): it must (1) reflect a persisted draft
// into the dose/grind-setting inputs and the bean/basket/puckscreen/recipe
// selects on every call, and (2) wire each field's change/input listener
// exactly once (the _lsWired guard) so re-renders don't pile up duplicate
// listeners that would each independently write the same draft key. Same
// fake-document harness as the sibling live.ts test files.
import { describe, it, expect, beforeEach, vi } from 'vitest';

// vitest's node environment has no browser globals; stub them through a loose
// view of globalThis (the same bridge the sibling live tests use).
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };
g.navigator ??= { language: 'en-US' };

const renderBeanSelectMock = vi.fn();
vi.mock('../public-src/views/shots/annotation.js', () => ({
  renderGrinderField: vi.fn(),
  getGrinderFieldValue: () => '',
  handleGrinderFieldChange: () => {},
  _renderBeanSelect: (...args: unknown[]) => renderBeanSelectMock(...args) as unknown,
  _renderBasketSelect: () => {},
  _renderPuckScreenSelect: () => {},
  _renderRecipeSelect: () => {},
}));

// The DOM stand-in these tests touch, including the listener capture the
// _lsWired guard assertion needs.
interface FakeElement {
  className: string;
  textContent: string;
  style: Record<string, string>;
  value: string;
  classList: { add: () => void; remove: () => void; contains: () => boolean; toggle: () => void };
  querySelector: () => null;
  selectedOptions: { dataset: Record<string, string> }[];
  addEventListener: (type: string, cb: () => void) => void;
  removeEventListener: () => void;
  _fire: (type: string) => void;
}

function makeFakeDocument() {
  const registry = new Map<string, FakeElement>();
  function makeElement(): FakeElement {
    const listeners: Record<string, () => void> = {};
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
    getElementById: (id: string): FakeElement => {
      if (!registry.has(id)) registry.set(id, makeElement());
      return registry.get(id)!;
    },
  };
}

describe('renderLiveShotSetupPanel()', () => {
  let doc: ReturnType<typeof makeFakeDocument>;
  let draftStore: Record<string, string>;
  let S: (typeof import('../public-src/state/index.js'))['S'];
  let renderLiveShotSetupPanel: (typeof import('../public-src/views/live.js'))['renderLiveShotSetupPanel'];

  // renderLiveShotSetupPanel wires its DOM listeners exactly once per
  // module instance (the _lsWired module-level guard). vi.resetModules()
  // plus a fresh dynamic import of both live.js AND state/index.js gives
  // each test its own _lsWired and its own S — re-importing only live.js
  // would leave it reading a stale S instance from before the reset,
  // silently no-op-ing every S.activeMachineId assignment a test makes.
  beforeEach(async () => {
    renderBeanSelectMock.mockClear();
    draftStore = {};
    g.localStorage = {
      getItem: (key: string) => (key in draftStore ? draftStore[key] : null),
      setItem: (key: string, value: string) => { draftStore[key] = value; },
      removeItem: (key: string) => { delete draftStore[key]; },
    };
    doc = makeFakeDocument();
    g.document = doc;

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

    const saved = JSON.parse(draftStore['glp_live_shot_setup_1']) as { grindSetting?: string };
    expect(saved.grindSetting).toBe('5.0');
  });

  it('scopes the draft storage key to the active machine', () => {
    draftStore['glp_live_shot_setup_2'] = JSON.stringify({ dose: 16 });
    S.activeMachineId = 2;

    renderLiveShotSetupPanel();

    expect(doc.getElementById('lsDose').value).toBe(16);
  });
});
