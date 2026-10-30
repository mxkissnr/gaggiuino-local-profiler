import { describe, it, expect, beforeEach, vi } from 'vitest';
import { stub } from './helpers/boot-stub-dom.js';

// annotation.ts (and with it annotation-mix.ts) pulls in state/index.ts, which
// reads localStorage/navigator at module load — same stubbing approach as
// test/annotation-basket-puckscreen-save.test.ts. The panel also builds its
// library <select>s through the DOM API, so Option/createDocumentFragment and a
// catch-all element stub stand in for the browser (vitest has no DOM here).
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };
g.navigator    ??= { language: 'en-US' };
g.window       ??= {};

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

interface FakeEl {
  value: string;
  readOnly: boolean;
  innerHTML: unknown;
  style: Record<string, string>;
  selectedOptions: { dataset: Record<string, string> }[];
  replaceChildren(): void;
  addEventListener(): void;
  querySelectorAll(): unknown[];
}

function makeEl(): FakeEl {
  return {
    value: '', readOnly: false, innerHTML: '', style: {},
    selectedOptions: [{ dataset: {} }],
    replaceChildren: () => {},
    addEventListener: () => {},
    querySelectorAll: () => [],
  };
}

let els: Record<string, FakeEl>;

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
  g.document = {
    getElementById: (id: string) => els[id] ?? stub(),
    createDocumentFragment: () => ({ append: () => {} }),
    body: stub(),
  };
  el('annCoffee').value = 'Bean A';
  S.shots = [{ id: 1, timestamp: 1700000000, annotation: {} }];
  S.primaryShotId = 1;
  S.coffeeLibrary = { beans: [], grinders: [], baskets: [], puckScreens: [], recipes: [] };
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

  it('drops the mix when a shot without one is loaded', () => {
    twoBeans(10, 8);
    expect(mix.mixRowCount()).toBe(2);
    mix.loadBeanMix({ coffee: 'Bean A' });
    expect(mix.mixRowCount()).toBe(1);
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
