// #2038 slice 4: the machine dialog. The machines list is a plain grouped list
// whose rows open the machine form in the shared detail sheet — a centred
// dialog on desktop, a bottom sheet on phones — with the machine's remaining
// row actions in the sheet bar's ⋯ menu.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

// vitest's node environment has no browser globals; stub them through a loose
// view of globalThis (the same bridge the other component tests use).
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };
g.navigator ??= { language: 'en-US' };

const dialogs = vi.hoisted(() => ({
  confirmDialog: vi.fn<(message: string, opts?: { confirmLabel?: string }) => Promise<boolean>>(),
}));

vi.mock('../public-src/components/confirm-dialog.js', () => ({ confirmDialog: dialogs.confirmDialog }));

type FakeElement = {
  value: string; innerHTML: string; textContent: string; title: string; className: string;
  style: Record<string, string>; dataset: Record<string, string>;
  disabled: boolean; hidden: boolean; checked: boolean;
  parentNode: unknown; nextSibling: unknown;
  handlers: Record<string, () => void>;
  open: boolean;
  querySelectorAll(): unknown[];
  querySelector(sel: string): FakeElement;
  addEventListener(type: string, fn: () => void): void;
  appendChild(child: FakeElement): void;
  remove(): void; removeAttribute(name: string): void; setAttribute(name: string, value: string): void;
  insertBefore(child: FakeElement, next: unknown): void;
  insertAdjacentHTML(pos: string, markup: string): void;
  children: FakeElement[];
};

// Every fake caches its own querySelector result, so a listener bound to one
// selector can be found again through the same selector.
function fake(): FakeElement {
  const kids: Record<string, FakeElement> = {};
  const el: FakeElement = {
    value: '', innerHTML: '', textContent: '', title: '', className: '',
    style: {}, dataset: {}, disabled: false, hidden: false, checked: false,
    parentNode: null, nextSibling: null, children: [], handlers: {}, open: false,
    querySelectorAll: () => [],
    querySelector: (sel: string) => (kids[sel] ??= fake()),
    addEventListener: (type: string, fn: () => void) => { el.handlers[type] = fn; },
    appendChild: (child: FakeElement) => { el.children.push(child); },
    remove: () => {},
    insertBefore: (child: FakeElement) => { el.children.push(child); },
    removeAttribute: () => {},
    setAttribute: () => {},
    insertAdjacentHTML: () => {},
  };
  return el;
}

// Module-level init in state/i18n touches document, so a bare stub goes in
// before the imports; the tests below swap in their own fake per case.
g.document = { getElementById: () => undefined, body: { classList: { add: () => {}, remove: () => {} } } };

const { openDetailSheet, closeDetailSheet } = await import('../public-src/components/detail-sheet.js');
const { openMachineForm, closeMachineForm, renderMachinesList, wireMachineDialogActions } =
  await import('../public-src/components/machines-settings.js');
const { S } = await import('../public-src/state/index.js');
const { html } = await import('../public-src/utils.js');
const { t } = await import('../public-src/i18n.js');

type MachineFormArg = NonNullable<Parameters<typeof openMachineForm>[0]>;

S.currentLang = 'en';
g.fetch = () => Promise.resolve({ ok: false, status: 502, json: () => Promise.resolve({}) });

function installDom(host: FakeElement, desktop: boolean): void {
  g.window = {
    matchMedia: (query: string) => ({ matches: query.includes('max-width') ? !desktop : false }),
    innerWidth: 1280,
    innerHeight: 900,
    setTimeout,
    clearTimeout,
  };
  g.document = {
    getElementById: (id: string) => (id === 'detailSheet' ? host : undefined),
    body: { classList: { add: () => {}, remove: () => {} } },
    activeElement: null,
  };
}

describe('detail sheet content and dialog options (#2038)', () => {
  let host: FakeElement;
  beforeEach(() => { host = fake(); });
  afterEach(() => { closeDetailSheet(); });

  it('moves a content node into the body and puts it back on close', () => {
    const body = fake();
    host.querySelector = (sel: string) => (sel === '.detail-sheet-body' ? body : (null as unknown as FakeElement));
    installDom(host, true);

    const parent = { insertBefore: vi.fn() };
    const next = { marker: 'next' };
    const node = { parentNode: parent, nextSibling: next } as unknown as HTMLElement;

    openDetailSheet({ title: 'Machine', body: html``, content: node });
    expect(body.children).toContain(node as unknown as FakeElement);

    closeDetailSheet();
    expect(parent.insertBefore).toHaveBeenCalledWith(node, next);
  });

  it('puts the previous content back before a second sheet is shown', () => {
    const body = fake();
    host.querySelector = (sel: string) => (sel === '.detail-sheet-body' ? body : (null as unknown as FakeElement));
    installDom(host, true);

    const parent = { insertBefore: vi.fn() };
    const first = { parentNode: parent, nextSibling: null } as unknown as HTMLElement;
    openDetailSheet({ title: 'First', body: html``, content: first });
    openDetailSheet({ title: 'Second', body: html`` });
    expect(parent.insertBefore).toHaveBeenCalledWith(first, null);
  });

  it('is a centred dialog on desktop without an anchor, and not on a phone', () => {
    installDom(host, true);
    openDetailSheet({ title: 'Machine', body: html``, dialog: true });
    expect(host.innerHTML).toContain('detail-dialog');

    const phone = fake();
    installDom(phone, false);
    openDetailSheet({ title: 'Machine', body: html``, dialog: true });
    expect(phone.innerHTML).not.toContain('detail-dialog');
  });

  it('stays the anchored popover on desktop when an anchor is given', () => {
    const sheet = { offsetWidth: 200, offsetHeight: 100, style: {}, querySelector: () => null };
    host.querySelector = (sel: string) => (sel === '.lib-sheet' ? (sheet as unknown as FakeElement) : (null as unknown as FakeElement));
    installDom(host, true);
    const anchor = { getBoundingClientRect: () => ({ left: 50, right: 100, top: 100, height: 20 }) } as unknown as HTMLElement;
    openDetailSheet({ title: 'Machine', body: html``, dialog: true, anchor });
    expect(host.innerHTML).toContain('detail-pop');
    expect(host.innerHTML).not.toContain('detail-dialog');
  });
});

