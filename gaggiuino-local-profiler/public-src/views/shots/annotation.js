import { S }                              from '../../state.js';
import { t }                              from '../../i18n.js';
import { apiFetch }                       from '../../api.js';
import { esc, germanToIso }              from '../../utils.js';
import { renderSidebar, updateSidebarHighlighting } from '../../components/sidebar.js';
import { calcBeanAgeAtShot, _roastDateFromLibrary } from './utils.js';
import { suggestGrindDoseForBean } from './grind.js';
import { loadShotImageBlobUrl, invalidateShotImage } from '../../bean-image.js';
import { openImageCropEditor } from '../../components/image-crop.js';
import { openLightbox } from '../../components/lightbox.js';
import { COFFEE_ICON_SVG, CHECK_ICON_SVG } from '../../icons.js';
import { localeFor } from '../../constants.js';
import { computeBeanRemaining } from '../../bean-math.js';

// ── Auto-save ─────────────────────────────────────────────────────────────

let _autoSaveTimer = null;

// Deducts milk stock for a newly-assigned (or changed) drink+milk combo.
// Gated on drinkType OR milkType actually changing vs. the previously saved
// annotation, not just milkType changing — otherwise re-assigning the same
// milk to a newly-picked drink (the common case, since most people always
// use the same milk) would never fire. Shared by both the debounced
// auto-save and the explicit Save button so neither path can silently skip
// the deduction the other one handles.
export function _maybeDeductMilk(shot, payload) {
  const prevMilkType  = shot?.annotation?.milkType ?? null;
  const prevDrinkType = shot?.annotation?.drinkType ?? null;
  if (!payload.milkType || !payload.drinkType) return;
  if (payload.milkType === prevMilkType && payload.drinkType === prevDrinkType) return;
  const menuItem = S.drinkMenu?.find(m => m.id === payload.drinkType);
  if (!(menuItem?.milkMl > 0)) return;
  apiFetch(`api/library/milk/${payload.milkType}/deduct`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ml: menuItem.milkMl }),
  }).then(r2 => {
    if (r2.ok) r2.json().then(updated => {
      if (S.milkTypes) {
        const mi = S.milkTypes.findIndex(m => m.id === updated.id);
        if (mi !== -1) S.milkTypes[mi] = updated;
      }
    });
  }).catch(() => {});
}

// Finds a frozen-portion entry by id across every bean/bag — portion ids are
// globally unique (generated from frozenAt), so no beanId is needed to
// locate one. Returns { bean, portion } or null.
function _findFrozenPortion(portionId) {
  for (const bean of S.coffeeLibrary?.beans || []) {
    for (const bag of bean.bags || []) {
      const portion = (bag.frozenPortions || []).find(p => p.id === portionId);
      if (portion) return { bean, portion };
    }
  }
  return null;
}

// #502: mirrors _maybeDeductMilk's shape exactly — compares the previous vs.
// new frozenPortionId so re-saving the same choice never double-counts, and
// switching choices (including back to "not frozen", i.e. null) correctly
// reverses the previous decrement. Uses the existing adjust-frozen-portion
// endpoint (absolute remainingCount) rather than a delta endpoint, computing
// the target value from the client's already-loaded S.coffeeLibrary state.
function _adjustFrozenPortionRemaining(portionId, delta) {
  const found = _findFrozenPortion(portionId);
  if (!found) return;
  const { bean, portion } = found;
  const current = Number.isFinite(portion.remainingCount) ? portion.remainingCount : portion.portionCount;
  const remainingCount = Math.min(Math.max(current + delta, 0), portion.portionCount);
  apiFetch(`api/library/bean/${bean.id}/adjust-frozen-portion`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ portionId, remainingCount }),
  }).then(r => r.ok ? r.json() : null).then(updated => {
    if (!updated) return;
    const idx = S.coffeeLibrary.beans.findIndex(b => b.id === bean.id);
    if (idx !== -1) S.coffeeLibrary.beans[idx] = updated;
  }).catch(() => {});
}

export function _maybeAdjustFrozenPortion(shot, payload) {
  const prevPortionId = shot?.annotation?.frozenPortionId ?? null;
  const newPortionId  = payload.frozenPortionId ?? null;
  if (prevPortionId === newPortionId) return;
  if (prevPortionId != null) _adjustFrozenPortionRemaining(prevPortionId, +1);
  if (newPortionId != null) _adjustFrozenPortionRemaining(newPortionId, -1);
}

