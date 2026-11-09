import { describe, it, expect, beforeEach, vi } from 'vitest';
import { installBootStubs, stub } from './helpers/boot-stub-dom.js';
import type { GrindScale } from '../public-src/grind-scale.js';
import type { LibraryRow } from '../public-src/state/index.js';

// #1961: the annotation panel's grind field follows the selected grinder's
// scale. Same harness as annotation-grinder-select.test.ts — the boot stub
// installs the globals the module graph reads at load, and each case swaps
// `document` for its own fakes, because vitest's node environment has no DOM.
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };
g.navigator    ??= { language: 'en-US' };
installBootStubs();

class FakeOption {
  text: string;
  value: string;
  selected: boolean;
  dataset: Record<string, unknown> = {};
  constructor(text: string, value: string | number, _defaultSelected = false, selected = false) {
    this.text = text;
    this.value = String(value);
    this.selected = selected;
  }
}

type Handler = () => void;

interface FakeEl {
  value: string;
  hidden: boolean;
  innerHTML: unknown;
  textContent: string;
  style: Record<string, string>;
  dataset: Record<string, string>;
  attrs: Record<string, string>;
  selectedOptions: { dataset: Record<string, string> }[];
  listeners: Record<string, Handler[]>;
  options: FakeOption[];
  onchange: (() => void) | null;
  addEventListener(name: string, fn: Handler): void;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  replaceChildren(frag?: unknown): void;
  querySelectorAll(selector: string): FakeEl[];
}

function makeEl(overrides: Partial<FakeEl> = {}): FakeEl {
  const node: FakeEl = {
    value: '', hidden: false, innerHTML: '', textContent: '', style: {}, dataset: {}, attrs: {},
    selectedOptions: [{ dataset: {} }],
    listeners: {},
    options: [],
    onchange: null,
    addEventListener(name, fn) { (node.listeners[name] ??= []).push(fn); },
    setAttribute(name, value) { node.attrs[name] = value; },
    removeAttribute(name) { delete node.attrs[name]; },
    querySelectorAll: () => [],
    replaceChildren(frag?: unknown) {
      const collected = (frag as { nodes?: unknown[] } | undefined)?.nodes ?? [];
      node.options = collected as FakeOption[];
      node.value = node.options.find(o => o.selected)?.value ?? '';
    },
    ...overrides,
  };
  return node;
}

function fire(node: FakeEl, name: string): void {
  const handlers = node.listeners[name];
  if (!handlers?.length) throw new Error(`no ${name} listener registered`);
  for (const handler of handlers) handler();
}

const ANN_IDS = [
  'annCoffee', 'annBasket', 'annPuckScreen', 'annFrozenPortionId',
  'annGrinder', 'annGrinderOther', 'annGrindSetting', 'annDose', 'annTds', 'annNotes',
  'annTasteTag', 'annDrinkType', 'annMilkType', 'annRecipe',
  'annMixRows', 'annMixAddBtn', 'annPhotoThumb', 'annPhotoRemoveBtn', 'annPhotoAdjustBtn',
];

let els: Record<string, FakeEl>;

function el(id: string): FakeEl {
  const node = els[id];
  if (!node) throw new Error(`no fake element: ${id}`);
  return node;
}

const { S } = await import('../public-src/state/index.js');
const apiModule = await import('../public-src/api/transport.js');
// r.ok:false keeps the save from reaching the post-save sidebar re-render; the
// payload handed to apiFetch is captured either way.
const fetchSpy = vi.spyOn(apiModule, 'apiFetch').mockResolvedValue({ ok: false } as Response);
const {
  renderAnnotationPanel, quickClone,
  scheduleAutoSave, flushAutoSave,
} = await import('../public-src/views/shots/annotation.js');
const { wireAnnotationPanel } = await import('../public-src/boot/annotation.js');
const mix = await import('../public-src/views/shots/annotation-mix.js');
const { getGrindFieldValue, grindSelectId } = await import('../public-src/views/shots/grind-field.js');
const { updateLibraryDatalist } = await import('../public-src/views/library.js');