describe('the machine dialog (#2038)', () => {
  const elements: Record<string, FakeElement> = {};
  const host = fake();
  const list = fake();
  let saved: MachineFormArg;

  function fakeElement(id: string): FakeElement { return (elements[id] ??= fake()); }

  beforeEach(() => {
    for (const key of Object.keys(elements)) delete elements[key];
    host.innerHTML = '';
    list.children.length = 0;
    list.innerHTML = '';
    installDom(host, true);
    g.document = {
      getElementById: (id: string) => (id === 'detailSheet' ? host : id === 'machinesList' ? list : fakeElement(id)),
      createElement: () => fake(),
      body: { classList: { add: () => {}, remove: () => {} } },
      activeElement: null,
    };
    dialogs.confirmDialog.mockReset();
    dialogs.confirmDialog.mockResolvedValue(false);
    S.machines = [
      { id: 1, name: 'Gaggia', type: 'gaggiuino' },
      { id: 2, name: 'Mate', type: 'gaggimate', isDefault: true },
    ];
    S.allShots = [];
    // A real parent, so the sheet's content move (and the return on close) runs.
    fakeElement('machineFormCard').parentNode = fake();
    saved = S.machines[0] as unknown as MachineFormArg;
  });

  it('opens a saved machine in the sheet bar with its actions menu', () => {
    openMachineForm(saved);
    expect(fakeElement('machineFormCard').style.display).toBe('');
    const markup = host.innerHTML;
    expect(markup).toContain('Gaggia');
    expect(markup).toContain('machine-dialog-more');
    const backups = markup.indexOf('class="machine-backups-btn"');
    const setDefault = markup.indexOf('machine-set-default-btn');
    const del = markup.indexOf('machine-delete-btn');
    expect(backups).toBeGreaterThanOrEqual(0);
    expect(setDefault).toBeGreaterThan(backups);
    expect(del).toBeGreaterThan(setDefault);
  });

  it('drops Set as default for the default machine', () => {
    const def = S.machines[1] as unknown as MachineFormArg;
    openMachineForm(def);
    expect(host.innerHTML).toContain('machine-delete-btn');
    expect(host.innerHTML).not.toContain('machine-set-default-btn');
  });

  it('shows Add machine for a new machine and no menu', () => {
    openMachineForm(null);
    expect(host.innerHTML).toContain('Add machine');
    expect(host.innerHTML).not.toContain('machine-dialog-more');
  });

  it('leaves the sheet alone for the inline setup wizard form', () => {
    openMachineForm(saved);
    const sheetMarkup = host.innerHTML;
    openMachineForm(saved, { inline: true });
    expect(host.innerHTML).toBe(sheetMarkup);
  });

  it('closes the sheet when the form closes', () => {
    openMachineForm(saved);
    closeMachineForm();
    expect(fakeElement('machineFormCard').style.display).toBe('none');
  });

  it('folds the menu and confirms before deleting', () => {
    const root = fake();
    wireMachineDialogActions(root as unknown as HTMLElement, saved);
    const menu = root.querySelector('.machine-dialog-more');
    menu.open = true;

    root.querySelector('.machine-delete-btn').handlers.click?.();

    expect(menu.open).toBe(false);
    expect(dialogs.confirmDialog).toHaveBeenCalledWith(t('settings_machine_delete_confirm'), { confirmLabel: t('lib_btn_delete') });
  });

  it('hides Set as default once the machine became the default', () => {
    const root = fake();
    wireMachineDialogActions(root as unknown as HTMLElement, saved);
    const btn = root.querySelector('.machine-set-default-btn');
    expect(btn.hidden).toBe(false);

    btn.handlers.click?.();

    expect(btn.hidden).toBe(true);
    expect(root.querySelector('.machine-dialog-more').open).toBe(false);
  });

  it('renders rows with icon, name, subtitle and no action buttons', () => {
    renderMachinesList();
    const rows = list.children;
    expect(rows).toHaveLength(2);
    const first = rows[0];
    const second = rows[1];
    if (!first || !second) throw new Error('expected two rows');
    expect(first.innerHTML).toContain('machine-row-main');
    expect(first.dataset.machineId).toBe('1');
    expect(second.dataset.machineId).toBe('2');
    expect(first.innerHTML).toContain('Gaggiuino');
    expect(first.innerHTML).not.toContain('Default');
    expect(second.innerHTML).toContain('Default');
    expect(first.innerHTML).not.toContain('machine-row-badge');
  });
});
