import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { installBootStubs, stub } from './helpers/boot-stub-dom.js';

// #1960: the annotation panel's grinder is a select-with-"Other…" field now.
// annotation.ts pulls in state/index.ts (which reads localStorage/navigator at
// module load) and, through boot/annotation.ts, the whole views/shots barrel.
// The boot stub installs those globals first; each case then swaps `document`
// for its own fakes, since vitest's node environment has no DOM.
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

// A listener-recording stand-in for an element. fire() replays what the browser
// would dispatch, and replaceChildren() mirrors a real <select>: the option
// marked selected becomes the value.
type Handler = () => void;

interface FakeEl {
  value: string;
  hidden: boolean;
  readOnly: boolean;
  innerHTML: unknown;
  style: Record<string, string>;
  dataset: Record<string, string>;
  selectedOptions: { dataset: Record<string, string> }[];
  listeners: Record<string, Handler[]>;
  options: FakeOption[];
  addEventListener(name: string, fn: Handler): void;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  replaceChildren(frag?: unknown): void;
  querySelectorAll(selector: string): FakeEl[];
}

function makeEl(overrides: Partial<FakeEl> = {}): FakeEl {
  const node: FakeEl = {
    value: '', hidden: false, readOnly: false, innerHTML: '', style: {}, dataset: {},
    selectedOptions: [{ dataset: {} }],
    listeners: {},
    options: [],
    addEventListener(name, fn) { (node.listeners[name] ??= []).push(fn); },
    // Attribute writes on these fake nodes are ignored.
    setAttribute: () => {},
    removeAttribute: () => {},
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

// Every annotation-panel id is a fake node; anything else (the pill containers,
// the degassing tracker, the auto-save status) falls back to the catch-all stub.
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
  renderAnnotationPanel, quickClone, renderGrinderField, refreshGrinderField,
  getGrinderFieldValue, scheduleAutoSave, flushAutoSave, annotationBusy,
} = await import('../public-src/views/shots/annotation.js');
const { wireAnnotationPanel } = await import('../public-src/boot/annotation.js');
const mix = await import('../public-src/views/shots/annotation-mix.js');

interface GrinderPayload { grinder: string }

function savedPayload(): GrinderPayload {
  const call = fetchSpy.mock.calls[0];
  if (!call) throw new Error('no save request was sent');
  return JSON.parse(call[1]?.body as string) as GrinderPayload;
}

function setGrinders(names: string[], defaultName?: string): void {
  S.coffeeLibrary.grinders = names.map((name, i) => ({ id: i + 1, name, isDefault: name === defaultName }));
}

// The save runs unawaited (as in the app), so let its promise chain finish
// before asserting on the module's busy state again.
async function drain(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

async function idle(): Promise<void> {
  flushAutoSave();
  await drain();
}

beforeEach(() => {
  fetchSpy.mockClear();
  els = {};
  for (const id of ANN_IDS) els[id] = makeEl();
  g.document = {
    getElementById: (id: string) => (id.startsWith('ann') ? el(id) : stub()),
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

describe('annotation grinder dropdown (#1960)', () => {
  // The issue's required proof: an existing shot keeps a grinder that is not
  // in the library when it is edited and saved.
  it('keeps a stored grinder that is not in the library under "Other…"', async () => {
    setGrinders(['Niche Zero']);
    renderAnnotationPanel({ id: 1, timestamp: 1700000000, annotation: { grinder: 'Rare Grinder' } });

    expect(el('annGrinder').value).toBe('__other__');
    expect(el('annGrinderOther').value).toBe('Rare Grinder');
    expect(el('annGrinderOther').style.display).toBe('');

    scheduleAutoSave();
    flushAutoSave();
    await drain();
    expect(savedPayload().grinder).toBe('Rare Grinder');
  });

  it('selects a stored library grinder and hides the free-text input', async () => {
    setGrinders(['Niche Zero', 'DF64']);
    renderAnnotationPanel({ id: 1, timestamp: 1700000000, annotation: { grinder: 'DF64' } });

    expect(el('annGrinder').value).toBe('DF64');
    expect(el('annGrinderOther').style.display).toBe('none');

    scheduleAutoSave();
    flushAutoSave();
    await drain();
    expect(savedPayload().grinder).toBe('DF64');
  });

  it('never normalises a stored name that differs only in case', async () => {
    setGrinders(['Niche Zero']);
    renderAnnotationPanel({ id: 1, timestamp: 1700000000, annotation: { grinder: 'niche zero' } });

    expect(el('annGrinder').value).toBe('__other__');
    expect(el('annGrinderOther').value).toBe('niche zero');

    scheduleAutoSave();
    flushAutoSave();
    await drain();
    expect(savedPayload().grinder).toBe('niche zero');
  });

  it('leaves a shot without a grinder without one instead of taking the first', async () => {
    setGrinders(['Niche Zero', 'DF64']);
    renderAnnotationPanel({ id: 1, timestamp: 1700000000, annotation: {} });

    expect(el('annGrinder').value).toBe('');

    scheduleAutoSave();
    flushAutoSave();
    await drain();
    expect(savedPayload().grinder).toBe('');
  });

  it('shows a stored name in the free-text input when the library has no grinders', async () => {
    renderAnnotationPanel({ id: 1, timestamp: 1700000000, annotation: { grinder: 'Rare Grinder' } });

    expect(el('annGrinder').hidden).toBe(true);
    expect(el('annGrinderOther').style.display).toBe('');
    expect(el('annGrinderOther').value).toBe('Rare Grinder');

    scheduleAutoSave();
    flushAutoSave();
    await drain();
    expect(savedPayload().grinder).toBe('Rare Grinder');
  });

  it('saves a typed name with an empty grinder library', async () => {
    renderAnnotationPanel({ id: 1, timestamp: 1700000000, annotation: {} });
    el('annGrinderOther').value = 'Borrowed Grinder';

    scheduleAutoSave();
    flushAutoSave();
    await drain();
    expect(savedPayload().grinder).toBe('Borrowed Grinder');
  });

  it('shows the flagged default grinder on a new shot', () => {
    setGrinders(['Default G', 'Other G'], 'Default G');
    S.shotDefaults = { grinder: 'Default G' };
    renderAnnotationPanel({ id: 1, timestamp: 1700000000, annotation: {} });

    expect(el('annGrinder').value).toBe('Default G');
    expect(el('annGrinderOther').style.display).toBe('none');
  });

  it('clones a previous shot\'s grinder that is not in the library under "Other…"', async () => {
    setGrinders(['Niche Zero']);
    S.shots = [
      { id: 1, timestamp: 1700000000, annotation: { coffee: 'Bean A', beanId: 11, grinder: 'Rare Grinder', grindSetting: '22', dose: 18 } },
      { id: 2, timestamp: 1700000100, annotation: {} },
    ];
    S.primaryShotId = 2;

    quickClone();

    expect(el('annGrinder').value).toBe('__other__');
    expect(el('annGrinderOther').value).toBe('Rare Grinder');
    flushAutoSave();
    await drain();
    expect(savedPayload().grinder).toBe('Rare Grinder');
  });

  it('shows a bean-suggested grinder outside the library under "Other…"', () => {
    setGrinders(['Niche Zero']);
    S.shots = [
      { id: 1, timestamp: 1700000000, annotation: { coffee: 'Bean A', beanId: 11, grinder: 'Rare Grinder', grindSetting: '22' } },
      { id: 2, timestamp: 1700000100, annotation: {} },
    ];
    S.primaryShotId = 2;
    renderAnnotationPanel({ id: 2, timestamp: 1700000100, annotation: {} });

    wireAnnotationPanel();
    el('annCoffee').value = 'Bean A';
    fire(el('annCoffee'), 'change');

    expect(el('annGrinder').value).toBe('__other__');
    expect(el('annGrinderOther').value).toBe('Rare Grinder');
  });
});

describe('grinder select change wiring (#1960)', () => {
  it('schedules a save and hides the input when a library grinder is picked', async () => {
    setGrinders(['Niche Zero']);
    renderGrinderField('annGrinder', 'annGrinderOther', '');
    wireAnnotationPanel();

    el('annGrinder').value = 'Niche Zero';
    fire(el('annGrinder'), 'change');

    expect(annotationBusy()).toBe(true);
    expect(el('annGrinderOther').style.display).toBe('none');
    flushAutoSave();
    await drain();
  });

  // "Other…" with nothing typed is not a choice yet: saving now would blank the
  // shot's grinder before the user has typed anything.
  it('schedules no save for "Other…" with nothing typed', async () => {
    // Let any save left over from the previous case finish: this asserts on the
    // module-wide busy state, not just on a fresh timer.
    await idle();
    setGrinders(['Niche Zero']);
    renderGrinderField('annGrinder', 'annGrinderOther', '');
    wireAnnotationPanel();
    expect(annotationBusy()).toBe(false);

    el('annGrinder').value = '__other__';
    el('annGrinderOther').value = '';
    fire(el('annGrinder'), 'change');

    expect(el('annGrinderOther').style.display).toBe('');
    expect(annotationBusy()).toBe(false);
  });

  it('saves a typed name from the free-text input', async () => {
    setGrinders(['Niche Zero']);
    renderGrinderField('annGrinder', 'annGrinderOther', '');
    wireAnnotationPanel();

    el('annGrinder').value = '__other__';
    el('annGrinderOther').value = 'Typed Grinder';
    fire(el('annGrinderOther'), 'input');

    expect(annotationBusy()).toBe(true);
    flushAutoSave();
    await drain();
    expect(savedPayload().grinder).toBe('Typed Grinder');
  });

  it('schedules a save for "Other…" once text is there', async () => {
    setGrinders(['Niche Zero']);
    renderGrinderField('annGrinder', 'annGrinderOther', '');
    wireAnnotationPanel();

    el('annGrinder').value = '__other__';
    el('annGrinderOther').value = 'Kept Grinder';
    fire(el('annGrinder'), 'change');

    expect(annotationBusy()).toBe(true);
    flushAutoSave();
    await drain();
    expect(savedPayload().grinder).toBe('Kept Grinder');
  });
});

describe('refreshGrinderField after a library change (#1960)', () => {
  it('moves a name out of "Other…" once the library contains it', () => {
    renderGrinderField('annGrinder', 'annGrinderOther', 'Rare Grinder');
    expect(el('annGrinder').value).toBe('__other__');

    setGrinders(['Rare Grinder']);
    refreshGrinderField('annGrinder', 'annGrinderOther');

    expect(el('annGrinder').value).toBe('Rare Grinder');
    expect(el('annGrinderOther').style.display).toBe('none');
    expect(getGrinderFieldValue('annGrinder', 'annGrinderOther')).toBe('Rare Grinder');
  });

  it('keeps the value when the library no longer has it', () => {
    setGrinders(['Niche Zero']);
    renderGrinderField('annGrinder', 'annGrinderOther', 'Niche Zero');

    setGrinders([]);
    refreshGrinderField('annGrinder', 'annGrinderOther');

    expect(el('annGrinder').hidden).toBe(true);
    expect(el('annGrinderOther').style.display).toBe('');
    expect(getGrinderFieldValue('annGrinder', 'annGrinderOther')).toBe('Niche Zero');
  });

  it('leaves the field alone while the free-text input has focus', () => {
    renderGrinderField('annGrinder', 'annGrinderOther', 'Rare Grinder');
    (g.document as { activeElement: unknown }).activeElement = el('annGrinderOther');

    setGrinders(['Rare Grinder']);
    refreshGrinderField('annGrinder', 'annGrinderOther');

    expect(el('annGrinder').value).toBe('__other__');
    expect(el('annGrinderOther').value).toBe('Rare Grinder');
  });

  it('does not reset "Other…" with nothing typed yet', () => {
    setGrinders(['Niche Zero']);
    renderGrinderField('annGrinder', 'annGrinderOther', '');
    el('annGrinder').value = '__other__';
    el('annGrinderOther').value = '';

    refreshGrinderField('annGrinder', 'annGrinderOther');

    expect(el('annGrinder').value).toBe('__other__');
    expect(el('annGrinderOther').value).toBe('');
  });

  it('refreshes a hidden select once the first grinder appears', () => {
    renderGrinderField('annGrinder', 'annGrinderOther', '');
    expect(el('annGrinder').hidden).toBe(true);

    setGrinders(['Niche Zero']);
    refreshGrinderField('annGrinder', 'annGrinderOther');

    expect(el('annGrinder').hidden).toBe(false);
    expect(el('annGrinder').value).toBe('');
  });
});

describe('annotation grinder markup sources (#1960)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const read = (rel: string): string => readFileSync(join(here, rel), 'utf8');

  it('renders the grinder as a select plus a hidden free-text fallback', () => {
    const markup = read('../public-src/index.html');
    expect(markup).toContain('<select id="annGrinder">');
    expect(markup).not.toMatch(/<input[^>]*id="annGrinder"/);
  });

  it('gives the free-text fallback a 44px target on a phone', () => {
    expect(read('../public-src/style.css')).toMatch(/#annGrinderOther[^{]*\{\s*min-height:\s*44px/);
  });

  // The 44px rule only applies on a phone if it sits inside the mobile media
  // block; outside it, it would shrink desktop pickers to a touch target.
  it('puts that rule inside the max-width: 768px media block', () => {
    const css = read('../public-src/style.css');
    const ruleAt = css.indexOf('#annGrinderOther');
    expect(ruleAt).toBeGreaterThan(-1);
    // Walk back out of the rule: the first '{' met at depth 0 is the one whose
    // prelude has to be the media query.
    let depth = 0;
    let prelude = '';
    for (let i = ruleAt - 1; i >= 0; i--) {
      const ch = css[i];
      if (ch === '}') depth++;
      else if (ch === '{') {
        if (depth === 0) { prelude = css.slice(css.lastIndexOf('\n', i) + 1, i).trim(); break; }
        depth--;
      }
    }
    expect(prelude).toBe('@media (max-width: 768px)');
  });
});

describe('kiosk page needs no change for this slice (#1960)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const read = (rel: string): string => readFileSync(join(here, rel), 'utf8');

  // A native <select> opens the platform picker, which the kiosk would have to
  // style itself. It has no select and no library field, so this slice leaves
  // it alone — pinned here so a later edit cannot quietly add one.
  it.each(['../public-src/kiosk.html', '../public-src/kiosk.ts', '../public-src/kiosk.css'])(
    '%s has no select and no grinder field',
    rel => {
      const source = read(rel);
      expect(source).not.toMatch(/<select\b/);
      expect(source).not.toMatch(/grinder/i);
      expect(source).not.toMatch(/coffeeLibrary/);
    },
  );
});
