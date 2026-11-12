import { describe, it, expect, beforeEach, vi } from 'vitest';

// library.ts's import chain touches state/index.ts/i18n.ts, which read
// localStorage/navigator at module load time — stub the minimum browser
// globals so the module graph can be imported under vitest's node
// environment (same pattern as the other library tests).
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };

// saveBeanAddBag() drives saveBeanInternal, which calls into the library API;
// mocking it keeps the test off the network and lets it return a canned bean.
const mocks = vi.hoisted(() => ({ saveBean: vi.fn(), updateBeanBag: vi.fn(), toast: vi.fn() }));
vi.mock('../public-src/api/library.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../public-src/api/library.js')>();
  return { ...actual, saveBean: mocks.saveBean, updateBeanBag: mocks.updateBeanBag };
});
vi.mock('../public-src/components/toast.js', () => ({ showToast: mocks.toast }));

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
  disabled = false;
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

  prepend(node: FakeElement): void {
    this.insertBefore(node, this.firstChild);
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
    // markup (renderBeanCard) and the fake DOM keeps innerHTML as
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
  requestCloseBeanForm: () => boolean;
  discardBeanForm: () => void;
  saveBeanAddBag: () => Promise<void>;
  saveBeanNoBag: () => Promise<void>;
  saveBean: () => Promise<void>;
  openNewBagForm: (id: number, roastDate?: string) => void;
}

interface Bean {
  id: number;
  name: string;
  roaster: string;
  bags: unknown[];
  flavors: string[];
  roastDate?: string;
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
let showToast: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  doc = new FakeDocument();
  showToast = vi.fn();
  g.document = doc;
  g.window = { matchMedia: () => ({ matches: false }), showToast };
  mocks.saveBean.mockReset();
  mocks.updateBeanBag.mockReset();
  mocks.toast.mockReset();
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

  it('creates through the bar Save and opens the new-bag form with the roast date', async () => {
    const { home, form } = setupHome();
    mocks.saveBean.mockResolvedValue({
      id: 7, name: 'New Bean', roaster: 'Kaffee Braun', bags: [], flavors: [],
    });

    library.openBeanForm();
    expect(form.parentNode).not.toBe(home);
    doc.getElementById('beanFormName')!.value = 'New Bean';
    doc.getElementById('beanFormRoastDate')!.value = '2026-03-04';

    // The form sheet header's Save is the create submit path: it saves the
    // bean and asks for its bag straight away (#1933).
    const saveBtn = find('lib-sheet-save');
    expect(saveBtn).not.toBeNull();
    saveBtn!.dispatch('click');

    await vi.waitFor(() => expect(mocks.saveBean).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(form.parentNode).toBe(home));

    expect(mocks.saveBean.mock.calls[0]?.[0]).toBeNull();
    expect(mocks.saveBean.mock.calls[0]?.[1]).toMatchObject({ name: 'New Bean', roastDate: '2026-03-04' });
    expect(S.coffeeLibrary.beans.some(b => b.id === 7)).toBe(true);

    const sheet = doc.body.querySelector('#beanSheet');
    expect(sheet).not.toBeNull();
    expect(sheet?.innerHTML).toContain('id="newBagForm7"');
    expect(doc.getElementById('newBagForm7')?.style.display).toBe('');
    expect(doc.getElementById('newBagRoastDate7')?.value).toBe('2026-03-04');
    // Only the weight and the batch number are left to type.
    expect(doc.getElementById('newBagStock7')?.value).toBe('');
    expect(doc.getElementById('newBagBatchNumber7')?.value).toBe('');
    expect(doc.activeElement).toBe(doc.getElementById('newBagStock7'));
  });

