import { describe, it, expect, beforeEach, vi } from 'vitest';
import { installBootStubs, stub } from './helpers/boot-stub-dom.js';

// annotation.ts (and with it annotation-mix.ts) pulls in state/index.ts, which
// reads localStorage/navigator at module load — same stubbing approach as
// test/annotation-basket-puckscreen-save.test.ts. The panel also builds its
// library <select>s through the DOM API, so Option/createDocumentFragment and a
// catch-all element stub stand in for the browser (vitest has no DOM here).
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };
g.navigator    ??= { language: 'en-US' };
// boot/annotation.ts (imported below) pulls in the whole views/shots barrel, so
// the browser globals it expects must be in place before the imports run. The
// boot stub covers those; each test then swaps `document` for its own fakes.
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
g.Option = FakeOption;

// A listener-recording stand-in. renderBeanMix() attaches its handlers through
// querySelectorAll() and _wirePrimarySelect() through addEventListener(), so
// both are real here: fire() replays what the browser would dispatch.
type Handler = () => void;

interface FakeEl {
  value: string;
  readOnly: boolean;
  disabled?: boolean;
  id?: string;
  innerHTML: unknown;
  style: Record<string, string>;
  dataset: Record<string, string>;
  selectedOptions: { dataset: Record<string, string> }[];
  listeners: Record<string, Handler[]>;
  options?: FakeEl[];
  replaceChildren(): void;
  addEventListener(name: string, fn: Handler): void;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  // renderBeanMix() reaches its rendered children this way.
  querySelectorAll(selector: string): FakeEl[];
}

function makeEl(overrides: Partial<FakeEl> = {}): FakeEl {
  const node: FakeEl = {
    value: '', readOnly: false, innerHTML: '', style: {}, dataset: {},
    selectedOptions: [{ dataset: {} }],
    listeners: {},
    replaceChildren: () => {},
    addEventListener(name, fn) { (node.listeners[name] ??= []).push(fn); },
    querySelectorAll: () => [],
    // attachAutocomplete() (reached through wireAnnotationPanel) annotates the
    // grinder input with these.
    setAttribute: () => {},
    removeAttribute: () => {},
    ...overrides,
  };
  return node;
}

// Replays every handler registered under one event name, in registration
// order — that is what the browser dispatches. annCoffee carries both the mix
// module's listener and the panel's own bean-change handler.
function fire(node: FakeEl, name: string): void {
  const handlers = node.listeners[name];
  if (!handlers?.length) throw new Error(`no ${name} listener registered`);
  for (const handler of handlers) handler();
}

let els: Record<string, FakeEl>;

// The mix rows live in rendered markup, so the container parses what
// renderBeanMix() writes and hands back one fake node per input/select/button.
// Without that the render path (and the handlers it attaches) would be
// untested: the module only ever reaches its children through
// querySelectorAll() and getElementById().
interface MixNodes { inputs: FakeEl[]; selects: FakeEl[]; removes: FakeEl[] }

function tagAttrs(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of tag.matchAll(/([a-zA-Z-]+)="([^"]*)"/g)) {
    const name = m[1];
    if (name) attrs[name] = m[2] ?? '';
  }
  return attrs;
}

function makeMixContainer(register: (id: string, node: FakeEl) => void): FakeEl {
  const nodes: MixNodes = { inputs: [], selects: [], removes: [] };
  let markup = '';

  const parse = (html: string): void => {
    nodes.inputs = [];
    nodes.selects = [];
    nodes.removes = [];
    for (const m of html.matchAll(/<input\b[^>]*>/g)) {
      const attrs = tagAttrs(m[0] ?? '');
      if (attrs['data-mix-row'] === undefined) continue;
      const node = makeEl({ id: attrs.id ?? '', value: attrs.value ?? '', dataset: { mixRow: attrs['data-mix-row'] } });
      nodes.inputs.push(node);
      register(attrs.id ?? '', node);
    }
    for (const m of html.matchAll(/<select\b[^>]*>/g)) {
      const attrs = tagAttrs(m[0] ?? '');
      if (attrs['data-mix-bean'] === undefined) continue;
      const node = makeEl({ id: attrs.id ?? '', value: '', dataset: { mixBean: attrs['data-mix-bean'] }, options: [] });
      // Mirrors the real <select>: the chosen option becomes the value.
      node.replaceChildren = (frag?: unknown) => {
        const collected = (frag as { nodes?: unknown[] } | undefined)?.nodes ?? [];
        node.options = collected as FakeEl[];
        const chosen = (collected as { selected?: boolean; value?: string }[]).find(o => o.selected);
        node.value = chosen?.value ?? '';
      };
      nodes.selects.push(node);
      register(attrs.id ?? '', node);
    }
    for (const m of html.matchAll(/<button\b[^>]*>/g)) {
      const attrs = tagAttrs(m[0] ?? '');
      if (attrs['data-mix-remove'] === undefined) continue;
      // No handler here: renderBeanMix() attaches the click itself, and the
      // test fires that one through fire().
      nodes.removes.push(makeEl({ id: attrs.id ?? '', dataset: { mixRemove: attrs['data-mix-remove'] } }));
    }
  };

  const container = makeEl();
  Object.defineProperty(container, 'innerHTML', {
    get: () => markup,
    set: (value: unknown) => { markup = String(value); parse(markup); },
  });
  container.querySelectorAll = (selector: string) =>
    selector.includes('data-mix-row') ? nodes.inputs
      : selector.includes('data-mix-bean') ? nodes.selects
        : selector.includes('data-mix-remove') ? nodes.removes
          : [];
  return container;
}

