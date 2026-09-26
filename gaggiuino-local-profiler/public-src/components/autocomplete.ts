// Reusable free-text autocomplete, replacing the app's native <datalist>
// inputs. A reported bug (Pixel, Android/Chrome): <datalist> renders with
// the browser's own UI, which looks different per platform and is
// unreliable to tap on Android/Chrome — a known datalist limitation, not
// something fixable from the input side with CSS/JS. This renders
// suggestions in the app's own dropdown style instead.
//
// Free text stays valid at all times, exactly like <datalist> — this never
// restricts the field to only the suggested values.
//
// Selection reacts to `pointerdown` on the suggestion, not `click`: on
// Android/Chrome, tapping an option fires the input's `blur` (which would
// hide the list) before a `click` event ever reaches the option element, so
// a naive click handler silently misses most taps. `pointerdown` runs
// first and calls preventDefault(), which stops that blur from happening
// at all, so the tap always lands.

// ── Pure filtering logic (kept separate from DOM so it's unit-testable
// under vitest's node environment) ──────────────────────────────────────
export function filterSuggestions(list: unknown, query: unknown, limit = 8): string[] {
  const source = Array.isArray(list) ? list : [];
  const pool = Array.from(new Set(source.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)));
  const trimmedQuery = (typeof query === 'string' ? query : '').trim();
  const q = trimmedQuery.toLowerCase();
  if (!q) return pool.slice(0, limit);

  const startsWith: string[] = [];
  const contains: string[] = [];
  for (const item of pool) {
    // Case-sensitive exact match only — a case-insensitive one would also
    // hide a suggestion that differs only in casing (e.g. typed "bourbon",
    // library has "Bourbon"), which is exactly the useful correction a
    // suggestion should offer.
    if (item === trimmedQuery) continue;
    const lower = item.toLowerCase();
    if (lower.startsWith(q)) startsWith.push(item);
    else if (lower.includes(q)) contains.push(item);
  }
  return [...startsWith, ...contains].slice(0, limit);
}

let _uid = 0;

export interface AutocompleteHandle {
  refresh: () => void;
  close: () => void;
}

declare global {
  interface HTMLInputElement {
    _autocomplete?: AutocompleteHandle;
  }
}

// Wires a text input to a suggestion dropdown. `getOptions` is called fresh
// on every open/keystroke so it should return the current full candidate
// list (e.g. `() => S.coffeeLibrary.beans.map(b => b.name)`) — no separate
// caching/"populate" step is needed, the list is always live.
//
// Returns a handle ({ refresh, close }) and is idempotent: calling it again
// on an already-attached input just returns the existing handle.
export function attachAutocomplete(
  inputArg: HTMLInputElement | null,
  getOptions?: (() => unknown) | null,
  opts: { limit?: number } = {},
): AutocompleteHandle | null {
  if (!inputArg) return null;
  if (inputArg._autocomplete) return inputArg._autocomplete;
  const input = inputArg;

  const limit = opts.limit ?? 8;
  const doc = input.ownerDocument || document;

  const wrap = doc.createElement('div');
  wrap.className = 'autocomplete-wrap';
  input.parentNode?.insertBefore(wrap, input);
  wrap.appendChild(input);

  const list = doc.createElement('ul');
  list.className = 'autocomplete-list';
  list.id = `${input.id || 'autocomplete' + (++_uid)}-listbox`;
  list.setAttribute('role', 'listbox');
  list.hidden = true;
  wrap.appendChild(list);

  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-controls', list.id);
  input.setAttribute('autocomplete', 'off');

  let items: string[] = [];
  let activeIndex = -1;
  let suppressOpen = false;

  function computeItems(): void {
    const options = getOptions ? getOptions() : [];
    items = filterSuggestions(options, input.value, limit);
  }

  function render(): void {
    if (!items.length) { close(); return; }
    list.innerHTML = '';
    items.forEach((val, i) => {
      const li = doc.createElement('li');
      li.className = 'autocomplete-item';
      li.id = `${list.id}-opt-${i}`;
      li.setAttribute('role', 'option');
      li.textContent = val;
      li.addEventListener('pointerdown', e => {
        e.preventDefault(); // keep focus on input, skip the blur race entirely
        select(val);
      });
      list.appendChild(li);
    });
    activeIndex = -1;
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  }

  function close(): void {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    activeIndex = -1;
  }

  function select(val: string): void {
    input.value = val;
    close();
    // Dispatched so other listeners (autosave, etc.) see the change like
    // any other input — suppressed here only against *this* component's own
    // 'input' listener, which would otherwise immediately reopen the list
    // with the remaining fuzzy matches right after the user just picked one.
    suppressOpen = true;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    suppressOpen = false;
    input.focus();
  }

  function setActive(i: number): void {
    const opts_ = [...list.children];
    opts_.forEach(el => el.classList.remove('active'));
    activeIndex = i;
    if (i >= 0 && opts_[i]) {
      opts_[i].classList.add('active');
      input.setAttribute('aria-activedescendant', opts_[i].id);
      opts_[i].scrollIntoView?.({ block: 'nearest' });
    } else {
      input.removeAttribute('aria-activedescendant');
    }
  }

  function openFresh(): void {
    if (suppressOpen) return;
    computeItems();
    render();
  }

  // Re-renders currently visible suggestions against fresh data (e.g. after
  // a library save/delete elsewhere changed the candidate list). A no-op if
  // this field isn't focused/open right now.
  function refresh(): void {
    if (list.hidden) return;
    openFresh();
  }

  input.addEventListener('focus', openFresh);
  input.addEventListener('input', openFresh);
  input.addEventListener('blur', close);
  input.addEventListener('keydown', e => {
    if (list.hidden) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') openFresh();
      return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(Math.min(activeIndex + 1, items.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(Math.max(activeIndex - 1, 0)); }
    else if (e.key === 'Enter') { if (activeIndex >= 0) { e.preventDefault(); select(items[activeIndex]); } else close(); }
    else if (e.key === 'Escape') { close(); }
  });

  const handle = { refresh, close };
  input._autocomplete = handle;
  return handle;
}
