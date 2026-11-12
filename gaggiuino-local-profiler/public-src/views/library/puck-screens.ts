// Puck Screens section (#635) of the Library view, split out of
// views/library.ts. Pure move + type port (Part of #1115); no behavior change.
import { S } from '../../state/index.js';
import { t, tHtml } from '../../i18n.js';
import * as libraryApi from '../../api/library.js';
import { esc, html, joinHtml } from '../../utils.js';
import { ICON_TRASH } from '../../icons.js';
import type { Html } from '../../utils.js';
import { cropAndUploadPhoto, adjustPhoto, savedPhotoRow } from '../../photo-upload.js';
import type { PhotoCropShape } from '../../photo-upload.js';
import { openLightbox } from '../../components/lightbox.js';
import { showToast } from '../../components/toast.js';
import { confirmDialog } from '../../components/confirm-dialog.js';
import { markFieldInvalid } from '../../components/field-error.js';
import { bindFormAutosave } from '../../components/form-autosave.js';
import { loadPuckScreenImageBlobUrl, invalidatePuckScreenImage } from '../../bean-image.js';
import type { PuckScreen } from '../../api/types.js';

// Same 1:1 crop the puck screen photo always had.
const PUCK_SCREEN_PHOTO: PhotoCropShape = { shape: 'square' };

const ICON_PENCIL: Html = html`<svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15" aria-hidden="true"><path d="M20.71,7.04C21.1,6.65 21.1,6 20.71,5.63L18.37,3.29C18,2.9 17.35,2.9 16.96,3.29L15.12,5.12L18.87,8.87M3,17.25V21H6.75L17.81,9.93L14.06,6.18L3,17.25Z"/></svg>`;

// state/index.ts's CoffeeLibrary types the puck-screen collection as
// PuckScreen[]; this section declares just the slice of S it reads (same
// pattern as views/shots/index.ts's _libCollection).
interface PuckScreenState {
  coffeeLibrary: { puckScreens?: PuckScreen[] };
}
function _state(): PuckScreenState {
  return S;
}

function _puckScreenThicknessLabel(thickness?: string | null): string {
  return thickness ? t(`puckscreen_thickness_${thickness.replace(/-/g, '_')}`) : '';
}

export function renderPuckScreenList(): void {
  const el = document.getElementById('puckScreenListUI');
  if (!el) return;
  const puckScreens = _state().coffeeLibrary.puckScreens || [];
  if (!puckScreens.length) { el.innerHTML = html`<div class="lib-empty">${tHtml('lib_empty_puckscreens')}</div>`; return; }
  // codeql[js/xss-through-dom] false positive: esc()/escapeHtml() already applied, see #760
  el.innerHTML = joinHtml(puckScreens.map(p => {
    const extra = [_puckScreenThicknessLabel(p.thickness), p.material].filter(Boolean).join(' · ');
    return html`
    <div class="lib-item">
      ${p.image ? html`<img class="lib-puckscreen-thumb" data-puckscreen-id="${esc(p.id)}" alt="">` : html``}
      <div class="lib-item-info">
        <div class="lib-item-name">${esc(p.name)}</div>
        ${extra ? html`<div class="lib-item-sub lib-item-extra">${esc(extra)}</div>` : html``}
        ${p.notes ? html`<div class="lib-item-sub">${esc(p.notes)}</div>` : html``}
      </div>
      <div class="lib-item-actions">
        <button class="lib-btn-sm lib-btn-icon" data-action="edit-puckscreen" data-id="${esc(p.id)}" title="${tHtml('lib_btn_edit')}">${ICON_PENCIL}</button>
        <button class="lib-btn-sm del lib-btn-icon" data-action="delete-puckscreen" data-id="${esc(p.id)}" title="${tHtml('lib_btn_delete')}">${ICON_TRASH}</button>
      </div>
    </div>`;
  }));
  loadPuckScreenThumbnails();
}

function loadPuckScreenThumbnails(): void {
  document.querySelectorAll<HTMLImageElement>('.lib-puckscreen-thumb[data-puckscreen-id]').forEach(img => {
    const id = Number(img.dataset.puckscreenId);
    void loadPuckScreenImageBlobUrl(id).then(url => {
      if (!url) return;
      img.src = url;
      img.onclick = e => { e.stopPropagation(); openLightbox(img.src); };
    });
  });
}

// The form saves itself while editing (#1962); the save button stays for
// creating. Bound once, on the first open: the form element is persistent.
let _autosaveBound = false;

export function openPuckScreenForm(puckScreen?: PuckScreen | null): void {
  S.puckScreenEditId = puckScreen ? puckScreen.id : null;
  (document.getElementById('puckScreenFormName') as HTMLInputElement).value      = puckScreen?.name      || '';
  (document.getElementById('puckScreenFormThickness') as HTMLInputElement).value = puckScreen?.thickness || '';
  (document.getElementById('puckScreenFormMaterial') as HTMLInputElement).value  = puckScreen?.material  || '';
  (document.getElementById('puckScreenFormNotes') as HTMLInputElement).value     = puckScreen?.notes     || '';
  (document.getElementById('puckScreenFormImageField') as HTMLElement).style.display = puckScreen ? '' : 'none';
  const adjustBtn = document.getElementById('puckScreenFormImageAdjustBtn') as HTMLElement;
  adjustBtn.style.display = puckScreen?.image ? '' : 'none';
  // onclick, not addEventListener: reopening the form must not stack handlers.
  adjustBtn.onclick = () => { if (S.puckScreenEditId) void _adjustPuckScreenImage(S.puckScreenEditId); };
  const form = document.getElementById('puckScreenAddForm') as HTMLElement;
  // Editing saves itself, so the button would only be a second way to save.
  const saveBtn = document.getElementById('savePuckScreenBtn');
  if (saveBtn) saveBtn.style.display = puckScreen ? 'none' : '';
  if (!_autosaveBound) {
    _autosaveBound = true;
    bindFormAutosave(form, {
      isEditing: () => !!S.puckScreenEditId,
      save: async () => { const ok = await _persistPuckScreen(); if (ok) renderPuckScreenList(); return ok; },
    });
  }
  form.classList.add('open');
  (document.getElementById('puckScreenAddTrigger') as HTMLElement).style.display = 'none';
  (document.getElementById('puckScreenFormName') as HTMLInputElement).focus();
}

