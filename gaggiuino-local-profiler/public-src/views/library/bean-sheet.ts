import { t, tHtml } from '../../i18n.js';
import * as libraryApi from '../../api/library.js';
import { esc, html, joinHtml } from '../../utils.js';
import type { Html } from '../../utils.js';
import { SLIDERS_ICON_SVG, TARGET_ICON_SVG, SNOWFLAKE_ICON_SVG, CLOSE_ICON_SVG } from '../../icons.js';
import { applySheetFlavorHighlight, resetSheetFlavorHighlight } from '../../components/flavor-mini-wheel.js';
import { attachSheetSwipe } from '../../components/sheet-swipe.js';
import { classifyBeanBags } from './bags.js';
import { shelfStock, beanInitials } from './shelf.js';
import { renderBeanCard, beanFreshBadge, originDisplay } from './bean-card.js';
import { _beanList } from './bean-shared.js';
import type { BeanListRow } from './bean-shared.js';
import * as libraryView from '../library.js';

// Circular with library.ts (it re-exports this module): the namespace may only
// be dereferenced inside functions, never copied at module load.

const ICON_PENCIL = `<svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15" aria-hidden="true"><path d="M20.71,7.04C21.1,6.65 21.1,6 20.71,5.63L18.37,3.29C18,2.9 17.35,2.9 16.96,3.29L15.12,5.12L18.87,8.87M3,17.25V21H6.75L17.81,9.93L14.06,6.18L3,17.25Z"/></svg>` as Html;
const ICON_TRASH = `<svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15" aria-hidden="true"><path d="M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19M8,9H10V19H8V9M14,9H16V19H14V9M15.5,4L14.5,3H9.5L8.5,4H5V6H19V4H15.5Z"/></svg>` as Html;
const ICON_QR = `<svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15" aria-hidden="true"><path d="M3,11H5V13H3V11M11,5H13V9H11V5M9,11H13V15H11V13H9V11M15,11H17V13H19V11H21V13H19V15H21V19H19V21H17V19H13V21H11V17H15V15H17V13H15V11M19,19V15H17V19H19M15,3H21V9H15V3M17,5V7H19V5H17M3,3H9V9H3V3M5,5V7H7V5H5M3,15H9V21H3V15M5,17V19H7V17H5Z"/></svg>` as Html;

// Bean ids with an in-flight toggle-active request — disables the archive /
// restore button for that bean so a slow connection can't double-fire the
// toggle before the first request's re-render lands.
const _pendingBeanActiveToggles = new Set<number>();

// ── Bean detail sheet (#1330 part 2) ──────────────────────────────────────
// A tap on a shelf tile or a list row opens the bean's full card in a sheet
// over the shelf instead of expanding it inline below the grid. One
// persistent host on <body>; every action that re-renders the shelf also
// refreshes the open sheet (renderShelfSections / renderBeanList in ../library.ts).
let _sheetBeanId: number | null = null;
let _sheetReturnFocus: HTMLElement | null = null;
// Open state of the sheet's overflow <details>; the host is rebuilt on every
// render, so its meaning lives outside the DOM (same pattern as
// _shelfArchiveOpen).
let _sheetMoreOpen = false;
let _sheetKeyHandler: ((e: KeyboardEvent) => void) | null = null;
// Bean id the host currently shows. The host is rebuilt (innerHTML) on every
// render, so this remembers whether the next render is the same bean (keep the
// scroll) or a fresh open (start at the top). See renderBeanSheet below.
let _sheetRenderedBeanId: number | null = null;

// The shelf refreshes an open sheet; the bean form takes over from it.
export function sheetBeanId(): number | null { return _sheetBeanId; }
// The bean form moves focus itself, so closing the sheet must not move it back.
export function forgetSheetReturnFocus(): void { _sheetReturnFocus = null; }

// Progressive enhancement: view transitions and the fold keyframe only when
// the user has not asked for reduced motion.
function _sheetMotionOk(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// #1349 touch of love: the shelf tile of a just-created bean bounces once.
export function _dropNewShelfTile(id: number): void {
  if (!_sheetMotionOk() || typeof document === 'undefined' || typeof document.querySelector !== 'function') return;
  const tile = document.querySelector<HTMLElement>(`#beanListUI [data-action="open-bean-sheet"][data-id="${id}"]`);
  if (!tile || typeof tile.classList?.add !== 'function') return;
  tile.classList.add('lib-shelf-drop');
  setTimeout(() => tile.classList.remove('lib-shelf-drop'), 450);
}

function _sheetHost(): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  const existing = document.getElementById('beanSheet');
  if (existing) return existing;
  if (typeof document.createElement !== 'function' || !document.body) return null;
  const host = document.createElement('div');
  host.id = 'beanSheet';
  host.className = 'lib-sheet-host';
  document.body.appendChild(host);
  return host;
}

