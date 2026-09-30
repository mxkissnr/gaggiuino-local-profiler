// Bag lifecycle, stock quick-adjust, full bag edit and drag-reorder sections of
// the Library view, split out of views/library.js. Pure move + type port
// (Part of #1115); no behavior change.
import { S } from '../../state/index.js';
import { t, tHtml } from '../../i18n.js';
import * as libraryApi from '../../api/library.js';
import { esc, todayIsoDate, html, joinHtml } from '../../utils.js';
import type { Html } from '../../utils.js';
import type { Bean } from '../../api/types.js';
import * as libraryView from '../library.js';

// Circular with library.js (it re-exports this module): only ever touched at
// call time, never read at module load.
const library = libraryView as unknown as { renderBeanList: () => void };

const ICON_PENCIL = `<svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15" aria-hidden="true"><path d="M20.71,7.04C21.1,6.65 21.1,6 20.71,5.63L18.37,3.29C18,2.9 17.35,2.9 16.96,3.29L15.12,5.12L18.87,8.87M3,17.25V21H6.75L17.81,9.93L14.06,6.18L3,17.25Z"/></svg>` as Html;
const ICON_TRASH = `<svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15" aria-hidden="true"><path d="M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19M8,9H10V19H8V9M14,9H16V19H14V9M15.5,4L14.5,3H9.5L8.5,4H5V6H19V4H15.5Z"/></svg>` as Html;

// The generated Bean.bags item lags the backend: every bean-returning
// response also carries price_eur/sortOrder (stored) and the server-computed
// consumedG/remainingG/current (SimulateBagQueue). This names what the
// runtime actually sends.
export type BagRow = NonNullable<Bean['bags']>[number] & {
  price_eur?: number | null | undefined;
  sortOrder?: number | undefined;
  consumedG?: number | undefined;
  remainingG?: number | undefined;
  current?: boolean | undefined;
};

export type BeanRow = Omit<Bean, 'bags'> & { bags?: BagRow[] | undefined };

export type BagState = 'current' | 'upcoming' | 'past';

export interface BagEntry {
  bg: BagRow;
  consumed: number;
  stockG: number | null;
  remaining: number | null;
  isLastEmpty?: boolean | undefined;
}

export interface ClassifiedBags {
  current: BagEntry | null;
  upcoming: BagEntry[];
  past: BagEntry[];
}

// state/index.ts types library rows as opaque LibraryRow records; this section
// owns the bean/bag shape, reached through one typed view of the same array.
function _beans(): BeanRow[] {
  return S.coffeeLibrary.beans as unknown as BeanRow[];
}

function _field(id: string): HTMLInputElement | null {
  return document.getElementById(id) as HTMLInputElement | null;
}

// ── Bag lifecycle: Volle / Aktuelle / Vergangene ───────────────────────────
// Three states a bag moves through — consumedG/remainingG/current are now
// computed server-side (SimulateBagQueue, go/internal/library/
// orders_support.go) and attached to every bag by the backend on every
// bean-returning response, so this is a pure lookup, not a replay of
// doseRows: no simulation logic lives on the frontend anymore.
//   - "current": the one bag actually being drawn from right now — lowest
//     sortOrder among tracked bags with remaining > 0 (queue order, not
//     "most recently added").
//   - "upcoming" ("Volle"): tracked, remaining > 0, queued behind current.
//   - "past" ("Vergangene"): remaining <= 0, or never tracked at all.
//     Hidden by default in the UI.
export function classifyBeanBags(b: BeanRow): ClassifiedBags {
  const bags = Array.isArray(b.bags) ? b.bags : [];
  const upcoming: BagEntry[] = [];
  const past: BagEntry[] = [];
  let current: BagEntry | null = null;
  for (const bg of bags) {
    // consumedG/remainingG are only attached to bags SimulateBagQueue could
    // resolve (i.e. tracked ones) — their absence IS the untracked signal.
    const tracked = bg.remainingG != null;
    const entry: BagEntry = { bg, consumed: bg.consumedG ?? 0, stockG: tracked ? parseFloat(String(bg.stock_g)) : null, remaining: tracked ? (bg.remainingG ?? null) : null };
    if (bg.current) current = entry;
    else if (entry.remaining != null && entry.remaining > 0) upcoming.push(entry);
    else past.push(entry);
  }
  // Queue order must stay visible/editable in "Volle" — the drag-reorder
  // UI (renderBagCard) depends on this being sorted.
  upcoming.sort((a, b2) => (a.bg.sortOrder ?? a.bg.openedAt ?? 0) - (b2.bg.sortOrder ?? b2.bg.openedAt ?? 0));
  // Most recently emptied first — both for display order and so the one
  // fat-finger-correction exception below always lands on the bag that was
  // actually just marked empty, not an arbitrarily older one.
  past.sort((a, b2) => (b2.bg.sortOrder ?? b2.bg.openedAt ?? 0) - (a.bg.sortOrder ?? a.bg.openedAt ?? 0));
  // The single most recently emptied (tracked) bag stays editable — "ich
  // habe mich im Bestand verklickt" needs a way back without resurrecting
  // arbitrary old history. Untracked entries have nothing to correct.
  const lastEmpty = past.find(e => e.stockG != null);
  if (lastEmpty) lastEmpty.isLastEmpty = true;
  return { current, upcoming, past };
}

