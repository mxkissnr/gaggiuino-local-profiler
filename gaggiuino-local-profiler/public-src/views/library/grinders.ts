// Grinder list + grinder form sections of the Library view, split out of
// views/library.js. Pure move + type port (Part of #1115); no behavior change.
import { S } from '../../state/index.js';
import { t, tHtml } from '../../i18n.js';
import * as libraryApi from '../../api/library.js';
import { esc, html, joinHtml, toIsoDateInput } from '../../utils.js';
import type { Html } from '../../utils.js';
import { WRENCH_ICON_SVG } from '../../icons.js';
import { attachAutocomplete } from '../../components/autocomplete.js';
import { openImageCropEditor } from '../../components/image-crop.js';
import { openLightbox } from '../../components/lightbox.js';
import { loadGrinderImageBlobUrl, invalidateGrinderImage } from '../../bean-image.js';
import { currentGrinderZeroPoint } from '../../grind-zero.js';
import type { Grinder } from '../../api/types.js';
import * as libraryView from '../library.js';

// Circular with library.js (it re-exports this module): only ever touched at
// call time, never read at module load.
const library = libraryView;

const ICON_PENCIL: Html = html`<svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15" aria-hidden="true"><path d="M20.71,7.04C21.1,6.65 21.1,6 20.71,5.63L18.37,3.29C18,2.9 17.35,2.9 16.96,3.29L15.12,5.12L18.87,8.87M3,17.25V21H6.75L17.81,9.93L14.06,6.18L3,17.25Z"/></svg>`;
const ICON_TRASH: Html  = html`<svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15" aria-hidden="true"><path d="M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19M8,9H10V19H8V9M14,9H16V19H14V9M15.5,4L14.5,3H9.5L8.5,4H5V6H19V4H15.5Z"/></svg>`;

// Static burr-type suggestions for the grinder form (moved out of the old
// <datalist> markup in index.html).
const BURR_TYPE_SUGGESTIONS = ['Konisch Stahl', 'Konisch Keramik', 'Flach Stahl', 'Flach Keramik'];

// The generated Grinder schema lags the backend: wear is really
// { shotsSinceBurrs, gramsSinceBurrs } (go/internal/library/handlers.go) and
// zeroPointHistory entries always carry both fields. This names what the
// runtime actually sends.
export type GrinderRow = Omit<Grinder, 'wear' | 'zeroPointHistory'> & {
  zeroPointHistory?: { zeroPoint: number; since: number }[];
  wear?: { shotsSinceBurrs: number; gramsSinceBurrs: number } | undefined;
};

// state/index.ts types library rows as opaque LibraryRow records; this section
// owns the grinder shape, reached through one typed view of the same array.
function _grinders(): GrinderRow[] {
  return S.coffeeLibrary.grinders as GrinderRow[];
}

// Same reason as GrinderRow: the API client returns the lagging generated type.
function _asRow(grinder: Grinder): GrinderRow {
  return grinder as GrinderRow;
}

// Every form field read/written here is an <input>; the shared .value API is
// all that is used.
function _input(id: string): HTMLInputElement {
  return document.getElementById(id) as HTMLInputElement;
}

function _el(id: string): HTMLElement {
  return document.getElementById(id) as HTMLElement;
}

function _zeroPointValue(grinder: GrinderRow | null | undefined): string {
  const zeroPoint = currentGrinderZeroPoint(grinder);
  return zeroPoint != null ? String(zeroPoint) : '';
}

