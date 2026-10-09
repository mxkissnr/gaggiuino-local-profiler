import type { ShelfBean } from './library/shelf.js';
import { S } from '../state/index.js';
import { tHtml } from '../i18n.js';
import * as libraryApi from '../api/library.js';
import { esc, html, joinHtml } from '../utils.js';
import type { Html } from '../utils.js';
import { setBeanFilter } from '../components/sidebar.js';
import { switchMode } from '../components/mode.js';
import { loadBeanImageBlobUrl } from '../bean-image.js';
import { openLightbox } from '../components/lightbox.js';
import { renderShotDefaultsSettingsCard } from '../components/shot-defaults-settings.js';
import { renderRecipeList } from './library/recipes.js';
import { renderMilkList } from './library/milk.js';
import { renderBasketList } from './library/baskets.js';
import { renderPuckScreenList } from './library/puck-screens.js';
import { renderGrinderList } from './library/grinders.js';
import {
  classifyBeanShelf, renderShelfTile, renderShelfRow, shelfStock,
  matchesShelfQuery, matchesShelfFilter, sortShelf, loadShelfPrefs, saveShelfPrefs,
} from './library/shelf.js';
import type { ShelfFilter, ShelfPrefs, ShelfSort, ShelfView } from './library/shelf.js';
import { _beanList, _state, _el } from './library/bean-shared.js';
import {
  sheetBeanId, renderBeanSheet, closeBeanSheet,
} from './library/bean-sheet.js';

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
// #1539: the live path passes keepQuery, because the shelf search is
// session-only and a remote change must not wipe what the user is typing.
export function resetShelfPrefs(keepQuery = false): void {
  const query = keepQuery ? (_shelfPrefsLazy?.query ?? '') : '';
  _shelfPrefsLazy = null;
  if (query) shelfPrefs().query = query;
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
  if (sheetBeanId() != null) renderBeanSheet();
  else loadBeanThumbnails();
}

export function renderBeanList(): void {
  const el = document.getElementById('beanListUI');
  if (!el) return;
  const beans = _beanList();
  if (!beans.length) {
    if (sheetBeanId() != null) closeBeanSheet();
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
export function loadBeanThumbnails() {
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

// Clicking a bean's name in the Library sets the sidebar's structured bean
// filter (state.js S.beanFilter / sidebar.js setBeanFilter()) and jumps to
// the Shots tab so the filtered history is immediately visible.
export function filterShotsByBean(id: number): void {
  const bean = _beanList().find(b => b.id === id);
  if (!bean) return;
  setBeanFilter(bean.id, bean.name);
  switchMode('shots');
}

// Section symbols moved to ./library/* — re-exported so existing importers
// of views/library.js (main.ts et al.) keep working.
export { openBeanSheet, closeBeanSheet, requestCloseBeanSheet, beanSheetRestoredScroll, toggleBeanActive } from './library/bean-sheet.js';
export { openBeanForm, closeBeanForm, requestCloseBeanForm, discardBeanForm, editBean, saveBean, saveBeanNoBag, saveBeanAddBag, deleteBean } from './library/bean-form-sheet.js';
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
  openScanModal, closeScanModal, _runScanLoop, _submitManualScan, _handleScanPhoto, _handleScanResult,
} from './library/import.js';
export {
  toggleBagCard, openBagStockEdit, closeBagStockEdit, openEditBag, closeEditBag,
  saveEditBag, saveBagStock, markBagEmpty, togglePastBags, reorderBags,
} from './library/bags.js';
