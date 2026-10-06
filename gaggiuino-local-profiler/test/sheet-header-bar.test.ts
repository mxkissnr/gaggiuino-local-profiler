import { describe, it, expect, beforeEach, vi } from 'vitest';

// library.js's import chain touches state.js/i18n.js, which read
// localStorage/navigator at module load time — stub the minimum browser
// globals so the module graph can be imported under vitest's node environment.
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };
g.navigator ??= { language: 'en-US' };

// The form sheet's bar Save must reach the same API path as the form's own
// Save button; mocking keeps the test off the network.
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
// parents and wires real click listeners on the bar, so appendChild /
// insertBefore / parentNode / dispatch are real here (same shape as the
// library-bean-form-sheet test).
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
    this.parentNode?.removeChild(this);
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
    // missing host stays observable. Every field is a permissive stub.
    if (id === 'beanSheet' || id === 'beanFormSheet') return null;
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

interface StateLike {
  coffeeLibrary: { beans: unknown[]; recipes: unknown[]; grinders: unknown[] };
  shots: unknown[];
  currentLang: string;
  beanEditId: number | null;
}

interface LibraryModule {
  openBeanSheet: (id: number) => void;
  openBeanForm: (bean?: unknown) => void;
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

// The slice of the markup from the bar's opening div up to the content block
// that follows it, so placement can be asserted inside the bar only.
function barSlice(inner: string): string {
  const start = inner.indexOf('class="lib-sheet-bar"');
  if (start < 0) return '';
  const stops = ['lib-sheet-hero', 'detail-sheet-body', 'lib-form-confirm', 'lib-form-sheet-body']
    .map(marker => inner.indexOf(marker, start))
    .filter(index => index >= 0);
  return inner.slice(start, stops.length ? Math.min(...stops) : undefined);
}

describe('bean sheet header bar (#1489)', () => {
  let doc: FakeDocument;
  let S: StateLike;
  let library: LibraryModule;
  let t: (key: string, ...args: unknown[]) => string;

  beforeEach(async () => {
    doc = new FakeDocument();
    g.document = doc;
    g.window = { matchMedia: () => ({ matches: false }) };
    vi.resetModules();
    ({ S } = (await import('../public-src/state/index.js')) as unknown as { S: StateLike });
    ({ t } = (await import('../public-src/i18n.js')) as unknown as { t: typeof t });
    S.currentLang = 'en';
    S.shots = [];
    S.coffeeLibrary = {
      beans: [{
        id: 1,
        name: 'Yirgacheffe Chelelektu',
        roaster: 'Kaffee Braun',
        origin: 'ET',
        flavors: [],
        bags: [{ id: 1, stock_g: 250, consumedG: 0, remainingG: 250, current: true, roastDate: '2026-01-01' }],
      }],
      recipes: [],
      grinders: [],
    };
    library = (await import('../public-src/views/library.js')) as unknown as LibraryModule;
  });

  it('puts close first, then the name, then the two icons and the menu', () => {
    library.openBeanSheet(1);
    const inner = doc.body.querySelector('#beanSheet')!.innerHTML;
    const bar = barSlice(inner);
    expect(bar).not.toBe('');

    const close = bar.indexOf('class="lib-sheet-close"');
    const title = bar.indexOf('id="beanSheetTitle"');
    const shot = bar.indexOf('data-action="filter-by-bean"');
    const edit = bar.indexOf('data-action="edit-bean"');
    expect(close).toBeGreaterThanOrEqual(0);
    expect(title).toBeGreaterThan(close);
    expect(shot).toBeGreaterThan(title);
    expect(edit).toBeGreaterThan(shot);

    // The two icon actions plus the ⋮ menu live in the bar.
    expect(count(bar, 'class="lib-sheet-iconbtn"')).toBe(2);
    expect(bar).toContain('lib-sheet-more');
    expect(bar).toContain('class="lib-sheet-bar-actions"');
  });

  it('shows Shot log and Edit exactly once and drops Edit from the menu', () => {
    library.openBeanSheet(1);
    const inner = doc.body.querySelector('#beanSheet')!.innerHTML;

    expect(count(inner, `aria-label="${t('lib_sheet_shot_log')}"`)).toBe(1);
    expect(count(inner, `aria-label="${t('lib_btn_edit')}"`)).toBe(1);
    expect(count(inner, 'data-action="edit-bean"')).toBe(1);
    expect(count(inner, 'data-action="filter-by-bean"')).toBe(1);

    // The primary row keeps the two bag actions, no shot log.
    const row = inner.slice(inner.indexOf('class="lib-sheet-actions"'));
    expect(row).toContain('data-action="open-new-bag"');
    expect(row).toContain('data-action="open-freeze-form"');
    expect(row).not.toContain('data-action="filter-by-bean"');
  });
});

describe('detail sheet header bar (#1489)', () => {
  it('renders the close and the title in the bar, and no action icons', async () => {
    const doc = new FakeDocument();
    g.document = doc;
    g.window = { matchMedia: (q: string) => ({ matches: q.includes('max-width') }) };
    vi.resetModules();
    const { openDetailSheet } = await import('../public-src/components/detail-sheet.js');
    const { html } = await import('../public-src/utils.js');

    const host = doc.createElement();
    host.id = 'detailSheet';
    doc.body.appendChild(host);

    openDetailSheet({ title: '3 May 2026', sub: '4 Shots', body: html`<p class="body-marker">row</p>` });

    const inner = host.innerHTML;
    const bar = barSlice(inner);
    // The bar holds the close button (before) and the title.
    const close = bar.indexOf('class="lib-sheet-close"');
    const title = bar.indexOf('id="detailSheetTitle"');
    expect(close).toBeGreaterThanOrEqual(0);
    expect(title).toBeGreaterThan(close);
    // No action icons at all.
    expect(inner).not.toContain('lib-sheet-iconbtn');
    expect(inner).not.toContain('lib-sheet-more');
    expect(inner).not.toContain('data-action="');
    expect(inner).not.toContain('lib-sheet-save');
    // The sub moved out of the bar into the content.
    expect(bar).not.toContain('detail-sheet-sub');
    expect(inner.indexOf('detail-sheet-sub')).toBeGreaterThan(inner.indexOf('id="detailSheetTitle"'));
  });
});

describe('bean form sheet header bar save (#1489)', () => {
  let doc: FakeDocument;
  let S: StateLike;
  let library: LibraryModule;

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

  beforeEach(async () => {
    doc = new FakeDocument();
    g.document = doc;
    g.window = { matchMedia: () => ({ matches: false }) };
    mocks.saveBean.mockReset();
    vi.resetModules();
    ({ S } = (await import('../public-src/state/index.js')) as unknown as { S: StateLike });
    S.currentLang = 'en';
    S.shots = [];
    S.beanEditId = null;
    S.coffeeLibrary = { beans: [], recipes: [], grinders: [] };
    library = (await import('../public-src/views/library.js')) as unknown as LibraryModule;
  });

  it('bar Save runs the same submit path as the form save button', async () => {
    setupHome();
    library.openBeanForm();

    const save = doc.body.querySelector('#beanFormSheet')?.querySelector('.lib-sheet-save') ?? null;
    expect(save).not.toBeNull();
    expect(save?.getAttribute('aria-label')).toBeTruthy();

    doc.getElementById('beanFormName')!.value = 'New Bean';
    mocks.saveBean.mockResolvedValue(null);
    save!.dispatch('click');
    await Promise.resolve();

    expect(mocks.saveBean).toHaveBeenCalledTimes(1);
    const [, payload] = mocks.saveBean.mock.calls[0] ?? [];
    expect((payload as { name?: string } | undefined)?.name).toBe('New Bean');
  });
});
