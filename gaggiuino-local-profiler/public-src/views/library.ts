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
import { attachSheetSwipe } from '../components/sheet-swipe.js';
import { renderShotDefaultsSettingsCard } from '../components/shot-defaults-settings.js';
import { CLOSE_ICON_SVG } from '../icons.js';
import { renderRecipeList } from './library/recipes.js';
import { renderMilkList } from './library/milk.js';
import { renderBasketList } from './library/baskets.js';
import { renderPuckScreenList } from './library/puck-screens.js';
import { renderGrinderList } from './library/grinders.js';
import { classifyBeanBags } from './library/bags.js';
import {
  classifyBeanShelf, renderShelfTile, renderShelfRow, shelfStock,
  matchesShelfQuery, matchesShelfFilter, sortShelf, loadShelfPrefs, saveShelfPrefs,
} from './library/shelf.js';
import type { ShelfFilter, ShelfPrefs, ShelfSort, ShelfView } from './library/shelf.js';
import { _beanList, _state, _field, _el } from './library/bean-shared.js';
import type { BeanListRow } from './library/bean-shared.js';
import { openNewBagForm } from './library/bean-card.js';
import { updateStickerButton, stagedBeanImage, clearStagedBeanImage } from './library/bean-sticker.js';
import { populateOriginSelect, bindOriginInput, setFormOrigins, populateSuggestionDatalists, bindFlavorInput, setFormFlavors, commitFlavorInput, formFlavors, formOrigins } from './library/bean-form-chips.js';
import {
  sheetBeanId, forgetSheetReturnFocus, renderBeanSheet, openBeanSheet, closeBeanSheet,
  _dropNewShelfTile, _overlayShieldsSheets, _trapTab,
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
  if (sheetBeanId() != null) { forgetSheetReturnFocus(); closeBeanSheet(); }
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
    forgetSheetReturnFocus();
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

// Section symbols moved to ./library/* — re-exported so existing importers
// of views/library.js (main.ts et al.) keep working.
export { openBeanSheet, closeBeanSheet, beanSheetRestoredScroll, toggleBeanActive } from './library/bean-sheet.js';
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