// The sheet head shows the same freshness/roast/decaf/archived badges the
// card's header row renders.
function _sheetBadges(b: BeanListRow): Html {
  const disabled = b.enabled === false;
  return html`${beanFreshBadge(b)}
    ${b.roastType ? html`<span class="lib-roast-badge">${esc(t('roast_type_' + b.roastType))}</span>` : esc('')}
    ${b.decaf ? html`<span class="lib-decaf-badge">DECAF</span>` : esc('')}
    ${disabled ? html`<span class="lib-disabled-badge">${tHtml('lib_shelf_archived_tag')}</span>` : esc('')}`;
}

function _sheetStockHtml(b: BeanListRow): Html {
  const { openG, sealedBags, frozenG } = shelfStock(b);
  const parts: Html[] = [];
  if (openG != null) parts.push(html`<span class="lib-sheet-stock-g">${esc(openG)} g</span>`);
  if (sealedBags > 0) parts.push(html`<span class="lib-shelf-sealed">${tHtml('lib_shelf_full_bags', sealedBags)}</span>`);
  if (frozenG > 0) parts.push(html`<span class="lib-shelf-frozen-line">${SNOWFLAKE_ICON_SVG}${esc(frozenG)} g</span>`);
  return parts.length ? html`<div class="lib-sheet-stock">${joinHtml(parts)}</div>` : esc('');
}

// Overflow menu: every meta action the old card toolbar offered, now with
// text labels. Archive/restore replaces the old eye toggle (#1330).
function _sheetMenu(b: BeanListRow): Html {
  const disabled = b.enabled === false;
  return html`<details class="lib-sheet-more"${esc(_sheetMoreOpen ? ' open' : '')}>
    <summary aria-label="${tHtml('lib_sheet_more')}">⋯</summary>
    <div class="lib-sheet-menu-list">
      <button type="button" class="lib-sheet-menu-btn" data-action="edit-bean" data-id="${esc(b.id)}">${ICON_PENCIL} ${tHtml('lib_btn_edit')}</button>
      <button type="button" class="lib-sheet-menu-btn" data-action="create-profile-from-bean" data-id="${esc(b.id)}">${SLIDERS_ICON_SVG} ${tHtml('profile_create_from_bean')}</button>
      <button type="button" class="lib-sheet-menu-btn" data-action="start-dialin-from-bean" data-id="${esc(b.id)}">${TARGET_ICON_SVG} ${tHtml('dialin_wizard_start_from_bean')}</button>
      <button type="button" class="lib-sheet-menu-btn" data-action="toggle-bean-qr" data-id="${esc(b.id)}">${ICON_QR} ${tHtml('bean_qr_label')}</button>
      <span class="lib-sheet-menu-sep"></span>
      <button type="button" class="lib-sheet-menu-btn" data-action="toggle-bean-active" data-id="${esc(b.id)}"${esc(_pendingBeanActiveToggles.has(b.id) ? ' disabled' : '')}>${tHtml(disabled ? 'lib_btn_restore' : 'lib_btn_archive')}</button>
      <span class="lib-sheet-menu-sep"></span>
      <button type="button" class="lib-sheet-menu-btn del" data-action="delete-bean" data-id="${esc(b.id)}">${ICON_TRASH} ${tHtml('lib_btn_delete')}</button>
    </div>
  </details>`;
}

function _sheetPrimary(b: BeanListRow): Html {
  const { current } = classifyBeanBags(b);
  const activeBag = current?.bg || null;
  return html`<div class="lib-sheet-actions">
    <button type="button" class="lib-sheet-primary" data-action="filter-by-bean" data-id="${esc(b.id)}">${tHtml('lib_sheet_shot_log')}</button>
    <button type="button" class="lib-sheet-primary" data-action="open-new-bag" data-id="${esc(b.id)}">${tHtml('lib_new_bag_title')}</button>
    ${activeBag ? html`<button type="button" class="lib-sheet-primary" data-action="open-freeze-form" data-id="${esc(b.id)}">${tHtml('bag_freeze_btn')}</button>` : esc('')}
  </div>`;
}

