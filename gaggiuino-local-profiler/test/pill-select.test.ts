// #1962 slice 3: pill-select.ts turns a short <select> into visible pills while
// keeping the hidden select as the single source of truth. The node test env
// has no DOM, so these fakes stand in for the handful of methods the helper
// touches; the module itself must be imported after the globals exist.
import { describe, it, expect, beforeEach } from 'vitest';

interface FakeOptionSpec { value: string; text: string; key?: string }

class FakeEvent {
  readonly type: string;
  readonly bubbles: boolean;
  constructor(type: string, init?: { bubbles?: boolean }) {
    this.type = type;
    this.bubbles = init?.bubbles ?? false;
  }
}

class FakeClassList {
  private readonly names = new Set<string>();
  toggle(name: string, on?: boolean): void {
    if (on === true) this.names.add(name);
    else this.names.delete(name);
  }
  contains(name: string): boolean { return this.names.has(name); }
}

class FakeElement {
  id = '';
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly classList = new FakeClassList();
  readonly attrs: Record<string, string> = {};
  readonly listeners: Record<string, Array<(e: FakeEvent) => void>> = {};
  readonly children: FakeElement[] = [];
  className = '';
  type = '';
  textContent = '';

  setAttribute(name: string, value: string): void { this.attrs[name] = value; }
  getAttribute(name: string): string | null { return this.attrs[name] ?? null; }
  addEventListener(name: string, fn: (e: FakeEvent) => void): void { (this.listeners[name] ??= []).push(fn); }
  appendChild(el: FakeElement): void { this.children.push(el); }
  fire(name: string): void { for (const fn of this.listeners[name] ?? []) fn(new FakeEvent(name)); }
}

class FakeOption {
  readonly value: string;
  readonly textContent: string;
  private readonly attrs: Record<string, string> = {};
  constructor(spec: FakeOptionSpec) {
    this.value = spec.value;
    this.textContent = spec.text;
    if (spec.key !== undefined) this.attrs['data-i18n'] = spec.key;
  }
  getAttribute(name: string): string | null { return this.attrs[name] ?? null; }
}

// The `value` and `disabled` accessors live on the prototype so the helper can
// read their descriptors, exactly as it does for the real HTMLSelectElement.
class FakeHTMLSelectElement extends FakeElement {
  options: FakeOption[] = [];
  readonly inserted: FakeElement[] = [];
  readonly dispatched: FakeEvent[] = [];
  private current = '';
  private disabledFlag = false;

  get value(): string { return this.current; }
  set value(v: string) { this.current = v; }
  get disabled(): boolean { return this.disabledFlag; }
  set disabled(v: boolean) { this.disabledFlag = v; }
  insertAdjacentElement(_where: string, el: FakeElement): void { this.inserted.push(el); }
  dispatchEvent(e: FakeEvent): void { this.dispatched.push(e); }
}

// Labels a select can be named by, keyed by the id in `label[for="<id>"]`.
const labels = new Map<string, FakeElement>();

const g = globalThis as unknown as Record<string, unknown>;
g.HTMLSelectElement = FakeHTMLSelectElement;
g.Event = FakeEvent;
g.document = {
  createElement: () => new FakeElement(),
  querySelectorAll: () => [],
  querySelector: (selector: string): FakeElement | null => {
    const match = /^label\[for="(.*)"\]$/.exec(selector);
    return match ? labels.get(match[1]!) ?? null : null;
  },
};

const { bindPillSelect, bindPillSelects } = await import('../public-src/components/pill-select.js');

function at<T>(arr: readonly T[], i: number): T {
  const v = arr[i];
  if (v === undefined) throw new Error(`no element at index ${i}`);
  return v;
}

function makeSelect(specs: FakeOptionSpec[], label?: string): FakeHTMLSelectElement {
  const select = new FakeHTMLSelectElement();
  select.options = specs.map(spec => new FakeOption(spec));
  if (label !== undefined) select.setAttribute('aria-label', label);
  return select;
}

function pillsOf(select: FakeHTMLSelectElement): FakeElement[] {
  return at(select.inserted, 0).children;
}

// The helper is typed against the real DOM classes; the fakes only exist here.
const asSelect = (select: FakeHTMLSelectElement): HTMLSelectElement => select as unknown as HTMLSelectElement;

const WALL_TYPES: FakeOptionSpec[] = [
  { value: '', text: '– none –', key: 'basket_wall_type_none' },
  { value: 'pressurized', text: 'Pressurized', key: 'basket_wall_type_pressurized' },
  { value: 'high-flow', text: 'High-Flow', key: 'basket_wall_type_high_flow' },
];

