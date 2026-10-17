import { themeColor } from '../utils.js';

// The app's single toast (moved out of main.ts for #1716). One element is
// reused for every message, so a newer toast always replaces the current one,
// its action included.

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastOptions {
  duration?: number;
  /** Optional button (e.g. Undo). Clicking it hides the toast. */
  action?: ToastAction;
}

type ToastElement = HTMLElement & { _t?: ReturnType<typeof setTimeout> };

function hideToast(el: ToastElement): void {
  clearTimeout(el._t);
  el.style.opacity = '0';
  el.style.pointerEvents = 'none';
  // Drop the action so a faded-out toast leaves no focusable button behind.
  el.querySelector('.glp-toast-action')?.remove();
}

export function showToast(msg: string, opts: ToastOptions | number = {}): void {
  const { duration = 3000, action } = typeof opts === 'number' ? { duration: opts } : opts;
  let el = document.getElementById('glpToast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'glpToast';
    el.className = 'glp-toast';
    // Polite live region: screen readers announce each new message.
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.style.cssText = [
      'position:fixed', 'bottom:24px', 'left:50%', 'transform:translateX(-50%)',
      // #814: was a hardcoded #27272a/#e4e4e7 — a dark chip on a light page.
      `background:${themeColor('--raised', '#27272a')}`, `color:${themeColor('--gray-200', '#e4e4e7')}`,
      'padding:10px 20px', 'border-radius:8px',
      'font-size:.85rem', 'z-index:9999', 'box-shadow:0 4px 12px rgba(0,0,0,.4)',
      'transition:opacity .3s', 'pointer-events:none', 'white-space:nowrap',
    ].join(';');
    document.body.appendChild(el);
  }
  const toast = el as ToastElement;
  toast.textContent = msg;
  if (action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'glp-toast-action';
    btn.textContent = action.label;
    btn.onclick = () => { hideToast(toast); action.onClick(); };
    toast.appendChild(btn);
  }
  toast.style.opacity = '1';
  // Only a toast with a button takes clicks; a plain one stays click-through.
  toast.style.pointerEvents = action ? 'auto' : 'none';
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { hideToast(toast); }, duration);
}