// ── Grinder list ──────────────────────────────────────────────────────────
export function renderGrinderList(): void {
  const el = document.getElementById('grinderListUI');
  if (!el) return;
  // Grinders are shared equipment, not scoped to the active machine — always
  // render the full library regardless of S.activeMachineId. This reverts
  // the display-filtering part of #334; see #339 for why that filter was
  // wrong (it hid nearly the whole library once a second machine existed).
  const grinders = _grinders();
  if (!grinders.length) {
    el.innerHTML = html`<div class="lib-empty">${tHtml('lib_empty_grinders')}</div>`;
    return;
  }
  // codeql[js/xss-through-dom] false positive: esc()/escapeHtml() already applied, see #760
  el.innerHTML = joinHtml(grinders.map(g => {
    const extra = [g.burrType, g.purchaseDate].filter(Boolean).join(' · ');
    const zeroPoint = currentGrinderZeroPoint(g);
    return html`
    <div class="lib-item">
      ${g.image ? html`<img class="lib-grinder-thumb" data-grinder-id="${esc(g.id)}" alt="">` : html``}
      <div class="lib-item-info">
        <div class="lib-item-name">${esc(g.name)}</div>
        ${extra ? html`<div class="lib-item-sub lib-item-extra">${esc(extra)}</div>` : html``}
        ${g.notes ? html`<div class="lib-item-sub">${esc(g.notes)}</div>` : html``}
        ${zeroPoint != null ? html`<div class="lib-item-sub">${tHtml('lib_grinder_zero_point')}: ${esc(String(zeroPoint))}</div>` : html``}
        ${g.wear ? html`<div class="lib-item-sub lib-grinder-wear">
          <span>${WRENCH_ICON_SVG} ${tHtml('lib_grinder_wear', g.wear.shotsSinceBurrs, formatWearGrams(g.wear.gramsSinceBurrs))}</span>
          <button class="lib-btn-sm lib-grinder-reset-burrs" data-action="reset-grinder-burrs" data-id="${esc(g.id)}">${tHtml('lib_grinder_reset_burrs')}</button>
        </div>` : html``}
      </div>
      <div class="lib-item-actions">
        <button class="lib-btn-sm lib-btn-icon" data-action="edit-grinder" data-id="${esc(g.id)}" title="${tHtml('lib_btn_edit')}">${ICON_PENCIL}</button>
        <button class="lib-btn-sm del lib-btn-icon" data-action="delete-grinder" data-id="${esc(g.id)}" title="${tHtml('lib_btn_delete')}">${ICON_TRASH}</button>
      </div>
    </div>`;
  }));
  loadGrinderThumbnails();
}

// Mirrors the g/kg formatting used by the analytics "Total Coffee" tile.
function formatWearGrams(g: number): string {
  return g >= 1000 ? (g / 1000).toFixed(1) + ' kg' : Math.round(g) + ' g';
}

// Grinder images need the auth token, so <img src> can't point at the API
// directly (see bean-image.js) — set the blob-url src async after render.
// #441: click opens the fullscreen lightbox, same as bean photos (#440).
function loadGrinderThumbnails(): void {
  document.querySelectorAll<HTMLImageElement>('.lib-grinder-thumb[data-grinder-id]').forEach(img => {
    const id = Number(img.dataset.grinderId);
    void loadGrinderImageBlobUrl(id).then(url => {
      if (!url) return;
      img.src = url;
      img.onclick = e => { e.stopPropagation(); openLightbox(img.src); };
    });
  });
}

// ── Grinder form ──────────────────────────────────────────────────────────
export function openGrinderForm(grinder?: GrinderRow | null): void {
  S.grinderEditId = grinder ? grinder.id : null;
  _input('grinderFormName').value  = grinder?.name  || '';
  _input('grinderFormNotes').value = grinder?.notes || '';
  _input('grinderFormBurrType').value     = grinder?.burrType || '';
  attachAutocomplete(_input('grinderFormBurrType'), () => BURR_TYPE_SUGGESTIONS);
  _input('grinderFormPurchaseDate').value = toIsoDateInput(grinder?.purchaseDate);
  _el('grinderFormImageField').style.display = grinder ? '' : 'none';
  // Zero-point tracking only makes sense once a grinder already has shot
  // history to correct — hidden for a brand-new grinder, same as the photo
  // field above.
  _el('grinderFormZeroPointField').style.display = grinder ? '' : 'none';
  _input('grinderFormZeroPoint').value = _zeroPointValue(grinder);
  _input('grinderFormZeroPointSince').value = '';
  renderGrinderZeroPointHistory(grinder);
  _el('grinderAddForm').classList.add('open');
  _el('grinderAddTrigger').style.display = 'none';
  _input('grinderFormName').focus();
}

export function closeGrinderForm(): void {
  S.grinderEditId = null;
  _el('grinderAddForm').classList.remove('open');
  _el('grinderAddTrigger').style.display = '';
}

export function editGrinder(id: number): void {
  const g = _grinders().find(g => g.id === id);
  if (g) openGrinderForm(g);
}

function renderGrinderZeroPointHistory(grinder: GrinderRow | null | undefined): void {
  const el = document.getElementById('grinderFormZeroPointHistory');
  if (!el) return;
  const history = grinder?.zeroPointHistory;
  if (!Array.isArray(history) || !history.length) { el.innerHTML = html``; return; }
  const sorted = [...history].sort((a, b) => a.since - b.since);
  el.innerHTML = html`<div class="zp-history">${joinHtml(sorted.map(e => {
    const date = new Date(e.since).toLocaleDateString();
    return html`<div class="zp-history-entry">
      <span>${esc(String(e.zeroPoint))} &mdash; ${esc(date)}</span>
      <button type="button" class="lib-btn-sm del lib-btn-icon" data-action="delete-grinder-zero-point" data-id="${esc(grinder?.id)}" data-since="${esc(e.since)}" title="${tHtml('lib_grinder_zero_point_delete')}">&#x2715;</button>
    </div>`;
  }))}</div>`;
}

