// Shared keyboard behaviour for modals and sheets (#1619): Escape closes the
// topmost dialog, focus moves inside when it opens, Tab is trapped while it is
// open, and closing returns focus to whatever opened it. A module-level stack
// keeps nested overlays (e.g. the crop editor over a detail sheet) from closing
// each other's Escape target.

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

const _stack: HTMLElement[] = [];

export interface DialogKeyboardHandle {
  release: () => void;
}

export interface DialogKeyboardOptions {
  /** Element to focus on open; defaults to the first focusable inside `host`. */
  initialFocus?: HTMLElement | null;
  /** Element to restore focus to on close; defaults to the element focused when the dialog opened. */
  returnFocus?: HTMLElement | null;
}

export function focusablesWithin(host: HTMLElement | null): HTMLElement[] {
  if (!host || typeof host.querySelectorAll !== 'function') return [];
  return Array.from(host.querySelectorAll<HTMLElement>(FOCUSABLE));
}

export function trapTabKey(e: KeyboardEvent, host: HTMLElement | null): void {
  const items = focusablesWithin(host);
  const first = items[0];
  const last = items[items.length - 1];
  if (!first || !last) return;
  const active = typeof document !== 'undefined' ? document.activeElement : null;
  if (e.shiftKey && (active === first || !items.includes(active as HTMLElement))) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (active === last || !items.includes(active as HTMLElement))) {
    e.preventDefault();
    first.focus();
  }
}

export function attachDialogKeyboard(
  host: HTMLElement | null,
  onEscape: () => void,
  opts: DialogKeyboardOptions = {},
): DialogKeyboardHandle {
  if (!host || typeof document === 'undefined') return { release: () => {} };

  const opener = opts.returnFocus ?? ((document.activeElement as HTMLElement | null) ?? null);
  _stack.push(host);

  const target = opts.initialFocus ?? focusablesWithin(host)[0] ?? host;
  if (target === host && typeof host.setAttribute === 'function'
    && (typeof host.hasAttribute !== 'function' || !host.hasAttribute('tabindex'))) {
    host.setAttribute('tabindex', '-1');
  }
  if (typeof target.focus === 'function') target.focus();

  const onKey = (e: KeyboardEvent): void => {
    if (_stack[_stack.length - 1] !== host) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      onEscape();
      return;
    }
    if (e.key === 'Tab') trapTabKey(e, host);
  };
  if (typeof document.addEventListener === 'function') document.addEventListener('keydown', onKey);

  let released = false;
  return {
    release(): void {
      if (released) return;
      released = true;
      const at = _stack.lastIndexOf(host);
      if (at >= 0) _stack.splice(at, 1);
      if (typeof document.removeEventListener === 'function') document.removeEventListener('keydown', onKey);
      if (opener && opener !== document.body && typeof opener.focus === 'function'
        && (typeof document.contains !== 'function' || document.contains(opener))) {
        opener.focus();
      }
    },
  };
}
