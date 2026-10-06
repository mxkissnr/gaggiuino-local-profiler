import { S } from '../../state/index.js';
import { t } from '../../i18n.js';
import { html, toIsoDateInput } from '../../utils.js';
import { CLOSE_ICON_SVG } from '../../icons.js';
import { attachSheetSwipe, animateSheetOut, settleSheetOut, startSheetEnter } from '../../components/sheet-swipe.js';
import { classifyBeanBags } from './bags.js';
import type { BeanRow } from './bags.js';
import { _beanList, _state, _field, _el } from './bean-shared.js';
import type { BeanListRow } from './bean-shared.js';
import { populateOriginSelect, bindOriginInput, setFormOrigins, populateSuggestionDatalists, bindFlavorInput, setFormFlavors, commitFlavorInput, formFlavors, formOrigins } from './bean-form-chips.js';
import { updateStickerButton, clearStagedBeanImage, stagedBeanImage } from './bean-sticker.js';
import {
  sheetBeanId, forgetSheetReturnFocus, openBeanSheet, closeBeanSheet,
  _overlayShieldsSheets, _trapTab, _dropNewShelfTile,
} from './bean-sheet.js';
import * as libraryApi from '../../api/library.js';
import { invalidateBeanImage } from '../../bean-image.js';
import { renderRecipeList } from './recipes.js';
import { openNewBagForm } from './bean-card.js';
import * as libraryView from '../library.js';

// Circular with library.ts (it re-exports this module): only ever touched at
// call time, never read at module load.
const library = libraryView;

// ── Bean form sheet (#1349) ───────────────────────────────────────────────
// The bean form is static markup in index.html. Rather than re-template it,
// opening the form moves that same node into this sheet and closing moves it
// back, so every input value, id and listener survives untouched.
let _formSheetHost: HTMLElement | null = null;
let _formSheetBody: HTMLElement | null = null;
let _formSheetBackdrop: HTMLElement | null = null;
let _formSheetSection: HTMLElement | null = null;
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

  // #1488: one sheet-level listener covers the grab pill, the head and the
  // form content (while it is scrolled to the top).
  attachSheetSwipe(section, backdrop, requestCloseBeanForm);

  _formSheetHost = host;
  _formSheetBody = body;
  _formSheetBackdrop = backdrop;
  _formSheetSection = section;
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
  startSheetEnter(_formSheetSection, _formSheetBackdrop);
  _formReturnBeanId = S.beanEditId;
  _wireFormSheetKeys();
  _field('beanFormName').focus();
}

export function openBeanForm(bean?: BeanRow | null): void {
  // Finish a still-sliding close before painting, so its timer cannot wipe the
  // sheet we are about to open.
  settleSheetOut();
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

// Slides the form sheet out from wherever it is, then runs the sync close.
function _animateFormSheetOut(done: () => void): void {
  const section = _formSheetSection;
  if (!section) { done(); return; }
  animateSheetOut(section, _formSheetBackdrop, done);
}

// Dirty-aware close: a form with unsaved edits asks before discarding. A real
// close (X, backdrop, Esc, swipe, discard) slides the sheet out first.
export function requestCloseBeanForm(): void {
  if (_beanFormDirty) { _showFormConfirm(); return; }
  _animateFormSheetOut(closeBeanForm);
}

// Cancel / confirm-bar discard: an explicit "throw my edits away", no prompt.
export function discardBeanForm(): void {
  _beanFormDirty = false;
  _animateFormSheetOut(closeBeanForm);
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
  library.updateLibraryDatalist();
  closeBeanForm();
  library.renderBeanList();
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
  library.updateLibraryDatalist();
  library.renderBeanList();
}