// The scroll container the sheet rebuild would otherwise reset is the
// `.lib-sheet` element itself (overflow-y:auto). Read its current offset; 0
// when the host isn't showing one (fresh open) or lacks a real querySelector
// (the lightweight fake DOMs the tests install).
function _sheetScrollTop(host: HTMLElement): number {
  if (typeof host.querySelector !== 'function') return 0;
  const sheet = host.querySelector<HTMLElement>('.lib-sheet');
  const top = sheet?.scrollTop;
  return typeof top === 'number' ? top : 0;
}

// Decides the scrollTop to restore after a rebuild: a re-render of the SAME
// bean keeps its position so tapping inside the sheet doesn't jump to the top,
// while a fresh open or a different bean starts at 0. Pure so the test can pin
// the decision without a real scroll container.
export function beanSheetRestoredScroll(
  prevBeanId: number | null,
  nextBeanId: number,
  prevScrollTop: number,
  enter: boolean,
): number {
  if (enter || prevBeanId == null || prevBeanId !== nextBeanId) return 0;
  return Number.isFinite(prevScrollTop) && prevScrollTop > 0 ? prevScrollTop : 0;
}

// #1412: the card's inline forms (new bag, freeze, edit frozen portion:
// .lib-new-bag-form, shown via style.display; bag stock/edit rows) live in
// the sheet's innerHTML, so a rebuild closed them and dropped typed text.
export interface OpenSheetForms { open: string[]; values: Array<[string, string]> }

export function captureOpenSheetForms(root: ParentNode): OpenSheetForms {
  const snap: OpenSheetForms = { open: [], values: [] };
  if (typeof root.querySelectorAll !== 'function') return snap;
  for (const selector of ['.lib-new-bag-form', '.lib-stock-edit-row']) {
    for (const form of Array.from(root.querySelectorAll<HTMLElement>(selector))) {
      if (form.style.display === 'none') continue;
      if (form.id) snap.open.push(form.id);
      if (typeof form.querySelectorAll !== 'function') continue;
      for (const input of Array.from(form.querySelectorAll<HTMLInputElement>('input[id]'))) {
        snap.values.push([input.id, input.value]);
      }
    }
  }
  return snap;
}

export function restoreOpenSheetForms(snap: OpenSheetForms, byId: (id: string) => HTMLElement | null): void {
  for (const id of snap.open) { const form = byId(id); if (form) form.style.display = ''; }
  for (const [id, value] of snap.values) {
    const input = byId(id) as HTMLInputElement | null;
    if (input) input.value = value;
  }
}