// Bag cards are collapsed by default (space-saving on mobile) — this Set
// tracks which bag ids are expanded, mirroring the _pendingBeanActiveToggles
// module-state pattern already used in views/library.js.
const _expandedBagCards = new Set<number | undefined>();
// Same pattern for the "Vergangene" (past bags) section per bean id — see
// renderBeanList's pastSection comment for why this can't live as
// DOM-only classList/dataset state anymore.
export const _expandedPastSections = new Set<number>();

// Renders one bag card. `state` is 'current' | 'upcoming' | 'past' — only
// current/upcoming get the stock-adjust controls (past is already empty by
// definition); delete is only offered on upcoming/past (never current —
// see classifyBeanBags, and never the last remaining bag, enforced
// server-side too). The full edit dialog is only offered while the bag is
// still unconsumed (consumed === 0) — upcoming bags always qualify by
// construction (SimulateBagQueue never touches a bag before its turn),
// current loses it as soon as any dose lands on it, past bags never had it.
// Only 'upcoming' bags are drag-reorderable (see main.js's pointer-events
// drag handler) — current is queue-position-fixed, past is inert.
export function renderBagCard(b: BeanRow, entry: BagEntry, state: BagState, beans: BeanRow[], canDelete: boolean): Html {
  const { bg, consumed, stockG, remaining } = entry;
  const pct = remaining != null && stockG != null && stockG > 0 ? Math.round((remaining / stockG) * 100) : null;
  const editingStock = S._bagStockEditId === bg.id;
  const editingFull  = S._bagFullEditId === bg.id;
  const expanded = _expandedBagCards.has(bg.id);
  // Past bags are locked out of editing except the single most recently
  // emptied one (classifyBeanBags' isLastEmpty) — lets a "verklickt"
  // (fat-fingered) mark-empty/stock-adjust get corrected without reopening
  // arbitrary older history.
  const canEdit = state === 'past' ? !!entry.isLastEmpty : consumed === 0;
  const details: Html[] = [
    stockG != null && stockG > 0 ? html`<span class="lib-bag-detail"><span class="lib-bag-detail-label">${tHtml('lib_bag_weight')}</span><span class="lib-bag-detail-val">${esc(stockG)} g</span></span>` : esc(''),
    consumed > 0 ? html`<span class="lib-bag-detail"><span class="lib-bag-detail-label">${tHtml('lib_bag_consumed')}</span><span class="lib-bag-detail-val">${esc(consumed)} g</span></span>` : esc(''),
    remaining != null ? html`<span class="lib-bag-detail"><span class="lib-bag-detail-label">${tHtml('lib_bag_remaining')}</span><span class="lib-bag-detail-val">${esc(remaining)} g${pct != null ? html` (${esc(pct)}%)` : esc('')}</span></span>` : esc(''),
    bg.price_eur ? html`<span class="lib-bag-detail"><span class="lib-bag-detail-label">${tHtml('lib_bag_price')}</span><span class="lib-bag-detail-val">${esc(parseFloat(String(bg.price_eur)).toFixed(2))} €</span></span>` : esc(''),
    bg.batchNumber ? html`<span class="lib-bag-detail"><span class="lib-bag-detail-label">${tHtml('lib_bag_batch_number')}</span><span class="lib-bag-detail-val">${esc(bg.batchNumber)}</span></span>` : esc(''),
  ].filter(Boolean);
  const stateBadge: Html = state === 'current'
    ? html`<span class="lib-bag-active-badge">${tHtml('lib_bag_state_current')}</span>`
    : state === 'upcoming'
    ? html`<span class="lib-bag-upcoming-badge">${tHtml('lib_bag_state_upcoming')}</span>`
    : html`<span class="lib-bag-past-badge">${tHtml('lib_bag_state_past')}</span>`;
  // stockG != null (tracked), not stockG > 0 — the last-emptied exception
  // is specifically for a bag sitting at 0, so requiring a positive stock
  // here would hide the fix for the exact case it exists for.
  const canAdjust = (state === 'current' || state === 'upcoming' || (state === 'past' && entry.isLastEmpty)) && stockG != null;
  // "Als leer markieren" lives inside the stock-adjust row now, not as its
  // own always-visible button — both are "change this bag's stock" actions.
  const stockRow: Html = editingStock
    ? html`<div class="lib-stock-edit-row">
         <input type="number" class="lib-new-bag-input" id="bagStockEditInput${esc(bg.id)}" value="${esc(remaining ?? 0)}" min="0" step="1" placeholder="${tHtml('lib_stock_adjust_ph')}">
         <button class="lib-save-btn" data-action="save-bag-stock-edit" data-bean-id="${esc(b.id)}" data-bag-id="${esc(bg.id)}">${tHtml('lib_save')}</button>
         <button class="lib-btn-sm" data-action="mark-bag-empty" data-bean-id="${esc(b.id)}" data-bag-id="${esc(bg.id)}">${tHtml('lib_bag_mark_empty')}</button>
         <button class="lib-btn-sm" data-action="close-bag-stock-edit" data-bean-id="${esc(b.id)}">${tHtml('lib_cancel')}</button>
       </div>`
    : esc('');
  // Full-detail edit (roastDate/original weight/price/batch number) — the
  // pencil icon's target. Distinct from stockRow above: that one only ever
  // adjusts remaining stock (via consumedG math), this one PUTs every
  // field updateBag accepts at once, same contract putBagStock already
  // relies on for its own partial (stock-only) writes.
  const editRow: Html = editingFull
    ? html`<div class="lib-new-bag-form" style="display:flex">
         <div class="lib-new-bag-fields">
           <input type="date" class="lib-new-bag-input" id="editBagRoastDate${esc(bg.id)}" title="${tHtml('lib_bag_roast_date')}" value="${esc(bg.roastDate || '')}" max="${esc(todayIsoDate())}">
           <input type="number" class="lib-new-bag-input" id="editBagStock${esc(bg.id)}" placeholder="${tHtml('lib_bag_stock')}" min="0" step="1" value="${esc(stockG ?? '')}">
           <input type="number" class="lib-new-bag-input" id="editBagPrice${esc(bg.id)}" placeholder="${tHtml('lib_bag_price')}" min="0" step="0.01" value="${esc(bg.price_eur ?? '')}">
           <input type="text" class="lib-new-bag-input" id="editBagBatchNumber${esc(bg.id)}" placeholder="${tHtml('lib_bag_batch_number')}" maxlength="50" value="${esc(bg.batchNumber || '')}">
         </div>
         <div class="lib-form-actions">
           <button class="lib-btn-sm" data-action="close-edit-bag" data-bean-id="${esc(b.id)}">${tHtml('lib_cancel')}</button>
           <button class="lib-save-btn" data-action="save-edit-bag" data-bean-id="${esc(b.id)}" data-bag-id="${esc(bg.id)}">${tHtml('lib_bag_save')}</button>
         </div>
       </div>`
    : esc('');
  const dragHandle: Html = state === 'upcoming'
    ? html`<span class="lib-bag-drag-handle" data-bag-drag-handle data-bean-id="${esc(b.id)}" data-bag-id="${esc(bg.id)}" title="${tHtml('lib_bag_reorder_handle')}">⠿</span>`
    : esc('');
  return html`<div class="lib-bag-card${esc(state === 'current' ? ' active' : '')}${esc(expanded ? ' expanded' : '')}" data-bag-card data-bag-id="${esc(bg.id)}">
    <div class="lib-bag-card-header" data-action="toggle-bag-card" data-bag-id="${esc(bg.id)}">
      ${dragHandle}
      <span class="lib-bag-date">${bg.roastDate ? esc(bg.roastDate) : tHtml('lib_bag_no_roast_date')}</span>
      ${stateBadge}
      ${pct != null ? html`<span class="lib-bag-pct">${esc(pct)}%</span>` : esc('')}
      <span class="lib-bag-chevron">${esc(expanded ? '▾' : '▸')}</span>
    </div>
    <div class="lib-bag-card-body" style="${esc(expanded ? '' : 'display:none')}">
      <div class="lib-bag-card-actions">
        ${canEdit && !editingFull ? html`<button class="lib-bag-edit-btn" data-action="open-edit-bag" data-bean-id="${esc(b.id)}" data-bag-id="${esc(bg.id)}" title="${tHtml('lib_bag_edit')}">${ICON_PENCIL}</button>` : esc('')}
        ${canDelete ? html`<button class="lib-bag-del" data-action="delete-bag" data-bean-id="${esc(b.id)}" data-bag-id="${esc(bg.id)}" title="${tHtml('lib_bag_delete')}">${ICON_TRASH}</button>` : esc('')}
      </div>
      ${editingFull ? esc('') : html`<div class="lib-bag-card-details">
        ${details.length ? joinHtml(details) : html`<span class="lib-bag-empty-note">${tHtml('lib_bag_stock_untracked')}</span>`}
      </div>`}
      ${canAdjust && !editingStock && !editingFull ? html`<div class="lib-bag-card-actions-row">
        <button class="lib-btn-sm" data-action="open-bag-stock-edit" data-bag-id="${esc(bg.id)}">${tHtml('lib_stock_edit_btn')}</button>
      </div>` : esc('')}
      ${stockRow}
      ${editRow}
    </div>
  </div>`;
}