describe('#1962 pill select', () => {
  let select: FakeHTMLSelectElement;
  beforeEach(() => {
    labels.clear();
    select = makeSelect(WALL_TYPES, 'Wall type');
  });

  it('renders one pill per non-empty option and hides the select', () => {
    bindPillSelect(asSelect(select));
    const pills = pillsOf(select);
    expect(pills.map(p => p.dataset.val)).toEqual(['pressurized', 'high-flow']);
    expect(pills.map(p => p.textContent)).toEqual(['Pressurized', 'High-Flow']);
    expect(select.style.display).toBe('none');
    expect(at(select.inserted, 0).className).toBe('theme-toggle-group');
    expect(at(select.inserted, 0).getAttribute('aria-label')).toBe('Wall type');
  });

  it('copies data-i18n-aria-label from the select to its group', () => {
    select.setAttribute('data-i18n-aria-label', 'basket_wall_type_label');
    bindPillSelect(asSelect(select));
    expect(at(select.inserted, 0).getAttribute('data-i18n-aria-label'))
      .toBe('basket_wall_type_label');
  });

  it('names the group from a <label for> when the select has no aria-label', () => {
    const select = makeSelect(WALL_TYPES);
    select.id = 'basketWallType';
    const labelEl = new FakeElement();
    labelEl.setAttribute('for', 'basketWallType');
    labels.set('basketWallType', labelEl);

    bindPillSelect(asSelect(select));

    const group = at(select.inserted, 0);
    expect(labelEl.id).toBe('basketWallType-label');
    expect(group.getAttribute('aria-labelledby')).toBe('basketWallType-label');
    expect(group.getAttribute('aria-label')).toBeNull();
  });

  it('keeps an id the label already has when pointing aria-labelledby at it', () => {
    const select = makeSelect(WALL_TYPES);
    select.id = 'basketWallType';
    const labelEl = new FakeElement();
    labelEl.id = 'wallTypeHeading';
    labels.set('basketWallType', labelEl);

    bindPillSelect(asSelect(select));

    expect(at(select.inserted, 0).getAttribute('aria-labelledby')).toBe('wallTypeHeading');
  });

  it('copies data-i18n from the option to its pill', () => {
    bindPillSelect(asSelect(select));
    expect(pillsOf(select).map(p => p.getAttribute('data-i18n')))
      .toEqual(['basket_wall_type_pressurized', 'basket_wall_type_high_flow']);
  });

  it('a click sets the value and dispatches one bubbling change event', () => {
    bindPillSelect(asSelect(select));
    at(pillsOf(select), 1).fire('click');
    expect(select.value).toBe('high-flow');
    expect(select.dispatched).toHaveLength(1);
    expect(at(select.dispatched, 0).type).toBe('change');
    expect(at(select.dispatched, 0).bubbles).toBe(true);
  });

  it('clicking the active pill clears the field when an empty option exists', () => {
    select.value = 'pressurized';
    bindPillSelect(asSelect(select));
    at(pillsOf(select), 0).fire('click');
    expect(select.value).toBe('');
    expect(select.dispatched).toHaveLength(1);
  });

  it('clicking the active pill keeps the value when the select is not clearable', () => {
    const sort = makeSelect([{ value: 'fresh', text: 'Fresh' }, { value: 'name', text: 'Name' }]);
    sort.value = 'fresh';
    bindPillSelect(asSelect(sort));
    at(pillsOf(sort), 0).fire('click');
    expect(sort.value).toBe('fresh');
  });

  it('writing select.value repaints active and aria-pressed', () => {
    bindPillSelect(asSelect(select));
    const pills = pillsOf(select);
    expect(pills.map(p => p.classList.contains('active'))).toEqual([false, false]);
    select.value = 'high-flow';
    expect(pills.map(p => p.classList.contains('active'))).toEqual([false, true]);
    expect(pills.map(p => p.getAttribute('aria-pressed'))).toEqual(['false', 'true']);
  });

  it('binding twice adds no second group', () => {
    bindPillSelect(asSelect(select));
    bindPillSelect(asSelect(select));
    expect(select.inserted).toHaveLength(1);
  });

  it('bindPillSelects ignores a null select', () => {
    expect(() => { bindPillSelect(null); }).not.toThrow();
    expect(() => { bindPillSelects(document); }).not.toThrow();
  });
});