// els is a plain record, so its entries are `| undefined` under
// noUncheckedIndexedAccess; these tests only ever create the ids used here.
function el(id: string): FakeEl {
  const node = els[id];
  if (!node) throw new Error(`no fake element: ${id}`);
  return node;
}

const PAYLOAD_FIELDS = [
  'annCoffee', 'annDose', 'annMixRows', 'annMixAddBtn',
  'annGrinder', 'annGrindSetting', 'annTds', 'annNotes',
  'annBasket', 'annPuckScreen', 'annDrinkType', 'annMilkType',
  'annRecipe', 'annFrozenPortionId',
];

const { S } = await import('../public-src/state/index.js');
const apiModule = await import('../public-src/api/transport.js');
// r.ok:false keeps the save from reaching the post-save sidebar re-render; the
// payload handed to apiFetch is captured either way.
const fetchSpy = vi.spyOn(apiModule, 'apiFetch').mockResolvedValue({ ok: false } as Response);
const { scheduleAutoSave, flushAutoSave, quickClone } = await import('../public-src/views/shots/annotation.js');
const { wireAnnotationPanel } = await import('../public-src/boot/annotation.js');
const mix = await import('../public-src/views/shots/annotation-mix.js');

interface MixPayloadPart { beanId: number | null; coffee: string; grams: number }
interface AnnotationPayload {
  coffee: string;
  beanId: number | null;
  dose: number | null;
  beanMix: MixPayloadPart[] | null;
}

function savedPayload(): AnnotationPayload {
  const call = fetchSpy.mock.calls[0];
  if (!call) throw new Error('no save request was sent');
  return JSON.parse(call[1]?.body as string) as AnnotationPayload;
}

// One extra row holding Bean A and Bean B — the shape "Add another bean" plus
// the two bean selects builds.
function twoBeans(a: number, b: number): void {
  mix.resetBeanMix();
  mix.addMixRow();
  mix.setMixRowBean(0, 'Bean A', 11);
  mix.setMixRowGrams(0, a);
  mix.setMixRowBean(1, 'Bean B', 12);
  mix.setMixRowGrams(1, b);
}

beforeEach(() => {
  fetchSpy.mockClear();
  els = {};
  for (const id of PAYLOAD_FIELDS) els[id] = makeEl();
  els.annMixRows = makeMixContainer((id, node) => { els[id] = node; });
  g.document = {
    getElementById: (id: string) => els[id] ?? stub(),
    createDocumentFragment: () => {
      const frag = { nodes: [] as unknown[], append: (node: unknown) => { frag.nodes.push(node); } };
      return frag;
    },
    body: stub(),
    createElement: () => stub(),
  };
  el('annCoffee').value = 'Bean A';
  S.shots = [{ id: 1, timestamp: 1700000000, annotation: {} }];
  S.primaryShotId = 1;
  S.coffeeLibrary = {
    beans: [
      { id: 11, name: 'Bean A', remainingG: 250 },
      { id: 12, name: 'Bean B', remainingG: 250 },
      { id: 13, name: 'Bean C', remainingG: 250 },
    ],
    grinders: [], baskets: [], puckScreens: [], recipes: [],
  };
  mix.resetBeanMix();
});

