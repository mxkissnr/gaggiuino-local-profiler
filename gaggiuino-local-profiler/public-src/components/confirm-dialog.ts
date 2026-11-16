import { t } from '../i18n.js';
import { attachDialogKeyboard } from './dialog-a11y.js';

// The app's one confirmation dialog (#1962, docs/DESIGN.md "Confirming"). The
// message is set as text, so it can never carry markup. Cancel is the initial
// focus: Enter on an unread dialog must not delete anything.

export interface ConfirmDialogOptions {
  /** Label of the confirm button; defaults to OK. Use lib_btn_delete for a delete. */
  confirmLabel?: string;
  /** Only an OK button: for a message the user must see before the page changes. */
  acknowledgeOnly?: boolean;
}

// Only one dialog may be up at a time (#2026): a quick double tap on delete
// used to stack two overlays, and answering both sent the request twice. A call
// while one is open resolves false at once, which is the same as "no".
let _open = false;

export function confirmDialog(message: string, opts: ConfirmDialogOptions = {}): Promise<boolean> {
  if (_open) return Promise.resolve(false);
  _open = true;
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'guided-maint-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');

    const box = document.createElement('div');
    box.className = 'guided-maint-modal';
    const text = document.createElement('p');
    text.className = 'settings-card-desc';
    text.style.whiteSpace = 'pre-line';
    text.textContent = message;

    const actions = document.createElement('div');
    actions.className = 'lib-form-actions';
    const accept = document.createElement('button');
    accept.type = 'button';
    accept.className = 'lib-save-btn';
    accept.textContent = opts.confirmLabel ?? t('maint_ok');

    let cancel: HTMLButtonElement | null = null;
    if (!opts.acknowledgeOnly) {
      cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'lib-btn-sm';
      cancel.textContent = t('lib_cancel');
      actions.appendChild(cancel);
    }
    actions.appendChild(accept);
    box.appendChild(text);
    box.appendChild(actions);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    // Escape and a backdrop click mean "no" everywhere except an acknowledgement,
    // which has no "no": closing it is the only way to continue.
    const dismissed = opts.acknowledgeOnly === true;
    let settled = false;
    const finish = (result: boolean): void => {
      if (settled) return;
      settled = true;
      _open = false;
      keyboard.release();
      overlay.remove();
      resolve(result);
    };
    const keyboard = attachDialogKeyboard(overlay, () => { finish(dismissed); }, { initialFocus: cancel ?? accept });
    accept.addEventListener('click', () => { finish(true); });
    cancel?.addEventListener('click', () => { finish(false); });
    overlay.addEventListener('click', e => { if (e.target === overlay) finish(dismissed); });
  });
}
