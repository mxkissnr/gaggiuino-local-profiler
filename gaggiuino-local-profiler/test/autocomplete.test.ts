import { describe, it, expect } from 'vitest';
import { filterSuggestions, attachAutocomplete } from '../public-src/components/autocomplete.js';

describe('filterSuggestions — pure filtering logic', () => {
  const list = ['Bourbon', 'Bourbon Rojo', 'Geisha', 'Gesha', 'SL28', 'Caturra'];

  it('returns the list (deduped, limited) when the query is empty', () => {
    expect(filterSuggestions(list, '', 3)).toEqual(['Bourbon', 'Bourbon Rojo', 'Geisha']);
  });

  it('is case-insensitive', () => {
    expect(filterSuggestions(list, 'GEI')).toEqual(['Geisha']);
  });

  it('ranks prefix matches before substring-only matches', () => {
    // "Ge" is a prefix of Geisha/Gesha, and a substring of nothing else here —
    // add a case where a substring match would sort first alphabetically to
    // prove ordering comes from match kind, not alphabetical order.
    const withSubstring = ['Zesty Gesha Blend', 'Geisha', 'Gesha'];
    expect(filterSuggestions(withSubstring, 'ge')).toEqual(['Geisha', 'Gesha', 'Zesty Gesha Blend']);
  });

  it('excludes an item that exactly matches the already-typed query', () => {
    expect(filterSuggestions(['Geisha'], 'Geisha')).toEqual([]);
  });

  it('dedupes identical entries', () => {
    expect(filterSuggestions(['Washed', 'Washed', 'Natural'], '')).toEqual(['Washed', 'Natural']);
  });

  it('drops non-string/blank entries without throwing', () => {
    expect(filterSuggestions(['Washed', '', null, undefined, '  ', 'Natural'], '')).toEqual(['Washed', 'Natural']);
  });

  it('respects the limit', () => {
    expect(filterSuggestions(list, '', 2)).toHaveLength(2);
  });

  it('returns an empty array for a query that matches nothing', () => {
    expect(filterSuggestions(list, 'zzz')).toEqual([]);
  });

  it('handles a missing/undefined list gracefully', () => {
    expect(filterSuggestions(undefined, 'x')).toEqual([]);
  });
});

// ── Minimal fake DOM for attachAutocomplete() interaction tests ────────────
// This repo has no jsdom/happy-dom dependency (vitest runs with
// environment: 'node') — build just enough of a DOM to support the
// createElement/appendChild/classList/attribute/event calls
// attachAutocomplete() actually makes, mirroring the "fake minimal
// document" convention in test/bottom-nav-config.test.js.
function makeFakeDoc() {
  function createElement(tag) {
    const el = {
      tagName: String(tag).toUpperCase(),
      id: '',
      className: '',
      style: {},
      dataset: {},
      hidden: false,
      value: '',
      parentNode: null,
      ownerDocument: null,
      _attrs: {},
      _listeners: {},
      _children: [],
      _text: '',
      _html: '',
      classList: {
        _set: new Set(),
        add(c) { this._set.add(c); },
        remove(c) { this._set.delete(c); },
        contains(c) { return this._set.has(c); },
      },
      get children() { return el._children; },
      get textContent() { return el._text; },
      set textContent(v) { el._text = v; },
      get innerHTML() { return el._html; },
      set innerHTML(v) { el._html = v; if (v === '') el._children = []; },
      setAttribute(k, v) { el._attrs[k] = String(v); },
      getAttribute(k) { return Object.prototype.hasOwnProperty.call(el._attrs, k) ? el._attrs[k] : null; },
      removeAttribute(k) { delete el._attrs[k]; },
      appendChild(child) {
        if (child.parentNode && child.parentNode._children) {
          const old = child.parentNode._children;
          const i = old.indexOf(child);
          if (i !== -1) old.splice(i, 1);
        }
        child.parentNode = el;
        el._children.push(child);
        return child;
      },
      insertBefore(newNode, ref) {
        const idx = el._children.indexOf(ref);
        newNode.parentNode = el;
        if (idx === -1) el._children.push(newNode);
        else el._children.splice(idx, 0, newNode);
        return newNode;
      },
      addEventListener(type, fn) { (el._listeners[type] ||= []).push(fn); },
      dispatchEvent(evt) { (el._listeners[evt.type] || []).slice().forEach(fn => fn(evt)); return true; },
      fire(type, props = {}) { el.dispatchEvent({ type, preventDefault() {}, ...props }); },
      focus() {},
      blur() {},
    };
    return el;
  }
  return { createElement };
}

function setup(getOptions) {
  const doc = makeFakeDoc();
  const field = doc.createElement('div');
  const input = doc.createElement('input');
  input.id = 'beanFormVariety';
  input.ownerDocument = doc;
  field.appendChild(input);
  const handle = attachAutocomplete(input, getOptions);
  const list = field._children.find(c => c.tagName === 'DIV')._children.find(c => c.tagName === 'UL');
  return { doc, field, input, list, handle };
}

