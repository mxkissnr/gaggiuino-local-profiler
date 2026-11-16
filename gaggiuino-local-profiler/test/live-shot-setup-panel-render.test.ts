// Covers renderLiveShotSetupPanel(): it must (1) reflect a persisted draft
// into the dose/grind-setting inputs and the bean/basket/puckscreen/recipe
// selects on every call, and (2) wire each field's change/input listener
// exactly once (the _lsWired guard) so re-renders don't pile up duplicate
// listeners that would each independently write the same draft key. Same
// fake-document harness as the sibling live.ts test files.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FakeOption } from './helpers/fake-option-dom.js';
import type { GrindScale } from '../public-src/grind-scale.js';

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
  hidden: boolean;
  options: FakeOption[];
  onchange: (() => void) | null;
  classList: { add: () => void; remove: () => void; contains: () => boolean; toggle: () => void };
  querySelector: () => null;
  selectedOptions: { dataset: Record<string, string> }[];
  addEventListener: (type: string, cb: () => void) => void;
  removeEventListener: () => void;
  replaceChildren: (frag: { children: FakeOption[] }) => void;
  setAttribute: (name: string, value: string) => void;
  removeAttribute: (name: string) => void;
  _fire: (type: string) => void;
  _listenerCount: (type: string) => number;
}

