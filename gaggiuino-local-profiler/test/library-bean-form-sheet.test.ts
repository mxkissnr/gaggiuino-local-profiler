import { describe, it, expect, beforeEach, vi } from 'vitest';

// library.js's import chain touches state.js/i18n.js, which read
// localStorage/navigator at module load time — stub the minimum browser
// globals so the module graph can be imported under vitest's node
// environment (same pattern as the other library tests).
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };

// saveBeanAddBag() drives saveBeanInternal, which calls into the library API;
// mocking it keeps the test off the network and lets it return a canned bean.
const mocks = vi.hoisted(() => ({ saveBean: vi.fn() }));
vi.mock('../public-src/api/library.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../public-src/api/library.js')>();
  return { ...actual, saveBean: mocks.saveBean };
});

type Listener = (event: FakeEvent) => void;
interface FakeEvent { target?: unknown; key?: string; preventDefault?: () => void }

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

// A small but tree-aware fake DOM: the form sheet moves #beanAddForm between
// parents, so appendChild/insertBefore/parentNode/nextSibling are real here.
class FakeElement {
  id = '';
  className = '';
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  innerHTML = '';
  textContent = '';
  hidden = false;
  value = '';
  checked = false;
  type = '';
  parentNode: FakeElement | null = null;
  readonly children: FakeElement[] = [];
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Listener[]>();
  readonly classList: FakeClassList;
  private readonly docRef: FakeDocument;

  constructor(docRef: FakeDocument) {
    this.docRef = docRef;
    this.classList = new FakeClassList(this);
  }

  get firstChild(): FakeElement | null {
    return this.children[0] ?? null;
  }

  get nextSibling(): FakeElement | null {
    const parent = this.parentNode;
    if (!parent) return null;
    const index = parent.children.indexOf(this);
    return index >= 0 ? (parent.children[index + 1] ?? null) : null;
  }

  appendChild(child: FakeElement): FakeElement {
    child.detach();
    child.parentNode = this;
    this.children.push(child);
    this.docRef.register(child);
    return child;
  }

  insertBefore(node: FakeElement, ref: FakeElement | null): FakeElement {
    node.detach();
    node.parentNode = this;
    if (ref) {
      const index = this.children.indexOf(ref);
      if (index >= 0) { this.children.splice(index, 0, node); return node; }
    }
    this.children.push(node);
    return node;
  }

  removeChild(child: FakeElement): void {
    const index = this.children.indexOf(child);
    if (index >= 0) { this.children.splice(index, 1); child.parentNode = null; }
  }

  remove(): void {
    this.detach();
  }

  detach(): void {
    this.parentNode?.removeChild(this);
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

  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type);
    if (list) this.listeners.set(type, list.filter(entry => entry !== listener));
  }

  dispatch(type: string, event: FakeEvent = {}): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ target: this, preventDefault: () => {}, ...event });
    }
  }

  focus(): void {
    this.docRef.activeElement = this;
  }

  querySelector(selector: string): FakeElement | null {
    for (const child of this.children) {
      if (this.matches(child, selector)) return child;
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const found: FakeElement[] = [];
    const walk = (el: FakeElement): void => {
      for (const child of el.children) {
        if (this.matches(child, selector)) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }

  private matches(el: FakeElement, selector: string): boolean {
    if (selector.startsWith('.')) return el.classList.contains(selector.slice(1));
    if (selector.startsWith('#')) return el.id === selector.slice(1);
    return false;
  }
}

class FakeDocument {
  readonly body = new FakeElement(this);
  readonly documentElement = new FakeElement(this);
  activeElement: FakeElement | null = null;
  private readonly nodes = new Map<string, FakeElement>();
  private readonly listeners = new Map<string, Listener[]>();

  constructor() {
    this.documentElement.id = 'html';
  }

  createElement(): FakeElement {
    return new FakeElement(this);
  }

  register(el: FakeElement): void {
    if (el.id) this.nodes.set(el.id, el);
  }

  getElementById(id: string): FakeElement | null {
    const known = this.nodes.get(id);
    if (known) return known;
    const found = this.body.querySelector(`#${id}`);
    if (found) { this.nodes.set(id, found); return found; }
    // The sheet hosts must genuinely be created, never auto-vivified, so a
    // missing host stays observable. Everything else (the ~25 form fields)
    // is a permissive stub, like the other library tests.
    if (id === 'beanSheet' || id === 'beanFormSheet') return null;
    // The inline bag form only exists inside the bean detail sheet's painted
    // markup (renderBeanCard with inSheet) and the fake DOM keeps innerHTML as
    // a plain string, so expose the element only once that markup is present —
    // otherwise a genuinely missing form stays observable (#1398).
    if (id.startsWith('newBagForm')) {
      const sheet = this.nodes.get('beanSheet');
      if (!sheet || !sheet.innerHTML.includes(`id="${id}"`)) return null;
      const el = new FakeElement(this);
      el.id = id;
      this.nodes.set(id, el);
      return el;
    }
    const el = new FakeElement(this);
    el.id = id;
    this.nodes.set(id, el);
    return el;
  }

  querySelector(): FakeElement | null { return null; }
  querySelectorAll(): FakeElement[] { return []; }
  contains(): boolean { return true; }

  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type);
    if (list) this.listeners.set(type, list.filter(entry => entry !== listener));
  }
}

interface LibraryModule {
  openBeanForm: (bean?: unknown) => void;
  closeBeanForm: () => void;
  requestCloseBeanForm: () => void;
  discardBeanForm: () => void;
  saveBeanAddBag: () => Promise<void>;
  openNewBagForm: (id: number) => void;
}

