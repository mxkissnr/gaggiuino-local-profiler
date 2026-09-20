// #946: annotation.js's library <select>s (bean/basket/puck screen/recipe)
// are built with `new Option()` + DocumentFragment + replaceChildren instead
// of an innerHTML string, so CodeQL no longer re-raises js/xss-through-dom on
// every code move. The Node test env has no DOM; these fakes capture the
// produced option objects so tests can assert value/dataset/selected/text
// directly. The real HTMLOptionElement sets its first ctor arg as text
// (textContent — never parsed as markup), which is the property that proves
// the escaping guarantee, so FakeOption stores it verbatim.

export class FakeOption {
  text: string;
  value: string;
  selected: boolean;
  dataset: Record<string, string>;
  constructor(text: string, value: string | number, _defaultSelected = false, selected = false) {
    this.text = text;
    this.value = String(value);
    this.selected = selected;
    this.dataset = {};
  }
}

export class FakeFragment {
  children: unknown[] = [];
  append(...nodes: unknown[]) { this.children.push(...nodes); }
}

export interface FakeSelect {
  options?: unknown[];
  replaceChildren(fragment: FakeFragment): void;
}

// Installs globalThis.Option + globalThis.document and returns a map of
// id -> fake <select>. Each fake select exposes `.options` (the array passed
// to replaceChildren) after a render. `extraElements` lets a caller add
// non-select nodes the render path also touches (e.g. recipeField.style).
export function installFakeOptionDom(ids: string[], extraElements: Record<string, unknown> = {}): Record<string, FakeSelect> {
  // The Node test env has no DOM; these fakes stand in for the real classes,
  // so the DOM-typed globals need an explicit bridge.
  const globals = globalThis as unknown as { Option: unknown; document: unknown };
  globals.Option = FakeOption;
  const selects: Record<string, FakeSelect> = {};
  for (const id of ids) {
    selects[id] = { replaceChildren(fragment: FakeFragment) { this.options = fragment.children; } };
  }
  const all: Record<string, unknown> = { ...selects, ...extraElements };
  globals.document = {
    createDocumentFragment: () => new FakeFragment(),
    getElementById: (id: string) => all[id] ?? null,
  };
  return selects;
}
