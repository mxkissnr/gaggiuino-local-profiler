import { t } from '../i18n.js';
import { esc, html } from '../utils.js';
import type { Html } from '../utils.js';
import { CHECK_ICON_SVG } from '../icons.js';

type AutosaveState = 'idle' | 'pending' | 'saved' | 'failed';

// Saves an open edit form whenever a field is committed (#1962, docs/DESIGN.md
// "Saving"). Creating an entry keeps its save button: isEditing() is false.
// Editing shows a lasting saved or failed state instead of a brief flash
// (#2098). Callers call the returned reset on every open of the form.
export function bindFormAutosave(form: HTMLElement, opts: { isEditing: () => boolean; save: () => Promise<boolean> }): () => void {
  // A form without an actions row has nowhere to show the status; the DOM
  // fakes in the unit tests have no querySelector at all, so check first.
  const actions = (form as Partial<Element>).querySelector?.('.lib-form-actions') ?? null;
  if (!actions) return () => {};

  const status = document.createElement('span');
  status.className = 'autosave-status';
  status.setAttribute('role', 'status');
  actions.appendChild(status);

  const show = (state: AutosaveState): void => {
    const content: Record<AutosaveState, Html> = {
      idle: html``,
      pending: esc(t('autosave_pending')),
      saved: html`${CHECK_ICON_SVG} ${esc(t('autosave_saved'))}`,
      failed: esc(t('autosave_failed')),
    };
    status.innerHTML = content[state];
    status.classList.toggle('visible', state !== 'idle');
    status.classList.toggle('failed', state === 'failed');
  };

  let running = false;
  let again = false;
  let generation = 0;
  const run = async (): Promise<void> => {
    if (running) { again = true; return; }
    running = true;
    const gen = generation;
    show('pending');
    let ok: boolean;
    try { ok = await opts.save(); } catch { ok = false; }
    running = false;
    if (again) { again = false; void run(); return; }
    if (gen === generation) show(ok ? 'saved' : 'failed');
  };

  form.addEventListener('change', e => {
    if ((e.target as HTMLInputElement | null)?.type === 'file' || !opts.isEditing()) return;
    void run();
  });

  return () => { generation++; show('idle'); };
}
