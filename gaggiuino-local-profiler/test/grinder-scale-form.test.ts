import { describe, it, expect, beforeEach, vi } from 'vitest';
import { installBootStubs } from './helpers/boot-stub-dom.js';
import type { Grinder } from '../public-src/api/types.js';
import type { GrindScale } from '../public-src/grind-scale.js';
import type { GrinderRow } from '../public-src/views/library/grinders.js';

// #1961: the grinder form's scale fields. grinders.ts pulls in state/i18n and,
// through views/library.ts, the whole library view graph — the boot stub
// installs the globals those read at module load, and each case swaps
// `document` for its own fake, as library-shelf-classify.test.ts does.
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };
g.navigator    ??= { language: 'en-US' };
installBootStubs();

const mocks = vi.hoisted(() => ({ saveGrinder: vi.fn() }));

vi.mock('../public-src/api/library.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../public-src/api/library.js')>()),
  saveGrinder: mocks.saveGrinder,
}));

interface FakeEl {
  value: string;
  hidden: boolean;
  innerHTML: string;
  textContent: string;
  className: string;
  style: Record<string, string>;
  dataset: Record<string, string>;
  attrs: Record<string, string>;
  checked: boolean;
  classList: { add(): void; remove(): void; toggle(): void; contains(): boolean };
  addEventListener(): void;
  removeEventListener(): void;
  appendChild(): void;
  insertBefore(): void;
  remove(): void;
  focus(): void;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  getAttribute(): null;
  querySelectorAll(): never[];
  replaceChildren(frag?: unknown): void;
  options: unknown[];
  onclick: ((e: unknown) => void) | null;
}

function makeEl(overrides: Partial<FakeEl> = {}): FakeEl {
  return {
    value: '', hidden: false, innerHTML: '', textContent: '', className: '', style: {}, dataset: {},
    attrs: {}, checked: false, options: [], onclick: null,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {}, removeEventListener() {},
    appendChild() {}, insertBefore() {}, remove() {}, focus() {},
    setAttribute(name, value) { this.attrs[name] = value; },
    removeAttribute(name) { delete this.attrs[name]; },
    getAttribute: () => null,
    querySelectorAll: () => [],
    replaceChildren(frag?: unknown) {
      this.options = (frag as { nodes?: unknown[] } | undefined)?.nodes ?? [];
    },
    ...overrides,
  };
}

// The scale form's root: a browser creates the range inputs its markup carries,
// so the fake does the same for the ids (and their value attributes).
class FakeRoot {
  onclick: ((e: unknown) => void) | null = null;
  markup = '';
  readonly doc: FakeDocument;
  constructor(doc: FakeDocument) { this.doc = doc; }
  get innerHTML(): string { return this.markup; }
  set innerHTML(value: string) {
    this.markup = value;
    // A re-render without a scale carries value="" for all three, so clear
    // first: the regex only creates the nodes the markup names.
    for (const id of ['grinderFormScaleMin', 'grinderFormScaleMax', 'grinderFormScaleStep']) this.doc.node(id).value = '';
    for (const m of value.matchAll(/<input[^>]*id="([^"]*)"[^>]*value="([^"]*)"/g)) {
      this.doc.node(m[1] ?? '').value = m[2] ?? '';
    }
  }
}

class FakeDocument {
  nodes: Record<string, FakeEl> = {};
  roots: Record<string, FakeRoot> = {};
  activeElement: unknown = null;
  node(id: string): FakeEl { return (this.nodes[id] ??= makeEl()); }
  root(id: string): FakeRoot { return (this.roots[id] ??= new FakeRoot(this)); }
  getElementById(id: string): unknown { return id === 'grinderFormScale' ? this.root(id) : this.node(id); }
  createElement(): FakeEl { return makeEl(); }
  createDocumentFragment(): { nodes: unknown[]; append: (...n: unknown[]) => void } {
    const frag = { nodes: [] as unknown[], append: (...n: unknown[]) => { frag.nodes.push(...n); } };
    return frag;
  }
  querySelector(): null { return null; }
  querySelectorAll(): never[] { return []; }
  addEventListener(): void {}
  removeEventListener(): void {}
  body = makeEl();
}

const doc = new FakeDocument();

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
g.Option = FakeOption;

const { S } = await import('../public-src/state/index.js');
const { openGrinderForm, saveGrinder } = await import('../public-src/views/library/grinders.js');
const { renderGrindField, grindSelectId } = await import('../public-src/views/shots/grind-field.js');
const { scaleForGrinder } = await import('../public-src/grind-scale.js');
const { calcNextGrindSuggestion } = await import('../public-src/dialin-convergence.js');
g.document = doc;

// The whole module is mocked (not spied on): grinders.ts reads it through a
// namespace import, which a spy on the test's own handle would not replace.
const saveSpy = mocks.saveGrinder;
// Echoes the payload back, so the library holds exactly what was saved.
saveSpy.mockImplementation((id: number | null, payload: unknown) => Promise.resolve(
  { id: id ?? 7, ...(payload as Record<string, unknown>) } as unknown as Grinder));

const STEPPED_0_60: GrindScale = { type: 'stepped', min: 0, max: 60, step: 1 };
const STEPLESS_0_9: GrindScale = { type: 'stepless', min: 0, max: 9, step: 0.1 };

function el(id: string): FakeEl { return doc.node(id); }

