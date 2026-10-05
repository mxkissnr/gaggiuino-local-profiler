import type { BeanRow } from './library/bags.js';
import type { ShelfBean } from './library/shelf.js';
import { S } from '../state/index.js';
import { t, tHtml } from '../i18n.js';
import * as libraryApi from '../api/library.js';
import { esc, toIsoDateInput, html, joinHtml } from '../utils.js';
import type { Html } from '../utils.js';
import { setBeanFilter } from '../components/sidebar.js';
import { switchMode } from '../components/mode.js';
import { loadBeanImageBlobUrl, invalidateBeanImage } from '../bean-image.js';
import { openLightbox } from '../components/lightbox.js';
import { applySheetFlavorHighlight, resetSheetFlavorHighlight } from '../components/flavor-mini-wheel.js';
import { attachSheetSwipe } from '../components/sheet-swipe.js';
import { renderShotDefaultsSettingsCard } from '../components/shot-defaults-settings.js';
import { TARGET_ICON_SVG, SLIDERS_ICON_SVG, SNOWFLAKE_ICON_SVG, CLOSE_ICON_SVG } from '../icons.js';
import { renderRecipeList } from './library/recipes.js';
import { renderMilkList } from './library/milk.js';
import { renderBasketList } from './library/baskets.js';
import { renderPuckScreenList } from './library/puck-screens.js';
import { renderGrinderList } from './library/grinders.js';
import { classifyBeanBags } from './library/bags.js';
import {
  classifyBeanShelf, renderShelfTile, renderShelfRow, shelfStock, beanInitials,
  matchesShelfQuery, matchesShelfFilter, sortShelf, loadShelfPrefs, saveShelfPrefs,
} from './library/shelf.js';
import type { ShelfFilter, ShelfPrefs, ShelfSort, ShelfView } from './library/shelf.js';
import { _beanList, _state, _field, _el } from './library/bean-shared.js';
import type { BeanListRow } from './library/bean-shared.js';
import { openNewBagForm, renderBeanCard, beanFreshBadge, originDisplay } from './library/bean-card.js';
import { updateStickerButton, stagedBeanImage, clearStagedBeanImage } from './library/bean-sticker.js';
import { populateOriginSelect, bindOriginInput, setFormOrigins, populateSuggestionDatalists, bindFlavorInput, setFormFlavors, commitFlavorInput, formFlavors, formOrigins } from './library/bean-form-chips.js';

const ICON_PENCIL = `<svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15" aria-hidden="true"><path d="M20.71,7.04C21.1,6.65 21.1,6 20.71,5.63L18.37,3.29C18,2.9 17.35,2.9 16.96,3.29L15.12,5.12L18.87,8.87M3,17.25V21H6.75L17.81,9.93L14.06,6.18L3,17.25Z"/></svg>` as Html;
const ICON_TRASH = `<svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15" aria-hidden="true"><path d="M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19M8,9H10V19H8V9M14,9H16V19H14V9M15.5,4L14.5,3H9.5L8.5,4H5V6H19V4H15.5Z"/></svg>` as Html;
const ICON_QR = `<svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15" aria-hidden="true"><path d="M3,11H5V13H3V11M11,5H13V9H11V5M9,11H13V15H11V13H9V11M15,11H17V13H19V11H21V13H19V15H21V19H19V21H17V19H13V21H11V17H15V15H17V13H15V11M19,19V15H17V19H19M15,3H21V9H15V3M17,5V7H19V5H17M3,3H9V9H3V3M5,5V7H7V5H5M3,15H9V21H3V15M5,17V19H7V17H5Z"/></svg>` as Html;

// ── Library load ──────────────────────────────────────────────────────────
export async function loadLibrary(): Promise<void> {
  try {
    const library = await libraryApi.getLibrary();
    if (!library) return;
    S.coffeeLibrary = library as typeof S.coffeeLibrary;
    const lib = _state().coffeeLibrary;
    if (!lib.recipes)     lib.recipes     = [];
    if (!lib.milks)       lib.milks       = [];
    if (!lib.baskets)     lib.baskets     = [];
    if (!lib.puckScreens) lib.puckScreens = [];
    updateLibraryDatalist();
    renderRecipeList();
    renderMilkList();
    renderBasketList();
    renderPuckScreenList();
    // #526: this fetch is fired unawaited from main.js's init sequence, racing
    // switchMode('library') (mode.js), which renders the bean/grinder lists
    // straight off S.coffeeLibrary the moment the user opens Library — before
    // this promise resolves, that render sees the still-empty default
    // ({ beans: [], grinders: [] }, state.js) and, since nothing re-renders it
    // afterwards, the flavor-wheel button (and everything else data-dependent)
    // stays invisible for the rest of the session even once the data arrives.
    // Re-render here too so a load that finishes after the user is already on
    // Library corrects itself; a cheap no-op re-render if they aren't there yet.
    renderBeanList();
    renderGrinderList();
    // #654: same race — the shot-defaults Settings card's bean/basket/puck-
    // screen <select>s are also populated straight off S.coffeeLibrary at
    // init, before this fetch necessarily resolves.
    renderShotDefaultsSettingsCard();
  } catch { /* ignore */ }
}