describe('bean mix rows (#1837)', () => {
  it('adds rows up to four and keeps the primary bean row', () => {
    expect(mix.mixRowCount()).toBe(1);
    mix.addMixRow();
    expect(mix.mixRowCount()).toBe(2);
    mix.addMixRow();
    mix.addMixRow();
    expect(mix.mixRowCount()).toBe(4);
    mix.addMixRow();
    expect(mix.mixRowCount()).toBe(4);

    mix.removeMixRow(3);
    expect(mix.mixRowCount()).toBe(3);
    // Row 1 is the panel's own bean select and never goes away.
    mix.removeMixRow(0);
    expect(mix.mixRowCount()).toBe(3);
  });

  it('keeps the dose equal to the sum of the rows, read-only, while mixing', () => {
    twoBeans(10, 8);
    expect(el('annDose').value).toBe('18');
    expect(el('annDose').readOnly).toBe(true);

    // 10 g + 10.5 g, rounded to the 0.1 g the field shows.
    mix.setMixRowGrams(1, '10.5');
    expect(el('annDose').value).toBe('20.5');

    mix.resetBeanMix();
    expect(el('annDose').readOnly).toBe(false);
  });

  it('saves beanMix with the part holding the most grams as the primary bean', () => {
    twoBeans(10, 8);
    scheduleAutoSave();
    flushAutoSave();

    const body = savedPayload();
    expect(body.beanMix).toEqual([
      { beanId: 11, coffee: 'Bean A', grams: 10 },
      { beanId: 12, coffee: 'Bean B', grams: 8 },
    ]);
    expect(body.dose).toBe(18);
    expect(body.coffee).toBe('Bean A');
    expect(body.beanId).toBe(11);
  });

  it('picks the heavier row as primary bean regardless of its position', () => {
    twoBeans(8, 10);
    scheduleAutoSave();
    flushAutoSave();

    const body = savedPayload();
    expect(body.coffee).toBe('Bean B');
    expect(body.beanId).toBe(12);
    expect(body.dose).toBe(18);
  });

  it('keeps the first row primary on a grams tie', () => {
    twoBeans(9, 9);
    scheduleAutoSave();
    flushAutoSave();

    const body = savedPayload();
    expect(body.coffee).toBe('Bean A');
    expect(body.beanId).toBe(11);
  });

  it('sends a null beanMix once the mix is back to one bean', () => {
    twoBeans(10, 8);
    mix.removeMixRow(1);
    expect(mix.mixRowCount()).toBe(1);
    scheduleAutoSave();
    flushAutoSave();

    const body = savedPayload();
    expect(body.beanMix).toBeNull();
    expect(body.coffee).toBe('Bean A');
  });

  it('never saves fewer than two usable parts as a mix', () => {
    mix.resetBeanMix();
    mix.addMixRow();
    mix.setMixRowBean(0, 'Bean A', 11);
    mix.setMixRowGrams(0, 10);
    // Row 2 names no bean, so only one part is usable — not a mix.
    scheduleAutoSave();
    flushAutoSave();

    expect(savedPayload().beanMix).toBeNull();
  });

  it('restores a saved mix with its primary bean in row 1', () => {
    mix.loadBeanMix({
      coffee: 'Bean B',
      beanMix: [
        { beanId: 11, coffee: 'Bean A', grams: 8 },
        { beanId: 12, coffee: 'Bean B', grams: 10 },
      ],
    });
    expect(mix.mixRowCount()).toBe(2);
    expect(el('annDose').value).toBe('18');
    expect(mix.mixParts().map(p => p.coffee)).toEqual(['Bean B', 'Bean A']);
  });

  it('skips rows without grams when building the payload parts', () => {
    mix.resetBeanMix();
    mix.addMixRow();
    mix.addMixRow();
    mix.setMixRowBean(0, 'Bean A', 11);
    mix.setMixRowGrams(0, 10);
    mix.setMixRowBean(1, 'Bean B', 12);
    mix.setMixRowGrams(1, '');
    mix.setMixRowBean(2, 'Bean C', 13);
    mix.setMixRowGrams(2, 6);

    expect(mix.mixParts().map(p => p.coffee)).toEqual(['Bean A', 'Bean C']);
    expect(el('annDose').value).toBe('16');
  });

  it('keeps at most four rows when a saved mix holds more parts', () => {
    mix.loadBeanMix({
      coffee: 'Bean A',
      beanMix: [
        { beanId: 11, coffee: 'Bean A', grams: 5 },
        { beanId: 12, coffee: 'Bean B', grams: 5 },
        { beanId: 13, coffee: 'Bean C', grams: 5 },
        { beanId: 14, coffee: 'Bean D', grams: 5 },
        { beanId: 15, coffee: 'Bean E', grams: 5 },
      ],
    });
    expect(mix.mixRowCount()).toBe(4);
    expect(el('annDose').value).toBe('20');
  });

  it('drops the mix when a shot without one is loaded', () => {
    twoBeans(10, 8);
    expect(mix.mixRowCount()).toBe(2);
    mix.loadBeanMix({ coffee: 'Bean A' });
    expect(mix.mixRowCount()).toBe(1);
  });

  // ── Duplicate beans (#1837 review) ──────────────────────────────────────
  // checkBeanMixBeanID in go/internal/shots/validation.go rejects a beanMix
  // that names the same bean twice, and a rejected patch saves nothing at all,
  // so the editor must never send one.

  it('merges two rows naming the same bean into one summed part', () => {
    mix.resetBeanMix();
    mix.addMixRow();
    mix.setMixRowBean(0, 'Bean A', 11);
    mix.setMixRowGrams(0, 9);
    mix.setMixRowBean(1, 'Bean A', 11);
    mix.setMixRowGrams(1, 9);

    scheduleAutoSave();
    flushAutoSave();

    // The two shares are one bean, so the merged single part is not a mix and
    // the payload clears the key rather than sending a rejected duplicate.
    expect(mix.mixParts()).toEqual([{ beanId: 11, coffee: 'Bean A', grams: 18 }]);
    expect(savedPayload().beanMix).toBeNull();
  });

  it('merges two name-only rows naming the same bean', () => {
    mix.resetBeanMix();
    mix.addMixRow();
    mix.addMixRow();
    mix.setMixRowBean(0, 'Bean A', null);
    mix.setMixRowGrams(0, 6);
    mix.setMixRowBean(1, 'Bean A', null);
    mix.setMixRowGrams(1, 4);
    mix.setMixRowBean(2, 'Bean B', null);
    mix.setMixRowGrams(2, 5);

    expect(mix.mixParts()).toEqual([
      { beanId: null, coffee: 'Bean A', grams: 10 },
      { beanId: null, coffee: 'Bean B', grams: 5 },
    ]);
  });

  it('disables a bean another row already picked in the extra selects', () => {
    mix.resetBeanMix();
    mix.addMixRow();
    mix.setMixRowBean(0, 'Bean A', 11);
    mix.setMixRowGrams(0, 10);
    mix.setMixRowBean(1, 'Bean B', 12);
    mix.setMixRowGrams(1, 8);
    mix.renderBeanMix();

    const beanBSelect = el('annMixBean1');
    const optionA = beanBSelect.options?.find(o => o.value === 'Bean A');
    const optionB = beanBSelect.options?.find(o => o.value === 'Bean B');
    // Bean A belongs to row 1 and Bean B is this row's own pick — both stay
    // usable; nothing else in this library is taken.
    expect(optionA?.disabled).toBe(true);
    expect(optionB?.disabled).toBe(false);
  });

  // ── Grams ceiling (#1837 review) ────────────────────────────────────────

  it('never sends a part above the server\'s 100 g ceiling', () => {
    twoBeans(10, 150);
    expect(mix.mixParts().map(p => p.grams)).toEqual([10, 100]);

    scheduleAutoSave();
    flushAutoSave();
    const body = savedPayload();
    expect(body.beanMix?.map(p => p.grams)).toEqual([10, 100]);
    expect(body.dose).toBe(110);
  });

  it('merging two shares keeps the part inside the ceiling', () => {
    mix.resetBeanMix();
    mix.addMixRow();
    mix.addMixRow();
    mix.setMixRowBean(0, 'Bean A', 11);
    mix.setMixRowGrams(0, 80);
    mix.setMixRowBean(1, 'Bean A', 11);
    mix.setMixRowGrams(1, 80);
    mix.setMixRowBean(2, 'Bean B', 12);
    mix.setMixRowGrams(2, 5);

    expect(mix.mixParts()).toEqual([
      { beanId: 11, coffee: 'Bean A', grams: 100 },
      { beanId: 12, coffee: 'Bean B', grams: 5 },
    ]);
  });

  // ── DOM wiring (#1837 review) ───────────────────────────────────────────

  it('renders one row per mix row with a grams input each', () => {
    twoBeans(10, 8);
    mix.renderBeanMix();

    const container = el('annMixRows');
    const rows = container.querySelectorAll('input[data-mix-row]');
    expect(rows.map(r => r.value)).toEqual(['10', '8']);
    expect(container.style.display).toBe('');
    // Row 1's bean is the panel's own select, so only the extra rows get one.
    expect(container.querySelectorAll('select[data-mix-bean]').map(s => s.id)).toEqual(['annMixBean1']);
    expect(container.querySelectorAll('button[data-mix-remove]')).toHaveLength(1);
  });

  it('hides the rows container and the add button on a single bean', () => {
    mix.resetBeanMix();
    expect(el('annMixRows').style.display).toBe('none');
    expect(el('annMixAddBtn').style.display).toBe('');
  });

  it('hides the add button once four rows are shown', () => {
    mix.resetBeanMix();
    mix.addMixRow();
    mix.addMixRow();
    mix.addMixRow();
    expect(mix.mixRowCount()).toBe(4);
    expect(el('annMixAddBtn').style.display).toBe('none');
  });

  it('takes grams typed into a row input and re-sums the dose', () => {
    twoBeans(10, 8);
    const secondRow = el('annMixGrams1');
    secondRow.value = '12';
    fire(secondRow, 'input');
    expect(el('annDose').value).toBe('22');
  });

  it('takes the bean picked in an extra row select', () => {
    mix.resetBeanMix();
    mix.addMixRow();
    mix.setMixRowBean(0, 'Bean A', 11);
    mix.setMixRowGrams(0, 10);
    mix.setMixRowGrams(1, 6);
    mix.renderBeanMix();

    const select = el('annMixBean1');
    select.value = 'Bean C';
    select.selectedOptions = [{ dataset: { beanId: '13' } }];
    fire(select, 'change');

    expect(mix.mixParts()).toEqual([
      { beanId: 11, coffee: 'Bean A', grams: 10 },
      { beanId: 13, coffee: 'Bean C', grams: 6 },
    ]);
  });

  it('removes a row through its remove button', () => {
    twoBeans(10, 8);
    mix.renderBeanMix();
    const removeBtn = el('annMixRows').querySelectorAll('button[data-mix-remove]')[0];
    if (!removeBtn) throw new Error('no remove button rendered');
    fire(removeBtn, 'click');
    expect(mix.mixRowCount()).toBe(1);
  });

  it('re-labels row 1 when the primary bean select changes during a mix', () => {
    twoBeans(10, 8);
    const coffee = el('annCoffee');
    coffee.value = 'Bean C';
    coffee.selectedOptions = [{ dataset: { beanId: '13' } }];
    fire(coffee, 'change');

    expect(mix.mixParts()).toEqual([
      { beanId: 13, coffee: 'Bean C', grams: 10 },
      { beanId: 12, coffee: 'Bean B', grams: 8 },
    ]);
    // The dose stays the rows' sum, never the newly picked bean's own dose.
    expect(el('annDose').value).toBe('18');
  });

  it('leaves the dose alone when the primary bean changes during a mix', () => {
    twoBeans(10, 8);
    // Bean C has a dose of its own in its history, so the panel's bean handler
    // would overwrite the mix's sum with 20 were it not for the guard.
    S.shots = [
      { id: 1, timestamp: 1700000000, annotation: {} },
      { id: 2, timestamp: 1700000100, annotation: { coffee: 'Bean C', beanId: 13, dose: 20 } },
    ];
    el('annCoffee').value = 'Bean C';
    el('annCoffee').selectedOptions = [{ dataset: { beanId: '13' } }];

    wireAnnotationPanel();
    fire(el('annCoffee'), 'change');

    // Still the mix's own sum (10 g + 8 g), not the 20 g suggested for Bean C.
    expect(el('annDose').value).toBe('18');
    expect(el('annDose').readOnly).toBe(true);
  });

  it('still fills the dose from the bean suggestion outside a mix', () => {
    mix.resetBeanMix();
    S.shots = [
      { id: 1, timestamp: 1700000000, annotation: { coffee: 'Bean A', beanId: 11, dose: 18 } },
      { id: 2, timestamp: 1700000100, annotation: {} },
    ];
    S.primaryShotId = 2;
    el('annCoffee').value = 'Bean A';

    wireAnnotationPanel();
    fire(el('annCoffee'), 'change');

    expect(el('annDose').value).toBe('18');
    expect(el('annDose').readOnly).toBe(false);
  });

  it('quick-clone resets the mix to a single bean', () => {
    S.shots = [
      { id: 1, timestamp: 1700000000, annotation: { coffee: 'Bean A', beanId: 11 } },
      { id: 2, timestamp: 1700000100, annotation: {} },
    ];
    S.primaryShotId = 2;
    mix.loadBeanMix({
      coffee: 'Bean A',
      beanMix: [
        { beanId: 11, coffee: 'Bean A', grams: 10 },
        { beanId: 12, coffee: 'Bean B', grams: 8 },
      ],
    });
    expect(mix.mixRowCount()).toBe(2);

    quickClone();
    expect(mix.mixRowCount()).toBe(1);
    flushAutoSave();
  });
});