function makeFakeDocument() {
  const registry = new Map<string, FakeElement>();
  function makeElement(): FakeElement {
    const listeners: Record<string, Array<() => void>> = {};
    const node: FakeElement = {
      className: '', textContent: '', style: {}, value: '', hidden: false, options: [], onchange: null,
      classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
      querySelector: () => null,
      selectedOptions: [],
      // The grind field builds its options with new Option() + a fragment.
      replaceChildren(frag) { node.options = frag.children; },
      setAttribute() {},
      removeAttribute() {},
      // Keep every listener per event type rather than overwriting the previous
      // one, so a double-wired field (a broken _lsWired guard) is observable.
      addEventListener(type, cb) { (listeners[type] ??= []).push(cb); },
      removeEventListener() {},
      _fire(type) { listeners[type]?.forEach(cb => cb()); },
      _listenerCount(type) { return listeners[type]?.length ?? 0; },
    };
    return node;
  }
  return {
    getElementById: (id: string): FakeElement => {
      if (!registry.has(id)) registry.set(id, makeElement());
      return registry.get(id)!;
    },
    createDocumentFragment: () => {
      const frag = { children: [] as FakeOption[], append: (v: FakeOption) => { frag.children.push(v); } };
      return frag;
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
  // plus a fresh dynamic import of both live.ts AND state/index.ts gives
  // each test its own _lsWired and its own S — re-importing only live.ts
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
    g.Option = FakeOption;

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
    expect(grindEl._listenerCount('input')).toBe(1);

    grindEl.value = '5.0';
    grindEl._fire('input');

    const raw = draftStore['glp_live_shot_setup_1'];
    if (raw === undefined) throw new Error('draft not persisted');
    const saved = JSON.parse(raw) as { grindSetting?: string };
    expect(saved.grindSetting).toBe('5.0');
  });

  it('wires every setup field exactly once, even across re-renders', () => {
    renderLiveShotSetupPanel();
    renderLiveShotSetupPanel(); // second render must not add a second listener

    // Double-wiring would be invisible to a fake that overwrote the previous
    // callback; the counting fake above makes it fail here instead.
    const wired: Array<[string, string]> = [
      ['lsToggle', 'click'],
      ['lsBean', 'change'],
      ['lsGrinder', 'change'],
      ['lsGrinderOther', 'input'],
      ['lsGrindSetting', 'input'],
      ['lsDose', 'input'],
      ['lsBasket', 'change'],
      ['lsPuckScreen', 'change'],
      ['lsRecipe', 'change'],
      ['lsReset', 'click'],
    ];
    for (const [id, type] of wired) {
      expect(doc.getElementById(id)._listenerCount(type)).toBe(1);
    }
  });

  it('scopes the draft storage key to the active machine', () => {
    draftStore['glp_live_shot_setup_2'] = JSON.stringify({ dose: 16 });
    S.activeMachineId = 2;

    renderLiveShotSetupPanel();

    expect(doc.getElementById('lsDose').value).toBe(16);
  });

  // #1961 slice 6 — the panel's grind field follows the draft grinder's scale.
  describe('grind field', () => {
    const STEPPED: GrindScale  = { type: 'stepped', min: 0, max: 10, step: 1 };
    const STEPLESS: GrindScale = { type: 'stepless', min: 0, max: 9, step: 0.1 };

    function setGrinders(grinders: Array<{ name: string; scale?: GrindScale }>): void {
      S.coffeeLibrary = { grinders, beans: [] };
    }

    afterEach(() => {
      S.coffeeLibrary = { grinders: [], beans: [] };
    });

    function savedGrind(): string | undefined {
      const raw = draftStore['glp_live_shot_setup_1'];
      if (raw === undefined) throw new Error('draft not persisted');
      return (JSON.parse(raw) as { grindSetting?: string }).grindSetting;
    }

    it('shows a stepped grinder\'s draft value in the dropdown and writes a pick back', () => {
      setGrinders([{ name: 'K6', scale: STEPPED }]);
      draftStore['glp_live_shot_setup_1'] = JSON.stringify({ grinder: 'K6', grindSetting: '3' });

      renderLiveShotSetupPanel();

      const select = doc.getElementById('grindSelect-lsGrindSetting');
      expect(select.hidden).toBe(false);
      expect(doc.getElementById('lsGrindSetting').hidden).toBe(true);
      expect(select.options.map(o => o.value)).toContain('3');
      expect(select.value).toBe('3');

      select.value = '6';
      select._fire('change');

      expect(savedGrind()).toBe('6');
    });

    it('accepts a comma decimal on a stepless grinder and keeps the last good value on a bad one', () => {
      setGrinders([{ name: 'Lagom', scale: STEPLESS }]);
      draftStore['glp_live_shot_setup_1'] = JSON.stringify({ grinder: 'Lagom', grindSetting: '5' });

      renderLiveShotSetupPanel();

      const input = doc.getElementById('lsGrindSetting');
      expect(input.hidden).toBe(false);

      input.value = '8,3';
      input._fire('input');
      expect(savedGrind()).toBe('8.3');

      input.value = '12';
      input._fire('input');
      expect(savedGrind()).toBe('8.3');
    });

    it('leaves an off-list stepped value in the draft unchanged', () => {
      setGrinders([{ name: 'K6', scale: STEPPED }]);
      draftStore['glp_live_shot_setup_1'] = JSON.stringify({ grinder: 'K6', grindSetting: '33.5' });

      renderLiveShotSetupPanel();

      const select = doc.getElementById('grindSelect-lsGrindSetting');
      const extra = select.options[1];
      expect(extra?.value).toBe('33.5');
      expect(select.value).toBe('33.5');

      doc.getElementById('lsDose').value = '20';
      doc.getElementById('lsDose')._fire('input');
      expect(savedGrind()).toBe('33.5');
    });
  });

  // #1954 — the bean change handler's grinder/grind-setting prefill. The
  // draft is written onto the next shot, so a value taken from a grinder the
  // user isn't pulling on would pollute that grinder's history.
  describe('bean change prefill', () => {
    function setLibrary(grinders: { name: string; isDefault?: boolean }[], beans: unknown[]): void {
      S.coffeeLibrary = { grinders, beans } as unknown as typeof S.coffeeLibrary;
    }

    function pickBean(beanId: string, coffee: string): void {
      renderLiveShotSetupPanel();
      const beanSelect = doc.getElementById('lsBean');
      beanSelect.value = coffee;
      beanSelect.selectedOptions = [{ dataset: { beanId } }];
      beanSelect._fire('change');
    }

    function savedDraft(): { grinder?: string; grindSetting?: string } {
      const raw = draftStore['glp_live_shot_setup_1'];
      if (raw === undefined) throw new Error('draft not persisted');
      return JSON.parse(raw) as { grinder?: string; grindSetting?: string };
    }

    it('without a default copies the bean\'s first known entry, as before', () => {
      setLibrary([{ name: 'Old Grinder' }], [{
        id: 42,
        name: 'Bean A',
        knownGrindSettings: [{ grinder: 'Old Grinder', grindSetting: '12' }],
      }]);

      pickBean('42', 'Bean A');

      expect(savedDraft()).toMatchObject({ grinder: 'Old Grinder', grindSetting: '12' });
    });

    it('with a default and no history takes the default grinder and an empty setting', () => {
      setLibrary(
        [{ name: 'Old Grinder' }, { name: 'New Grinder', isDefault: true }],
        [{
          id: 42,
          name: 'Bean A',
          knownGrindSettings: [{ grinder: 'Old Grinder', grindSetting: '12' }],
        }],
      );

      pickBean('42', 'Bean A');

      expect(savedDraft().grinder).toBe('New Grinder');
      expect(savedDraft().grindSetting).toBe('');
    });

    it('with a default and its own known entry takes that value', () => {
      setLibrary(
        [{ name: 'Old Grinder' }, { name: 'New Grinder', isDefault: true }],
        [{
          id: 42,
          name: 'Bean A',
          knownGrindSettings: [
            { grinder: 'Old Grinder', grindSetting: '12' },
            { grinder: 'New Grinder', grindSetting: '24' },
          ],
        }],
      );

      pickBean('42', 'Bean A');

      expect(savedDraft()).toMatchObject({ grinder: 'New Grinder', grindSetting: '24' });
    });

    it('never overwrites a draft that already has a grinder', () => {
      setLibrary(
        [{ name: 'New Grinder', isDefault: true }],
        [{ id: 42, name: 'Bean A', knownGrindSettings: [{ grinder: 'New Grinder', grindSetting: '24' }] }],
      );
      draftStore['glp_live_shot_setup_1'] = JSON.stringify({ grinder: 'Manual Grinder' });

      pickBean('42', 'Bean A');

      expect(savedDraft()).toMatchObject({ grinder: 'Manual Grinder' });
    });
  });
});