// Bean/grinder names feed the annGrinder (main.js) and recipeFormBean
// autocompletes (components/autocomplete.js) — both read S.coffeeLibrary
// live, so nothing needs to be "populated" ahead of time. This just
// re-renders whichever of those is currently open, so a save/delete
// elsewhere in the library shows up immediately if the user has one open.
export function updateLibraryDatalist(): void {
  (document.getElementById('annGrinder') as HTMLInputElement | null)?._autocomplete?.refresh();
  (document.getElementById('recipeFormBean') as HTMLInputElement | null)?._autocomplete?.refresh();
}

export function switchLibTab(tab: string): void {
  _el('libTabBeans').classList.toggle('active',       tab === 'beans');
  _el('libTabGrinders').classList.toggle('active',    tab === 'grinders');
  _el('libTabRecipes').classList.toggle('active',     tab === 'recipes');
  _el('libTabMilk')?.classList.toggle('active',      tab === 'milk');
  _el('libTabBaskets')?.classList.toggle('active',   tab === 'baskets');
  _el('libTabPuckScreens')?.classList.toggle('active', tab === 'puckscreens');
  _el('libTabProfiles')?.classList.toggle('active',  tab === 'profiles');
  _el('libSectionBeans').classList.toggle('active',   tab === 'beans');
  _el('libSectionGrinders').classList.toggle('active', tab === 'grinders');
  _el('libSectionRecipes').classList.toggle('active', tab === 'recipes');
  _el('libSectionMilk')?.classList.toggle('active',  tab === 'milk');
  _el('libSectionBaskets')?.classList.toggle('active', tab === 'baskets');
  _el('libSectionPuckScreens')?.classList.toggle('active', tab === 'puckscreens');
  _el('libSectionProfiles')?.classList.toggle('active', tab === 'profiles');
}

// Bean ids with an in-flight toggle-active request — disables the archive /
// restore button for that bean so a slow connection can't double-fire the
// toggle before the first request's re-render lands.
const _pendingBeanActiveToggles = new Set<number>();

// ── Bean list ─────────────────────────────────────────────────────────────
// Open state of the collapsed "Empty & archive" <details>; the element is
// rebuilt on every render, so its meaning has to live outside the DOM.
let _shelfArchiveOpen = false;

// Active shelf toolbar state, loaded lazily: loadShelfPrefs() reads shelf.ts's
// module bindings, which the shelf.ts -> bags.ts -> library.ts -> shelf.ts
// import cycle leaves uninitialized during module evaluation. Only filter/sort
// are persisted (shelf.ts's saveShelfPrefs); the query is session-only so a
// stale search can't silently hide beans after a reload.
let _shelfPrefsLazy: ShelfPrefs | null = null;
function shelfPrefs(): ShelfPrefs {
  return (_shelfPrefsLazy ??= loadShelfPrefs());
}

// #1375: main.ts calls this once the shared choices fetched from the server
// have replaced the local cache, so an already-rendered shelf re-reads them.
export function resetShelfPrefs(): void {
  _shelfPrefsLazy = null;
  renderBeanList();
}

function _shelfHeading(key: string, count?: number): Html {
  return html`<div class="lib-shelf-heading"><span>${tHtml(key)}</span>${count != null ? html`<span class="lib-shelf-count">${esc(count)}</span>` : esc('')}</div>`;
}

function renderShelfToolbar(prefs: ShelfPrefs): Html {
  const chip = (filter: ShelfFilter, key: string): Html =>
    html`<button type="button" class="lib-shelf-chip" data-shelf-filter="${esc(filter)}" aria-pressed="${esc(prefs.filter === filter ? 'true' : 'false')}">${tHtml(key)}</button>`;
  const viewBtn = (view: ShelfView, key: string): Html =>
    html`<button type="button" class="lib-shelf-view-btn" data-shelf-view="${esc(view)}" aria-pressed="${esc(prefs.view === view ? 'true' : 'false')}" aria-label="${tHtml(key)}" title="${tHtml(key)}">${tHtml(key)}</button>`;
  return html`<div class="lib-shelf-toolbar">
    <div class="lib-shelf-search-row">
      <input type="search" id="libShelfSearch" class="lib-shelf-search" placeholder="${tHtml('lib_shelf_search_ph')}" aria-label="${tHtml('lib_shelf_search_ph')}" value="${esc(prefs.query)}">
      <div class="lib-shelf-views">${viewBtn('shelf', 'lib_shelf_view_shelf')}${viewBtn('list', 'lib_shelf_view_list')}</div>
    </div>
    <div class="lib-shelf-chips">${chip('all', 'lib_shelf_all')}${chip('espresso', 'roast_type_espresso')}${chip('filter', 'roast_type_filter')}${chip('decaf', 'lib_bean_decaf')}</div>
    <select id="libShelfSort" class="lib-shelf-sort">
      <option value="fresh" ${esc(prefs.sort === 'fresh' ? 'selected' : '')}>${tHtml('lib_shelf_sort_fresh')}</option>
      <option value="name" ${esc(prefs.sort === 'name' ? 'selected' : '')}>${tHtml('lib_shelf_sort_name')}</option>
      <option value="remaining" ${esc(prefs.sort === 'remaining' ? 'selected' : '')}>${tHtml('lib_shelf_sort_remaining')}</option>
    </select>
  </div>`;
}

// The shelves live in their own container so toolbar events can rebuild just
// them — rebuilding the whole view on every keystroke would drop the caret.
function _shelfSectionsMount(): HTMLElement | null {
  const el = document.getElementById('beanListUI');
  if (!el) return null;
  if (typeof el.querySelector !== 'function') return el;
  return el.querySelector<HTMLElement>('#libShelfSections') || el;
}

