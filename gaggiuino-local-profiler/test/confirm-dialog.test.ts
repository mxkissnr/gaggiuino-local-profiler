// #1962: confirmDialog() is the app's one confirmation dialog. vitest runs in
// the node environment with no DOM, so the sliver the dialog touches is faked
// here (same approach as test/image-crop-dialog.test.ts) and the shared
// keyboard helper is mocked so its Escape callback can be fired directly.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

type Listener = (event?: unknown) => void;

class FakeEl {
  className = '';
  textContent = '';
  type = '';
  removed = false;
  readonly style: Record<string, string> = {};
  readonly attrs = new Map<string, string>();
  readonly children: FakeEl[] = [];
  readonly listeners = new Map<string, Listener[]>();

  setAttribute(name: string, value: string): void { this.attrs.set(name, value); }
  appendChild(child: FakeEl): FakeEl { this.children.push(child); return child; }
  remove(): void { this.removed = true; }
  addEventListener(type: string, fn: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  fire(type: string, event?: unknown): void {
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }
  focus(): void { /* focus is browser-only */ }
}

interface KeyboardCall {
  host: FakeEl;
  onEscape: () => void;
  initialFocus: FakeEl | null;
}

const keyboard = vi.hoisted(() => ({
  calls: [] as KeyboardCall[],
  release: vi.fn(),
  labels: { maint_ok: 'OK', lib_cancel: 'Cancel' } as Record<string, string>,
}));

vi.mock('../public-src/components/dialog-a11y.js', () => ({
  attachDialogKeyboard: (host: FakeEl, onEscape: () => void, opts: { initialFocus?: FakeEl | null } = {}) => {
    keyboard.calls.push({ host, onEscape, initialFocus: opts.initialFocus ?? null });
    return { release: keyboard.release };
  },
}));

vi.mock('../public-src/i18n.js', () => ({
  t: (key: string): string => keyboard.labels[key] ?? key,
}));

const { confirmDialog } = await import('../public-src/components/confirm-dialog.js');

const g = globalThis as unknown as Record<string, unknown>;

interface FakeDocument {
  body: FakeEl;
  created: string[];
  createElement: (tag: string) => FakeEl;
}

let doc: FakeDocument;

function fakeDocument(): FakeDocument {
  const created: string[] = [];
  return {
    body: new FakeEl(),
    created,
    createElement(tag: string): FakeEl {
      created.push(tag);
      return new FakeEl();
    },
  };
}

function at(list: FakeEl[], index: number): FakeEl {
  const el = list[index];
  if (!el) throw new Error(`missing element ${index}`);
  return el;
}

function overlay(): FakeEl { return at(doc.body.children, 0); }
function box(): FakeEl { return at(overlay().children, 0); }
function text(): FakeEl { return at(box().children, 0); }
function buttons(): FakeEl[] { return at(box().children, 1).children; }
function confirmButton(): FakeEl { return at(buttons(), buttons().length - 1); }
function cancelButton(): FakeEl { return at(buttons(), 0); }
function lastKeyboardCall(): KeyboardCall {
  const call = keyboard.calls[keyboard.calls.length - 1];
  if (!call) throw new Error('attachDialogKeyboard was not called');
  return call;
}

beforeEach(() => {
  doc = fakeDocument();
  g.document = doc;
  keyboard.calls = [];
  keyboard.release.mockClear();
});

afterEach(() => {
  delete g.document;
});

describe('confirmDialog() (#1962)', () => {
  it('resolves true when the confirm button is clicked', async () => {
    const pending = confirmDialog('Delete this?');
    confirmButton().fire('click');
    await expect(pending).resolves.toBe(true);
    expect(overlay().removed).toBe(true);
    expect(keyboard.release).toHaveBeenCalledTimes(1);
  });

  it('resolves false when cancel is clicked', async () => {
    const pending = confirmDialog('Delete this?');
    cancelButton().fire('click');
    await expect(pending).resolves.toBe(false);
    expect(overlay().removed).toBe(true);
    expect(keyboard.release).toHaveBeenCalledTimes(1);
  });

  it('resolves false on Escape', async () => {
    const pending = confirmDialog('Delete this?');
    lastKeyboardCall().onEscape();
    await expect(pending).resolves.toBe(false);
    expect(overlay().removed).toBe(true);
    expect(keyboard.release).toHaveBeenCalledTimes(1);
  });

  it('resolves once, even when two ways out fire together', async () => {
    const pending = confirmDialog('Delete this?');
    lastKeyboardCall().onEscape();
    overlay().fire('click', { target: overlay() });
    await expect(pending).resolves.toBe(false);
    expect(keyboard.release).toHaveBeenCalledTimes(1);
  });

  it('resolves false on a backdrop click but stays open on a click inside', async () => {
    const pending = confirmDialog('Delete this?');
    const dialog = overlay();
    dialog.fire('click', { target: box() });
    expect(dialog.removed).toBe(false);
    dialog.fire('click', { target: dialog });
    await expect(pending).resolves.toBe(false);
    expect(dialog.removed).toBe(true);
    expect(keyboard.release).toHaveBeenCalledTimes(1);
  });

  it('shows Cancel and OK by default and focuses Cancel', () => {
    void confirmDialog('Delete this?');
    expect(buttons()).toHaveLength(2);
    expect(cancelButton().textContent).toBe('Cancel');
    expect(confirmButton().textContent).toBe('OK');
    expect(lastKeyboardCall().initialFocus).toBe(cancelButton());
  });

  it('uses the given confirm label', async () => {
    const pending = confirmDialog('Delete this?', { confirmLabel: 'Delete' });
    expect(confirmButton().textContent).toBe('Delete');
    confirmButton().fire('click');
    await expect(pending).resolves.toBe(true);
  });

  it('sets the message as text, never as markup', () => {
    void confirmDialog('Server said <img src=x onerror=alert(1)>');
    expect(text().textContent).toBe('Server said <img src=x onerror=alert(1)>');
    expect(doc.created).not.toContain('img');
  });

  it('shows only OK when acknowledging, and Escape still closes it', async () => {
    const pending = confirmDialog('Restored. Reloading…', { acknowledgeOnly: true });
    expect(buttons()).toHaveLength(1);
    expect(confirmButton().textContent).toBe('OK');
    expect(lastKeyboardCall().initialFocus).toBe(confirmButton());
    lastKeyboardCall().onEscape();
    await expect(pending).resolves.toBe(true);
    expect(overlay().removed).toBe(true);
    expect(keyboard.release).toHaveBeenCalledTimes(1);
  });
});
