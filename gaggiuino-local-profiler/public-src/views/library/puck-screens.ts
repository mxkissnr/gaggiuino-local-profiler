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
  (document.getElementById('puckScreenAddForm') as HTMLElement).classList.add('open');
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

export async function savePuckScreen(): Promise<void> {
  const name      = (document.getElementById('puckScreenFormName') as HTMLInputElement).value.trim();
  const thickness = (document.getElementById('puckScreenFormThickness') as HTMLInputElement).value;
  const material  = (document.getElementById('puckScreenFormMaterial') as HTMLInputElement).value.trim();
  const notes     = (document.getElementById('puckScreenFormNotes') as HTMLInputElement).value.trim();
  if (!name) { (document.getElementById('puckScreenFormName') as HTMLInputElement).focus(); return; }
  const saved = await libraryApi.savePuckScreen(S.puckScreenEditId, { name, thickness, material, notes });
  if (!saved) return;
  const lib = _state().coffeeLibrary;
  const puckScreens = lib.puckScreens ?? [];
  lib.puckScreens = puckScreens;
  if (S.puckScreenEditId) {
    const idx = puckScreens.findIndex(p => p.id === S.puckScreenEditId);
    if (idx !== -1) puckScreens[idx] = saved;
  } else {
    puckScreens.push(saved);
  }
  closePuckScreenForm();
  renderPuckScreenList();
}

export async function uploadPuckScreenImage(id: number, input: HTMLInputElement): Promise<void> {
  const file = input.files![0];
  if (!file) return;
  const pending = cropAndUploadPhoto(libraryApi.libraryImageUrl('puckscreen', id), file, PUCK_SCREEN_PHOTO);
  // eslint-disable-next-line require-atomic-updates -- `input` is a per-call function parameter (the DOM element passed in), not shared state
  input.value = '';
  const r = await pending;
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
  if (!confirm(t('lib_confirm_delete_puckscreen'))) return;
  const r = await libraryApi.deletePuckScreenById(id);
  if (!r.ok) return;
  _state().coffeeLibrary.puckScreens = (_state().coffeeLibrary.puckScreens || []).filter(p => p.id !== id);
  renderPuckScreenList();
}