function wireShelfToolbar(): void {
  const prefs = shelfPrefs();
  const search = document.getElementById('libShelfSearch') as HTMLInputElement | null;
  if (search?.addEventListener) {
    search.value = prefs.query;
    search.addEventListener('input', () => {
      prefs.query = search.value;
      renderShelfSections();
    });
  }
  const sort = document.getElementById('libShelfSort') as HTMLSelectElement | null;
  if (sort?.addEventListener) {
    sort.value = prefs.sort;
    sort.addEventListener('change', () => {
      prefs.sort = (sort.value as ShelfSort) || 'fresh';
      saveShelfPrefs(prefs);
      renderShelfSections();
    });
  }
  document.querySelectorAll<HTMLButtonElement>('[data-shelf-filter]').forEach(chip => {
    if (!chip.addEventListener) return;
    chip.addEventListener('click', () => {
      prefs.filter = (chip.dataset.shelfFilter as ShelfFilter) || 'all';
      saveShelfPrefs(prefs);
      document.querySelectorAll<HTMLButtonElement>('[data-shelf-filter]').forEach(c => {
        c.setAttribute('aria-pressed', c.dataset.shelfFilter === prefs.filter ? 'true' : 'false');
      });
      renderShelfSections();
    });
  });
  document.querySelectorAll<HTMLButtonElement>('[data-shelf-view]').forEach(btn => {
    if (!btn.addEventListener) return;
    btn.addEventListener('click', () => {
      prefs.view = (btn.dataset.shelfView as ShelfView) === 'list' ? 'list' : 'shelf';
      saveShelfPrefs(prefs);
      document.querySelectorAll<HTMLButtonElement>('[data-shelf-view]').forEach(b => {
        b.setAttribute('aria-pressed', b.dataset.shelfView === prefs.view ? 'true' : 'false');
      });
      renderShelfSections();
    });
  });
}

function renderShelfSections(): void {
  const mount = _shelfSectionsMount();
  if (!mount) return;
  // Beans are a shared consumable, not scoped to the active machine — always
  // render the full library regardless of S.activeMachineId. This reverts
  // the display-filtering part of #334; see #339 for why that filter was
  // wrong (it hid nearly the whole library once a second machine existed).
  const beans = _beanList();
  const prefs = shelfPrefs();
  const queried = beans.filter(b => matchesShelfQuery(b, prefs.query));
  const { inUse, stock, emptyArchive } = classifyBeanShelf(queried);
  const isList = prefs.view === 'list';

  // One shelf: the beans being drunk and the unopened stock side by side.
  // Filter and sort apply to both together, then a stable partition moves the
  // opened beans to the front. classifyBeanShelf's inUse is exactly the opened
  // set, so it is filtered out of the combined list before sorting to keep the
  // partition from double-counting.
  const combined = sortShelf([...inUse, ...stock].filter(b => matchesShelfFilter(b, prefs.filter)), prefs.sort);
  const isOpened = (b: ShelfBean): boolean => shelfStock(b).opened;
  const shelfRows = [...combined.filter(isOpened), ...combined.filter(b => !isOpened(b))];
  const archiveRows = sortShelf(emptyArchive.filter(b => matchesShelfFilter(b, prefs.filter)), prefs.sort);

  // Same items in either view: a photo grid on the shelf, a compact list on
  // request. Tapping either one opens the bean's detail sheet (#1330).
  const items = (rows: ShelfBean[], muted: boolean): Html => {
    const parts = rows.map(b => isList
      ? renderShelfRow(b, { muted })
      : renderShelfTile(b, { muted }));
    return html`<div class="${esc(isList ? 'lib-shelf-list' : 'lib-shelf')}">${joinHtml(parts)}</div>`;
  };

  const shelfHtml: Html = shelfRows.length
    ? html`<section class="lib-shelf-section">${_shelfHeading('lib_shelf_stock', shelfRows.length)}
        ${shelfRows.length >= 10 ? html`<div class="lib-shelf-full-note">${tHtml('lib_shelf_full')}</div>` : esc('')}
        ${items(shelfRows, false)}</section>`
    : esc('');

  const archiveHtml: Html = archiveRows.length
    ? html`<details class="lib-shelf-archive"${esc(_shelfArchiveOpen ? ' open' : '')}>
        <summary class="lib-shelf-heading lib-shelf-archive-summary"><span>${tHtml('lib_shelf_archive')}</span><span class="lib-shelf-count">${esc(archiveRows.length)}</span></summary>
        ${items(archiveRows, true)}</details>`
    : esc('');

  const filtersActive = prefs.query.trim() !== '' || prefs.filter !== 'all';
  const noMatchHtml: Html = filtersActive && !shelfRows.length && !archiveRows.length
    ? html`<div class="lib-shelf-no-match">${tHtml('lib_shelf_no_match')}</div>`
    : esc('');

  // codeql[js/xss-through-dom] false positive: esc()/escapeHtml() already applied, see #760
  mount.innerHTML = html`${noMatchHtml}${shelfHtml}${archiveHtml}`;

  // Remember the archive section's open state; the <details> is recreated on
  // every render, so the native toggle event is re-wired here each time. The
  // typeof guard keeps the lightweight fake DOMs the tests install working
  // (they give the element innerHTML but no querySelector).
  const archive = typeof mount.querySelector === 'function'
    ? mount.querySelector<HTMLDetailsElement>('.lib-shelf-archive')
    : null;
  if (archive) archive.ontoggle = () => { _shelfArchiveOpen = archive.open; };

  // Every action that re-renders the shelf also refreshes the open sheet.
  if (_sheetBeanId != null) renderBeanSheet();
  else loadBeanThumbnails();
}

