import { describe, it, expect, vi, beforeEach } from 'vitest';

// #1619: keyboard operation for the converted cards and dialogs.

const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };
g.navigator ??= { language: 'en-US' };

interface FakeActionEl {
  dataset: Record<string, string>;
  click: ReturnType<typeof vi.fn>;
  closest: (selector: string) => FakeActionEl | null;
}

function roleButton(action: string): FakeActionEl {
  const el: FakeActionEl = {
    dataset: { action },
    click: vi.fn(),
    closest: (selector: string): FakeActionEl | null => (selector === '[data-action][role="button"]' ? el : null),
  };
  return el;
}

describe('role="button" cards activate from the keyboard (#1619)', () => {
  it('Enter activates a card action', () => {
    const card = roleButton('goto-shot');
    const preventDefault = vi.fn();
    activateActionFromKeyboard({ key: 'Enter', target: card, preventDefault } as unknown as KeyboardEvent);
    expect(card.click).toHaveBeenCalledTimes(1);
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  it('Space activates a header action', () => {
    const header = roleButton('toggle-bag-card');
    const preventDefault = vi.fn();
    activateActionFromKeyboard({ key: ' ', target: header, preventDefault } as unknown as KeyboardEvent);
    expect(header.click).toHaveBeenCalledTimes(1);
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  it('ignores other keys and native buttons', () => {
    const other = roleButton('goto-shot');
    activateActionFromKeyboard({ key: 'a', target: other, preventDefault: vi.fn() } as unknown as KeyboardEvent);

    // Native <button> elements fire their own click on Enter/Space.
    const native = { click: vi.fn(), closest: () => null };
    activateActionFromKeyboard({ key: 'Enter', target: native, preventDefault: vi.fn() } as unknown as KeyboardEvent);

    expect(other.click).not.toHaveBeenCalled();
    expect(native.click).not.toHaveBeenCalled();
  });
});

// ── Backup modal focus lifecycle ─────────────────────────────────────────

interface FakeClassList {
  add: (token: string) => void;
  remove: (token: string) => void;
  contains: (token: string) => boolean;
}

class FakeEl {
  id = '';
  innerHTML = '';
  textContent = '';
  className = '';
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  checked = false;
  disabled = false;
  value = '';
  children: FakeEl[] = [];
  onchange: (() => void) | null = null;
  oninput: (() => void) | null = null;
  onclick: (() => void) | null = null;
  focus = vi.fn();
  readonly classList: FakeClassList;
  private readonly tokens = new Set<string>();

  constructor() {
    this.classList = {
      add: (t: string) => { this.tokens.add(t); },
      remove: (t: string) => { this.tokens.delete(t); },
      contains: (t: string) => this.tokens.has(t),
    };
  }

  addEventListener(_type: string, _fn: (...args: unknown[]) => void): void { /* only the module-load keydown wiring */ }
  removeEventListener(_type: string, _fn: (...args: unknown[]) => void): void { /* no-op */ }
  appendChild(child: FakeEl): FakeEl { this.children.push(child); return child; }
  setAttribute(_name: string, _value: string): void { /* attributes are not read here */ }
  hasAttribute(): boolean { return false; }
  querySelector(): FakeEl { return new FakeEl(); }
  querySelectorAll(): FakeEl[] { return []; }
}

type KeyHandler = (e: KeyboardEvent) => void;

interface FakeDoc {
  els: Record<string, FakeEl>;
  activeElement: { focus: ReturnType<typeof vi.fn> } | null;
  addEventListener: (type: string, fn: KeyHandler) => void;
  removeEventListener: (type: string, fn: KeyHandler) => void;
  contains: () => boolean;
  createElement: () => FakeEl;
  getElementById: (id: string) => FakeEl;
  querySelectorAll: () => never[];
  body: FakeEl;
}

function makeDocument(): { doc: FakeDoc; modal: FakeEl; confirm: FakeEl; listeners: Record<string, KeyHandler[]> } {
  const els: Record<string, FakeEl> = {};
  const listeners: Record<string, KeyHandler[]> = {};
  const get = (id: string): FakeEl => (els[id] ??= Object.assign(new FakeEl(), { id }));
  const modal = get('backupModal');
  const confirm = get('backupModalConfirmBtn');
  // One focusable inside the dialog, so focus can be asserted moving in.
  modal.querySelectorAll = () => [confirm];
  const doc: FakeDoc = {
    els,
    activeElement: null,
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    removeEventListener: (type, fn) => {
      const list = listeners[type];
      if (list) listeners[type] = list.filter(f => f !== fn);
    },
    contains: () => true,
    createElement: () => new FakeEl(),
    getElementById: get,
    querySelectorAll: () => [],
    body: new FakeEl(),
  };
  return { doc, modal, confirm, listeners };
}

g.window ??= {};
g.sessionStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
g.document = makeDocument().doc;
const { activateActionFromKeyboard } = await import('../public-src/boot/delegation.js');
const { openBackupExportModal, closeBackupModal } = await import('../public-src/components/backup-modal.js');

describe('backup modal dialog keyboard (#1619)', () => {
  let doc: FakeDoc;
  let modal: FakeEl;
  let confirm: FakeEl;
  let listeners: Record<string, KeyHandler[]>;
  let opener: { focus: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    ({ doc, modal, confirm, listeners } = makeDocument());
    g.document = doc;
    opener = { focus: vi.fn() };
    doc.activeElement = opener;
  });

  it('exposes dialog semantics, moves focus in, and Escape closes and returns focus', () => {
    openBackupExportModal();

    expect(modal.classList.contains('open')).toBe(true);
    expect(confirm.focus).toHaveBeenCalledTimes(1);

    const onKeydown = listeners.keydown?.[0];
    expect(onKeydown).toBeDefined();
    onKeydown?.({ key: 'Escape', preventDefault: vi.fn() } as unknown as KeyboardEvent);

    expect(modal.classList.contains('open')).toBe(false);
    expect(opener.focus).toHaveBeenCalledTimes(1);
    expect(listeners.keydown ?? []).toHaveLength(0);
  });

  it('traps Tab inside the dialog', () => {
    openBackupExportModal();
    const onKeydown = listeners.keydown?.[0];
    const preventDefault = vi.fn();
    onKeydown?.({ key: 'Tab', shiftKey: false, preventDefault } as unknown as KeyboardEvent);

    // Only one focusable is inside, so both edges wrap to it.
    expect(confirm.focus).toHaveBeenCalledTimes(2);
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  it('closing directly also restores focus to the opener', () => {
    openBackupExportModal();
    closeBackupModal();
    expect(opener.focus).toHaveBeenCalledTimes(1);
  });
});