  it('"save without bag" does not open the new-bag form', async () => {
    const { home, form } = setupHome();
    mocks.saveBean.mockResolvedValue({
      id: 7, name: 'New Bean', roaster: 'Kaffee Braun', bags: [], flavors: [],
    });

    library.openBeanForm();
    doc.getElementById('beanFormName')!.value = 'New Bean';
    doc.getElementById('beanFormRoastDate')!.value = '2026-03-04';

    await library.saveBeanNoBag();

    expect(mocks.saveBean).toHaveBeenCalledTimes(1);
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
    // Declined: only the confirm bar shows, so a swipe must spring back.
    expect(library.requestCloseBeanForm()).toBe(false);

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

    expect(library.requestCloseBeanForm()).toBe(true);

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

  it('adding a later bag passes no roast date and moves no focus', () => {
    setupHome();
    const form = doc.createElement();
    form.id = 'newBagForm7';
    form.style.display = 'none';
    doc.register(form);
    const date = doc.createElement();
    date.id = 'newBagRoastDate7';
    doc.register(date);

    // boot/delegation.ts's "open-new-bag" action calls openNewBagForm(id) with
    // no date: the form opens, but nothing is prefilled or focused (#1933).
    doc.activeElement = null;
    library.openNewBagForm(7);

    expect(form.style.display).toBe('');
    expect(date.value).toBe('');
    expect(doc.activeElement).toBeNull();
  });
});

describe('bean roast date follows the current bag (#1606)', () => {
  it('prefills the form with the current bag roast date, not the bean-level one', () => {
    setupHome();
    const bean = addBean();
    bean.roastDate = '2025-12-31';
    library.openBeanForm(bean);

    expect(doc.getElementById('beanFormRoastDate')!.value).toBe('2026-01-01');
  });

  it('editing without touching the roast date sends no roastDate', async () => {
    setupHome();
    const bean = addBean();
    bean.roastDate = '2025-12-31';
    mocks.saveBean.mockResolvedValue({
      id: 1, name: 'Renamed', roaster: 'Kaffee Braun', bags: bean.bags,
    });
    library.openBeanForm(bean);
    doc.getElementById('beanFormName')!.value = 'Renamed';

    await library.saveBean();

    const payload = mocks.saveBean.mock.calls[0]?.[1] as Record<string, unknown>;
    expect('roastDate' in payload).toBe(false);
  });

  it('editing the roast date sends the new value', async () => {
    setupHome();
    const bean = addBean();
    bean.roastDate = '2025-12-31';
    mocks.saveBean.mockResolvedValue({
      id: 1, name: 'Yirgacheffe Chelelektu', roaster: 'Kaffee Braun', bags: bean.bags,
    });
    library.openBeanForm(bean);
    doc.getElementById('beanFormRoastDate')!.value = '2026-02-02';

    await library.saveBean();

    const payload = mocks.saveBean.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload.roastDate).toBe('2026-02-02');
  });
});

describe('bean autosave leaves the bag alone (#2018)', () => {
  const bagWithPrice = (price: number | null): unknown[] => [
    { id: 1, stock_g: 250, consumedG: 0, remainingG: 250, current: true, roastDate: '2026-01-01', price_eur: price },
  ];

  it('an edit save with an unchanged price makes no bag update call', async () => {
    setupHome();
    const bean = addBean();
    bean.bags = bagWithPrice(12.5);
    mocks.saveBean.mockResolvedValue({
      id: 1, name: 'Renamed', roaster: 'Kaffee Braun', bags: bagWithPrice(12.5), flavors: [],
    });
    library.openBeanForm(bean);
    doc.getElementById('beanFormName')!.value = 'Renamed';

    await library.saveBean();

    expect(mocks.saveBean).toHaveBeenCalledTimes(1);
    expect(mocks.updateBeanBag).not.toHaveBeenCalled();
  });

  it('an edit save with a changed price updates the current bag once', async () => {
    setupHome();
    const bean = addBean();
    bean.bags = bagWithPrice(12.5);
    mocks.saveBean.mockResolvedValue({
      id: 1, name: 'Yirgacheffe Chelelektu', roaster: 'Kaffee Braun', bags: bagWithPrice(12.5), flavors: [],
    });
    mocks.updateBeanBag.mockResolvedValue({
      id: 1, name: 'Yirgacheffe Chelelektu', roaster: 'Kaffee Braun', bags: bagWithPrice(13), flavors: [],
    });
    library.openBeanForm(bean);
    doc.getElementById('beanFormPrice')!.value = '13';

    await library.saveBean();

    expect(mocks.updateBeanBag).toHaveBeenCalledTimes(1);
    const call = mocks.updateBeanBag.mock.calls[0] as unknown as [number, number, Record<string, unknown>];
    expect(call[0]).toBe(1);
    expect(call[1]).toBe(1);
    expect(call[2]?.price_eur).toBe(13);
  });
});

describe('a failed bag price update keeps the form unsaved (#2022)', () => {
  const bagWithPrice = (price: number | null): unknown[] => [
    { id: 1, stock_g: 250, consumedG: 0, remainingG: 250, current: true, roastDate: '2026-01-01', price_eur: price },
  ];

  it('shows the save error, returns no row and retries the bag update next time', async () => {
    const { home, form } = setupHome();
    const bean = addBean();
    bean.bags = bagWithPrice(12.5);
    mocks.saveBean.mockResolvedValue({
      id: 1, name: 'Yirgacheffe Chelelektu', roaster: 'Kaffee Braun', bags: bagWithPrice(12.5), flavors: [],
    });
    // The bean itself saves; only the follow-up bag update fails.
    mocks.updateBeanBag
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 1, name: 'Yirgacheffe Chelelektu', roaster: 'Kaffee Braun', bags: bagWithPrice(13), flavors: [],
      });
    library.openBeanForm(bean);
    doc.getElementById('beanFormPrice')!.value = '13';

    await library.saveBean();

    // The sheet's own toast, not the window one the rejected save uses.
    expect(mocks.toast).toHaveBeenCalledWith('Error saving');
    expect(mocks.updateBeanBag).toHaveBeenCalledTimes(1);
    // The bean row the first request stored stays; the form counts as unsaved.
    expect(S.coffeeLibrary.beans).toHaveLength(1);
    expect(form.parentNode).not.toBe(home);

    await library.saveBean();

    expect(mocks.updateBeanBag).toHaveBeenCalledTimes(2);
    expect(form.parentNode).toBe(home);
  });
});