interface Bean {
  id: number;
  name: string;
  roaster: string;
  bags: unknown[];
  flavors: string[];
}

interface StateLike {
  coffeeLibrary: { beans: Bean[]; recipes: unknown[]; grinders: unknown[] };
  shots: unknown[];
  currentLang: string;
  beanEditId: number | null;
}

let doc: FakeDocument;
let library: LibraryModule;
let S: StateLike;

beforeEach(async () => {
  doc = new FakeDocument();
  g.document = doc;
  g.window = { matchMedia: () => ({ matches: false }) };
  mocks.saveBean.mockReset();
  vi.resetModules();
  ({ S } = (await import('../public-src/state/index.js')) as unknown as { S: StateLike });
  library = (await import('../public-src/views/library.js')) as unknown as LibraryModule;
  S.currentLang = 'en';
  S.shots = [];
  S.beanEditId = null;
  S.coffeeLibrary = { beans: [], recipes: [], grinders: [] };
});

// Rebuilds the inline home: #beanAddForm followed by the trigger row, as in
// index.html. Returns the form so the test can track where it is.
function setupHome(): { home: FakeElement; form: FakeElement } {
  const home = doc.createElement();
  home.id = 'libSectionBeans';
  const trigger = doc.createElement();
  trigger.className = 'lib-trigger-row';
  const form = doc.createElement();
  form.id = 'beanAddForm';
  home.appendChild(trigger);
  home.insertBefore(form, trigger);
  doc.register(home);
  doc.register(trigger);
  doc.register(form);
  doc.body.appendChild(home);
  return { home, form };
}

function addBean(): Bean {
  const bean: Bean = {
    id: 1,
    name: 'Yirgacheffe Chelelektu',
    roaster: 'Kaffee Braun',
    bags: [{ id: 1, stock_g: 250, consumedG: 0, remainingG: 250, current: true, roastDate: '2026-01-01' }],
    flavors: [],
  };
  S.coffeeLibrary.beans = [bean];
  return bean;
}

function find(className: string): FakeElement | null {
  return doc.body.querySelector(`.${className}`);
}

describe('bean form sheet (#1349)', () => {
  it('moves the form into the sheet, and puts it back on close', () => {
    const { home, form } = setupHome();
    library.openBeanForm();

    const host = doc.body.querySelector('#beanFormSheet');
    expect(host).not.toBeNull();
    expect(host?.classList.contains('open')).toBe(true);
    const body = host?.querySelector('.lib-form-sheet-body') ?? null;
    expect(body).not.toBeNull();
    expect(form.parentNode).toBe(body);
    expect(form.classList.contains('open')).toBe(true);

    library.closeBeanForm();

    expect(form.parentNode).toBe(home);
    expect(form.nextSibling?.className).toBe('lib-trigger-row');
    expect(host?.classList.contains('open')).toBe(false);
  });

  it('returns to the bean detail sheet when editing is cancelled', () => {
    setupHome();
    const bean = addBean();
    library.openBeanForm(bean);
    library.closeBeanForm();

    const sheet = doc.body.querySelector('#beanSheet');
    expect(sheet).not.toBeNull();
    expect(sheet?.innerHTML).toContain('Yirgacheffe Chelelektu');
  });

  it('closes after creating without opening a detail sheet', () => {
    const { home, form } = setupHome();
    library.openBeanForm();
    library.closeBeanForm();

    expect(form.parentNode).toBe(home);
    expect(doc.body.querySelector('#beanSheet')).toBeNull();
  });

  it('asks before discarding a dirty form, and discard closes it', () => {
    const { home, form } = setupHome();
    library.openBeanForm();
    const host = doc.body.querySelector('#beanFormSheet');
    const confirm = find('lib-form-confirm');
    expect(confirm?.getAttribute('hidden')).toBe('');

    form.dispatch('input');
    library.requestCloseBeanForm();

    expect(host?.classList.contains('open')).toBe(true);
    expect(confirm?.getAttribute('hidden')).toBeNull();
    expect(form.parentNode).not.toBe(home);

    library.discardBeanForm();

    expect(host?.classList.contains('open')).toBe(false);
    expect(form.parentNode).toBe(home);
  });

  it('closes an untouched form without asking', () => {
    const { home, form } = setupHome();
    library.openBeanForm();
    const confirm = find('lib-form-confirm');

    library.requestCloseBeanForm();

    expect(confirm?.getAttribute('hidden')).toBe('');
    expect(form.parentNode).toBe(home);
  });
});

describe('save and add bag (#1398)', () => {
  it('opens the freshly created bean sheet with its inline bag form visible', async () => {
    setupHome();
    doc.getElementById('beanFormName')!.value = 'New Bean';
    mocks.saveBean.mockResolvedValue({
      id: 7,
      name: 'New Bean',
      roaster: 'Kaffee Braun',
      bags: [{ id: 1, stock_g: 250, consumedG: 0, remainingG: 250, current: true, roastDate: '2026-01-01' }],
    });

    await library.saveBeanAddBag();

    const sheet = doc.body.querySelector('#beanSheet');
    expect(sheet).not.toBeNull();
    expect(sheet?.classList.contains('open')).toBe(true);
    expect(sheet?.innerHTML).toContain('id="newBagForm7"');
    const form = doc.getElementById('newBagForm7');
    expect(form).not.toBeNull();
    expect(form?.style.display).toBe('');
  });

  it('openNewBagForm tolerates a bag form that is not in the DOM', () => {
    expect(() => library.openNewBagForm(999)).not.toThrow();
  });
});