export function toggleBagCard(bagId: number): void {
  if (_expandedBagCards.has(bagId)) _expandedBagCards.delete(bagId);
  else _expandedBagCards.add(bagId);
  library.renderBeanList();
}

// ── Per-bag stock quick-adjust ──────────────────────────────────────────────
// Stock is only ever adjustable at the bag level now — there is no
// bean-wide stock-edit UI anymore (a bean's remaining is purely the sum of
// its bags', computed server-side).

export function openBagStockEdit(bagId: number): void {
  S._bagStockEditId = bagId;
  library.renderBeanList();
}

export function closeBagStockEdit(): void {
  S._bagStockEditId = null;
  library.renderBeanList();
}

// ── Full bag edit (roastDate/weight/price/batch number) — the bag card's
// pencil icon. Distinct from the stock-adjust flow above (open/close/save-
// BagStockEdit): that one only ever touches remaining stock via consumedG
// math; this one lets every field updateBag accepts be corrected at once
// (e.g. a mistyped roast date or batch number).
export function openEditBag(bagId: number): void {
  S._bagFullEditId = bagId;
  library.renderBeanList();
}

export function closeEditBag(): void {
  S._bagFullEditId = null;
  library.renderBeanList();
}

export async function saveEditBag(beanId: number, bagId: number): Promise<void> {
  const roastDate   = _field(`editBagRoastDate${bagId}`)?.value.trim() || '';
  const stock_g     = parseFloat(_field(`editBagStock${bagId}`)?.value ?? '');
  const price_eur   = parseFloat(_field(`editBagPrice${bagId}`)?.value ?? '');
  const batchNumber = _field(`editBagBatchNumber${bagId}`)?.value.trim() || '';
  const saved = await libraryApi.updateBeanBag(beanId, bagId, {
    roastDate,
    stock_g: Number.isNaN(stock_g) ? null : stock_g,
    price_eur: Number.isNaN(price_eur) ? null : price_eur,
    batchNumber,
  });
  if (!saved) return;
  const idx = _beans().findIndex(b => b.id === beanId);
  if (idx !== -1) _beans()[idx] = saved;
  S._bagFullEditId = null;
  library.renderBeanList();
}