// Reads every annotation field's current DOM value into the API payload
// shape — the single source of truth for both the debounced auto-save and
// its immediate flush, so neither path can silently build a different
// payload than the other (#430, was previously duplicated between
// scheduleAutoSave and the now-removed explicit saveAnnotation()).
function _buildAnnotationPayload(shot) {
  const coffeeSelect = document.getElementById('annCoffee');
  const coffee = coffeeSelect.value.trim();
  // #456: the select's chosen <option> carries data-bean-id (see
  // _renderBeanSelect) when the value matches a real library bean — null for
  // an empty selection or a stale name no longer in the library.
  const beanIdAttr = coffeeSelect.selectedOptions[0]?.dataset.beanId;
  const beanId = beanIdAttr ? parseInt(beanIdAttr, 10) : null;
  // #635: same data-attribute pattern as beanId above — real <select>s, ID-
  // based, no free-text/name matching involved.
  const basketSelect = document.getElementById('annBasket');
  const basketIdAttr = basketSelect?.selectedOptions[0]?.dataset.basketId;
  const basketId = basketIdAttr ? parseInt(basketIdAttr, 10) : null;
  const puckScreenSelect = document.getElementById('annPuckScreen');
  const puckScreenIdAttr = puckScreenSelect?.selectedOptions[0]?.dataset.puckscreenId;
  const puckScreenId = puckScreenIdAttr ? parseInt(puckScreenIdAttr, 10) : null;
  return {
    rating:       S.currentRating || null,
    coffee,
    beanId,
    basketId,
    puckScreenId,
    grinder:      document.getElementById('annGrinder').value.trim(),
    grindSetting: document.getElementById('annGrindSetting').value.trim(),
    dose:         parseFloat(document.getElementById('annDose').value) || null,
    roastDate:    germanToIso(_roastDateFromLibrary(coffee, shot?.timestamp, beanId) || '') || null,
    tds:          parseFloat(document.getElementById('annTds').value) || null,
    notes:        document.getElementById('annNotes').value.trim(),
    drinkType:    document.getElementById('annDrinkType')?.value || null,
    milkType:     document.getElementById('annMilkType')?.value ? parseInt(document.getElementById('annMilkType').value) : null,
    recipeId:     parseInt(document.getElementById('annRecipe')?.value) || null,
    beanAgeDays:  calcBeanAgeAtShot(coffee, shot?.timestamp, beanId) ?? null,
    frozenPortionId: parseInt(document.getElementById('annFrozenPortionId')?.value, 10) || null,
  };
}

// #430: #autoSaveStatus is now the only save feedback (the explicit Save
// button is gone) — it carries the full lifecycle: pending while a save is
// in flight, a confirmation on success, hidden otherwise. 'idle' explicitly
// hides it, used when a freshly-selected shot has no in-flight save of its
// own to report.
function _setAutoSaveStatus(state) {
  const status = document.getElementById('autoSaveStatus');
  if (!status) return;
  clearTimeout(status._hideTimer);
  if (state === 'pending') {
    status.textContent = t('autosave_pending');
    status.classList.add('visible');
  } else if (state === 'saved') {
    status.innerHTML = `${CHECK_ICON_SVG} ${esc(t('autosave_saved'))}`;
    status.classList.add('visible');
    status._hideTimer = setTimeout(() => status.classList.remove('visible'), 1800);
  } else {
    status.classList.remove('visible');
  }
}