function pickScaleType(type: string): void {
  const root = doc.root('grinderFormScale');
  root.onclick?.({ target: { closest: () => ({ dataset: { scaleType: type } }) } });
}

function setRange(min: string, max: string, step: string): void {
  el('grinderFormScaleMin').value = min;
  el('grinderFormScaleMax').value = max;
  el('grinderFormScaleStep').value = step;
}

function lastPayload(): Record<string, unknown> {
  const call = saveSpy.mock.calls.at(-1);
  if (!call) throw new Error('saveGrinder was never called');
  return call[1] as Record<string, unknown>;
}

function libraryGrinders(): GrinderRow[] {
  return S.coffeeLibrary.grinders as unknown as GrinderRow[];
}

beforeEach(() => {
  saveSpy.mockClear();
  doc.nodes = {};
  doc.roots = {};
  doc.activeElement = null;
  // The containers renderGrinderScaleForm writes into; the root's own innerHTML
  // setter only re-creates the range inputs.
  for (const id of ['grinderFormScaleType', 'grinderFormScaleRange', 'grinderFormScaleMin',
    'grinderFormScaleMax', 'grinderFormScaleStep', 'grinderFormScaleError']) doc.node(id);
  S.grinderEditId = null;
  S.coffeeLibrary = { beans: [], grinders: [], baskets: [], puckScreens: [], recipes: [] };
});

describe('saving the scale from the grinder form (#1961)', () => {
  it('sends scale: null when the none pill is selected', async () => {
    openGrinderForm(null);
    el('grinderFormName').value = 'K6';
    pickScaleType('stepped');
    pickScaleType('');

    await saveGrinder();

    expect(lastPayload().scale).toBeNull();
  });

  it('sends a stepless scale and stores the response in the library', async () => {
    openGrinderForm(null);
    el('grinderFormName').value = 'K6';
    pickScaleType('stepless');
    setRange('0', '9', '0.1');

    await saveGrinder();

    expect(lastPayload().scale).toEqual(STEPLESS_0_9);
    expect(libraryGrinders()[0]?.scale).toEqual(STEPLESS_0_9);
  });

  it('calls no API and shows the error for invalid values', async () => {
    openGrinderForm(null);
    el('grinderFormName').value = 'K6';
    pickScaleType('stepless');
    setRange('9', '2', '0.1');

    await saveGrinder();

    expect(saveSpy).not.toHaveBeenCalled();
    expect(el('grinderFormScaleError').hidden).toBe(false);
    expect(el('grinderFormScaleError').textContent).toBe('Check the range: From must be below To, and the step must fit inside it.');
  });

  it('shows a saved scale when the grinder is opened, and none for a grinder without one', () => {
    openGrinderForm({ id: 1, name: 'K6', scale: STEPPED_0_60 });
    expect(el('grinderFormScaleType').innerHTML).toContain('aria-pressed="true" data-scale-type="stepped"');
    expect(el('grinderFormScaleMin').value).toBe('0');
    expect(el('grinderFormScaleMax').value).toBe('60');
    expect(el('grinderFormScaleStep').value).toBe('1');
    expect(el('grinderFormScaleRange').hidden).toBe(false);

    openGrinderForm({ id: 2, name: 'Hand' });
    expect(el('grinderFormScaleType').innerHTML).toContain('aria-pressed="true" data-scale-type=""');
    expect(el('grinderFormScaleRange').hidden).toBe(true);
    expect(el('grinderFormScaleMin').value).toBe('');
  });
});

describe('a saved scale changes behaviour, not only the stored value (#1961)', () => {
  const rounds = [{ grindSetting: 8, seconds: 20 }];

  it('moves in whole clicks on stepped and on a 0.1 grid on stepless', async () => {
    openGrinderForm(null);
    el('grinderFormName').value = 'K6';
    pickScaleType('stepped');
    setRange('0', '60', '1');
    await saveGrinder();
    expect(lastPayload().scale).toEqual(STEPPED_0_60);
    expect(libraryGrinders()[0]?.scale).toEqual(STEPPED_0_60);

    renderGrindField('annGrindSetting', 'K6', '8');
    expect(el('annGrindSetting').hidden).toBe(true);
    expect(el(grindSelectId('annGrindSetting')).hidden).toBe(false);

    const stepped = calcNextGrindSuggestion(rounds, scaleForGrinder(libraryGrinders(), 'K6'));
    expect(stepped.nextGrind).toBe(6);
    expect(stepped.delta).toBe(-2);

    const saved = libraryGrinders()[0];
    if (!saved) throw new Error('no grinder was stored');
    openGrinderForm(saved);
    pickScaleType('stepless');
    setRange('0', '9', '0.1');
    await saveGrinder();
    expect(lastPayload().scale).toEqual(STEPLESS_0_9);
    expect(libraryGrinders()).toHaveLength(1);
    expect(libraryGrinders()[0]?.scale).toEqual(STEPLESS_0_9);

    renderGrindField('annGrindSetting', 'K6', '8');
    expect(el('annGrindSetting').hidden).toBe(false);
    expect(el(grindSelectId('annGrindSetting')).hidden).toBe(true);
    expect(el('annGrindSetting').attrs.inputmode).toBe('decimal');

    const stepless = calcNextGrindSuggestion(rounds, scaleForGrinder(libraryGrinders(), 'K6'));
    expect(stepless.nextGrind).toBe(7.7);
    expect(stepless.delta).toBe(-0.3);
  });
});
