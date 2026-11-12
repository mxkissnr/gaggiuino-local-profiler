import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { installBootStubs } from './helpers/boot-stub-dom.js';

// The library view graph reads localStorage/navigator at module load; the boot
// stub installs those globals, and each case swaps `document` for its own fake
// (same pattern as grinder-scale-form.test.ts).
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };
g.navigator    ??= { language: 'en-US' };
installBootStubs();

// Every form's save request goes through this module, so stubbing it keeps the
// tests off the network and lets each case decide how the request settles.
type SaveApi = Mock<(id: number | null, payload: unknown) => Promise<unknown>>;

const mocks = vi.hoisted(() => ({
  saveBasket: vi.fn<(id: number | null, payload: unknown) => Promise<unknown>>(),
  savePuckScreen: vi.fn<(id: number | null, payload: unknown) => Promise<unknown>>(),
  saveRecipe: vi.fn<(id: number | null, payload: unknown) => Promise<unknown>>(),
  saveGrinder: vi.fn<(id: number | null, payload: unknown) => Promise<unknown>>(),
  showToast: vi.fn<(msg: string) => void>(),
}));

vi.mock('../public-src/api/library.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../public-src/api/library.js')>()),
  saveBasket: mocks.saveBasket,
  savePuckScreen: mocks.savePuckScreen,
  saveRecipe: mocks.saveRecipe,
  saveGrinder: mocks.saveGrinder,
}));

vi.mock('../public-src/components/toast.js', () => ({ showToast: mocks.showToast }));

type Listener = (event: { target?: unknown }) => void;

class FakeClassList {
  private readonly host: FakeElement;

  constructor(host: FakeElement) {
    this.host = host;
  }

  private names(): Set<string> {
    return new Set(this.host.className.split(' ').filter(Boolean));
  }

  add(...names: string[]): void {
    const set = this.names();
    names.forEach(n => set.add(n));
    this.host.className = [...set].join(' ');
  }

  remove(...names: string[]): void {
    const set = this.names();
    names.forEach(n => set.delete(n));
    this.host.className = [...set].join(' ');
  }

  contains(name: string): boolean {
    return this.names().has(name);
  }

  toggle(name: string, force?: boolean): boolean {
    const on = force ?? !this.contains(name);
    if (on) this.add(name); else this.remove(name);
    return on;
  }
}

// The four forms are static markup in index.html, so a flat id-keyed element is
// enough here: no form is moved between parents. Tree walking answers empty so
// the list renders and the autosave binder stay inert.
class FakeElement {
  id = '';
  className = '';
  innerHTML = '';
  textContent = '';
  value = '';
  checked = false;
  disabled = false;
  hidden = false;
  type = 'text';
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  parentNode: FakeElement | null = null;
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Listener[]>();
  readonly classList: FakeClassList;
  _autocomplete?: unknown;
  private readonly docRef: FakeDocument;

  constructor(docRef: FakeDocument) {
    this.docRef = docRef;
    this.classList = new FakeClassList(this);
  }

  get ownerDocument(): FakeDocument {
    return this.docRef;
  }

  appendChild(child: FakeElement): FakeElement {
    child.parentNode = this;
    return child;
  }

  insertBefore(child: FakeElement): FakeElement {
    child.parentNode = this;
    return child;
  }

  prepend(): void {}

  remove(): void {
    this.parentNode = null;
  }

  focus(): void {
    this.docRef.activeElement = this;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === 'hidden') this.hidden = true;
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
    if (name === 'hidden') this.hidden = false;
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  addEventListener(_type: string, listener: Listener): void {
    this.listeners.set(_type, [...(this.listeners.get(_type) ?? []), listener]);
  }

  removeEventListener(_type: string, listener: Listener): void {
    this.listeners.set(_type, (this.listeners.get(_type) ?? []).filter(entry => entry !== listener));
  }

  querySelector(): null {
    return null;
  }

  querySelectorAll(): never[] {
    return [];
  }

  replaceChildren(): void {}
}

class FakeDocument {
  readonly body = new FakeElement(this);
  readonly documentElement = new FakeElement(this);
  activeElement: FakeElement | null = null;
  private readonly nodes = new Map<string, FakeElement>();

  createElement(): FakeElement {
    return new FakeElement(this);
  }

  createDocumentFragment(): { nodes: unknown[]; append: (...nodes: unknown[]) => void } {
    const frag = { nodes: [] as unknown[], append: (...nodes: unknown[]) => { frag.nodes.push(...nodes); } };
    return frag;
  }

  getElementById(id: string): FakeElement {
    const known = this.nodes.get(id);
    if (known) return known;
    const el = new FakeElement(this);
    el.id = id;
    this.nodes.set(id, el);
    return el;
  }

  querySelector(): null {
    return null;
  }

  querySelectorAll(): never[] {
    return [];
  }

  addEventListener(): void {}
  removeEventListener(): void {}
  contains(): boolean { return true; }
}

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

interface LibraryApi {
  openBasketForm: (row?: unknown) => void;
  saveBasket: () => Promise<void>;
  openPuckScreenForm: (row?: unknown) => void;
  savePuckScreen: () => Promise<void>;
  openRecipeForm: (row?: unknown) => void;
  saveRecipe: () => Promise<void>;
  openGrinderForm: (row?: unknown) => void;
  saveGrinder: () => Promise<void>;
}