export async function deleteGrinderZeroPointEntry(grinderId: number, since: number): Promise<void> {
  const result = await libraryApi.deleteGrinderZeroPoint(grinderId, since);
  if (!result) return;
  const updated = _asRow(result);
  const grinders = _grinders();
  const idx = grinders.findIndex(g => g.id === grinderId);
  if (idx !== -1) grinders[idx] = { ...updated, wear: grinders[idx].wear };
  renderGrinderList();
  // Refresh history in open form if editing the same grinder.
  if (S.grinderEditId === grinderId) {
    _input('grinderFormZeroPoint').value = _zeroPointValue(updated);
    renderGrinderZeroPointHistory(updated);
  }
}

export async function saveGrinder(): Promise<void> {
  const name         = _input('grinderFormName').value.trim();
  const notes        = _input('grinderFormNotes').value.trim();
  const burrType     = _input('grinderFormBurrType').value.trim();
  const purchaseDate = _input('grinderFormPurchaseDate').value.trim();
  if (!name) { _input('grinderFormName').focus(); return; }
  const first = await libraryApi.saveGrinder(S.grinderEditId, { name, notes, burrType, purchaseDate });
  if (!first) return;
  let saved = _asRow(first);

  if (S.grinderEditId) {
    const zpRaw    = _input('grinderFormZeroPoint').value.trim();
    const sinceRaw = _input('grinderFormZeroPointSince').value.trim();
    if (zpRaw !== '') {
      const zeroPoint = parseFloat(zpRaw);
      const sinceMs   = sinceRaw ? new Date(sinceRaw).getTime() : 0;
      // For "now" inserts (sinceMs=0) the backend deduplicates on value;
      // for retroactive inserts we always send (dedup is on exact since+value pair).
      const isRetroactive = sinceMs > 0;
      if (!Number.isNaN(zeroPoint) && (isRetroactive || zeroPoint !== currentGrinderZeroPoint(saved))) {
        const updated = await libraryApi.setGrinderZeroPoint(S.grinderEditId, zeroPoint, isRetroactive ? sinceMs : undefined);
        if (updated) saved = _asRow(updated);
      }
    }
  }


  const grinders = _grinders();
  if (S.grinderEditId) {
    const idx = grinders.findIndex(g => g.id === S.grinderEditId);
    // The PUT response doesn't recompute wear stats — keep the existing ones
    // until the next full library load rather than dropping the card.
    if (idx !== -1) grinders[idx] = { ...saved, wear: grinders[idx].wear };
  } else {
    grinders.push(saved);
  }
  library.updateLibraryDatalist();
  closeGrinderForm();
  renderGrinderList();
}

export async function resetGrinderBurrs(id: number): Promise<void> {
  if (!confirm(t('lib_grinder_confirm_reset_burrs'))) return;
  const saved = await libraryApi.resetGrinderBurrs(id);
  if (!saved) return;
  const grinders = _grinders();
  const idx = grinders.findIndex(g => g.id === id);
  if (idx !== -1) grinders[idx] = _asRow(saved);
  renderGrinderList();
}

export async function uploadGrinderImage(id: number, input: HTMLInputElement): Promise<void> {
  const file = input.files![0];
  if (!file) return;
  const blob = await openImageCropEditor(file, { shape: 'square' });
  // eslint-disable-next-line require-atomic-updates -- `input` is a per-call function parameter (the DOM element passed in), not shared state
  input.value = '';
  if (!blob) return;
  const r = await libraryApi.uploadGrinderImage(id, blob);
  if (!r.ok) { alert(t('error_generic', ((await r.json().catch(() => ({}))) as { error?: string }).error || r.statusText)); return; }
  const saved = await r.json() as GrinderRow;
  const grinders = _grinders();
  const idx = grinders.findIndex(g => g.id === id);
  if (idx !== -1) grinders[idx] = saved;
  invalidateGrinderImage(id);
  renderGrinderList();
}

export async function deleteGrinder(id: number): Promise<void> {
  if (!confirm(t('lib_confirm_delete_grinder'))) return;
  const r = await libraryApi.deleteGrinderPermanently(id);
  if (!r.ok) return;
  S.coffeeLibrary.grinders = S.coffeeLibrary.grinders.filter(g => g.id !== id);
  library.updateLibraryDatalist();
  renderGrinderList();
}
