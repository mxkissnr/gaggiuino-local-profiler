// #946: annotation.js's library <select>s (bean/basket/puck screen/recipe)
// are built with `new Option()` + DocumentFragment + replaceChildren instead
// of an innerHTML string, so CodeQL no longer re-raises js/xss-through-dom on
// every code move. The Node test env has no DOM; these fakes capture the
// produced option objects so tests can assert value/dataset/selected/text
// directly. The real HTMLOptionElement sets its first ctor arg as text
// (textContent — never parsed as markup), which is the property that proves
// the escaping guarantee, so FakeOption stores it verbatim.

export class FakeOption {
  constructor(text, value, _defaultSelected = false, selected = false) {
    this.text = text;
    this.value = String(value);
    this.selected = selected;
    this.dataset = {};
  }
}

class FakeFragment {
  constructor() { this.children = []; }
  append(...nodes) { this.children.push(...nodes); }
}

// Installs globalThis.Option + globalThis.document and returns a map of
// id -> fake <select>. Each fake select exposes `.options` (the array passed
// to replaceChildren) after a render. `extraElements` lets a caller add
// non-select nodes the render path also touches (e.g. recipeField.style).
export function installFakeOptionDom(ids, extraElements = {}) {
  globalThis.Option = FakeOption;
  const selects = {};
  for (const id of ids) {
    selects[id] = { replaceChildren(frag) { this.options = frag.children; } };
  }
  const all = { ...selects, ...extraElements };
  globalThis.document = {
    createDocumentFragment: () => new FakeFragment(),
    getElementById: (id) => all[id] ?? null,
  };
  return selects;
}
