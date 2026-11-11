import { t } from '../i18n.js';

// Saves an open edit form whenever a field is committed (#1962, docs/DESIGN.md
// "Saving"). Creating an entry keeps its save button: isEditing() is false.
export function bindFormAutosave(form: HTMLElement, opts: { isEditing: () => boolean; save: () => Promise<boolean> }): void {
  // A form without an actions row has nowhere to show the status; the DOM
  // fakes in the unit tests have no querySelector at all, so check first.
  const actions = typeof form.querySelector === 'function' ? form.querySelector('.lib-form-actions') : null;
  if (!actions) return;

  const status = document.createElement('span');
  status.className = 'autosave-status';
  actions.prepend(status);

  // `.autosave-status` is transparent until it carries `visible`, so the
  // status is only ever seen while a save is pending or has just succeeded.
  let running = false;
  let again = false;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  const run = async (): Promise<void> => {
    if (running) { again = true; return; }
    running = true;
    clearTimeout(hideTimer);
    status.textContent = t('autosave_pending');
    status.classList.add('visible');
    let ok = false;
    try { ok = await opts.save(); } finally { running = false; }
    if (again) { again = false; void run(); return; }
    status.textContent = ok ? t('autosave_saved') : '';
    // The form stays open, so the confirmation has to clear itself again.
    if (ok) hideTimer = setTimeout(() => status.classList.remove('visible'), 1800);
    else status.classList.remove('visible');
  };

  form.addEventListener('change', e => {
    if ((e.target as HTMLInputElement | null)?.type === 'file' || !opts.isEditing()) return;
    void run();
  });
}
