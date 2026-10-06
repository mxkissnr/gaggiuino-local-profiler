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

type Handler = (event: { target?: unknown; preventDefault?: () => void }) => void;

function matches(el: El, selector: string): boolean {
  return selector.startsWith('.') ? el.classList.contains(selector.slice(1)) : el.id === selector.slice(1);
}

// Compact tree-aware fake element: enough for the form sheet, which moves
// #beanAddForm between parents and wires real click listeners on the bar.
class El {
  id = '';
  className = '';
  innerHTML = '';
  textContent = '';
  value = '';
  type = '';
  style: Record<string, string> = {};
  parent: El | null = null;
  readonly kids: El[] = [];
  private readonly attrs = new Map<string, string>();
  private readonly handlers = new Map<string, Handler[]>();
  private readonly doc: Doc;
  readonly classList = {
    contains: (name: string): boolean => this.hasClass(name),
    add: (...names: string[]): void => this.setClass(names, true),
    remove: (...names: string[]): void => this.setClass(names, false),
    toggle: (name: string, on: boolean): boolean => { this.setClass([name], on); return on; },
  };

  constructor(doc: Doc) {
    this.doc = doc;
  }

  private hasClass(name: string): boolean {
    return this.className.split(' ').includes(name);
  }

  private setClass(names: string[], on: boolean): void {
    const set = new Set(this.className.split(' ').filter(Boolean));
    for (const name of names) { if (on) set.add(name); else set.delete(name); }
    this.className = [...set].join(' ');
  }

  get firstChild(): El | null {
    return this.kids[0] ?? null;
  }

  get nextSibling(): El | null {
    const parent = this.parent;
    if (!parent) return null;
    const index = parent.kids.indexOf(this);
    return index >= 0 ? (parent.kids[index + 1] ?? null) : null;
  }

  appendChild(child: El): El {
    child.detach();
    child.parent = this;
    this.kids.push(child);
    this.doc.register(child);
    return child;
  }

  insertBefore(node: El, ref: El | null): El {
    node.detach();
    node.parent = this;
    const index = ref ? this.kids.indexOf(ref) : -1;
    if (index >= 0) this.kids.splice(index, 0, node); else this.kids.push(node);
    return node;
  }

  removeChild(child: El): void {
    const index = this.kids.indexOf(child);
    if (index >= 0) { this.kids.splice(index, 1); child.parent = null; }
  }

  detach(): void {
    this.parent?.removeChild(this);
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }

  addEventListener(type: string, listener: Handler): void {
    const list = this.handlers.get(type) ?? [];
    list.push(listener);
    this.handlers.set(type, list);
  }

  dispatch(type: string): void {
    for (const listener of this.handlers.get(type) ?? []) {
      listener({ target: this, preventDefault: () => {} });
    }
  }

  focus(): void {
    this.doc.activeElement = this;
  }

  querySelector(selector: string): El | null {
    for (const child of this.kids) {
      if (matches(child, selector)) return child;
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }

  querySelectorAll(selector: string): El[] {
    const out: El[] = [];
    const walk = (el: El): void => {
      for (const child of el.kids) {
        if (matches(child, selector)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
}

class Doc {
  readonly body = new El(this);
  activeElement: El | null = null;
  private readonly nodes = new Map<string, El>();

  createElement(): El {
    return new El(this);
  }

  register(el: El): void {
    if (el.id) this.nodes.set(el.id, el);
  }

  getElementById(id: string): El | null {
    const known = this.nodes.get(id);
    if (known) return known;
    const found = this.body.querySelector(`#${id}`);
    if (found) { this.nodes.set(id, found); return found; }
    // The sheet hosts must genuinely be created, never auto-vivified, so a
    // missing host stays observable. Every field is a permissive stub.
    if (id === 'beanSheet' || id === 'beanFormSheet') return null;
    const el = new El(this);
    el.id = id;
    this.nodes.set(id, el);
    return el;
  }

  addEventListener(): void { /* the sheet key listeners are irrelevant here */ }
  removeEventListener(): void {}
  contains(): boolean { return true; }
  querySelector(): El | null { return null; }
  querySelectorAll(): El[] { return []; }
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

// The slice of the rendered markup from the header bar up to the content block
// that follows it, so placement can be asserted inside the bar only.
function barSlice(inner: string): string {
  const start = inner.indexOf('class="lib-sheet-bar"');
  if (start < 0) return '';
  const stops = ['lib-sheet-hero', 'detail-sheet-body', 'lib-form-confirm', 'lib-form-sheet-body']
    .map(marker => inner.indexOf(marker, start))
    .filter(index => index >= 0);
  return inner.slice(start, stops.length ? Math.min(...stops) : undefined);
}

async function importState(): Promise<StateLike> {
  const { S } = (await import('../public-src/state/index.js')) as unknown as { S: StateLike };
  S.currentLang = 'en';
  S.shots = [];
  return S;
}

describe('bean sheet header bar (#1489)', () => {
  let doc: Doc;
  let S: StateLike;
  let library: LibraryModule;
  let t: (key: string) => string;

  beforeEach(async () => {
    doc = new Doc();
    g.document = doc;
    g.window = { matchMedia: () => ({ matches: false }) };
    vi.resetModules();
    S = await importState();
    ({ t } = (await import('../public-src/i18n.js')) as unknown as { t: (key: string) => string });
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
    const bar = barSlice(doc.body.querySelector('#beanSheet')!.innerHTML);
    expect(bar).not.toBe('');

    const close = bar.indexOf('class="lib-sheet-close"');
    const title = bar.indexOf('id="beanSheetTitle"');
    const shot = bar.indexOf('data-action="filter-by-bean"');
    const edit = bar.indexOf('data-action="edit-bean"');
    expect(title).toBeGreaterThan(close);
    expect(shot).toBeGreaterThan(title);
    expect(edit).toBeGreaterThan(shot);

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
    const doc = new Doc();
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
    const close = bar.indexOf('class="lib-sheet-close"');
    const title = bar.indexOf('id="detailSheetTitle"');
    expect(title).toBeGreaterThan(close);
    // No action icons at all.
    expect(inner).not.toContain('lib-sheet-iconbtn');
    expect(inner).not.toContain('lib-sheet-more');
    expect(inner).not.toContain('data-action="');
    expect(inner).not.toContain('lib-sheet-save');
    // The sub moved out of the bar into the content.
    expect(bar).not.toContain('detail-sheet-sub');
    expect(inner.indexOf('detail-sheet-sub')).toBeGreaterThan(title);
  });
});

describe('bean form sheet header bar save (#1489)', () => {
  let doc: Doc;
  let S: StateLike;
  let library: LibraryModule;

  function setupHome(): void {
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
  }

  beforeEach(async () => {
    doc = new Doc();
    g.document = doc;
    g.window = { matchMedia: () => ({ matches: false }) };
    mocks.saveBean.mockReset();
    vi.resetModules();
    S = await importState();
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
    const call = mocks.saveBean.mock.calls[0] as unknown[] | undefined;
    expect((call?.[1] as { name?: string } | undefined)?.name).toBe('New Bean');
  });
});