export function renderBeanList(): void {
  const el = document.getElementById('beanListUI');
  if (!el) return;
  const beans = _beanList();
  if (!beans.length) {
    if (_sheetBeanId != null) closeBeanSheet();
    el.innerHTML = html`<div class="lib-empty">${tHtml('lib_empty_beans')}</div>`;
    return;
  }
  // #1330: one shelf — the beans you are drinking stand first, the rest of the
  // stock behind them, and spent/archived beans tidy themselves into a
  // collapsed section. The toolbar switches the items between a photo grid and
  // a compact list; either way a tap opens the unchanged full card in a sheet.
  // The toolbar rebuilds with the view; the shelf it filters lives in its own
  // container so typing can re-render it without losing the caret.
  el.innerHTML = html`${renderShelfToolbar(shelfPrefs())}<div id="libShelfSections"></div>`;
  wireShelfToolbar();
  renderShelfSections();
}

// Bean images need the auth token, so <img src> can't point at the API
// directly (see bean-image.js) — set the blob-url src async after render.
// #440: click opens the same fullscreen lightbox already used for shot
// photos (sidebar.js) — stopPropagation mirrors that pattern in case a
// parent click handler is ever added to .lib-item.
function loadBeanThumbnails() {
  document.querySelectorAll<HTMLImageElement>('.lib-bean-thumb[data-bean-id], .lib-shelf-img[data-bean-id]').forEach(img => {
    const id = Number(img.dataset.beanId);
    void loadBeanImageBlobUrl(id).then(url => {
      if (!url) return;
      img.src = url;
      // A shelf tile's tap expands the bean, so only the list thumbnail opens
      // the lightbox (#1329).
      if (img.classList.contains('lib-bean-thumb')) {
        img.onclick = e => { e.stopPropagation(); openLightbox(img.src); };
      }
    });
  });
}

// ── Bean detail sheet (#1330 part 2) ──────────────────────────────────────
// A tap on a shelf tile or a list row opens the bean's full card in a sheet
// over the shelf instead of expanding it inline below the grid. One
// persistent host on <body>; every action that re-renders the shelf also
// refreshes the open sheet (renderShelfSections / renderBeanList above).
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