interface Payload { grinder: string; grindSetting: string; notes: string }

function savedPayload(): Payload {
  const call = fetchSpy.mock.calls[0];
  if (!call) throw new Error('no save request was sent');
  return JSON.parse(call[1]?.body as string) as Payload;
}

interface TestGrinder { id: number; name: string; isDefault?: boolean; scale?: GrindScale }

function setGrinders(grinders: TestGrinder[]): void {
  S.coffeeLibrary.grinders = grinders as unknown as LibraryRow[];
}

function setScale(name: string, scale: GrindScale): void {
  const grinder = (S.coffeeLibrary.grinders as unknown as TestGrinder[]).find(g => g.name === name);
  if (!grinder) throw new Error(`no grinder ${name}`);
  grinder.scale = scale;
}

// The save runs unawaited (as in the app), so let its promise chain finish.
async function drain(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

async function save(): Promise<Payload> {
  scheduleAutoSave();
  flushAutoSave();
  await drain();
  return savedPayload();
}

const STEPPED_0_4: GrindScale  = { type: 'stepped', min: 0, max: 4, step: 1 };
const STEPPED_0_60: GrindScale = { type: 'stepped', min: 0, max: 60, step: 1 };
const STEPPED_0_10: GrindScale = { type: 'stepped', min: 0, max: 10, step: 1 };
const STEPLESS_0_9: GrindScale = { type: 'stepless', min: 0, max: 9, step: 0.1 };

function panel(ann: Record<string, unknown>, grinder = 'K6'): void {
  renderAnnotationPanel({ id: 1, timestamp: 1700000000, annotation: { grinder, ...ann } });
}

beforeEach(async () => {
  // A pending debounce from the previous case must not run a save against this
  // case's DOM: with no primary shot, flushAutoSave() drops it without saving.
  S.primaryShotId = 0;
  flushAutoSave();
  await drain();
  fetchSpy.mockClear();
  els = {};
  for (const id of ANN_IDS) els[id] = makeEl();
  // The grind field's companions are static markup in index.html: the dropdown
  // starts hidden and the hint reads empty.
  els[grindSelectId('annGrindSetting')] = makeEl({ hidden: true });
  els['grindHint-annGrindSetting'] = makeEl({ hidden: true });
  g.document = {
    getElementById: (id: string) => (id in els ? el(id) : stub()),
    createDocumentFragment: () => {
      const frag = { nodes: [] as unknown[], append: (node: unknown) => { frag.nodes.push(node); } };
      return frag;
    },
    body: stub(),
    createElement: () => stub(),
    querySelectorAll: () => [],
    activeElement: null,
  };
  g.Option = FakeOption;
  S.shots = [{ id: 1, timestamp: 1700000000, annotation: {} }];
  S.primaryShotId = 1;
  S.shotDefaults = null;
  S.coffeeLibrary = {
    beans: [{ id: 11, name: 'Bean A', remainingG: 250 }],
    grinders: [],
    baskets: [], puckScreens: [], recipes: [],
  };
  mix.resetBeanMix();
});

describe('the annotation grind field on a stepped grinder', () => {
  beforeEach(() => { setGrinders([{ id: 1, name: 'K6', scale: STEPPED_0_4 }]); });

  it('shows the dropdown, hides the text input and saves a picked click', async () => {
    panel({ grindSetting: '2' });

    const select = el(grindSelectId('annGrindSetting'));
    expect(select.hidden).toBe(false);
    expect(el('annGrindSetting').hidden).toBe(true);
    expect(select.options.map(o => o.value)).toEqual(['', '0', '1', '2', '3', '4']);
    expect(select.value).toBe('2');

    wireAnnotationPanel();
    select.value = '3';
    fire(select, 'change');
    expect((await save()).grindSetting).toBe('3');
  });

  it('shows a stored off-list value as its own option and saves it byte for byte', async () => {
    setGrinders([{ id: 1, name: 'K6', scale: STEPPED_0_60 }]);
    panel({ grindSetting: '33.5' });

    const select = el(grindSelectId('annGrindSetting'));
    const extra = select.options[1];
    expect(extra?.value).toBe('33.5');
    expect(extra?.text).toBe('33.5 (not on this scale)');
    expect(select.value).toBe('33.5');

    // An autosave that never touched the field must not rewrite the value.
    expect((await save()).grindSetting).toBe('33.5');
  });

  it('keeps the stored spelling of a value that is on the list', async () => {
    setGrinders([{ id: 1, name: 'K6', scale: STEPPED_0_60 }]);
    panel({ grindSetting: '8.0' });

    expect(el(grindSelectId('annGrindSetting')).value).toBe('8');
    expect((await save()).grindSetting).toBe('8.0');
  });
});

describe('the annotation grind field on a stepless grinder', () => {
  beforeEach(() => { setGrinders([{ id: 1, name: 'K6', scale: STEPLESS_0_9 }]); });

  it('accepts a decimal typed with a comma', async () => {
    panel({ grindSetting: '' });
    expect(el('annGrindSetting').hidden).toBe(false);
    expect(el('annGrindSetting').attrs.inputmode).toBe('decimal');

    el('annGrindSetting').value = '8,3';
    expect((await save()).grindSetting).toBe('8.3');
  });

  it('shows the hint for an out-of-range entry and saves the last good value', async () => {
    panel({ grindSetting: '5' });
    wireAnnotationPanel();

    el('annGrindSetting').value = '12';
    el('annNotes').value = 'still saved';
    fire(el('annGrindSetting'), 'input');

    const hint = el('grindHint-annGrindSetting');
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toBe('Enter a value from 0 to 9 in steps of 0.1.');

    const payload = await save();
    expect(payload.grindSetting).toBe('5');
    expect(payload.notes).toBe('still saved');
  });

  it('saves a stored out-of-range value unchanged when another field changes', async () => {
    panel({ grindSetting: '12' });
    expect(el('annGrindSetting').value).toBe('12');

    el('annNotes').value = 'a note';
    expect((await save()).grindSetting).toBe('12');
  });
});

describe('the annotation grind field without a scale', () => {
  beforeEach(() => { setGrinders([{ id: 1, name: 'K6' }]); });

  it('round-trips free text verbatim and never shows the dropdown', async () => {
    panel({ grindSetting: '1.2.3' });

    expect(el('annGrindSetting').hidden).toBe(false);
    expect(el('annGrindSetting').value).toBe('1.2.3');
    expect(el(grindSelectId('annGrindSetting')).hidden).toBe(true);
    expect((await save()).grindSetting).toBe('1.2.3');
  });

  it('saves typed free text verbatim', async () => {
    panel({ grindSetting: '' });
    el('annGrindSetting').value = 'rotation.2.click';

    expect((await save()).grindSetting).toBe('rotation.2.click');
  });
});

describe('the default-grinder prefill (#1954) on a scaled grinder', () => {
  function lastShot(grindSetting: string): void {
    S.shots = [
      { id: 1, timestamp: 1700000000, annotation: { coffee: 'Bean A', beanId: 11, grinder: 'DF64', grindSetting, dose: 18 } },
      { id: 2, timestamp: 1700000100, annotation: {} },
    ];
    S.primaryShotId = 2;
  }

  it('clones a last value onto the default grinder as a valid click', async () => {
    setGrinders([{ id: 1, name: 'DF64', isDefault: true, scale: STEPPED_0_60 }]);
    lastShot('33.5');

    quickClone();

    expect(el(grindSelectId('annGrindSetting')).hidden).toBe(false);
    expect(el(grindSelectId('annGrindSetting')).value).toBe('34');
    expect((await save()).grindSetting).toBe('34');
  });

  it('leaves the field empty when the last value is off the scale', async () => {
    setGrinders([{ id: 1, name: 'DF64', isDefault: true, scale: STEPPED_0_60 }]);
    lastShot('70');

    quickClone();

    expect(el(grindSelectId('annGrindSetting')).value).toBe('');
    expect((await save()).grindSetting).toBe('');
  });

  it('prefills the same way from the bean-change handler', async () => {
    setGrinders([{ id: 1, name: 'DF64', isDefault: true, scale: STEPPED_0_60 }]);
    lastShot('33.5');
    wireAnnotationPanel();

    el('annCoffee').value = 'Bean A';
    fire(el('annCoffee'), 'change');

    expect(el(grindSelectId('annGrindSetting')).value).toBe('34');
    expect((await save()).grindSetting).toBe('34');
  });

  it('keeps the old free-text prefill for a default grinder without a scale', async () => {
    setGrinders([{ id: 1, name: 'DF64', isDefault: true }]);
    lastShot('22 clicks');

    quickClone();

    expect(el('annGrindSetting').hidden).toBe(false);
    expect(el('annGrindSetting').value).toBe('22 clicks');
    expect((await save()).grindSetting).toBe('22 clicks');
  });
});

describe('the annotation grind field follows a grinder change', () => {
  it('swaps the control and shows the value off-list on the new scale', () => {
    setGrinders([
      { id: 1, name: 'Wide', scale: STEPPED_0_60 },
      { id: 2, name: 'Narrow', scale: STEPPED_0_10 },
    ]);
    panel({ grindSetting: '20' }, 'Wide');
    wireAnnotationPanel();

    expect(el(grindSelectId('annGrindSetting')).value).toBe('20');

    el('annGrinder').value = 'Narrow';
    fire(el('annGrinder'), 'change');

    const select = el(grindSelectId('annGrindSetting'));
    expect(select.value).toBe('20');
    expect(select.options[1]?.text).toBe('20 (not on this scale)');
  });
});

describe('updateLibraryDatalist applies a changed scale (#1961, #1958)', () => {
  it('swaps the control of the open panel when the scale changed', () => {
    setGrinders([{ id: 1, name: 'K6', scale: STEPPED_0_60 }]);
    panel({ grindSetting: '5' });
    expect(el('annGrindSetting').hidden).toBe(true);

    setScale('K6', STEPLESS_0_9);
    updateLibraryDatalist();

    expect(el('annGrindSetting').hidden).toBe(false);
    expect(el(grindSelectId('annGrindSetting')).hidden).toBe(true);
    expect(el('annGrindSetting').attrs.inputmode).toBe('decimal');
    expect(el('annGrindSetting').value).toBe('5');
  });

  it('keeps an untouched off-list value', () => {
    setGrinders([{ id: 1, name: 'K6', scale: STEPPED_0_60 }]);
    panel({ grindSetting: '33.5' });

    updateLibraryDatalist();

    expect(el(grindSelectId('annGrindSetting')).value).toBe('33.5');
    expect(getGrindFieldValue('annGrindSetting')).toBe('33.5');
  });

  it('keeps a typed value that has not been saved yet', () => {
    // Only a stepless field can be typed into — on a stepped one the visible
    // control is the dropdown, so the input's value is not the user's entry.
    setGrinders([{ id: 1, name: 'K6', scale: STEPLESS_0_9 }]);
    panel({ grindSetting: '5' });
    el('annGrindSetting').value = '6';

    updateLibraryDatalist();

    expect(el('annGrindSetting').value).toBe('6');
    expect(getGrindFieldValue('annGrindSetting')).toBe('6');
  });

  it('leaves the field alone while the user is in it', () => {
    setGrinders([{ id: 1, name: 'K6', scale: STEPLESS_0_9 }]);
    panel({ grindSetting: '5' });
    (g.document as { activeElement: unknown }).activeElement = el('annGrindSetting');

    setScale('K6', STEPPED_0_10);
    updateLibraryDatalist();

    expect(el('annGrindSetting').hidden).toBe(false);
    expect(el(grindSelectId('annGrindSetting')).hidden).toBe(true);
  });
});