// PUT /bag/{id} replaces the full bag record (see updateBag server-side) —
// every call here must resend roastDate/price_eur/batchNumber alongside
// the new stock_g, or those fields get silently blanked.
async function putBagStock(beanId: number, bagId: number, newStockG: number): Promise<boolean> {
  const bean = _beans().find(b => b.id === beanId);
  const bag = bean?.bags?.find(bg => bg.id === bagId);
  if (!bag) return false;
  const saved = await libraryApi.updateBeanBag(beanId, bagId, {
    roastDate: bag.roastDate || '',
    stock_g: newStockG,
    price_eur: bag.price_eur ?? null,
    batchNumber: bag.batchNumber || '',
  });
  if (!saved) return false;
  const idx = _beans().findIndex(b => b.id === beanId);
  if (idx !== -1) _beans()[idx] = saved;
  return true;
}

export async function saveBagStock(beanId: number, bagId: number): Promise<void> {
  const val = parseFloat(_field(`bagStockEditInput${bagId}`)?.value ?? '');
  if (isNaN(val) || val < 0) return;
  const bean = _beans().find(b => b.id === beanId);
  const bag = bean?.bags?.find(bg => bg.id === bagId);
  if (!bean || !bag) return;
  const newStockG = Math.round(val + (bag.consumedG ?? 0));
  if (!(await putBagStock(beanId, bagId, newStockG))) return;
  // eslint-disable-next-line require-atomic-updates -- bagId is the per-call function parameter, not shared state
  S._bagStockEditId = null;
  library.renderBeanList();
}

