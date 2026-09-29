// Baskets section (#635) of the Library view, split out of views/library.js.
// Pure move + type port (Part of #1115); no behavior change.
import { S } from '../../state/index.js';
import { t } from '../../i18n.js';
import * as libraryApi from '../../api/library.js';
import { esc } from '../../utils.js';
import { openImageCropEditor } from '../../components/image-crop.js';
import { openLightbox } from '../../components/lightbox.js';
import { loadBasketImageBlobUrl, invalidateBasketImage } from '../../bean-image.js';
import type { Basket } from '../../api/types.js';

const ICON_PENCIL = `<svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15" aria-hidden="true"><path d="M20.71,7.04C21.1,6.65 21.1,6 20.71,5.63L18.37,3.29C18,2.9 17.35,2.9 16.96,3.29L15.12,5.12L18.87,8.87M3,17.25V21H6.75L17.81,9.93L14.06,6.18L3,17.25Z"/></svg>`;
const ICON_TRASH  = `<svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15" aria-hidden="true"><path d="M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19M8,9H10V19H8V9M14,9H16V19H14V9M15.5,4L14.5,3H9.5L8.5,4H5V6H19V4H15.5Z"/></svg>`;

// state/index.ts's CoffeeLibrary only declares beans/grinders; this section
// owns the basket collection, reached through this typed view of S (same
// pattern as views/shots/index.ts's _libCollection).
interface BasketState {
  coffeeLibrary: { baskets?: Basket[] };
}
function _state(): BasketState {
  return S as unknown as BasketState;
}

function _basketWallTypeLabel(wallType?: string | null): string {
  return wallType ? t(`basket_wall_type_${wallType.replace(/-/g, '_')}`) : '';
}

function _basketShapeLabel(shape?: string | null): string {
  return shape ? t(`basket_shape_${shape}`) : '';
}

export function renderBasketList(): void {
  const el = document.getElementById('basketListUI');
  if (!el) return;
  const baskets = _state().coffeeLibrary.baskets || [];
  if (!baskets.length) { el.innerHTML = `<div class="lib-empty">${t('lib_empty_baskets')}</div>`; return; }
  // codeql[js/xss-through-dom] false positive: esc()/escapeHtml() already applied, see #760
  el.innerHTML = baskets.map(b => {
    const extra = [b.doseCapacity, _basketWallTypeLabel(b.wallType), _basketShapeLabel(b.shape), b.holeCount].filter(Boolean).join(' · ');
    return `
    <div class="lib-item">
      ${b.image ? `<img class="lib-basket-thumb" data-basket-id="${b.id}" alt="">` : ''}
      <div class="lib-item-info">
        <div class="lib-item-name">${esc(b.name)}</div>
        ${extra ? `<div class="lib-item-sub lib-item-extra">${esc(extra)}</div>` : ''}
        ${b.notes ? `<div class="lib-item-sub">${esc(b.notes)}</div>` : ''}
      </div>
      <div class="lib-item-actions">
        <button class="lib-btn-sm lib-btn-icon" data-action="edit-basket" data-id="${b.id}" title="${t('lib_btn_edit')}">${ICON_PENCIL}</button>
        <button class="lib-btn-sm del lib-btn-icon" data-action="delete-basket" data-id="${b.id}" title="${t('lib_btn_delete')}">${ICON_TRASH}</button>
      </div>
    </div>`;
  }).join('');
  loadBasketThumbnails();
}

// Basket images need the auth token, so <img src> can't point at the API
// directly (see bean-image.js) — set the blob-url src async after render,
// same pattern as loadGrinderThumbnails.
function loadBasketThumbnails(): void {
  document.querySelectorAll<HTMLImageElement>('.lib-basket-thumb[data-basket-id]').forEach(img => {
    const id = Number(img.dataset.basketId);
    void loadBasketImageBlobUrl(id).then(url => {
      if (!url) return;
      img.src = url;
      img.onclick = e => { e.stopPropagation(); openLightbox(img.src); };
    });
  });
}