describe('double save guard (#1614 slice 4)', () => {
  it('ignores a second save while the first POST is still pending', async () => {
    setupHome();
    doc.getElementById('beanFormName')!.value = 'New Bean';

    let release!: (bean: Bean) => void;
    mocks.saveBean.mockImplementation(() => new Promise<Bean>(res => { release = res; }));

    const first = library.saveBeanNoBag();
    // Fired while the first request is still in flight: it must not POST again.
    const second = library.saveBeanNoBag();
    expect(mocks.saveBean).toHaveBeenCalledTimes(1);

    release({ id: 7, name: 'New Bean', roaster: 'Kaffee Braun', bags: [], flavors: [] });
    await first;
    await second;

    expect(mocks.saveBean).toHaveBeenCalledTimes(1);
  });
});

describe('edit autosave catch-up (#2016)', () => {
  it('saves once more after the in-flight save and still closes the form', async () => {
    const { home, form } = setupHome();
    // bindFormAutosave needs the actions row it puts its status into.
    const actions = doc.createElement();
    actions.className = 'lib-form-actions';
    form.appendChild(actions);
    const bean = addBean();
    const row = (name: string): Bean => ({ id: 1, name, roaster: 'Kaffee Braun', bags: bean.bags, flavors: [] });
    const releases: ((bean: Bean) => void)[] = [];
    mocks.saveBean.mockImplementation(() => new Promise<Bean>(res => { releases.push(res); }));

    library.openBeanForm(bean);
    doc.getElementById('beanFormName')!.value = 'Renamed';

    // The user clicks Save, then types. The autosave finds the save in flight
    // and must queue one catch-up save instead of dropping the keystroke.
    const buttonSave = library.saveBean();
    form.dispatch('change', { target: { type: 'text' } });
    expect(mocks.saveBean).toHaveBeenCalledTimes(1);

    releases[0]!(row('Renamed'));
    await buttonSave;

    // Both requests are still open here, which is exactly when a catch-up save
    // that shares the row with the button path would strand the form: the
    // button save has to close it on its own result, not on shared state.
    await vi.waitFor(() => expect(form.parentNode).toBe(home));
    expect(S.coffeeLibrary.beans[0]?.name).toBe('Renamed');

    await vi.waitFor(() => expect(mocks.saveBean).toHaveBeenCalledTimes(2));
    releases[1]!(row('Renamed'));
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    // The late catch-up must not reopen the form or start a third save.
    expect(form.parentNode).toBe(home);
    expect(mocks.saveBean).toHaveBeenCalledTimes(2);
  });
});

describe('rejected save shows an error (#1761)', () => {
  const saveButtonIds = ['saveBeanBtn', 'saveBeanNoBagBtn', 'saveBeanAddBagBtn'];

  function expectSaveButtonsEnabled(): void {
    expect(find('lib-sheet-save')?.disabled).toBe(false);
    for (const id of saveButtonIds) {
      expect(doc.getElementById(id)?.disabled).toBe(false);
    }
  }

  it('create: shows the server message and keeps the form and its values', async () => {
    const { home, form } = setupHome();
    mocks.saveBean.mockRejectedValue(new Error('name required'));

    library.openBeanForm();
    doc.getElementById('beanFormName')!.value = 'Rejected Bean';
    find('lib-sheet-save')!.dispatch('click');

    await vi.waitFor(() => expect(showToast).toHaveBeenCalledTimes(1));

    expect(showToast.mock.calls[0]?.[0]).toContain('name required');
    expect(form.parentNode).not.toBe(home);
    expect(doc.body.querySelector('#beanFormSheet')?.classList.contains('open')).toBe(true);
    expect(doc.getElementById('beanFormName')!.value).toBe('Rejected Bean');
    expect(S.coffeeLibrary.beans).toHaveLength(0);
    expectSaveButtonsEnabled();
  });

  it('edit: falls back to the HTTP status and leaves the bean unchanged', async () => {
    setupHome();
    const bean = addBean();
    mocks.saveBean.mockRejectedValue(new Error('HTTP 500'));

    library.openBeanForm(bean);
    doc.getElementById('beanFormName')!.value = 'Renamed';
    find('lib-sheet-save')!.dispatch('click');

    await vi.waitFor(() => expect(showToast).toHaveBeenCalledTimes(1));

    expect(showToast.mock.calls[0]?.[0]).toContain('HTTP 500');
    expect(doc.body.querySelector('#beanFormSheet')?.classList.contains('open')).toBe(true);
    expect(doc.getElementById('beanFormName')!.value).toBe('Renamed');
    expect(S.coffeeLibrary.beans).toHaveLength(1);
    expect(S.coffeeLibrary.beans[0]?.name).toBe('Yirgacheffe Chelelektu');
    expectSaveButtonsEnabled();
  });
});