// `enter` marks a render that comes from openBeanSheet: only then does the new
// `.lib-sheet` carry the slide-in class, so the animation plays on open and not
// on every action-driven rebuild.
export function renderBeanSheet(enter = false): void {
  const id = _sheetBeanId;
  if (id == null) return;
  const bean = _beanList().find(b => b.id === id);
  if (!bean) { closeBeanSheet(); return; }
  const host = _sheetHost();
  if (!host) return;
  const beans = _beanList();
  const origin = originDisplay(bean);
  const restoreScroll = beanSheetRestoredScroll(_sheetRenderedBeanId, id, _sheetScrollTop(host), enter);
  // Only a rebuild of the bean already shown keeps its open forms; a fresh open starts closed.
  const openForms = !enter && _sheetRenderedBeanId === id ? captureOpenSheetForms(host) : null;
  host.innerHTML = html`<div class="lib-sheet-backdrop" data-action="close-bean-sheet"></div>
    <section class="lib-sheet${esc(enter ? ' lib-sheet-enter' : '')}" role="dialog" aria-modal="true" aria-labelledby="beanSheetTitle">
      <div class="lib-sheet-grab" aria-hidden="true"></div>
      <div class="lib-sheet-head">
        <div class="lib-sheet-photo">${bean.image
          ? html`<img class="lib-bean-thumb${esc(bean.image === 'png' ? ' is-sticker' : '')}" data-bean-id="${esc(bean.id)}" alt="">`
          : html`<span class="lib-sheet-initials" aria-hidden="true">${esc(beanInitials(bean.roaster || bean.name || ''))}</span>`}</div>
        <div class="lib-sheet-titles">
          ${origin ? html`<div class="lib-item-origin-eyebrow">${esc(origin)}</div>` : esc('')}
          <h2 id="beanSheetTitle" class="serif-display lib-sheet-name">${esc(bean.name)}</h2>
          <div class="lib-sheet-badges">${_sheetBadges(bean)}</div>
          ${_sheetStockHtml(bean)}
        </div>
        <div class="lib-sheet-head-actions">
          ${_sheetMenu(bean)}
          <button type="button" class="lib-sheet-close" data-action="close-bean-sheet" aria-label="${tHtml('lib_sheet_close')}">${CLOSE_ICON_SVG}</button>
        </div>
      </div>
      ${_sheetPrimary(bean)}
      <div class="lib-sheet-body">${renderBeanCard(bean, beans)}</div>
    </section>`;
  if (openForms) restoreOpenSheetForms(openForms, formId => document.getElementById(formId));
  host.classList?.add('open');
  // Re-apply an aroma highlight that was active before this rebuild (the fresh
  // SVG has no is-hl classes of its own).
  applySheetFlavorHighlight(host);
  _sheetRenderedBeanId = id;
  // Restore the previous offset on the freshly built scroll container. Only a
  // positive value matters; 0 is the default the new element already has.
  if (restoreScroll > 0 && typeof host.querySelector === 'function') {
    const sheet = host.querySelector<HTMLElement>('.lib-sheet');
    if (sheet) sheet.scrollTop = restoreScroll;
  }
  const details = typeof host.querySelector === 'function'
    ? host.querySelector<HTMLDetailsElement>('.lib-sheet-more')
    : null;
  if (details) details.ontoggle = () => { _sheetMoreOpen = details.open; };
  // #1374: the rebuilt sheet gets fresh drag surfaces, so re-attach the
  // swipe-to-close each render (the old elements were discarded).
  const sheetEl = typeof host.querySelector === 'function' ? host.querySelector<HTMLElement>('.lib-sheet') : null;
  const grab = sheetEl && typeof sheetEl.querySelector === 'function' ? sheetEl.querySelector<HTMLElement>('.lib-sheet-grab') : null;
  const head = sheetEl && typeof sheetEl.querySelector === 'function' ? sheetEl.querySelector<HTMLElement>('.lib-sheet-head') : null;
  if (sheetEl && grab) attachSheetSwipe(sheetEl, grab, closeBeanSheet);
  if (sheetEl && head) attachSheetSwipe(sheetEl, head, closeBeanSheet);
  libraryView.loadBeanThumbnails();
}

function _focusSheetClose(): void {
  const host = typeof document !== 'undefined' ? document.getElementById('beanSheet') : null;
  const btn = host && typeof host.querySelector === 'function'
    ? host.querySelector<HTMLElement>('.lib-sheet-close')
    : null;
  btn?.focus?.();
}

function _foldSheetPhoto(): void {
  const host = typeof document !== 'undefined' ? document.getElementById('beanSheet') : null;
  const photo = host && typeof host.querySelector === 'function'
    ? host.querySelector<HTMLElement>('.lib-sheet-photo')
    : null;
  photo?.classList?.add('fold');
  setTimeout(() => photo?.classList?.remove('fold'), 350);
}

function _focusablesWithin(host: HTMLElement | null): HTMLElement[] {
  if (!host || typeof host.querySelectorAll !== 'function') return [];
  return Array.from(host.querySelectorAll<HTMLElement>(
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
  ));
}

// True while an overlay sits above a sheet: a lightbox, the crop/sticker
// editor or the barcode scan modal owns Escape until it is gone. The sticker
// editor in components/sticker/editor.ts reuses the crop editor's
// `.crop-editor-overlay` class, so one check covers both.
export function _overlayShieldsSheets(): boolean {
  if (typeof document === 'undefined') return false;
  const q = typeof document.querySelector === 'function' ? document.querySelector.bind(document) : null;
  const lightbox = q ? q('.lightbox-overlay') : null;
  const crop = q ? q('.crop-editor-overlay') : null;
  const fw = typeof document.getElementById === 'function' ? document.getElementById('flavorWheelModal') : null;
  const fwOpen = !!fw && fw.style?.display === 'flex';
  const scan = typeof document.getElementById === 'function' ? document.getElementById('scanModal') : null;
  const scanOpen = !!scan && scan.classList?.contains('open') === true;
  return !!(lightbox || crop || fwOpen || scanOpen);
}