export function openBasketForm(basket?: Basket | null): void {
  S.basketEditId = basket ? basket.id : null;
  (document.getElementById('basketFormName') as HTMLInputElement).value         = basket?.name         || '';
  (document.getElementById('basketFormDoseCapacity') as HTMLInputElement).value = basket?.doseCapacity || '';
  (document.getElementById('basketFormWallType') as HTMLInputElement).value     = basket?.wallType     || '';
  (document.getElementById('basketFormShape') as HTMLInputElement).value        = basket?.shape        || '';
  (document.getElementById('basketFormHoleCount') as HTMLInputElement).value    = basket?.holeCount    || '';
  (document.getElementById('basketFormNotes') as HTMLInputElement).value        = basket?.notes        || '';
  (document.getElementById('basketFormImageField') as HTMLElement).style.display = basket ? '' : 'none';
  (document.getElementById('basketAddForm') as HTMLElement).classList.add('open');
  (document.getElementById('basketAddTrigger') as HTMLElement).style.display = 'none';
  (document.getElementById('basketFormName') as HTMLInputElement).focus();
}

export function closeBasketForm(): void {
  S.basketEditId = null;
  (document.getElementById('basketAddForm') as HTMLElement).classList.remove('open');
  (document.getElementById('basketAddTrigger') as HTMLElement).style.display = '';
}

export function editBasket(id: number): void {
  const b = (_state().coffeeLibrary.baskets || []).find(b => b.id === id);
  if (b) openBasketForm(b);
}

export async function saveBasket(): Promise<void> {
  const name         = (document.getElementById('basketFormName') as HTMLInputElement).value.trim();
  const doseCapacity = (document.getElementById('basketFormDoseCapacity') as HTMLInputElement).value.trim();
  const wallType     = (document.getElementById('basketFormWallType') as HTMLInputElement).value;
  const shape        = (document.getElementById('basketFormShape') as HTMLInputElement).value;
  const holeCount    = (document.getElementById('basketFormHoleCount') as HTMLInputElement).value.trim();
  const notes        = (document.getElementById('basketFormNotes') as HTMLInputElement).value.trim();
  if (!name) { (document.getElementById('basketFormName') as HTMLInputElement).focus(); return; }
  const saved = await libraryApi.saveBasket(S.basketEditId, { name, doseCapacity, wallType, shape, holeCount, notes });
  if (!saved) return;
  const lib = _state().coffeeLibrary;
  const baskets = lib.baskets ?? [];
  lib.baskets = baskets;
  if (S.basketEditId) {
    const idx = baskets.findIndex(b => b.id === S.basketEditId);
    if (idx !== -1) baskets[idx] = saved;
  } else {
    baskets.push(saved);
  }
  closeBasketForm();
  renderBasketList();
}

export async function uploadBasketImage(id: number, input: HTMLInputElement): Promise<void> {
  const file = input.files![0];
  if (!file) return;
  const blob = await openImageCropEditor(file, { shape: 'square' });
  // eslint-disable-next-line require-atomic-updates -- `input` is a per-call function parameter (the DOM element passed in), not shared state
  input.value = '';
  if (!blob) return;
  const r = await libraryApi.uploadBasketImage(id, blob);
  if (!r.ok) { alert(t('error_generic', ((await r.json().catch(() => ({}))) as { error?: string }).error || r.statusText)); return; }
  const saved = await r.json() as Basket;
  const baskets = _state().coffeeLibrary.baskets || [];
  const idx = baskets.findIndex(b => b.id === id);
  if (idx !== -1) baskets[idx] = saved;
  invalidateBasketImage(id);
  renderBasketList();
}

export async function deleteBasket(id: number): Promise<void> {
  if (!confirm(t('lib_confirm_delete_basket'))) return;
  const r = await libraryApi.deleteBasketById(id);
  if (!r.ok) return;
  _state().coffeeLibrary.baskets = (_state().coffeeLibrary.baskets || []).filter(b => b.id !== id);
  renderBasketList();
}
