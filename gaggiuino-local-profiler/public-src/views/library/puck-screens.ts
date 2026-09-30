// Puck Screens section (#635) of the Library view, split out of
// views/library.js. Pure move + type port (Part of #1115); no behavior change.
import { S } from '../../state/index.js';
import { t, tHtml } from '../../i18n.js';
import * as libraryApi from '../../api/library.js';
import { esc, html, joinHtml } from '../../utils.js';
import type { Html } from '../../utils.js';
import { openImageCropEditor } from '../../components/image-crop.js';
import { openLightbox } from '../../components/lightbox.js';
import { loadPuckScreenImageBlobUrl, invalidatePuckScreenImage } from '../../bean-image.js';
import type { PuckScreen } from '../../api/types.js';

const ICON_PENCIL: Html = html`<svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15" aria-hidden="true"><path d="M20.71,7.04C21.1,6.65 21.1,6 20.71,5.63L18.37,3.29C18,2.9 17.35,2.9 16.96,3.29L15.12,5.12L18.87,8.87M3,17.25V21H6.75L17.81,9.93L14.06,6.18L3,17.25Z"/></svg>`;
const ICON_TRASH: Html  = html`<svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15" aria-hidden="true"><path d="M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19M8,9H10V19H8V9M14,9H16V19H14V9M15.5,4L14.5,3H9.5L8.5,4H5V6H19V4H15.5Z"/></svg>`;

// state/index.ts's CoffeeLibrary only declares beans/grinders; this section
// owns the puck-screen collection, reached through this typed view of S (same
// pattern as views/shots/index.ts's _libCollection).
interface PuckScreenState {
  coffeeLibrary: { puckScreens?: PuckScreen[] };
}
function _state(): PuckScreenState {
  return S as unknown as PuckScreenState;
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
  const blob = await openImageCropEditor(file, { shape: 'square' });
  // eslint-disable-next-line require-atomic-updates -- `input` is a per-call function parameter (the DOM element passed in), not shared state
  input.value = '';
  if (!blob) return;
  const r = await libraryApi.uploadPuckScreenImage(id, blob);
  if (!r.ok) { alert(t('error_generic', ((await r.json().catch(() => ({}))) as { error?: string }).error || r.statusText)); return; }
  const saved = await r.json() as PuckScreen;
  const puckScreens = _state().coffeeLibrary.puckScreens || [];
  const idx = puckScreens.findIndex(p => p.id === id);
  if (idx !== -1) puckScreens[idx] = saved;
  invalidatePuckScreenImage(id);
  renderPuckScreenList();
}

export async function deletePuckScreen(id: number): Promise<void> {
  if (!confirm(t('lib_confirm_delete_puckscreen'))) return;
  const r = await libraryApi.deletePuckScreenById(id);
  if (!r.ok) return;
  _state().coffeeLibrary.puckScreens = (_state().coffeeLibrary.puckScreens || []).filter(p => p.id !== id);
  renderPuckScreenList();
}