// Shared Tab trap for both sheets: keep focus inside the given host.
export function _trapTab(e: KeyboardEvent, host: HTMLElement | null): void {
  const items = _focusablesWithin(host);
  const first = items[0];
  const last = items[items.length - 1];
  if (!first || !last) return;
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

function _onSheetKeydown(e: KeyboardEvent): void {
  if (_sheetBeanId == null) return;
  if (e.key === 'Escape') {
    if (_overlayShieldsSheets()) return;
    const tag = document.activeElement?.tagName?.toLowerCase() || '';
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    e.preventDefault();
    closeBeanSheet();
    return;
  }
  if (e.key !== 'Tab') return;
  _trapTab(e, _sheetHost());
}

function _wireSheetKeys(): void {
  if (_sheetKeyHandler || typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
  _sheetKeyHandler = _onSheetKeydown;
  document.addEventListener('keydown', _sheetKeyHandler);
}

function _unwireSheetKeys(): void {
  const handler = _sheetKeyHandler;
  _sheetKeyHandler = null;
  if (!handler || typeof document === 'undefined' || typeof document.removeEventListener !== 'function') return;
  document.removeEventListener('keydown', handler);
}

// `onPainted` runs after the sheet's content is in the DOM, synchronously
// within openBeanSheet. Callers that need to touch elements inside the fresh
// card — e.g. revealing the inline bag form after "Save and add bag" (#1398) —
// use it rather than reaching into the sheet themselves.
export function openBeanSheet(id: number, onPainted?: () => void): void {
  const bean = _beanList().find(b => b.id === id);
  if (!bean) return;
  _sheetReturnFocus = (document.activeElement as HTMLElement | null) ?? null;
  _sheetBeanId = id;
  _sheetMoreOpen = false;
  const paint = (): void => {
    renderBeanSheet(true);
    document.body?.classList?.add('lib-sheet-open');
    _wireSheetKeys();
    _focusSheetClose();
    onPainted?.();
  };
  // The sheet's own enter animation is the transition; a root view transition
  // faded the whole page (#1452).
  paint();
}

export function closeBeanSheet(): void {
  const host = typeof document !== 'undefined' ? document.getElementById('beanSheet') : null;
  if (host) {
    host.innerHTML = html``;
    host.classList?.remove('open');
  }
  _sheetBeanId = null;
  _sheetRenderedBeanId = null;
  _sheetMoreOpen = false;
  resetSheetFlavorHighlight();
  _unwireSheetKeys();
  if (typeof document !== 'undefined') document.body?.classList?.remove('lib-sheet-open');
  const back = _sheetReturnFocus;
  _sheetReturnFocus = null;
  if (back && typeof back.focus === 'function'
    && typeof document !== 'undefined' && typeof document.contains === 'function' && document.contains(back)) {
    back.focus();
  }
}

// Manual override for the order card's bean picker — independent of stock.
// The bean stays fully visible/editable in the library either way; only its
// presence in /api/orders/active-beans changes.
export async function toggleBeanActive(id: number): Promise<void> {
  if (_pendingBeanActiveToggles.has(id)) return;
  const fromSheet = _sheetBeanId === id;
  _pendingBeanActiveToggles.add(id);
  libraryView.renderBeanList();
  // The pre-request render drew the button disabled; the finally below must
  // always repaint, unless the fold animation already owns the next render
  // (and the failed/aborted request paths re-render too).
  let folded = false;
  try {
    const saved = await libraryApi.toggleBeanActive(id);
    if (!saved) return;
    const idx = _beanList().findIndex(b => b.id === id);
    if (idx !== -1) _beanList()[idx] = saved;
    window.showToast?.(t(saved.enabled === false ? 'lib_archived_toast' : 'lib_restored_toast'));
    // Touch of love: on the shelf the bag folds away before the re-render
    // moves it into the archive section.
    if (fromSheet && saved.enabled === false && _sheetMotionOk()) {
      _foldSheetPhoto();
      folded = true;
      setTimeout(() => libraryView.renderBeanList(), 350);
    }
  } finally {
    _pendingBeanActiveToggles.delete(id);
    if (!folded) libraryView.renderBeanList();
  }
}