// Progressive enhancement: view transitions and the fold keyframe only when
// the user has not asked for reduced motion.
function _sheetMotionOk(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// #1349 touch of love: the shelf tile of a just-created bean bounces once.
function _dropNewShelfTile(id: number): void {
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

// `enter` marks a render that comes from openBeanSheet: only then does the new
// `.lib-sheet` carry the slide-in class, so the animation plays on open and not
// on every action-driven rebuild.
function renderBeanSheet(enter = false): void {
  const id = _sheetBeanId;
  if (id == null) return;
  const bean = _beanList().find(b => b.id === id);
  if (!bean) { closeBeanSheet(); return; }
  const host = _sheetHost();
  if (!host) return;
  const beans = _beanList();
  const origin = originDisplay(bean);
  const restoreScroll = beanSheetRestoredScroll(_sheetRenderedBeanId, id, _sheetScrollTop(host), enter);
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
  loadBeanThumbnails();
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
function _overlayShieldsSheets(): boolean {
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
function _trapTab(e: KeyboardEvent, host: HTMLElement | null): void {
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

// `onPainted` runs after the sheet's content is in the DOM. The paint may be
// deferred (it goes through a view transition when motion is allowed), so
// callers that need to touch elements inside the fresh card — e.g. revealing
// the inline bag form after "Save and add bag" (#1398) — must wait for this
// rather than assume the sheet is already built.
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
  const doc = document as Document & { startViewTransition?: (cb: () => void) => void };
  if (typeof doc.startViewTransition === 'function' && _sheetMotionOk()) doc.startViewTransition(paint);
  else paint();
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

// Clicking a bean's name in the Library sets the sidebar's structured bean
// filter (state.js S.beanFilter / sidebar.js setBeanFilter()) and jumps to
// the Shots tab so the filtered history is immediately visible.
export function filterShotsByBean(id: number): void {
  const bean = _beanList().find(b => b.id === id);
  if (!bean) return;
  setBeanFilter(bean.id, bean.name);
  switchMode('shots');
}

// ── Bean form sheet (#1349) ───────────────────────────────────────────────
// The bean form is static markup in index.html. Rather than re-template it,
// opening the form moves that same node into this sheet and closing moves it
// back, so every input value, id and listener survives untouched.
let _formSheetHost: HTMLElement | null = null;
let _formSheetBody: HTMLElement | null = null;
let _formSheetTitle: HTMLElement | null = null;
let _formSheetConfirm: HTMLElement | null = null;
let _formSheetKeyHandler: ((e: KeyboardEvent) => void) | null = null;
let _formHomeParent: Node | null = null;
let _formHomeNext: Node | null = null;
let _formReturnBeanId: number | null = null;
let _beanFormDirty = false;
let _beanFormDirtyBound = false;

function _rememberFormHome(): void {
  const form = typeof document !== 'undefined' ? document.getElementById('beanAddForm') : null;
  if (!form || !form.parentNode) return;
  // While the form sits in our own sheet body there is no home to learn;
  // re-recording on every other open also keeps the reference valid if the
  // library markup around the form is ever rebuilt.
  if (_formSheetBody && form.parentNode === _formSheetBody) return;
  _formHomeParent = form.parentNode;
  _formHomeNext = form.nextSibling;
}

function _restoreFormHome(): void {
  const form = typeof document !== 'undefined' ? document.getElementById('beanAddForm') : null;
  if (!form || !_formHomeParent) return;
  form.classList?.remove('open');
  if (_formHomeNext && _formHomeNext.parentNode === _formHomeParent) {
    _formHomeParent.insertBefore(form, _formHomeNext);
  } else {
    _formHomeParent.appendChild(form);
  }
}

// Persistent host, built once from the same classes as the detail sheet.
function _beanFormSheetHost(): HTMLElement | null {
  if (_formSheetHost) return _formSheetHost;
  if (typeof document === 'undefined'
    || typeof document.createElement !== 'function'
    || !document.body
    || typeof document.body.appendChild !== 'function') return null;

  const host = document.createElement('div');
  host.id = 'beanFormSheet';
  host.className = 'lib-sheet-host';

  const backdrop = document.createElement('div');
  backdrop.className = 'lib-sheet-backdrop';
  backdrop.setAttribute('data-action', 'close-bean-form-sheet');
  host.appendChild(backdrop);

  const section = document.createElement('section');
  section.className = 'lib-sheet lib-form-sheet';
  section.setAttribute('role', 'dialog');
  section.setAttribute('aria-modal', 'true');
  section.setAttribute('aria-labelledby', 'beanFormSheetTitle');

  // #1374: the same grab handle and swipe-to-close as the detail sheet; the
  // form's dirty guard (requestCloseBeanForm) still asks before discarding.
  const grab = document.createElement('div');
  grab.className = 'lib-sheet-grab';
  grab.setAttribute('aria-hidden', 'true');
  section.appendChild(grab);

  const head = document.createElement('div');
  head.className = 'lib-form-sheet-head';
  const title = document.createElement('h2');
  title.id = 'beanFormSheetTitle';
  title.className = 'lib-sheet-name';
  head.appendChild(title);
  const headActions = document.createElement('div');
  headActions.className = 'lib-form-sheet-head-actions';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'lib-sheet-close';
  close.setAttribute('data-action', 'close-bean-form-sheet');
  close.setAttribute('aria-label', t('lib_sheet_close'));
  close.innerHTML = CLOSE_ICON_SVG;
  headActions.appendChild(close);
  head.appendChild(headActions);
  section.appendChild(head);

  const confirm = document.createElement('div');
  confirm.className = 'lib-form-confirm';
  confirm.setAttribute('hidden', '');
  const question = document.createElement('span');
  question.className = 'lib-form-confirm-q';
  question.textContent = t('lib_form_discard_q');
  confirm.appendChild(question);
  const confirmActions = document.createElement('div');
  confirmActions.className = 'lib-form-confirm-actions';
  const discard = document.createElement('button');
  discard.type = 'button';
  discard.className = 'lib-btn-sm';
  discard.textContent = t('lib_form_discard');
  discard.addEventListener('click', () => discardBeanForm());
  confirmActions.appendChild(discard);
  const keep = document.createElement('button');
  keep.type = 'button';
  keep.className = 'lib-save-btn';
  keep.textContent = t('lib_form_keep_editing');
  keep.addEventListener('click', () => _hideFormConfirm());
  confirmActions.appendChild(keep);
  confirm.appendChild(confirmActions);
  section.appendChild(confirm);

  const body = document.createElement('div');
  body.className = 'lib-form-sheet-body';
  section.appendChild(body);

  host.appendChild(section);
  document.body.appendChild(host);

  attachSheetSwipe(section, grab, requestCloseBeanForm);
  attachSheetSwipe(section, head, requestCloseBeanForm);

  _formSheetHost = host;
  _formSheetBody = body;
  _formSheetTitle = title;
  _formSheetConfirm = confirm;
  return host;
}

function _showFormConfirm(): void {
  _formSheetConfirm?.removeAttribute('hidden');
}

function _hideFormConfirm(): void {
  _formSheetConfirm?.setAttribute('hidden', '');
}

// One delegated listener: anything the user touches inside the form marks it
// dirty. Programmatic prefill (imports) fires no event and stays clean.
function _bindBeanFormDirty(): void {
  if (_beanFormDirtyBound) return;
  const form = typeof document !== 'undefined' ? document.getElementById('beanAddForm') : null;
  if (!form || typeof form.addEventListener !== 'function') return;
  _beanFormDirtyBound = true;
  const mark = (): void => { _beanFormDirty = true; };
  form.addEventListener('input', mark);
  form.addEventListener('change', mark);
}

function _formSheetVisible(): boolean {
  return !!_formSheetHost && _formSheetHost.classList?.contains('open') === true;
}

function _onFormSheetKeydown(e: KeyboardEvent): void {
  if (!_formSheetVisible()) return;
  if (e.key === 'Escape') {
    if (_overlayShieldsSheets()) return;
    const tag = document.activeElement?.tagName?.toLowerCase() || '';
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    e.preventDefault();
    requestCloseBeanForm();
    return;
  }
  if (e.key !== 'Tab') return;
  _trapTab(e, _formSheetHost);
}

function _wireFormSheetKeys(): void {
  if (_formSheetKeyHandler || typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
  _formSheetKeyHandler = _onFormSheetKeydown;
  document.addEventListener('keydown', _formSheetKeyHandler);
}

function _unwireFormSheetKeys(): void {
  const handler = _formSheetKeyHandler;
  _formSheetKeyHandler = null;
  if (!handler || typeof document === 'undefined' || typeof document.removeEventListener !== 'function') return;
  document.removeEventListener('keydown', handler);
}

// Moves the form into the sheet, shows it and wires the sheet keyboard.
function _showBeanFormSheet(): void {
  const host = _beanFormSheetHost();
  if (!host) return;
  _rememberFormHome();
  const isEdit = S.beanEditId != null;
  if (_formSheetTitle) _formSheetTitle.textContent = t(isEdit ? 'lib_form_sheet_edit' : 'lib_form_sheet_new');
  _hideFormConfirm();
  const form = document.getElementById('beanAddForm');
  if (form) {
    const photo = document.getElementById('beanFormImageField');
    if (photo && typeof form.insertBefore === 'function' && form.firstChild !== photo) {
      form.insertBefore(photo, form.firstChild);
    }
    (_formSheetBody ?? host).appendChild(form);
    form.classList?.add('open');
  }
  host.classList?.add('open');
  document.body?.classList?.add('lib-sheet-open');
  _formReturnBeanId = S.beanEditId;
  _wireFormSheetKeys();
  _field('beanFormName').focus();
}

export function openBeanForm(bean?: BeanRow | null): void {
  _bindBeanFormDirty();
  // #1349: the form opens in its own sheet. When the detail sheet is up, hand
  // over to the form without bouncing focus back to the shelf tile first.
  if (_sheetBeanId != null) { _sheetReturnFocus = null; closeBeanSheet(); }
  S.beanEditId = bean ? bean.id : null;
  const importNotice = document.getElementById('beanFormImportNotice');
  if (importNotice) { importNotice.style.display = 'none'; importNotice.innerHTML = html``; }
  const dupWarning = document.getElementById('beanFormDuplicateWarning');
  if (dupWarning) { dupWarning.style.display = 'none'; dupWarning.innerHTML = html``; }
  const extraRecipes = document.getElementById('beanFormExtraRecipes');
  if (extraRecipes) { extraRecipes.style.display = 'none'; extraRecipes.innerHTML = html``; }
  _state()._urlImportExtraRecipes = null;
  _field('beanFormName').value      = bean?.name      || '';
  _field('beanFormRoaster').value   = bean?.roaster   || '';
  _field('beanFormRoastDate').value = toIsoDateInput(bean?.roastDate);
  _field('beanFormNotes').value     = bean?.notes     || '';
  // Stock and batch number are bag-only now (see classifyBeanBags/
  // renderBagCard's own "Bestand anpassen"/bag-dialog fields) — neither
  // field exists on the bean form at all.
  const activeEditBag = bean ? classifyBeanBags(bean).current?.bg : null;
  _field('beanFormDecaf').checked   = !!bean?.decaf;
  populateOriginSelect();
  bindOriginInput();
  setFormOrigins(bean);
  populateSuggestionDatalists();
  _field('beanFormVariety').value   = bean?.variety || '';
  _field('beanFormSpecies').value   = bean?.species || '';
  _field('beanFormCategory').value  = bean?.category || 'normal';
  _field('beanFormProcess').value   = bean?.process || '';
  bindFlavorInput();
  setFormFlavors(bean?.flavors);
  _field('beanFormFlavorInput').value = '';
  _field('beanFormRoastType').value = bean?.roastType || '';
  _field('beanFormRegion').value    = bean?.region || '';
  _field('beanFormAltitude').value      = String(bean?.altitude_m ?? '');
  _field('beanFormImporter').value      = bean?.importer || '';
  _field('beanFormHarvest').value       = bean?.harvest || '';
  _field('beanFormPrice').value = String(activeEditBag?.price_eur ?? bean?.price_eur ?? '');
  _field('beanFormProducer').value      = bean?.producer || '';
  _field('beanFormCertification').value = bean?.certification || '';
  _field('beanFormBrewTemp').value  = String(bean?.brewTempC ?? '');
  _field('beanFormBrewRatio').value = bean?.brewRatio || '';
  _field('beanFormBrewTime').value  = String(bean?.brewTimeS ?? '');
  _field('beanFormBrewNotes').value = bean?.brewNotes || '';
  // #1329 part 2: the photo picker is offered when creating too — the chosen
  // (cropped) blob is staged and uploaded right after the bean is saved.
  _el('beanFormImageField').style.display = '';
  const stagedHint = document.getElementById('beanFormImageStaged');
  if (stagedHint) stagedHint.style.display = 'none';
  void updateStickerButton();
  // Edit mode keeps a single Speichern; creating a new bean instead offers
  // "Speichern und Packung hinzufügen" / "Speichern ohne Packung" — there's
  // nothing to combine-with-a-bag-dialog once the bean already exists.
  // Reads S.beanEditId (set above), not the raw `bean` param — the
  // "+ Bohne hinzufügen" trigger button is wired directly as a click
  // listener, so `bean` there is the MouseEvent, not undefined/null.
  const isEdit = S.beanEditId != null;
  const saveBtn       = document.getElementById('saveBeanBtn');
  const saveNoBagBtn  = document.getElementById('saveBeanNoBagBtn');
  const saveAddBagBtn = document.getElementById('saveBeanAddBagBtn');
  if (saveBtn)       saveBtn.style.display       = isEdit ? '' : 'none';
  if (saveNoBagBtn)  saveNoBagBtn.style.display  = isEdit ? 'none' : '';
  if (saveAddBagBtn) saveAddBagBtn.style.display = isEdit ? 'none' : '';
  _el('beanAddTrigger').style.display = 'none';
  _beanFormDirty = false;
  _showBeanFormSheet();
}

export function closeBeanForm(): void {
  S.beanEditId        = null;
  S._urlImportSource   = null;
  S._urlImportedAt     = null;
  _state()._urlImportImageUrl = null;
  S._urlImportSourceUrl = null;
  _state()._urlImportExtraRecipes = null;
  clearStagedBeanImage();
  const stagedHint = document.getElementById('beanFormImageStaged');
  if (stagedHint) stagedHint.style.display = 'none';
  const stickerBtn = document.getElementById('beanFormStickerBtn');
  if (stickerBtn) stickerBtn.style.display = 'none';
  const extraEl = document.getElementById('beanFormExtraRecipes');
  if (extraEl) { extraEl.style.display = 'none'; extraEl.innerHTML = html``; }
  _hideFormConfirm();
  _restoreFormHome();
  _formSheetHost?.classList?.remove('open');
  _unwireFormSheetKeys();
  if (typeof document !== 'undefined') document.body?.classList?.remove('lib-sheet-open');
  _el('beanAddTrigger').style.display = '';
  _beanFormDirty = false;
  const returnId = _formReturnBeanId;
  _formReturnBeanId = null;
  if (returnId != null && _beanList().some(b => b.id === returnId)) {
    openBeanSheet(returnId);
    // The form's Save button is hidden again now; don't hand focus back to it
    // when this detail sheet is later closed.
    _sheetReturnFocus = null;
  }
}

// Dirty-aware close: a form with unsaved edits asks before discarding.
export function requestCloseBeanForm(): void {
  if (_beanFormDirty) { _showFormConfirm(); return; }
  closeBeanForm();
}

// Cancel / confirm-bar discard: an explicit "throw my edits away", no prompt.
export function discardBeanForm(): void {
  _beanFormDirty = false;
  closeBeanForm();
}

export function editBean(id: number): void {
  const bean = _beanList().find(b => b.id === id);
  if (bean) openBeanForm(bean);
}

export async function saveBean(): Promise<void> { return saveBeanInternal(false); }
// Create-only entry points (see openBeanForm's mode-conditional buttons) —
// both save the bean identically, they only differ in what happens right
// after: opening the existing new-bag dialog, or not.
export async function saveBeanNoBag(): Promise<void> { return saveBeanInternal(false); }
export async function saveBeanAddBag(): Promise<void> { return saveBeanInternal(true); }

async function saveBeanInternal(openBagDialogAfter: boolean): Promise<void> {
  const name      = _field('beanFormName').value.trim();
  const roaster   = _field('beanFormRoaster').value.trim();
  const roastDate = _field('beanFormRoastDate').value.trim();
  const notes     = _field('beanFormNotes').value.trim();
  const decaf     = _field('beanFormDecaf').checked;
  const variety   = _field('beanFormVariety').value.trim();
  const species   = _field('beanFormSpecies').value;
  const category  = _field('beanFormCategory').value;
  const process   = _field('beanFormProcess').value.trim();
  const roastType = _field('beanFormRoastType').value;
  const region    = _field('beanFormRegion').value.trim();
  const altitude_m    = _field('beanFormAltitude').value;
  const importer      = _field('beanFormImporter').value.trim();
  const harvest       = _field('beanFormHarvest').value.trim();
  const price_eur     = _field('beanFormPrice').value;
  const producer      = _field('beanFormProducer').value.trim();
  const certification = _field('beanFormCertification').value.trim();
  const brewTempC  = _field('beanFormBrewTemp').value;
  const brewRatio  = _field('beanFormBrewRatio').value.trim();
  const brewTimeS  = _field('beanFormBrewTime').value;
  const brewNotes  = _field('beanFormBrewNotes').value.trim();
  commitFlavorInput(); // take a still-typed flavor along
  if (!name) { _field('beanFormName').focus(); return; }
  const payload: Record<string, unknown> = {
    name, roaster, roastDate, notes, decaf, origins: formOrigins(), variety, species, category, process, flavors: formFlavors(), roastType, region,
    altitude_m, importer, harvest, price_eur, producer, certification,
    brewTempC, brewRatio, brewTimeS, brewNotes,
  };
  if (!S.beanEditId && S._urlImportSource) {
    payload.source     = S._urlImportSource;
    payload.importedAt = S._urlImportedAt;
    // A photo the user staged for this create wins over the import's image URL.
    if (_state()._urlImportImageUrl && !stagedBeanImage()) payload.imageUrl = _state()._urlImportImageUrl;
    if (S._urlImportSourceUrl) payload.sourceUrl = S._urlImportSourceUrl;
  }
  // #451: capture which opt-in Brew Guide recipe candidates are still
  // checked before closeBeanForm() clears both the DOM and this state.
  const extraRecipesToImport = (_state()._urlImportExtraRecipes || []).filter((_, i) =>
    document.querySelector<HTMLInputElement>(`[data-extra-recipe-idx="${i}"]`)?.checked);
  const saved = await libraryApi.saveBean(S.beanEditId, payload);
  if (!saved) return;
  if (S.beanEditId) {
    const idx = _beanList().findIndex(b => b.id === S.beanEditId);
    if (idx !== -1) _beanList()[idx] = saved;
  } else {
    _beanList().push(saved);
  }
  const wasCreate = !S.beanEditId;
  // #1329 part 2: upload a photo staged while creating, now that the bean has
  // an id. A failed upload must not lose the bean — it stays in the list and
  // the user gets the same generic error an edit-mode upload shows.
  const staged = stagedBeanImage();
  if (wasCreate && staged) {
    clearStagedBeanImage();
    const uploaded = await libraryApi.uploadBeanImage(saved.id, staged);
    if (uploaded.ok) {
      const withImage = (await uploaded.json()) as BeanListRow;
      const imgIdx = _beanList().findIndex(b => b.id === saved.id);
      if (imgIdx !== -1) _beanList()[imgIdx] = withImage;
      invalidateBeanImage(saved.id);
    } else {
      const err = (await uploaded.json().catch(() => ({}))) as { error?: string };
      alert(t('error_generic', err.error || uploaded.statusText));
    }
  }
  for (const recipe of extraRecipesToImport) {
    const importedRecipe = await libraryApi.saveRecipe(null, { ...recipe, brewMethod: 'espresso', beanName: saved.name });
    if (importedRecipe) {
      const lib = _state().coffeeLibrary;
      if (!lib.recipes) lib.recipes = [];
      lib.recipes.push(importedRecipe);
    }
  }
  // Also persist price_eur to the current bag so per-bag price stays in sync
  if (S.beanEditId && price_eur) {
    const activeBagForSave = classifyBeanBags(saved).current?.bg || null;
    if (activeBagForSave) {
      const savedWithBag = await libraryApi.updateBeanBag(S.beanEditId, activeBagForSave.id as number, {
        roastDate: activeBagForSave.roastDate || '', stock_g: activeBagForSave.stock_g ?? null,
        batchNumber: activeBagForSave.batchNumber || '', price_eur: parseFloat(price_eur) || null,
      });
      if (savedWithBag) {
        const idx2 = _beanList().findIndex(b => b.id === S.beanEditId);
        if (idx2 !== -1) _beanList()[idx2] = savedWithBag;
      }
    }
  }
  updateLibraryDatalist();
  closeBeanForm();
  renderBeanList();
  if (wasCreate) _dropNewShelfTile(saved.id);
  if (extraRecipesToImport.length) renderRecipeList();
  // #1398: the new bean's inline #newBagForm<id> only exists inside its
  // detail sheet (renderBeanCard), so with a plain
  // openNewBagForm the element was missing and the call threw. Open the
  // fresh sheet first and reveal the form once its content has painted.
  if (wasCreate && openBagDialogAfter) openBeanSheet(saved.id, () => openNewBagForm(saved.id));
}

export async function deleteBean(id: number): Promise<void> {
  if (!confirm(t('lib_confirm_delete_bean'))) return;
  const r = await libraryApi.deleteBeanPermanently(id);
  if (!r.ok) return;
  S.coffeeLibrary.beans = S.coffeeLibrary.beans.filter(b => b.id !== id);
  updateLibraryDatalist();
  renderBeanList();
}

// Manual override for the order card's bean picker — independent of stock.
// The bean stays fully visible/editable in the library either way; only its
// presence in /api/orders/active-beans changes.
export async function toggleBeanActive(id: number): Promise<void> {
  if (_pendingBeanActiveToggles.has(id)) return;
  const fromSheet = _sheetBeanId === id;
  _pendingBeanActiveToggles.add(id);
  renderBeanList();
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
      setTimeout(renderBeanList, 350);
    }
  } finally {
    _pendingBeanActiveToggles.delete(id);
    if (!folded) renderBeanList();
  }
}

// Section symbols moved to ./library/* — re-exported so existing importers
// of views/library.js (main.ts et al.) keep working.
export { renderBeanCard, safeHttpUrl, openNewBagForm, closeNewBagForm, deleteBag, saveNewBag, openFreezeForm, closeFreezeForm, saveFreezePortions, thawPortion, openEditFrozenForm, closeEditFrozenForm, saveEditFrozenForm, toggleBeanQR } from './library/bean-card.js';
export { stageNewBeanImage, uploadBeanImage, updateStickerButton, cutOutBeanSticker } from './library/bean-sticker.js';
export { setFormFlavors, setFormOrigins } from './library/bean-form-chips.js';
export {
  renderRecipeList, addRecipeStep, removeRecipeStep, openRecipeForm, closeRecipeForm,
  editRecipe, saveRecipe, deleteRecipe,
} from './library/recipes.js';
export { renderMilkList, openMilkForm, closeMilkForm, saveMilk, restockMilk, deleteMilk } from './library/milk.js';
export { renderBasketList, openBasketForm, closeBasketForm, editBasket, saveBasket, uploadBasketImage, deleteBasket } from './library/baskets.js';
export { renderPuckScreenList, openPuckScreenForm, closePuckScreenForm, editPuckScreen, savePuckScreen, uploadPuckScreenImage, deletePuckScreen } from './library/puck-screens.js';
export {
  renderGrinderList, openGrinderForm, closeGrinderForm, editGrinder, deleteGrinderZeroPointEntry,
  saveGrinder, resetGrinderBurrs, uploadGrinderImage, deleteGrinder,
} from './library/grinders.js';
export {
  toggleUrlImport, importFromUrl, toggleImportSettings, addCustomShopifyDomain,
  openScanModal, closeScanModal, _runScanLoop, _handleScanResult,
} from './library/import.js';
export {
  toggleBagCard, openBagStockEdit, closeBagStockEdit, openEditBag, closeEditBag,
  saveEditBag, saveBagStock, markBagEmpty, togglePastBags, reorderBags,
} from './library/bags.js';