export function closePuckScreenForm(): void {
  S.puckScreenEditId = null;
  (document.getElementById('puckScreenAddForm') as HTMLElement).classList.remove('open');
  (document.getElementById('puckScreenAddTrigger') as HTMLElement).style.display = '';
}

export function editPuckScreen(id: number): void {
  const p = (_state().coffeeLibrary.puckScreens || []).find(p => p.id === id);
  if (p) openPuckScreenForm(p);
}

// A second Save while the first request is pending must not create the entry
// twice (#2022); same guard as the bean form's _beanSaveInFlight.
let _puckScreenSaveInFlight = false;

// Reads, validates and persists the form; leaves the form open and does not
// clear the edit id, so autosave can keep saving the same entry (#1962).
async function _persistPuckScreen(): Promise<boolean> {
  if (_puckScreenSaveInFlight) return false;
  const name      = (document.getElementById('puckScreenFormName') as HTMLInputElement).value.trim();
  const thickness = (document.getElementById('puckScreenFormThickness') as HTMLInputElement).value;
  const material  = (document.getElementById('puckScreenFormMaterial') as HTMLInputElement).value.trim();
  const notes     = (document.getElementById('puckScreenFormNotes') as HTMLInputElement).value.trim();
  if (!name) { markFieldInvalid(document.getElementById('puckScreenFormName')); return false; }
  const editId = S.puckScreenEditId;
  _puckScreenSaveInFlight = true;
  const saveBtn = document.getElementById('savePuckScreenBtn') as HTMLButtonElement | null;
  if (saveBtn) saveBtn.disabled = true;
  try {
    const saved = await libraryApi.savePuckScreen(editId, { name, thickness, material, notes });
    if (!saved) { showToast(t('gm_toast_save_error')); return false; }
    const lib = _state().coffeeLibrary;
    const puckScreens = lib.puckScreens ?? [];
    lib.puckScreens = puckScreens;
    if (editId) {
      const idx = puckScreens.findIndex(p => p.id === editId);
      if (idx !== -1) puckScreens[idx] = saved;
    } else {
      puckScreens.push(saved);
    }
    return true;
  } catch {
    // A request that fails outright used to leave the user with no message.
    showToast(t('gm_toast_save_error'));
    return false;
  } finally {
    _puckScreenSaveInFlight = false;
    if (saveBtn) saveBtn.disabled = false;
  }
}

export async function savePuckScreen(): Promise<void> {
  const ok = await _persistPuckScreen();
  if (!ok) return;
  closePuckScreenForm();
  renderPuckScreenList();
}

export async function uploadPuckScreenImage(id: number, input: HTMLInputElement): Promise<void> {
  const file = input.files![0];
  if (!file) return;
  const r = await cropAndUploadPhoto(libraryApi.libraryImageUrl('puckscreen', id), file, PUCK_SCREEN_PHOTO);
  // eslint-disable-next-line require-atomic-updates -- `input` is a per-call function parameter (the DOM element passed in), not shared state
  input.value = '';
  if (!r) return;
  await _storePuckScreenPhoto(id, r);
}

async function _adjustPuckScreenImage(id: number): Promise<void> {
  const puckScreen = _state().coffeeLibrary.puckScreens?.find(p => p.id === id);
  if (!puckScreen?.image) return;
  const r = await adjustPhoto(libraryApi.libraryImageUrl('puckscreen', id), puckScreen.imageCrop, PUCK_SCREEN_PHOTO);
  if (!r) return;
  await _storePuckScreenPhoto(id, r);
}

async function _storePuckScreenPhoto(id: number, r: Response): Promise<void> {
  const saved = await savedPhotoRow<PuckScreen>(r);
  if (!saved) return;
  const puckScreens = _state().coffeeLibrary.puckScreens || [];
  const idx = puckScreens.findIndex(p => p.id === id);
  if (idx !== -1) puckScreens[idx] = saved;
  invalidatePuckScreenImage(id);
  renderPuckScreenList();
  if (S.puckScreenEditId === id) (document.getElementById('puckScreenFormImageAdjustBtn') as HTMLElement).style.display = '';
}

export async function deletePuckScreen(id: number): Promise<void> {
  if (!await confirmDialog(t('lib_confirm_delete_puckscreen'), { confirmLabel: t('lib_btn_delete') })) return;
  const r = await libraryApi.deletePuckScreenById(id);
  if (!r.ok) { showToast(t('error_generic', r.status)); return; }
  _state().coffeeLibrary.puckScreens = (_state().coffeeLibrary.puckScreens || []).filter(p => p.id !== id);
  renderPuckScreenList();
}