// One-click "already empty / thrown away" — sets this bag's stock_g so its
// computed remaining lands exactly on 0 (remaining <= 0 is what
// classifyBeanBags treats as "past"), without needing the adjust-stock
// input first.
export async function markBagEmpty(beanId: number, bagId: number): Promise<void> {
  const bean = _beans().find(b => b.id === beanId);
  const bag = bean?.bags?.find(bg => bg.id === bagId);
  if (!bean || !bag) return;
  if (!(await putBagStock(beanId, bagId, Math.round(bag.consumedG ?? 0)))) return;
  library.renderBeanList();
}

// Past bags are never in the initial renderBeanList() output — this
// builds their cards on first expand only (from the same live bean/dose
// state, so it stays correct across edits) and just toggles visibility on
// every call after that, so a bean with a long bag history doesn't pay
// the DOM-build cost for a section most views never open.
export function togglePastBags(beanId: number): void {
  if (_expandedPastSections.has(beanId)) _expandedPastSections.delete(beanId);
  else _expandedPastSections.add(beanId);
  library.renderBeanList();
}

// ── Drag-reorder for "upcoming" bags ────────────────────────────────────────
// Pointer Events unify mouse and touch (no separate touch handlers, no
// library) — drag a card past a sibling's vertical midpoint and it swaps
// places in the DOM immediately; on release the new DOM order becomes the
// new sortOrder via one POST .../reorder-bags call (server assigns the
// actual values, see handlers_beans.go's reorderBags).
interface DragState {
  pointerId: number;
  card: HTMLElement;
  list: HTMLElement;
  beanId: number;
}

let _dragState: DragState | null = null;

function bagDragPointerDown(e: PointerEvent): void {
  const handle = (e.target as Element).closest('[data-bag-drag-handle]');
  if (!handle) return;
  const card = handle.closest<HTMLElement>('[data-bag-card]');
  const list = handle.closest<HTMLElement>('[data-bag-drag-list]');
  if (!card || !list) return;
  e.preventDefault();
  handle.setPointerCapture(e.pointerId);
  _dragState = { pointerId: e.pointerId, card, list, beanId: Number(list.dataset.beanId) };
  card.classList.add('dragging');
  document.addEventListener('pointermove', bagDragPointerMove);
  document.addEventListener('pointerup', bagDragPointerUp);
}

function bagDragPointerMove(e: PointerEvent): void {
  if (!_dragState || e.pointerId !== _dragState.pointerId) return;
  const { card, list } = _dragState;
  const after = [...list.children].find(sib => {
    if (sib === card) return false;
    const rect = sib.getBoundingClientRect();
    return e.clientY < rect.top + rect.height / 2;
  });
  if (after) list.insertBefore(card, after);
  else list.appendChild(card);
}

// Sync listener wrapper: add/removeEventListener need a void-returning function.
function bagDragPointerUp(e: PointerEvent): void {
  void finishBagDrag(e);
}

async function finishBagDrag(e: PointerEvent): Promise<void> {
  if (!_dragState || e.pointerId !== _dragState.pointerId) return;
  const { card, list, beanId } = _dragState;
  card.classList.remove('dragging');
  document.removeEventListener('pointermove', bagDragPointerMove);
  document.removeEventListener('pointerup', bagDragPointerUp);
  _dragState = null;
  // data-bag-drag-list holds exactly this bean's upcoming (non-current) bags
  // (renderBeanList only puts those in it), so this is the complete ordered
  // list reorderBags/the server require: every upcoming bag, once, in DOM
  // order — not just the ones the pointer happened to cross.
  const bagIds = [...list.querySelectorAll<HTMLElement>('[data-bag-card]')].map(c => Number(c.dataset.bagId));
  await reorderBags(beanId, bagIds);
}

// Some test files import this module in a non-DOM (plain Node) vitest
// environment — guard the module-load-time listener registration the same
// way the rest of this codebase avoids assuming `document` exists globally.
if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', bagDragPointerDown);
}

export async function reorderBags(beanId: number, bagIds: number[]): Promise<void> {
  const saved = await libraryApi.reorderBeanBags(beanId, bagIds);
  if (!saved) return;
  const idx = _beans().findIndex(b => b.id === beanId);
  if (idx !== -1) _beans()[idx] = saved;
  library.renderBeanList();
}
