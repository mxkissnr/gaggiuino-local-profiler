import { S }                              from '../../state.js';
import { t }                              from '../../i18n.js';
import { apiFetch }                       from '../../api.js';
import { esc, germanToIso }              from '../../utils.js';
import { renderSidebar, updateSidebarHighlighting } from '../../components/sidebar.js';
import { calcBeanAgeAtShot, _roastDateFromLibrary } from './utils.js';
import { loadShotImageBlobUrl, invalidateShotImage } from '../../bean-image.js';
import { openImageCropEditor } from '../../components/image-crop.js';
import { openLightbox } from '../../components/lightbox.js';

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

export function scheduleAutoSave() {
  clearTimeout(_autoSaveTimer);
  _autoSaveTimer = setTimeout(async () => {
    if (!S.primaryShotId) return;
    const shot    = S.shots.find(s => s.id === S.primaryShotId);
    const coffee  = document.getElementById('annCoffee').value.trim();
    const payload = {
      rating:       S.currentRating || null,
      coffee,
      grinder:      document.getElementById('annGrinder').value.trim(),
      grindSetting: document.getElementById('annGrindSetting').value.trim(),
      dose:         parseFloat(document.getElementById('annDose').value) || null,
      roastDate:    germanToIso(_roastDateFromLibrary(coffee, shot?.timestamp) || '') || null,
      tds:          parseFloat(document.getElementById('annTds').value) || null,
      notes:        document.getElementById('annNotes').value.trim(),
      drinkType:    document.getElementById('annDrinkType')?.value || null,
      milkType:     document.getElementById('annMilkType')?.value ? parseInt(document.getElementById('annMilkType').value) : null,
      recipeId:     parseInt(document.getElementById('annRecipe')?.value) || null,
      beanAgeDays:  calcBeanAgeAtShot(coffee, shot?.timestamp) ?? null,
    };
    try {
      const r = await apiFetch(`api/shots/${S.primaryShotId}/annotate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      if (r.ok) {
        _maybeDeductMilk(shot, payload);
        const idx = S.shots.findIndex(s => s.id === S.primaryShotId);
        if (idx !== -1) S.shots[idx].annotation = payload;
        renderSidebar();
        updateSidebarHighlighting();
        const status = document.getElementById('autoSaveStatus');
        if (status) {
          status.textContent = '✓';
          status.classList.add('visible');
          clearTimeout(status._hideTimer);
          status._hideTimer = setTimeout(() => status.classList.remove('visible'), 1800);
        }
      }
    } catch { /* silent */ }
  }, 1000);
}

// ── Drink & milk pills ────────────────────────────────────────────────────

export async function loadDrinkMenu() {
  try {
    const r = await apiFetch('api/menu');
    if (r.ok) S.drinkMenu = await r.json();
  } catch { /* non-critical */ }
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

function _updateMilkFieldVisibility() {
  const field   = document.getElementById('milkTypeField');
  if (!field) return;
  const drinkId = document.getElementById('annDrinkType')?.value;
  field.style.display = (S.milkTypes?.length && drinkId) ? '' : 'none';
}

export function _renderBeanSelect(selectedName) {
  const select = document.getElementById('annCoffee');
  if (!select) return;
  const beans = S.coffeeLibrary?.beans || [];
  const names = beans.map(b => b.name);
  if (selectedName && !names.includes(selectedName)) names.push(selectedName);
  select.innerHTML = `<option value=""></option>` +
    names.map(n => `<option value="${esc(n)}"${n === selectedName ? ' selected' : ''}>${esc(n)}</option>`).join('');
}

export function _renderRecipeSelect(selectedId) {
  const field  = document.getElementById('recipeField');
  const select = document.getElementById('annRecipe');
  if (!field || !select) return;
  const recipes = S.coffeeLibrary?.recipes || [];
  if (!recipes.length) { field.style.display = 'none'; return; }
  field.style.display = '';
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
    const m = s.match(/^(\d{1,2})[.\-\/](\d{1,2})[.\-\/](\d{2,4})$/);
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
  const ann = shot.annotation || {};
  _renderShotPhoto(shot);
  S.currentRating = ann.rating || 0;
  renderStars(S.currentRating);
  _renderBeanSelect(ann.coffee || null);
  document.getElementById('annGrinder').value      = ann.grinder      || '';
  document.getElementById('annGrindSetting').value = ann.grindSetting || '';
  document.getElementById('annDose').value         = ann.dose         || '';
  updateDegassing(_roastDateFromLibrary(ann.coffee, shot?.timestamp) || '');
  document.getElementById('annTds').value          = ann.tds          || '';
  document.getElementById('annNotes').value        = ann.notes        || '';
  _renderDrinkPills(ann.drinkType || '');
  _renderMilkPills(ann.milkType ? String(ann.milkType) : '');
  _updateMilkFieldVisibility();
  _renderRecipeSelect(ann.recipeId || null);
  const btn = document.getElementById('saveAnnotationBtn');
  btn.textContent = t('btn_save');
  btn.classList.remove('saved');
  const badge = document.getElementById('orderedByBadge');
  if (badge) {
    const ob = ann.orderedBy;
    if (ob?.customer) {
      const drink = ob.item ? (ob.variant ? `${ob.item} · ${ob.variant}` : ob.item) : null;
      badge.textContent = `☕ ${ob.customer}${drink ? ` · ${drink}` : ''}${ob.note ? ` · ${ob.note}` : ''}`;
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
  const ann        = prev.annotation || {};
  const currentShot = S.shots.find(s => s.id === S.primaryShotId);
  _renderBeanSelect(ann.coffee || null);
  document.getElementById('annGrinder').value      = ann.grinder      || '';
  document.getElementById('annGrindSetting').value = ann.grindSetting || '';
  document.getElementById('annDose').value         = ann.dose         || '';
  updateDegassing(_roastDateFromLibrary(ann.coffee, currentShot?.timestamp) || '');
  _renderDrinkPills(ann.drinkType || '');
  _renderMilkPills('');
  _updateMilkFieldVisibility();
  _renderRecipeSelect(ann.recipeId || null);
}

export async function saveAnnotation() {
  if (!S.primaryShotId) return;
  const btn   = document.getElementById('saveAnnotationBtn');
  const shot  = S.shots.find(s => s.id === S.primaryShotId);
  const coffee = document.getElementById('annCoffee').value.trim();
  const payload = {
    rating:       S.currentRating || null,
    coffee,
    grinder:      document.getElementById('annGrinder').value.trim(),
    grindSetting: document.getElementById('annGrindSetting').value.trim(),
    dose:         parseFloat(document.getElementById('annDose').value) || null,
    roastDate:    germanToIso(_roastDateFromLibrary(coffee, shot?.timestamp) || '') || null,
    tds:          parseFloat(document.getElementById('annTds').value) || null,
    notes:        document.getElementById('annNotes').value.trim(),
    drinkType:    document.getElementById('annDrinkType')?.value || null,
    milkType:     document.getElementById('annMilkType')?.value ? parseInt(document.getElementById('annMilkType').value) : null,
    recipeId:     parseInt(document.getElementById('annRecipe')?.value) || null,
    beanAgeDays:  calcBeanAgeAtShot(coffee, shot?.timestamp) ?? null,
  };
  try {
    const r = await apiFetch(`api/shots/${S.primaryShotId}/annotate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    if (r.ok) {
      _maybeDeductMilk(shot, payload);
      const idx = S.shots.findIndex(s => s.id === S.primaryShotId);
      if (idx !== -1) S.shots[idx].annotation = payload;
      btn.textContent = t('btn_saved');
      btn.classList.add('saved');
      setTimeout(() => { btn.textContent = t('btn_save'); btn.classList.remove('saved'); }, 2000);
      renderSidebar();
      updateSidebarHighlighting();
    }
  } catch (e) { console.error('Annotation-Fehler:', e); }
}