async function _performAnnotationSave() {
  if (!S.primaryShotId) return;
  const id   = S.primaryShotId;
  const shot = S.shots.find(s => s.id === id);
  const payload = _buildAnnotationPayload(shot);
  try {
    const r = await apiFetch(`api/shots/${id}/annotate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    if (r.ok) {
      _maybeDeductMilk(shot, payload);
      _maybeAdjustFrozenPortion(shot, payload);
      const idx = S.shots.findIndex(s => s.id === id);
      if (idx !== -1) S.shots[idx].annotation = payload;
      renderSidebar();
      updateSidebarHighlighting();
      _setAutoSaveStatus('saved');
    } else {
      _setAutoSaveStatus('idle');
    }
  } catch { _setAutoSaveStatus('idle'); }
}

export function scheduleAutoSave() {
  clearTimeout(_autoSaveTimer);
  _setAutoSaveStatus('pending');
  _autoSaveTimer = setTimeout(() => { _autoSaveTimer = null; _performAnnotationSave(); }, 1000);
}

// Immediately runs a pending debounced save instead of waiting out the rest
// of its 1s delay — called on field blur, tab/page hide (visibilitychange)
// and mode-switch away from Shots (#430). Without this, editing a field and
// switching away inside that 1s window used to silently drop the edit; the
// removed explicit Save button was the only thing that had covered that gap
// before, so this flush takes over that responsibility explicitly rather
// than leaving it implicit in a button click.
export function flushAutoSave() {
  if (!_autoSaveTimer) return;
  clearTimeout(_autoSaveTimer);
  _autoSaveTimer = null;
  _performAnnotationSave();
}

// ── Drink & milk pills ────────────────────────────────────────────────────

export async function loadDrinkMenu() {
  try {
    const r = await apiFetch('api/menu');
    if (r.ok) S.drinkMenu = await r.json();
  } catch { /* non-critical */ }
}

// #654: optional per-install defaults auto-prefilled into a brand-new shot's
// annotation panel — loaded once at app init (main.js), same as
// loadDrinkMenu()/loadMilkTypes() above, and refreshed by
// components/shot-defaults-settings.js whenever the Settings card saves.
export async function loadShotDefaults() {
  try {
    const r = await apiFetch('api/shots/defaults');
    if (r.ok) S.shotDefaults = await r.json();
  } catch { /* non-critical */ }
}

// Merges the configured shot defaults into a shot's annotation, but only
// when that annotation is genuinely empty — i.e. this shot has never been
// annotated (see routes/shots.js: a synced-but-untouched shot's annotation
// is always {}). Any existing annotation, even a single field, is returned
// completely untouched: a configured default must never overwrite something
// the user already recorded. Applied fields stay fully editable afterward —
// this only changes what the form starts out showing.
export function _applyShotDefaults(ann) {
  if (ann && Object.keys(ann).length > 0) return ann;
  const d = S.shotDefaults;
  if (!d) return ann;
  return {
    drinkType:    d.drinkType    || null,
    coffee:       d.coffee       || null,
    beanId:       d.beanId       ?? null,
    basketId:     d.basketId     ?? null,
    puckScreenId: d.puckScreenId ?? null,
    grinder:      d.grinder      || '',
    dose:         d.dose         ?? null,
  };
}

export async function loadMilkTypes() {
  try {
    const r = await apiFetch('api/library/milks');
    if (r.ok) S.milkTypes = await r.json();
  } catch { /* non-critical */ }
}

export function _renderDrinkPills(selectedId) {
  const container = document.getElementById('drinkPillsContainer');
  const hidden    = document.getElementById('annDrinkType');
  if (!container) return;
  if (!S.drinkMenu?.length) { container.innerHTML = ''; return; }
  container.innerHTML = S.drinkMenu.map(m =>
    `<button type="button" class="drink-pill${selectedId === m.id ? ' active' : ''}"
      data-action="select-drink" data-id="${esc(m.id)}">${esc(m.emoji)} ${esc(m.name)}</button>`
  ).join('');
  if (hidden) hidden.value = selectedId || '';
}

export function selectDrinkType(id) {
  const hidden = document.getElementById('annDrinkType');
  if (!hidden) return;
  const newVal = hidden.value === id ? '' : id;
  _renderDrinkPills(newVal);
  _updateMilkFieldVisibility();
  scheduleAutoSave();
}

export function _renderMilkPills(selectedId) {
  const container = document.getElementById('milkPillsContainer');
  const hidden    = document.getElementById('annMilkType');
  if (!container) return;
  if (!S.milkTypes?.length) { container.innerHTML = ''; return; }
  container.innerHTML = S.milkTypes.map(m =>
    `<button type="button" class="drink-pill${selectedId === String(m.id) ? ' active' : ''}"
      data-action="select-milk" data-id="${esc(String(m.id))}">${esc(m.emoji || '🥛')} ${esc(m.name)}</button>`
  ).join('');
  if (hidden) hidden.value = selectedId || '';
}

export function selectMilkType(id) {
  const hidden = document.getElementById('annMilkType');
  if (!hidden) return;
  const newVal = hidden.value === id ? '' : id;
  _renderMilkPills(newVal);
  scheduleAutoSave();
}

// ── Frozen-portion pill (which pool of this bean's stock a shot used) ──────

// Bags/portions active as of a given shot's timestamp — mirrors the
// activeBag resolution in main.js's annCoffee change handler (openedAt <=
// shotMs, most recent first), so the frozen-portion choices reflect what
// was actually in the freezer at brew time, not just "now". Only portions
// with remaining stock are offered (a fully-thawed one has nothing left to
// pick).
function _activeFrozenPortionsForBean(bean, shotMs) {
  if (!bean) return [];
  const bags = Array.isArray(bean.bags) ? bean.bags : [];
  const activeBag = bags.filter(b => (b.openedAt || 0) <= shotMs).sort((a, b) => b.openedAt - a.openedAt)[0];
  const portions = Array.isArray(activeBag?.frozenPortions) ? activeBag.frozenPortions : [];
  return portions.filter(p => (Number.isFinite(p.remainingCount) ? p.remainingCount : p.portionCount) > 0);
}

// #502: an explicit "not frozen" pill is always offered alongside any active
// frozen batches — Max wants that to be a deliberate recorded choice, not
// just the absence of a selection. The whole field hides when the bean has
// no active frozen stock at all, since there'd be nothing to choose between.
export function _renderFrozenPortionPills(beanName, shotMs, selectedId) {
  const field     = document.getElementById('frozenPortionField');
  const container = document.getElementById('frozenPortionPillsContainer');
  const hidden    = document.getElementById('annFrozenPortionId');
  if (!field || !container || !hidden) return;
  const bean = beanName ? S.coffeeLibrary?.beans?.find(b => b.name === beanName) : null;
  const portions = _activeFrozenPortionsForBean(bean, shotMs ?? Date.now());
  if (!portions.length) { field.style.display = 'none'; container.innerHTML = ''; hidden.value = ''; return; }
  field.style.display = '';
  const locale = localeFor(S.currentLang);
  const selected = selectedId != null ? String(selectedId) : '';
  const options = [{ id: '', label: t('ann_frozen_portion_none') }, ...portions.map(p => {
    const dateStr    = new Date(p.frozenAt).toLocaleDateString(locale, { day: '2-digit', month: '2-digit', year: '2-digit' });
    const remaining  = Number.isFinite(p.remainingCount) ? p.remainingCount : p.portionCount;
    // #811: no glyph in the label -- this string is rendered as an <option>
    // text node in one place and as escaped markup in another, and an <option>
    // cannot carry an inline SVG. The frozen state is already carried by the
    // portion count and date, and by the icon on the badge itself.
    return { id: String(p.id), label: `${remaining}/${p.portionCount} · ${dateStr}` };
  })];
  container.innerHTML = options.map(o =>
    `<button type="button" class="drink-pill${selected === o.id ? ' active' : ''}" data-action="select-frozen-portion" data-id="${esc(o.id)}">${esc(o.label)}</button>`
  ).join('');
  hidden.value = selected;
}

export function selectFrozenPortion(id) {
  const hidden = document.getElementById('annFrozenPortionId');
  if (!hidden) return;
  const beanName = document.getElementById('annCoffee')?.value?.trim() || null;
  const shot     = S.primaryShotId ? S.shots.find(s => s.id === S.primaryShotId) : null;
  _renderFrozenPortionPills(beanName, shot ? shot.timestamp * 1000 : Date.now(), id || null);
  scheduleAutoSave();
}

function _updateMilkFieldVisibility() {
  const field   = document.getElementById('milkTypeField');
  if (!field) return;
  const drinkId = document.getElementById('annDrinkType')?.value;
  field.style.display = (S.milkTypes?.length && drinkId) ? '' : 'none';
}

// selectedBeanId, when given, takes priority over selectedName: id survives
// a bean rename, name does not. Without it (or when it no longer resolves
// in the current library — e.g. a deleted bean), falls back to matching by
// name, same as before this second parameter existed.
export function _renderBeanSelect(selectedName, selectedBeanId) {
  const select = document.getElementById('annCoffee');
  if (!select) return;
  const allBeans = S.coffeeLibrary?.beans || [];
  // #933 (was #915): exhausted (zero-stock) beans used to be dropped from
  // the candidate list entirely -- but that also blocked logging the very
  // last shot against a bean that's genuinely down to 0 g. They now stay
  // selectable, just sorted after every in-stock bean and labelled "Empty"
  // so the common case (picking an in-stock bean) still reads cleanly.
  // null means untracked/unlimited stock and always sorts as in-stock.
  // doseRows mirrors library.js's own adapter from S.shots' { annotation,
  // timestamp } shape.
  const doseRows = S.shots
    .filter(s => s.annotation?.coffee != null)
    .map(s => ({ coffee: s.annotation.coffee, beanId: s.annotation.beanId, dose: s.annotation.dose, timestamp: s.timestamp }));
  const inStock  = [];
  const exhausted = [];
  for (const b of allBeans) {
    const remaining = computeBeanRemaining(b, doseRows, allBeans);
    (remaining === null || remaining > 0 ? inStock : exhausted).push(b);
  }
  // #456: data-bean-id lets _buildAnnotationPayload read off the currently
  // selected bean's stable id — only real library beans get one; a stale
  // name kept around because it no longer matches any current bean does not.
  const options = [
    ...inStock.map(b => ({ name: b.name, id: b.id, empty: false })),
    ...exhausted.map(b => ({ name: b.name, id: b.id, empty: true })),
  ];
  // A stale/renamed selection (no longer matching any current bean by name)
  // still needs its own carve-out entry, same as before #933.
  if (selectedName && !options.some(o => o.name === selectedName)) {
    const stale = allBeans.find(b => b.name === selectedName);
    options.push({ name: selectedName, id: stale ? stale.id : null, empty: false });
  }
  const byId = selectedBeanId != null ? options.find(o => o.id === selectedBeanId) : null;
  const selected = byId ? byId.name : selectedName;
  // codeql[js/xss-through-dom] false positive: esc()/escapeHtml() already applied, see #760
  select.innerHTML = `<option value=""></option>` +
    options.map(o => `<option value="${esc(o.name)}"${o.id != null ? ` data-bean-id="${o.id}"` : ''}${o.name === selected ? ' selected' : ''}>${esc(o.name)}${o.empty ? ` (${t('lib_milk_empty')})` : ''}</option>`).join('');
}

// #635: baskets/puck screens are pure ID-based library selections (unlike
// beans, there's no free-text legacy value to preserve) — value and
// data-basket-id/data-puckscreen-id both carry the id, mirroring
// _renderBeanSelect's data-attribute pattern for _buildAnnotationPayload.
export function _renderBasketSelect(selectedId) {
  const select = document.getElementById('annBasket');
  if (!select) return;
  const baskets = S.coffeeLibrary?.baskets || [];
  // codeql[js/xss-through-dom] false positive: esc()/escapeHtml() already applied, see #760
  select.innerHTML = `<option value="">${t('ann_basket_none')}</option>` +
    baskets.map(b => `<option value="${b.id}" data-basket-id="${b.id}"${selectedId === b.id ? ' selected' : ''}>${esc(b.name)}</option>`).join('');
}

export function _renderPuckScreenSelect(selectedId) {
  const select = document.getElementById('annPuckScreen');
  if (!select) return;
  const puckScreens = S.coffeeLibrary?.puckScreens || [];
  // codeql[js/xss-through-dom] false positive: esc()/escapeHtml() already applied, see #760
  select.innerHTML = `<option value="">${t('ann_puckscreen_none')}</option>` +
    puckScreens.map(p => `<option value="${p.id}" data-puckscreen-id="${p.id}"${selectedId === p.id ? ' selected' : ''}>${esc(p.name)}</option>`).join('');
}

export function _renderRecipeSelect(selectedId) {
  const field  = document.getElementById('recipeField');
  const select = document.getElementById('annRecipe');
  if (!field || !select) return;
  const recipes = S.coffeeLibrary?.recipes || [];
  if (!recipes.length) { field.style.display = 'none'; return; }
  field.style.display = '';
  // codeql[js/xss-through-dom] false positive: esc()/escapeHtml() already applied, see #760
  select.innerHTML = `<option value="">${t('ann_recipe_none')}</option>` +
    recipes.map(r => `<option value="${r.id}"${r.id === selectedId ? ' selected' : ''}>${esc(r.name)}</option>`).join('');
}

// ── Annotation panel ──────────────────────────────────────────────────────

export function renderStars(rating) {
  document.querySelectorAll('#starRating .star').forEach(s => {
    s.classList.toggle('active', parseInt(s.dataset.val) <= rating);
  });
}

export function updateDegassing(val) {
  const tracker = document.getElementById('degassingTracker');
  const fill    = document.getElementById('degassingFill');
  const label   = document.getElementById('degassingLabel');
  const parseDMY = (s) => {
    if (!s) return null;
    const m = s.match(/^(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{2,4})$/);
    if (!m) return null;
    const y = m[3].length === 2 ? 2000 + parseInt(m[3]) : parseInt(m[3]);
    const d = new Date(y, parseInt(m[2]) - 1, parseInt(m[1]));
    return isNaN(d) ? null : d;
  };
  const date = parseDMY(val);
  if (!date) { tracker.style.display = 'none'; return; }
  const days = Math.floor((Date.now() - date.getTime()) / 86400000);
  if (days < 0 || days > 180) { tracker.style.display = 'none'; return; }
  tracker.style.display = 'block';
  const pct = Math.min(100, (days / 42) * 100);
  fill.style.width = pct + '%';
  let color, text;
  if      (days < 4)  { color = '#52525b'; text = t('degas_too_fresh', days); }
  else if (days < 7)  { color = '#eab308'; text = t('degas_almost',    days); }
  else if (days <= 21){ color = '#22c55e'; text = t('degas_optimal',   days); }
  else if (days <= 35){ color = '#f97316'; text = t('degas_aging',     days); }
  else                { color = '#ef4444'; text = t('degas_old',       days); }
  fill.style.background = color;
  label.style.color     = color;
  label.textContent     = text;
}

// ── Shot photo ────────────────────────────────────────────────────────────

function _renderShotPhoto(shot) {
  const thumb  = document.getElementById('annPhotoThumb');
  const remove = document.getElementById('annPhotoRemoveBtn');
  if (!thumb || !remove) return;
  if (shot.image) {
    thumb.style.display  = '';
    remove.style.display = '';
    thumb.setAttribute('data-clickable', '');
    loadShotImageBlobUrl(shot.id).then(url => { if (url) thumb.src = url; });
  } else {
    thumb.style.display  = 'none';
    thumb.removeAttribute('src');
    thumb.removeAttribute('data-clickable');
    remove.style.display = 'none';
  }
}

export function openShotPhotoLightbox() {
  const thumb = document.getElementById('annPhotoThumb');
  if (!thumb || !thumb.hasAttribute('data-clickable') || !thumb.src) return;
  openLightbox(thumb.src);
}

export async function uploadShotImage(input) {
  const file = input.files[0];
  if (!file || !S.primaryShotId) return;
  const id = S.primaryShotId;
  const blob = await openImageCropEditor(file, { shape: 'circle' });
  // eslint-disable-next-line require-atomic-updates -- `input` is a per-call function parameter (the DOM element passed in), not shared state
  input.value = '';
  if (!blob) return;
  const r = await apiFetch(`api/shots/${id}/image`, {
    method: 'POST', headers: { 'Content-Type': blob.type }, body: blob,
  });
  if (!r.ok) { alert(t('error_generic', (await r.json().catch(() => ({}))).error || r.statusText)); return; }
  const saved = await r.json();
  const idx = S.shots.findIndex(s => s.id === id);
  if (idx !== -1) S.shots[idx].image = saved.image;
  invalidateShotImage(id);
  _renderShotPhoto(saved);
  renderSidebar();
  updateSidebarHighlighting();
}

export async function removeShotImage() {
  if (!S.primaryShotId) return;
  const id = S.primaryShotId;
  const r = await apiFetch(`api/shots/${id}/image`, { method: 'DELETE' });
  if (!r.ok) return;
  const idx = S.shots.findIndex(s => s.id === id);
  if (idx !== -1) delete S.shots[idx].image;
  invalidateShotImage(id);
  _renderShotPhoto({ id, image: null });
  renderSidebar();
  updateSidebarHighlighting();
}

export function renderAnnotationPanel(shot) {
  const ann = _applyShotDefaults(shot.annotation || {});
  _renderShotPhoto(shot);
  S.currentRating = ann.rating || 0;
  renderStars(S.currentRating);
  _renderBeanSelect(ann.coffee || null, ann.beanId ?? null);
  _renderBasketSelect(ann.basketId ?? null);
  _renderPuckScreenSelect(ann.puckScreenId ?? null);
  _renderFrozenPortionPills(ann.coffee || null, shot?.timestamp ? shot.timestamp * 1000 : Date.now(), ann.frozenPortionId ?? null);
  document.getElementById('annGrinder').value      = ann.grinder      || '';
  document.getElementById('annGrindSetting').value = ann.grindSetting || '';
  document.getElementById('annDose').value         = ann.dose         || '';
  updateDegassing(_roastDateFromLibrary(ann.coffee, shot?.timestamp, ann.beanId) || '');
  document.getElementById('annTds').value          = ann.tds          || '';
  document.getElementById('annNotes').value        = ann.notes        || '';
  _renderDrinkPills(ann.drinkType || '');
  _renderMilkPills(ann.milkType ? String(ann.milkType) : '');
  _updateMilkFieldVisibility();
  _renderRecipeSelect(ann.recipeId || null);
  _setAutoSaveStatus('idle'); // #430: clear any leftover status from the previously viewed shot
  const badge = document.getElementById('orderedByBadge');
  if (badge) {
    const ob = ann.orderedBy;
    if (ob?.customer) {
      const drink = ob.item ? (ob.variant ? `${ob.item} · ${ob.variant}` : ob.item) : null;
      badge.innerHTML = `${COFFEE_ICON_SVG} ${esc(ob.customer)}${drink ? ` · ${esc(drink)}` : ''}${ob.note ? ` · ${esc(ob.note)}` : ''}`;
      badge.style.display = '';
    } else {
      badge.style.display = 'none';
    }
  }
}

export function quickClone() {
  if (!S.primaryShotId) return;
  const prev = S.shots.filter(s => s.id < S.primaryShotId).sort((a, b) => b.id - a.id)[0];
  if (!prev) return;
  const ann         = prev.annotation || {};
  const currentShot = S.shots.find(s => s.id === S.primaryShotId);
  // Prefer the currently-viewed shot's own bean when it already has one
  // annotated — only fall back to the previous shot's bean otherwise (#389).
  const currentAnn   = currentShot?.annotation || {};
  const useCurrentAnn = !!currentAnn.coffee;
  const beanName      = currentAnn.coffee || ann.coffee || null;
  // #456: beanId mirrors the same currentAnn/ann precedence as beanName.
  // Passed into _renderBeanSelect() below so it matches by id against the
  // CURRENT library (handles a bean renamed since either annotation was
  // saved), and passed through explicitly too for the grind/degassing
  // lookups that run before the DOM has been re-rendered with the new
  // selection.
  const beanId = useCurrentAnn ? (currentAnn.beanId ?? null) : (ann.beanId ?? null);
  _renderBeanSelect(beanName, beanId);
  // Grinder/grind setting/dose come from this bean's own history, not
  // blindly from prev — prev may have used a different bean entirely.
  // "↩ Letzten" means the grind last used for this bean, so prefer the
  // bean's most recently annotated shot over the best-scoring combo here.
  const suggested = beanName
    ? suggestGrindDoseForBean(beanName, S.coffeeLibrary, S.shots, { preferMostRecent: true, beanId })
    : { grinder: '', grindSetting: '', dose: '' };
  document.getElementById('annGrinder').value      = suggested.grinder      || ann.grinder      || '';
  document.getElementById('annGrindSetting').value = suggested.grindSetting || ann.grindSetting || '';
  document.getElementById('annDose').value         = suggested.dose         || ann.dose         || '';
  updateDegassing(_roastDateFromLibrary(beanName, currentShot?.timestamp, beanId) || '');
  // Basket/puck screen are equipment, not per-shot state — carried over from
  // the previous shot like the grinder above, rather than reset like the
  // frozen-portion choice below.
  _renderBasketSelect(ann.basketId ?? null);
  _renderPuckScreenSelect(ann.puckScreenId ?? null);
  _renderDrinkPills(ann.drinkType || '');
  _renderMilkPills('');
  _updateMilkFieldVisibility();
  _renderRecipeSelect(ann.recipeId || null);
  // Frozen-portion choice is per-shot, not carried over from prev — a clone
  // starts unset (like milk above), even if prev used a frozen portion.
  _renderFrozenPortionPills(beanName, currentShot?.timestamp ? currentShot.timestamp * 1000 : Date.now(), null);
  // #430: quickClone sets field values programmatically (no 'input' event
  // fires), so it must schedule the save itself — there's no explicit Save
  // button left to catch this otherwise.
  scheduleAutoSave();
}