interface StateLike {
  coffeeLibrary: { beans: unknown[]; grinders: unknown[]; baskets: unknown[]; puckScreens: unknown[]; recipes: unknown[] };
  shots: unknown[];
  currentLang: string;
  basketEditId: number | null;
  puckScreenEditId: number | null;
  grinderEditId: number | null;
  recipeEditId: number | null;
  beanEditId: number | null;
}

interface FormCase {
  label: string;
  formId: string;
  fieldId: string;
  saveBtnId: string;
  api: SaveApi;
  open: () => void;
  save: () => Promise<void>;
  savedRow: Record<string, unknown>;
}

let doc: FakeDocument;
let S: StateLike;
let libraryApiModule: LibraryApi;

function makeCase(
  label: string,
  formId: string,
  fieldId: string,
  saveBtnId: string,
  api: SaveApi,
  open: () => void,
  save: () => Promise<void>,
  savedRow: Record<string, unknown>,
): FormCase {
  return { label, formId, fieldId, saveBtnId, api, open, save, savedRow };
}

function cases(): FormCase[] {
  return [
    makeCase('basket', 'basketAddForm', 'basketFormName', 'saveBasketBtn', mocks.saveBasket,
      () => libraryApiModule.openBasketForm(null), () => libraryApiModule.saveBasket(), { id: 1, name: 'Basket' }),
    makeCase('puck screen', 'puckScreenAddForm', 'puckScreenFormName', 'savePuckScreenBtn', mocks.savePuckScreen,
      () => libraryApiModule.openPuckScreenForm(null), () => libraryApiModule.savePuckScreen(), { id: 1, name: 'Screen' }),
    makeCase('recipe', 'recipeAddForm', 'recipeFormName', 'saveRecipeBtn', mocks.saveRecipe,
      () => libraryApiModule.openRecipeForm(null), () => libraryApiModule.saveRecipe(), { id: 1, name: 'Recipe' }),
    makeCase('grinder', 'grinderAddForm', 'grinderFormName', 'saveGrinderBtn', mocks.saveGrinder,
      () => libraryApiModule.openGrinderForm(null), () => libraryApiModule.saveGrinder(), { id: 1, name: 'Grinder' }),
  ];
}

function formOpen(formId: string): boolean {
  return doc.getElementById(formId).classList.contains('open');
}

// The four forms need no list markup here, so the elements the modules touch at
// import/open time are plain cached nodes.
function resetDocument(): void {
  doc = new FakeDocument();
  g.document = doc as unknown as Document;
  for (const id of [
    'grinderFormScale', 'grinderFormScaleType', 'grinderFormScaleRange',
    'grinderFormScaleMin', 'grinderFormScaleMax', 'grinderFormScaleStep', 'grinderFormScaleError',
  ]) doc.getElementById(id);
}

beforeEach(async () => {
  mocks.saveBasket.mockReset();
  mocks.savePuckScreen.mockReset();
  mocks.saveRecipe.mockReset();
  mocks.saveGrinder.mockReset();
  mocks.showToast.mockReset();
  vi.resetModules();
  // Import the graph against the boot stub (it reads localStorage/navigator at
  // module load), then hand the forms this test's fake document.
  installBootStubs();
  ({ S } = (await import('../public-src/state/index.js')) as unknown as { S: StateLike });
  libraryApiModule = (await import('../public-src/views/library.js')) as unknown as LibraryApi;
  resetDocument();
  S.currentLang = 'en';
  S.shots = [];
  S.basketEditId = null;
  S.puckScreenEditId = null;
  S.grinderEditId = null;
  S.recipeEditId = null;
  S.beanEditId = null;
  S.coffeeLibrary = { beans: [], grinders: [], baskets: [], puckScreens: [], recipes: [] };
});

describe('a failed save shows the error and keeps the form open (#2022)', () => {
  it.each(cases())('$label', async form => {
    form.api.mockRejectedValue(new TypeError('Failed to fetch'));
    form.open();
    doc.getElementById(form.fieldId).value = 'Test entry';

    await form.save();

    expect(mocks.showToast).toHaveBeenCalledWith('Error saving');
    expect(formOpen(form.formId)).toBe(true);
    // The typed value stays, so the entry can be retried as it is.
    expect(doc.getElementById(form.fieldId).value).toBe('Test entry');
  });
});

describe('a double tap on Save makes one request (#2022)', () => {
  it.each(cases())('$label', async form => {
    let release!: (row: Record<string, unknown>) => void;
    form.api.mockImplementation(() => new Promise(res => { release = res; }));
    form.open();
    doc.getElementById(form.fieldId).value = 'Test entry';

    const first = form.save();
    // Fired while the first request is still pending: it must not save again.
    const second = form.save();
    expect(form.api).toHaveBeenCalledTimes(1);
    expect(doc.getElementById(form.saveBtnId).disabled).toBe(true);

    release(form.savedRow);
    await first;
    await second;

    expect(form.api).toHaveBeenCalledTimes(1);
    expect(doc.getElementById(form.saveBtnId).disabled).toBe(false);
  });
});