describe('attachAutocomplete — DOM wiring', () => {
  const options = () => ['Bourbon', 'Bourbon Rojo', 'Geisha'];

  it('wraps the input in a positioned wrap div and sets combobox ARIA', () => {
    const { input, field } = setup(options);
    expect(field._children).toHaveLength(1);
    expect(field._children[0].className).toBe('autocomplete-wrap');
    expect(input.getAttribute('role')).toBe('combobox');
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(input.getAttribute('aria-controls')).toBe('beanFormVariety-listbox');
  });

  it('is idempotent — attaching twice returns the same handle and does not re-wrap', () => {
    const { input, field, handle } = setup(options);
    const second = attachAutocomplete(input, options);
    expect(second).toBe(handle);
    expect(field._children).toHaveLength(1);
  });

  it('opens with filtered suggestions on focus', () => {
    const { input, list } = setup(options);
    input.value = 'bourbon';
    input.fire('focus');
    expect(list.hidden).toBe(false);
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(list.children.map(c => c.textContent)).toEqual(['Bourbon', 'Bourbon Rojo']);
  });

  it('re-filters on input', () => {
    const { input, list } = setup(options);
    input.value = 'gei';
    input.fire('input');
    expect(list.children.map(c => c.textContent)).toEqual(['Geisha']);
  });

  it('closes when nothing matches', () => {
    const { input, list } = setup(options);
    input.value = 'zzz';
    input.fire('input');
    expect(list.hidden).toBe(true);
    expect(input.getAttribute('aria-expanded')).toBe('false');
  });

  it('ArrowDown/ArrowUp move the active item and set aria-activedescendant', () => {
    const { input, list } = setup(options);
    input.fire('focus');
    input.fire('keydown', { key: 'ArrowDown' });
    expect(list.children[0].classList.contains('active')).toBe(true);
    expect(input.getAttribute('aria-activedescendant')).toBe(list.children[0].id);
    input.fire('keydown', { key: 'ArrowDown' });
    expect(list.children[1].classList.contains('active')).toBe(true);
    expect(list.children[0].classList.contains('active')).toBe(false);
    input.fire('keydown', { key: 'ArrowUp' });
    expect(list.children[0].classList.contains('active')).toBe(true);
  });

  it('Enter selects the active item and fires input+change', () => {
    const { input, list } = setup(options);
    let changed = false;
    input.addEventListener('change', () => { changed = true; });
    input.fire('focus');
    input.fire('keydown', { key: 'ArrowDown' });
    input.fire('keydown', { key: 'Enter' });
    expect(input.value).toBe('Bourbon');
    expect(list.hidden).toBe(true);
    expect(changed).toBe(true);
  });

  it('Enter with nothing highlighted just closes the list', () => {
    const { input, list } = setup(options);
    input.fire('focus');
    input.fire('keydown', { key: 'Enter' });
    expect(input.value).toBe('');
    expect(list.hidden).toBe(true);
  });

  it('Escape closes the list without changing the value', () => {
    const { input, list } = setup(options);
    input.fire('focus');
    input.fire('keydown', { key: 'Escape' });
    expect(list.hidden).toBe(true);
    expect(input.value).toBe('');
  });

  it('blur closes the list', () => {
    const { input, list } = setup(options);
    input.fire('focus');
    expect(list.hidden).toBe(false);
    input.fire('blur');
    expect(list.hidden).toBe(true);
  });

  // The actual bug being fixed (Pixel, Android/Chrome): a plain click
  // handler on the option can miss because blur (hiding the list) fires
  // before the click. Selection is wired to pointerdown with
  // preventDefault() instead, which keeps the input focused and never lets
  // blur fire in the first place — this asserts that handler exists and
  // works, not just a same-tick click.
  it('selects via pointerdown on an option, calling preventDefault (the touch fix)', () => {
    const { input, list } = setup(options);
    input.fire('focus');
    let prevented = false;
    list.children[1].fire('pointerdown', { preventDefault() { prevented = true; } });
    expect(prevented).toBe(true);
    expect(input.value).toBe('Bourbon Rojo');
    expect(list.hidden).toBe(true);
  });

  it('refresh() is a no-op while closed', () => {
    const { list, handle } = setup(options);
    expect(list.hidden).toBe(true);
    handle.refresh();
    expect(list.hidden).toBe(true);
  });

  it('refresh() re-renders currently visible suggestions against fresh data', () => {
    let pool = ['Bourbon'];
    const { input, list, handle } = setup(() => pool);
    input.fire('focus');
    expect(list.children.map(c => c.textContent)).toEqual(['Bourbon']);
    pool = ['Bourbon', 'Geisha'];
    handle.refresh();
    expect(list.children.map(c => c.textContent)).toEqual(['Bourbon', 'Geisha']);
  });

  it('free text stays valid — selecting never restricts input.value to suggestions', () => {
    const { input, list } = setup(options);
    input.value = 'Something not in the list';
    input.fire('input');
    expect(list.hidden).toBe(true); // no matches, but nothing rejects the typed value
    expect(input.value).toBe('Something not in the list');
  });
});
