import { S } from '../../state/index.js';
import { t } from '../../i18n.js';
import { html, toIsoDateInput } from '../../utils.js';
import { CLOSE_ICON_SVG } from '../../icons.js';
import { attachSheetSwipe } from '../../components/sheet-swipe.js';
import { classifyBeanBags } from './bags.js';
import type { BeanRow } from './bags.js';
import { _beanList, _state, _field, _el } from './bean-shared.js';
import { populateOriginSelect, bindOriginInput, setFormOrigins, populateSuggestionDatalists, bindFlavorInput, setFormFlavors } from './bean-form-chips.js';
import { updateStickerButton, clearStagedBeanImage } from './bean-sticker.js';
import {
  sheetBeanId, forgetSheetReturnFocus, openBeanSheet, closeBeanSheet,
  _overlayShieldsSheets, _trapTab,
} from './bean-sheet.js';

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
