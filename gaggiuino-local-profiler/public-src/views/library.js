import { S } from '../state.js';
import { t } from '../i18n.js';
import { apiFetch } from '../api.js';
import { esc, roastAgeDays, freshnessState, calcBeanRating, shouldShowFreshBadge } from '../utils.js';
import { COFFEE_COUNTRIES, VARIETY_SUGGESTIONS, PROCESS_SUGGESTIONS, countryName, flagEmoji } from '../constants.js';
import { loadBeanImageBlobUrl, loadGrinderImageBlobUrl, invalidateGrinderImage, invalidateBeanImage } from '../bean-image.js';
import { openImageCropEditor } from '../components/image-crop.js';
import { generateBeanQR, parseGlpQrParams } from '../glp-qr.js';
import { calcBestGrindCombosForBean } from './shots/grind.js';

const ICON_PENCIL = `<svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15" aria-hidden="true"><path d="M20.71,7.04C21.1,6.65 21.1,6 20.71,5.63L18.37,3.29C18,2.9 17.35,2.9 16.96,3.29L15.12,5.12L18.87,8.87M3,17.25V21H6.75L17.81,9.93L14.06,6.18L3,17.25Z"/></svg>`;
const ICON_TRASH  = `<svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15" aria-hidden="true"><path d="M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19M8,9H10V19H8V9M14,9H16V19H14V9M15.5,4L14.5,3H9.5L8.5,4H5V6H19V4H15.5Z"/></svg>`;
const ICON_EYE     = `<svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15" aria-hidden="true"><path d="M12,9A3,3 0 0,0 9,12A3,3 0 0,0 12,15A3,3 0 0,0 15,12A3,3 0 0,0 12,9M12,17A5,5 0 0,1 7,12A5,5 0 0,1 12,7A5,5 0 0,1 17,12A5,5 0 0,1 12,17M12,4.5C7,4.5 2.73,7.61 1,12C2.73,16.39 7,19.5 12,19.5C17,19.5 21.27,16.39 23,12C21.27,7.61 17,4.5 12,4.5Z"/></svg>`;
const ICON_EYE_OFF = `<svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15" aria-hidden="true"><path d="M11.83,9L15,12.16C15,12.11 15,12.05 15,12A3,3 0 0,0 12,9C11.94,9 11.89,9 11.83,9M7.53,9.8L9.08,11.35C9.03,11.56 9,11.77 9,12A3,3 0 0,0 12,15C12.22,15 12.44,14.97 12.65,14.92L14.2,16.47C13.53,16.8 12.79,17 12,17A5,5 0 0,1 7,12C7,11.21 7.2,10.47 7.53,9.8M2,4.27L4.28,6.55L4.73,7C3.08,8.3 1.78,10 1,12C2.73,16.39 7,19.5 12,19.5C13.55,19.5 15.03,19.2 16.38,18.66L16.81,19.08L19.73,22L21,20.73L3.27,3M12,7A5,5 0 0,1 17,12C17,12.64 16.87,13.26 16.64,13.82L19.57,16.75C21.07,15.5 22.27,13.86 23,12C21.27,7.61 17,4.5 12,4.5C10.6,4.5 9.26,4.75 8,5.2L10.17,7.35C10.74,7.13 11.35,7 12,7Z"/></svg>`;

// Bean origin display — beans predating the blend feature (or ones without an
// origins[] array yet) fall back to the legacy singular `origin` field.
function originDisplay(bean) {
  const origins = Array.isArray(bean.origins) && bean.origins.length
    ? bean.origins
    : (bean.origin ? [{ code: bean.origin }] : []);
  return origins.map(o => {
    const label = `${flagEmoji(o.code)} ${countryName(o.code, S.currentLang)}`.trim();
    return o.percent != null ? `${label} ${o.percent}%` : label;
  }).join(' + ');
}

// ── Library load ──────────────────────────────────────────────────────────
export async function loadLibrary() {
  try {
    const r = await apiFetch('api/library');
    if (!r.ok) return;
    S.coffeeLibrary = await r.json();
    if (!S.coffeeLibrary.recipes) S.coffeeLibrary.recipes = [];
    if (!S.coffeeLibrary.milks)   S.coffeeLibrary.milks   = [];
    updateLibraryDatalist();
    renderRecipeList();
    renderMilkList();
  } catch (e) {}
}

export function updateLibraryDatalist() {
  const beanDL    = document.getElementById('beanList');
  const grinderDL = document.getElementById('grinderList');
  if (beanDL)    beanDL.innerHTML    = S.coffeeLibrary.beans.map(b => `<option value="${esc(b.name)}">`).join('');
  if (grinderDL) grinderDL.innerHTML = S.coffeeLibrary.grinders.map(g => `<option value="${esc(g.name)}">`).join('');
}

export function switchLibTab(tab) {
  document.getElementById('libTabBeans').classList.toggle('active',       tab === 'beans');
  document.getElementById('libTabGrinders').classList.toggle('active',    tab === 'grinders');
  document.getElementById('libTabRecipes').classList.toggle('active',     tab === 'recipes');
  document.getElementById('libTabMilk')?.classList.toggle('active',      tab === 'milk');
  document.getElementById('libTabProfiles')?.classList.toggle('active',  tab === 'profiles');
  document.getElementById('libSectionBeans').classList.toggle('active',   tab === 'beans');
  document.getElementById('libSectionGrinders').classList.toggle('active', tab === 'grinders');
  document.getElementById('libSectionRecipes').classList.toggle('active', tab === 'recipes');
  document.getElementById('libSectionMilk')?.classList.toggle('active',  tab === 'milk');
  document.getElementById('libSectionProfiles')?.classList.toggle('active', tab === 'profiles');
}

// ── Bean list ─────────────────────────────────────────────────────────────
export function renderBeanList() {
  const el = document.getElementById('beanListUI');
  if (!el) return;
  // Beans are a shared consumable, not scoped to the active machine — always
  // render the full library regardless of S.activeMachineId. This reverts
  // the display-filtering part of #334; see #339 for why that filter was
  // wrong (it hid nearly the whole library once a second machine existed).
  const beans = S.coffeeLibrary.beans;
  if (!beans.length) {
    el.innerHTML = `<div class="lib-empty">${t('lib_empty_beans')}</div>`;
    return;
  }
  el.innerHTML = beans.map(b => {
    // Total consumption across all bags (all shots matching bean name)
    const totalConsumed = Math.round(S.shots.reduce((sum, s) => {
      const d = parseFloat(s.annotation?.dose);
      return (s.annotation?.coffee || '').toLowerCase() === b.name.toLowerCase() && d ? sum + d : sum;
    }, 0));

    // Current bag consumption (shots since last bag openedAt)
    const bags = Array.isArray(b.bags) ? b.bags : [];
    const activeBag = bags.length ? bags[bags.length - 1] : null;
    const activeBagConsumed = activeBag ? Math.round(S.shots.reduce((sum, s) => {
      const d = parseFloat(s.annotation?.dose);
      const match = (s.annotation?.coffee || '').toLowerCase() === b.name.toLowerCase();
      const afterOpen = s.timestamp * 1000 >= (activeBag.openedAt || 0);
      return (match && d && afterOpen) ? sum + d : sum;
    }, 0)) : totalConsumed;

    const remaining = b.stock_g ? Math.round(b.stock_g - activeBagConsumed) : null;
    let invHtml = '';
    if (b.stock_g) {
      const isLow = remaining < 100;
      const editingStock = S._beanStockEditId === b.id;
      // #404: small proportional bar next to the gram figure — purely
      // supplementary, the exact gram number (lib-inv-remaining text) is
      // unchanged and stays the source of truth.
      const stockPct = Math.max(0, Math.min(100, Math.round((remaining / b.stock_g) * 100)));
      const stockBar = `<span class="lib-stock-bar" title="${stockPct}%"><span class="lib-stock-bar-fill${isLow ? ' low' : ''}" style="width:${stockPct}%"></span></span>`;
      invHtml = `<div class="lib-inv-stats">
        <span>${t('lib_inv_consumed', activeBagConsumed)}</span>
        <span class="lib-inv-remaining${isLow ? ' low' : ''}">${t('lib_inv_remaining', remaining)}</span>${stockBar}
        ${isLow ? `<span class="lib-inv-reorder">${t('lib_inv_reorder')}</span>` : ''}
        ${bags.length > 1 ? `<span class="lib-inv-total">${t('lib_inv_total_consumed', totalConsumed)} · ${t('lib_inv_bags', bags.length)}</span>` : ''}
        ${editingStock
          ? `<div class="lib-stock-edit-row">
               <input type="number" class="lib-new-bag-input" id="stockEditInput${b.id}" value="${b.stock_g}" min="0" step="1" placeholder="${t('lib_bag_stock')}">
               <button class="lib-save-btn" data-action="save-stock-edit" data-id="${b.id}">${t('lib_save')}</button>
               <button class="lib-btn-sm" data-action="close-stock-edit" data-id="${b.id}">${t('lib_cancel')}</button>
             </div>`
          : `<button class="lib-btn-sm lib-stock-edit-btn" data-action="open-stock-edit" data-id="${b.id}" title="${t('lib_stock_edit_btn')}">${t('lib_stock_edit_btn')}</button>`
        }
      </div>`;
    } else if (totalConsumed > 0) {
      invHtml = `<div class="lib-inv-stats">
        <span>${t('lib_inv_total_consumed', totalConsumed)}</span>
        ${bags.length > 1 ? `<span>${t('lib_inv_bags', bags.length)}</span>` : ''}
      </div>`;
    }

    // Bag history (collapsed)
    const bagHistoryHtml = bags.length > 1 ? `
      <div class="lib-bag-history" id="bagHistory${b.id}" style="display:none">
        <div class="lib-bag-history-title">${t('lib_bag_history')}</div>
        ${bags.slice().reverse().map((bg, i) => `
          <div class="lib-bag-row${i === 0 ? ' active' : ''}">
            <span>${bg.roastDate || '–'}</span>
            <span>${bg.stock_g ? bg.stock_g + ' g' : '–'}</span>
            <span>${bg.batchNumber ? esc(bg.batchNumber) : '–'}</span>
            <button class="lib-bag-del" data-action="delete-bag" data-bean-id="${b.id}" data-bag-id="${bg.id}" title="${t('lib_bag_delete')}">✕</button>
          </div>`).join('')}
      </div>
      <button class="lib-btn-sm lib-bag-history-btn" data-action="toggle-bag-history" data-id="${b.id}" id="bagHistoryBtn${b.id}">▸ ${t('lib_bag_history')}</button>` : '';

    const roastAge = roastAgeDays(activeBag?.roastDate || b.roastDate);
    const freshBadge = (roastAge != null && shouldShowFreshBadge(b.stock_g, remaining))
      ? ` <span class="lib-fresh-badge fresh-${freshnessState(roastAge)}" title="${esc(t('freshness_title', roastAge))}">${roastAge}d</span>`
      : '';

    const rating = calcBeanRating(b.name, S.shots);
    const ratingHtml = rating ? `<div class="lib-rating-row" title="${esc(t('bean_rating_tooltip', rating.count))}">
      ${Array.from({ length: 5 }, (_, i) => `<span class="lib-star${i < Math.round(rating.avg) ? ' on' : ''}">★</span>`).join('')}
      <span class="lib-rating-num">${rating.avg.toFixed(1)}</span>
    </div>` : '';

    // Only the single best combo is shown — with several grinders/grind
    // settings tested per bean this can get noisy fast, and "the one thing
    // to try next" is more useful at a glance than a ranked list.
    const bestCombos = calcBestGrindCombosForBean(b.name, S.shots);
    const bestComboHtml = bestCombos ? `<div class="lib-best-combo-row" title="${esc(t('bean_best_combo_tooltip', bestCombos[0].shotCount))}">
      <span class="lib-best-combo-label">${t('bean_best_combo_label')}</span>
      <span class="lib-best-combo-value">${esc(t('bean_best_combo_value', bestCombos[0].grinder, bestCombos[0].grindSetting))}</span>
      <span class="lib-best-combo-score">${t('bean_best_combo_score', bestCombos[0].avgScore)}</span>
    </div>` : '';

    const extraParts = [
      b.altitude_m ? t('bean_altitude_display', b.altitude_m) : '',
      b.producer, b.importer ? t('bean_importer_display', b.importer) : '',
      b.harvest ? t('bean_harvest_display', b.harvest) : '',
      b.certification, b.price_eur ? `${b.price_eur.toFixed(2)} €` : '',
      activeBag?.batchNumber ? t('bag_batch_number_display', activeBag.batchNumber) : '',
    ].filter(Boolean);
    const extraHtml = extraParts.length
      ? `<div class="lib-item-sub lib-item-extra">${extraParts.map(esc).join(' · ')}</div>` : '';

    const brewParts = [
      b.brewTempC ? t('bean_brew_temp_display', b.brewTempC) : '',
      b.brewRatio,
      b.brewTimeS ? t('bean_brew_time_display', b.brewTimeS) : '',
    ].filter(Boolean);
    const brewHtml = brewParts.length || b.brewNotes
      ? `<div class="lib-item-sub lib-item-brew">☕ ${[...brewParts, b.brewNotes].filter(Boolean).map(esc).join(' · ')}</div>`
      : '';

    const disabled = b.enabled === false;
    // #404: origin moves out of the generic lib-item-sub line into its own
    // small eyebrow above the (now serif) bean name.
    const origin = originDisplay(b);
    const originEyebrow = origin ? `<div class="lib-item-origin-eyebrow">${esc(origin)}</div>` : '';
    return `<div class="lib-item${disabled ? ' lib-item-disabled' : ''}">
      ${b.image ? `<img class="lib-bean-thumb" data-bean-id="${b.id}" alt="">` : ''}
      <div class="lib-item-info">
        ${originEyebrow}
        <div class="lib-item-name"><span class="serif-display">${esc(b.name)}</span>${freshBadge}${b.roastType ? ` <span class="lib-roast-badge">${esc(t('roast_type_' + b.roastType))}</span>` : ''}${b.decaf ? ` <span class="lib-decaf-badge">DECAF</span>` : ''}${disabled ? ` <span class="lib-disabled-badge">${t('lib_bean_disabled_badge')}</span>` : ''}</div>
        <div class="lib-item-sub">${[
          b.region, b.species, b.variety, b.process, b.roaster, b.roastDate, b.notes,
        ].filter(Boolean).map(esc).join(' · ')}</div>
        ${extraHtml}
        ${brewHtml}
        ${ratingHtml}
        ${bestComboHtml}
        ${Array.isArray(b.flavors) && b.flavors.length ? `<div class="lib-flavor-row">${b.flavors.map(f => `<span class="flavor-chip flavor-chip-static">${esc(f)}</span>`).join('')}</div>` : ''}
        ${invHtml}
        ${bagHistoryHtml}
        ${b.source ? `<div class="lib-item-source">${t('lib_imported_from',
          b.sourceUrl ? `<a href="${esc(b.sourceUrl)}" target="_blank" rel="noopener">${esc(b.source)}</a>` : esc(b.source),
          esc(b.importedAt || ''))}</div>` : ''}
      </div>
      <div class="lib-item-actions">
        <button class="lib-btn-sm" data-action="open-new-bag" data-id="${b.id}" title="${t('lib_new_bag')}">${t('lib_new_bag')}</button>
        ${Array.isArray(b.flavors) && b.flavors.length ? `<button class="lib-btn-sm" data-action="open-flavor-wheel" data-id="${b.id}" title="${t('flavor_wheel_btn')}">🎡</button>` : ''}
        <button class="lib-btn-sm" data-action="create-profile-from-bean" data-id="${b.id}" title="${t('profile_create_from_bean')}">🎛</button>
        <button class="lib-btn-sm" data-action="start-dialin-from-bean" data-id="${b.id}" title="${t('dialin_wizard_start_from_bean')}">🎯</button>
        <button class="lib-btn-sm" data-action="toggle-bean-qr" data-id="${b.id}" title="${t('bean_qr_label')}">QR</button>
        <button class="lib-btn-sm lib-btn-icon" data-action="toggle-bean-active" data-id="${b.id}" title="${t(disabled ? 'lib_btn_enable' : 'lib_btn_disable')}">${disabled ? ICON_EYE_OFF : ICON_EYE}</button>
        <button class="lib-btn-sm lib-btn-icon" data-action="edit-bean" data-id="${b.id}" title="${t('lib_btn_edit')}">${ICON_PENCIL}</button>
        <button class="lib-btn-sm del lib-btn-icon" data-action="delete-bean" data-id="${b.id}" title="${t('lib_btn_delete')}">${ICON_TRASH}</button>
      </div>
      <div id="newBagForm${b.id}" class="lib-new-bag-form" style="display:none">
        <div class="lib-new-bag-fields">
          <input type="text" class="lib-new-bag-input" id="newBagRoastDate${b.id}" placeholder="${t('lib_bag_roast_date')} (TT.MM.JJJJ)">
          <input type="number" class="lib-new-bag-input" id="newBagStock${b.id}" placeholder="${t('lib_bag_stock')}" min="0" step="1">
          <input type="text" class="lib-new-bag-input" id="newBagBatchNumber${b.id}" placeholder="${t('lib_bag_batch_number')}" maxlength="50">
        </div>
        <div class="lib-form-actions">
          <button class="lib-btn-sm" data-action="close-new-bag" data-id="${b.id}">${t('lib_cancel')}</button>
          <button class="lib-save-btn" data-action="save-new-bag" data-id="${b.id}">${t('lib_new_bag_save')}</button>
        </div>
      </div>
      <div class="bean-qr-wrap" id="beanQR${b.id}" style="display:none">
        <canvas id="beanQRCanvas${b.id}"></canvas>
        <span class="bean-qr-label">${t('bean_qr_label')}</span>
      </div>
    </div>`;
  }).join('');

  loadBeanThumbnails();
}

// Bean images need the auth token, so <img src> can't point at the API
// directly (see bean-image.js) — set the blob-url src async after render.
function loadBeanThumbnails() {
  document.querySelectorAll('.lib-bean-thumb[data-bean-id]').forEach(img => {
    const id = Number(img.dataset.beanId);
    loadBeanImageBlobUrl(id).then(url => { if (url) img.src = url; });
  });
}

export function toggleBagHistory(id) {
  const wrap = document.getElementById(`bagHistory${id}`);
  const btn  = document.getElementById(`bagHistoryBtn${id}`);
  if (!wrap) return;
  const open = wrap.style.display === 'none';
  wrap.style.display = open ? '' : 'none';
  if (btn) btn.textContent = (open ? '▾ ' : '▸ ') + t('lib_bag_history');
}

export function openNewBagForm(id) {
  document.getElementById(`newBagForm${id}`).style.display = '';
}

export function closeNewBagForm(id) {
  document.getElementById(`newBagForm${id}`).style.display = 'none';
}

export async function deleteBag(beanId, bagId) {
  if (!confirm(t('lib_bag_delete') + '?')) return;
  const r = await apiFetch(`api/library/bean/${beanId}/bag/${bagId}`, { method: 'DELETE' });
  if (!r.ok) return;
  const saved = await r.json();
  const idx = S.coffeeLibrary.beans.findIndex(b => b.id === beanId);
  if (idx !== -1) S.coffeeLibrary.beans[idx] = saved;
  renderBeanList();
}

export async function saveNewBag(id) {
  const roastDate   = document.getElementById(`newBagRoastDate${id}`)?.value.trim() || '';
  const stock_g     = parseFloat(document.getElementById(`newBagStock${id}`)?.value) || null;
  const batchNumber = document.getElementById(`newBagBatchNumber${id}`)?.value.trim() || '';
  const r = await apiFetch(`api/library/bean/${id}/new-bag`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ roastDate, stock_g, batchNumber }),
  });
  if (!r.ok) return;
  const saved = await r.json();
  const idx = S.coffeeLibrary.beans.findIndex(b => b.id === id);
  if (idx !== -1) S.coffeeLibrary.beans[idx] = saved;
  renderBeanList();
}

export function openBeanStockEdit(id) {
  S._beanStockEditId = id;
  renderBeanList();
}

export function closeBeanStockEdit() {
  S._beanStockEditId = null;
  renderBeanList();
}

export async function saveBeanStock(id) {
  const val = parseFloat(document.getElementById(`stockEditInput${id}`)?.value);
  if (isNaN(val) || val < 0) return;
  const r = await apiFetch(`api/library/bean/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ stock_g: val }),
  });
  if (!r.ok) return;
  const saved = await r.json();
  const idx = S.coffeeLibrary.beans.findIndex(b => b.id === id);
  if (idx !== -1) S.coffeeLibrary.beans[idx] = saved;
  S._beanStockEditId = null;
  renderBeanList();
}

export function toggleBeanQR(id) {
  const wrap = document.getElementById(`beanQR${id}`);
  if (!wrap) return;
  if (wrap.style.display !== 'none') { wrap.style.display = 'none'; return; }
  const bean = S.coffeeLibrary.beans.find(b => b.id === id);
  if (!bean) return;
  wrap.style.display = 'flex';
  const canvas = document.getElementById(`beanQRCanvas${id}`);
  // toCanvas() with no callback returns a Promise — without this .catch(),
  // a rejection (e.g. QR data-capacity exceeded by a long notes field) was
  // an unhandled rejection: the canvas stayed silently blank, no error ever
  // reached the user.
  QRCode.toCanvas(canvas, generateBeanQR(bean), { width: 140, margin: 1, errorCorrectionLevel: 'L', color: { dark: '#e4e4e7', light: '#18181b' } })
    .catch(() => {
      wrap.style.display = 'none';
      alert(t('bean_qr_error'));
    });
}

// ── Grinder list ──────────────────────────────────────────────────────────
export function renderGrinderList() {
  const el = document.getElementById('grinderListUI');
  if (!el) return;
  // Grinders are shared equipment, not scoped to the active machine — always
  // render the full library regardless of S.activeMachineId. This reverts
  // the display-filtering part of #334; see #339 for why that filter was
  // wrong (it hid nearly the whole library once a second machine existed).
  const grinders = S.coffeeLibrary.grinders;
  if (!grinders.length) {
    el.innerHTML = `<div class="lib-empty">${t('lib_empty_grinders')}</div>`;
    return;
  }
  el.innerHTML = grinders.map(g => {
    const extra = [g.burrType, g.purchaseDate].filter(Boolean).join(' · ');
    return `
    <div class="lib-item">
      ${g.image ? `<img class="lib-grinder-thumb" data-grinder-id="${g.id}" alt="">` : ''}
      <div class="lib-item-info">
        <div class="lib-item-name">${esc(g.name)}</div>
        ${extra ? `<div class="lib-item-sub lib-item-extra">${esc(extra)}</div>` : ''}
        ${g.notes ? `<div class="lib-item-sub">${esc(g.notes)}</div>` : ''}
        ${g.wear ? `<div class="lib-item-sub lib-grinder-wear">
          <span>${t('lib_grinder_wear', g.wear.shotsSinceBurrs, formatWearGrams(g.wear.gramsSinceBurrs))}</span>
          <button class="lib-btn-sm lib-grinder-reset-burrs" data-action="reset-grinder-burrs" data-id="${g.id}">${t('lib_grinder_reset_burrs')}</button>
        </div>` : ''}
      </div>
      <div class="lib-item-actions">
        <button class="lib-btn-sm lib-btn-icon" data-action="edit-grinder" data-id="${g.id}" title="${t('lib_btn_edit')}">${ICON_PENCIL}</button>
        <button class="lib-btn-sm del lib-btn-icon" data-action="delete-grinder" data-id="${g.id}" title="${t('lib_btn_delete')}">${ICON_TRASH}</button>
      </div>
    </div>`;
  }).join('');
  loadGrinderThumbnails();
}

// Mirrors the g/kg formatting used by the analytics "Total Coffee" tile.
function formatWearGrams(g) {
  return g >= 1000 ? (g / 1000).toFixed(1) + ' kg' : Math.round(g) + ' g';
}

// Grinder images need the auth token, so <img src> can't point at the API
// directly (see bean-image.js) — set the blob-url src async after render.
function loadGrinderThumbnails() {
  document.querySelectorAll('.lib-grinder-thumb[data-grinder-id]').forEach(img => {
    const id = Number(img.dataset.grinderId);
    loadGrinderImageBlobUrl(id).then(url => { if (url) img.src = url; });
  });
}

// ── Flavor chips input ────────────────────────────────────────────────────
// Module-level working array; rendered into #beanFormFlavorChips before the
// text input. Enter/comma commits the typed value, × removes a chip.
let _formFlavors = [];
let _flavorInputBound = false;

function renderFlavorChips() {
  const wrap = document.getElementById('beanFormFlavorChips');
  if (!wrap) return;
  wrap.querySelectorAll('.flavor-chip').forEach(el => el.remove());
  const input = document.getElementById('beanFormFlavorInput');
  for (const [i, f] of _formFlavors.entries()) {
    const chip = document.createElement('span');
    chip.className = 'flavor-chip';
    chip.innerHTML = `${esc(f)} <button type="button" class="flavor-chip-x" data-flavor-idx="${i}">✕</button>`;
    wrap.insertBefore(chip, input);
  }
}

function commitFlavorInput() {
  const input = document.getElementById('beanFormFlavorInput');
  if (!input) return;
  const val = input.value.trim().replace(/,+$/, '').trim();
  input.value = '';
  if (!val || val.length > 50 || _formFlavors.length >= 20) return;
  if (_formFlavors.some(f => f.toLowerCase() === val.toLowerCase())) return;
  _formFlavors.push(val);
  renderFlavorChips();
}

function setFormFlavors(flavors) {
  _formFlavors = Array.isArray(flavors) ? [...flavors] : [];
  renderFlavorChips();
}

function bindFlavorInput() {
  if (_flavorInputBound) return;
  const input = document.getElementById('beanFormFlavorInput');
  const wrap  = document.getElementById('beanFormFlavorChips');
  if (!input || !wrap) return;
  _flavorInputBound = true;
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commitFlavorInput(); }
    else if (e.key === 'Backspace' && !input.value && _formFlavors.length) {
      _formFlavors.pop();
      renderFlavorChips();
    }
  });
  input.addEventListener('blur', commitFlavorInput);
  wrap.addEventListener('click', e => {
    const btn = e.target.closest('.flavor-chip-x');
    if (!btn) return;
    _formFlavors.splice(Number(btn.dataset.flavorIdx), 1);
    renderFlavorChips();
  });
}

// ── Bean form: origin (blend-capable chips, mirrors the flavor chips) ──────
// Each chip is a country code with an optional weighting percent, used by
// the world map to split a blend's shots across its origin countries.
let _formOrigins = [];
let _originInputBound = false;

function populateOriginSelect() {
  const sel = document.getElementById('beanFormOrigin');
  if (!sel) return;
  const options = COFFEE_COUNTRIES
    .map(c => ({ code: c.code, label: `${flagEmoji(c.code)} ${countryName(c.code, S.currentLang)}` }))
    .sort((a, b) => a.label.localeCompare(b.label, S.currentLang));
  sel.innerHTML = `<option value="">${t('lib_bean_origin_none')}</option>`
    + options.map(o => `<option value="${o.code}">${esc(o.label)}</option>`).join('');
  sel.value = '';
}

function renderOriginChips() {
  const wrap = document.getElementById('beanFormOriginChips');
  if (!wrap) return;
  wrap.innerHTML = _formOrigins.map((o, i) => `
    <span class="flavor-chip origin-chip">${flagEmoji(o.code)} ${esc(countryName(o.code, S.currentLang))}
      <input type="number" class="origin-chip-percent" data-origin-idx="${i}" min="0" max="100" step="1" placeholder="%" value="${o.percent ?? ''}">
      <button type="button" class="flavor-chip-x" data-origin-idx-remove="${i}">✕</button>
    </span>`).join('');
}

function setFormOrigins(bean) {
  const origins = Array.isArray(bean?.origins) && bean.origins.length
    ? bean.origins
    : (bean?.origin ? [{ code: bean.origin }] : []);
  _formOrigins = origins.map(o => ({ ...o }));
  renderOriginChips();
}

function bindOriginInput() {
  if (_originInputBound) return;
  const sel  = document.getElementById('beanFormOrigin');
  const wrap = document.getElementById('beanFormOriginChips');
  if (!sel || !wrap) return;
  _originInputBound = true;
  sel.addEventListener('change', () => {
    const code = sel.value;
    sel.value = '';
    if (!code || _formOrigins.some(o => o.code === code) || _formOrigins.length >= 5) return;
    _formOrigins.push({ code });
    renderOriginChips();
  });
  wrap.addEventListener('click', e => {
    const btn = e.target.closest('[data-origin-idx-remove]');
    if (!btn) return;
    _formOrigins.splice(Number(btn.dataset.originIdxRemove), 1);
    renderOriginChips();
  });
  wrap.addEventListener('change', e => {
    const input = e.target.closest('.origin-chip-percent');
    if (!input) return;
    const i = Number(input.dataset.originIdx);
    const n = parseFloat(input.value);
    _formOrigins[i].percent = Number.isFinite(n) && n >= 0 && n <= 100 ? n : undefined;
  });
}

function populateSuggestionDatalists() {
  const v = document.getElementById('varietySuggestions');
  const p = document.getElementById('processSuggestions');
  if (v && !v.children.length) v.innerHTML = VARIETY_SUGGESTIONS.map(s => `<option value="${s}">`).join('');
  if (p && !p.children.length) p.innerHTML = PROCESS_SUGGESTIONS.map(s => `<option value="${s}">`).join('');
}

export function openBeanForm(bean) {
  S.beanEditId = bean ? bean.id : null;
  const importNotice = document.getElementById('beanFormImportNotice');
  if (importNotice) { importNotice.style.display = 'none'; importNotice.innerHTML = ''; }
  const dupWarning = document.getElementById('beanFormDuplicateWarning');
  if (dupWarning) { dupWarning.style.display = 'none'; dupWarning.innerHTML = ''; }
  document.getElementById('beanFormName').value      = bean?.name      || '';
  document.getElementById('beanFormRoaster').value   = bean?.roaster   || '';
  document.getElementById('beanFormRoastDate').value = bean?.roastDate || '';
  document.getElementById('beanFormNotes').value     = bean?.notes     || '';
  document.getElementById('beanFormStock').value     = bean?.stock_g   || '';
  const activeEditBag = Array.isArray(bean?.bags) && bean.bags.length ? bean.bags[bean.bags.length - 1] : null;
  document.getElementById('beanFormBatchNumber').value = activeEditBag?.batchNumber || '';
  document.getElementById('beanFormDecaf').checked   = !!bean?.decaf;
  populateOriginSelect();
  bindOriginInput();
  setFormOrigins(bean);
  populateSuggestionDatalists();
  document.getElementById('beanFormVariety').value   = bean?.variety || '';
  document.getElementById('beanFormSpecies').value   = bean?.species || '';
  document.getElementById('beanFormProcess').value   = bean?.process || '';
  bindFlavorInput();
  setFormFlavors(bean?.flavors);
  document.getElementById('beanFormFlavorInput').value = '';
  document.getElementById('beanFormRoastType').value = bean?.roastType || '';
  document.getElementById('beanFormRegion').value    = bean?.region || '';
  document.getElementById('beanFormAltitude').value      = bean?.altitude_m ?? '';
  document.getElementById('beanFormImporter').value      = bean?.importer || '';
  document.getElementById('beanFormHarvest').value       = bean?.harvest || '';
  document.getElementById('beanFormPrice').value         = bean?.price_eur ?? '';
  document.getElementById('beanFormProducer').value      = bean?.producer || '';
  document.getElementById('beanFormCertification').value = bean?.certification || '';
  document.getElementById('beanFormBrewTemp').value  = bean?.brewTempC ?? '';
  document.getElementById('beanFormBrewRatio').value = bean?.brewRatio || '';
  document.getElementById('beanFormBrewTime').value  = bean?.brewTimeS ?? '';
  document.getElementById('beanFormBrewNotes').value = bean?.brewNotes || '';
  document.getElementById('beanFormImageField').style.display = bean ? '' : 'none';
  document.getElementById('beanAddForm').classList.add('open');
  document.getElementById('beanAddTrigger').style.display = 'none';
  document.getElementById('beanFormName').focus();
}

export function closeBeanForm() {
  S.beanEditId        = null;
  S._urlImportSource   = null;
  S._urlImportedAt     = null;
  S._urlImportImageUrl = null;
  S._urlImportSourceUrl = null;
  document.getElementById('beanAddForm').classList.remove('open');
  document.getElementById('beanAddTrigger').style.display = '';
}

export function editBean(id) {
  const bean = S.coffeeLibrary.beans.find(b => b.id === id);
  if (bean) openBeanForm(bean);
}

export async function saveBean() {
  const name      = document.getElementById('beanFormName').value.trim();
  const roaster   = document.getElementById('beanFormRoaster').value.trim();
  const roastDate = document.getElementById('beanFormRoastDate').value.trim();
  const notes     = document.getElementById('beanFormNotes').value.trim();
  const stock_g   = parseFloat(document.getElementById('beanFormStock').value) || null;
  const batchNumber = document.getElementById('beanFormBatchNumber').value.trim();
  const decaf     = document.getElementById('beanFormDecaf').checked;
  const variety   = document.getElementById('beanFormVariety').value.trim();
  const species   = document.getElementById('beanFormSpecies').value;
  const process   = document.getElementById('beanFormProcess').value.trim();
  const roastType = document.getElementById('beanFormRoastType').value;
  const region    = document.getElementById('beanFormRegion').value.trim();
  const altitude_m    = document.getElementById('beanFormAltitude').value;
  const importer      = document.getElementById('beanFormImporter').value.trim();
  const harvest       = document.getElementById('beanFormHarvest').value.trim();
  const price_eur     = document.getElementById('beanFormPrice').value;
  const producer      = document.getElementById('beanFormProducer').value.trim();
  const certification = document.getElementById('beanFormCertification').value.trim();
  const brewTempC  = document.getElementById('beanFormBrewTemp').value;
  const brewRatio  = document.getElementById('beanFormBrewRatio').value.trim();
  const brewTimeS  = document.getElementById('beanFormBrewTime').value;
  const brewNotes  = document.getElementById('beanFormBrewNotes').value.trim();
  commitFlavorInput(); // take a still-typed flavor along
  if (!name) { document.getElementById('beanFormName').focus(); return; }
  const payload = {
    name, roaster, roastDate, notes, stock_g, decaf, origins: _formOrigins, variety, species, process, flavors: _formFlavors, roastType, region,
    altitude_m, importer, harvest, price_eur, producer, certification,
    brewTempC, brewRatio, brewTimeS, brewNotes, batchNumber,
  };
  if (!S.beanEditId && S._urlImportSource) {
    payload.source     = S._urlImportSource;
    payload.importedAt = S._urlImportedAt;
    if (S._urlImportImageUrl) payload.imageUrl = S._urlImportImageUrl;
    if (S._urlImportSourceUrl) payload.sourceUrl = S._urlImportSourceUrl;
  }
  const body = JSON.stringify(payload);
  const url  = S.beanEditId ? `api/library/bean/${S.beanEditId}` : 'api/library/bean';
  const r    = await apiFetch(url, { method: S.beanEditId ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body });
  if (!r.ok) return;
  const saved = await r.json();
  if (S.beanEditId) {
    const idx = S.coffeeLibrary.beans.findIndex(b => b.id === S.beanEditId);
    if (idx !== -1) S.coffeeLibrary.beans[idx] = saved;
  } else {
    S.coffeeLibrary.beans.push(saved);
  }
  updateLibraryDatalist();
  closeBeanForm();
  renderBeanList();
}

export async function deleteBean(id) {
  if (!confirm(t('lib_confirm_delete_bean'))) return;
  const r = await apiFetch(`api/library/bean/${id}/delete`, { method: 'POST' });
  if (!r.ok) return;
  S.coffeeLibrary.beans = S.coffeeLibrary.beans.filter(b => b.id !== id);
  updateLibraryDatalist();
  renderBeanList();
}

// Manual override for the order card's bean picker — independent of stock.
// The bean stays fully visible/editable in the library either way; only its
// presence in /api/orders/active-beans changes.
export async function toggleBeanActive(id) {
  const r = await apiFetch(`api/library/bean/${id}/toggle-active`, { method: 'POST' });
  if (!r.ok) return;
  const saved = await r.json();
  const idx = S.coffeeLibrary.beans.findIndex(b => b.id === id);
  if (idx !== -1) S.coffeeLibrary.beans[idx] = saved;
  renderBeanList();
}

// ── Grinder form ──────────────────────────────────────────────────────────
export function openGrinderForm(grinder) {
  S.grinderEditId = grinder ? grinder.id : null;
  document.getElementById('grinderFormName').value  = grinder?.name  || '';
  document.getElementById('grinderFormNotes').value = grinder?.notes || '';
  document.getElementById('grinderFormBurrType').value     = grinder?.burrType || '';
  document.getElementById('grinderFormPurchaseDate').value = grinder?.purchaseDate || '';
  document.getElementById('grinderFormImageField').style.display = grinder ? '' : 'none';
  document.getElementById('grinderAddForm').classList.add('open');
  document.getElementById('grinderAddTrigger').style.display = 'none';
  document.getElementById('grinderFormName').focus();
}

export function closeGrinderForm() {
  S.grinderEditId = null;
  document.getElementById('grinderAddForm').classList.remove('open');
  document.getElementById('grinderAddTrigger').style.display = '';
}

export function editGrinder(id) {
  const g = S.coffeeLibrary.grinders.find(g => g.id === id);
  if (g) openGrinderForm(g);
}

export async function saveGrinder() {
  const name         = document.getElementById('grinderFormName').value.trim();
  const notes        = document.getElementById('grinderFormNotes').value.trim();
  const burrType     = document.getElementById('grinderFormBurrType').value.trim();
  const purchaseDate = document.getElementById('grinderFormPurchaseDate').value.trim();
  if (!name) { document.getElementById('grinderFormName').focus(); return; }
  const body = JSON.stringify({ name, notes, burrType, purchaseDate });
  const url  = S.grinderEditId ? `api/library/grinder/${S.grinderEditId}` : 'api/library/grinder';
  const r    = await apiFetch(url, { method: S.grinderEditId ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body });
  if (!r.ok) return;
  const saved = await r.json();
  if (S.grinderEditId) {
    const idx = S.coffeeLibrary.grinders.findIndex(g => g.id === S.grinderEditId);
    // The PUT response doesn't recompute wear stats — keep the existing ones
    // until the next full library load rather than dropping the card.
    if (idx !== -1) S.coffeeLibrary.grinders[idx] = { ...saved, wear: S.coffeeLibrary.grinders[idx].wear };
  } else {
    S.coffeeLibrary.grinders.push(saved);
  }
  updateLibraryDatalist();
  closeGrinderForm();
  renderGrinderList();
}

export async function resetGrinderBurrs(id) {
  if (!confirm(t('lib_grinder_confirm_reset_burrs'))) return;
  const r = await apiFetch(`api/library/grinder/${id}/reset-burrs`, { method: 'POST' });
  if (!r.ok) return;
  const saved = await r.json();
  const idx = S.coffeeLibrary.grinders.findIndex(g => g.id === id);
  if (idx !== -1) S.coffeeLibrary.grinders[idx] = saved;
  renderGrinderList();
}

export async function uploadBeanImage(id, input) {
  const file = input.files[0];
  if (!file) return;
  const blob = await openImageCropEditor(file, { shape: 'square' });
  input.value = '';
  if (!blob) return;
  const r = await apiFetch(`api/library/bean/${id}/image`, {
    method: 'POST', headers: { 'Content-Type': blob.type }, body: blob,
  });
  if (!r.ok) { alert(t('error_generic', (await r.json().catch(() => ({}))).error || r.statusText)); return; }
  const saved = await r.json();
  const idx = S.coffeeLibrary.beans.findIndex(b => b.id === id);
  if (idx !== -1) S.coffeeLibrary.beans[idx] = saved;
  invalidateBeanImage(id);
  renderBeanList();
}

export async function uploadGrinderImage(id, input) {
  const file = input.files[0];
  if (!file) return;
  const blob = await openImageCropEditor(file, { shape: 'square' });
  input.value = '';
  if (!blob) return;
  const r = await apiFetch(`api/library/grinder/${id}/image`, {
    method: 'POST', headers: { 'Content-Type': blob.type }, body: blob,
  });
  if (!r.ok) { alert(t('error_generic', (await r.json().catch(() => ({}))).error || r.statusText)); return; }
  const saved = await r.json();
  const idx = S.coffeeLibrary.grinders.findIndex(g => g.id === id);
  if (idx !== -1) S.coffeeLibrary.grinders[idx] = saved;
  invalidateGrinderImage(id);
  renderGrinderList();
}

export async function deleteGrinder(id) {
  if (!confirm(t('lib_confirm_delete_grinder'))) return;
  const r = await apiFetch(`api/library/grinder/${id}/delete`, { method: 'POST' });
  if (!r.ok) return;
  S.coffeeLibrary.grinders = S.coffeeLibrary.grinders.filter(g => g.id !== id);
  updateLibraryDatalist();
  renderGrinderList();
}

// ── URL import ────────────────────────────────────────────────────────────
export function toggleUrlImport() {
  const row = document.getElementById('urlImportRow');
  const visible = row.style.display !== 'none';
  row.style.display = visible ? 'none' : 'flex';
  if (!visible) document.getElementById('urlImportInput').focus();
}

export async function importFromUrl() {
  const input = document.getElementById('urlImportInput');
  const btn   = document.querySelector('#urlImportRow .lib-url-btn');
  const url   = input.value.trim();
  if (!url) return;
  btn.textContent = t('lib_url_importing');
  btn.disabled = true;
  try {
    const r = await apiFetch(`api/import/url?url=${encodeURIComponent(url)}`);
    if (r.status === 400) {
      alert(t('lib_url_unsupported'));
      return;
    }
    if (!r.ok) throw new Error();
    const data = await r.json();
    const finish = variant => {
      _applyUrlImport(data, variant);
      input.value = '';
      document.getElementById('urlImportRow').style.display = 'none';
    };
    if (Array.isArray(data.variants) && data.variants.length > 1) openVariantPicker(data.variants, finish);
    else finish(null);
  } catch {
    alert(t('lib_url_error'));
  } finally {
    btn.textContent = t('lib_url_btn');
    btn.disabled = false;
  }
}

// Shops commonly offer several sizes at different prices — a chosen variant's
// price/weight override the parser's own best-guess price_eur (based on
// Shopify's arbitrary "default" variant) so the price actually matches what
// the user is recording as stock_g.
const BUILTIN_IMPORT_METHODS = new Set(['builtin:kaffeebraun', 'builtin:hoppenworth-ploch', 'builtin:elbgold']);

// Labels the method that produced the pre-filled data so the user knows how
// much to trust it — a built-in shop parser is well-tested, while the
// generic fallbacks (custom Shopify domain, guessed Shopify endpoint,
// JSON-LD, bare OpenGraph tags) are best-effort and worth double-checking.
function _importMethodLabel(method, host) {
  if (!method) return null;
  if (BUILTIN_IMPORT_METHODS.has(method)) return t('lib_import_method_builtin', host || '');
  if (method === 'custom-shopify')  return t('lib_import_method_custom_shopify', host || '');
  if (method === 'generic-shopify') return t('lib_import_method_generic_shopify', host || '');
  if (method === 'jsonld')          return t('lib_import_method_jsonld', host || '');
  if (method === 'opengraph')       return t('lib_import_method_opengraph', host || '');
  return null;
}

function _renderImportNotice(method, host) {
  const el = document.getElementById('beanFormImportNotice');
  if (!el) return;
  const label = _importMethodLabel(method, host);
  if (!label) { el.style.display = 'none'; el.innerHTML = ''; return; }
  const unverified = !BUILTIN_IMPORT_METHODS.has(method);
  el.innerHTML = `<div>${esc(label)}</div>${unverified ? `<div class="lib-import-notice-hint">${esc(t('lib_import_unverified_hint'))}</div>` : ''}`;
  el.style.display = '';
}

// Non-blocking hint that the parsed bean looks like one already in the
// library (same source URL previously imported, or same name+roaster) — the
// user decides whether to still import (e.g. a fresh bag of the same bean).
function _renderDuplicateWarning(duplicateWarning) {
  const el = document.getElementById('beanFormDuplicateWarning');
  if (!el) return;
  if (!duplicateWarning) { el.style.display = 'none'; el.innerHTML = ''; return; }
  el.textContent = t('lib_import_duplicate_warning', duplicateWarning.name);
  el.style.display = '';
}

function _applyUrlImport(data, variant) {
  S._urlImportSource    = data.source    || null;
  S._urlImportedAt      = data.importedAt || null;
  S._urlImportImageUrl  = data.imageUrl  || null;
  S._urlImportSourceUrl = data.sourceUrl || null;
  openBeanForm();
  _renderImportNotice(data.importMethod, data.source);
  _renderDuplicateWarning(data.duplicateWarning);
  if (data.name)    document.getElementById('beanFormName').value    = data.name;
  if (data.roaster) document.getElementById('beanFormRoaster').value = data.roaster;
  if (data.notes)   document.getElementById('beanFormNotes').value   = data.notes;
  if (Array.isArray(data.origins) && data.origins.length) setFormOrigins({ origins: data.origins });
  else if (data.origin) setFormOrigins({ origin: data.origin });
  if (data.variety) document.getElementById('beanFormVariety').value = data.variety;
  if (data.process) document.getElementById('beanFormProcess').value = data.process;
  if (data.decaf)   document.getElementById('beanFormDecaf').checked = true;
  if (Array.isArray(data.flavors) && data.flavors.length) setFormFlavors(data.flavors);
  if (data.roastType) document.getElementById('beanFormRoastType').value = data.roastType;
  if (data.region)    document.getElementById('beanFormRegion').value    = data.region;
  if (data.altitude_m) document.getElementById('beanFormAltitude').value = data.altitude_m;
  if (data.importer)   document.getElementById('beanFormImporter').value = data.importer;
  if (data.harvest)    document.getElementById('beanFormHarvest').value  = data.harvest;
  if (variant) {
    document.getElementById('beanFormPrice').value = (variant.price / 100).toFixed(2);
    document.getElementById('beanFormStock').value = variant.weight;
  } else if (data.price_eur) {
    document.getElementById('beanFormPrice').value = data.price_eur;
  }
}

function openVariantPicker(variants, onPick) {
  const row  = document.getElementById('variantPickerRow');
  const list = document.getElementById('variantPickerList');
  const confirmBtn = document.getElementById('variantPickerConfirm');
  if (!row || !list || !confirmBtn) { onPick(variants[0]); return; }
  list.innerHTML = variants.map((v, i) => `
    <label class="lib-variant-picker-option">
      <input type="radio" name="variantPick" value="${i}" ${i === 0 ? 'checked' : ''}>
      ${esc(v.title || '?')} — ${(v.price / 100).toFixed(2)} €
    </label>`).join('');
  row.style.display = '';
  const handler = () => {
    const idx = Number(list.querySelector('input[name="variantPick"]:checked')?.value || 0);
    row.style.display = 'none';
    confirmBtn.removeEventListener('click', handler);
    onPick(variants[idx]);
  };
  confirmBtn.addEventListener('click', handler);
}

// ── Import provider settings ────────────────────────────────────────────────
export async function toggleImportSettings() {
  const row = document.getElementById('importSettingsRow');
  const visible = row.style.display !== 'none';
  row.style.display = visible ? 'none' : 'flex';
  if (!visible) await _loadAndRenderImportSettings();
}

async function _loadAndRenderImportSettings() {
  const r = await apiFetch('api/import/settings');
  if (!r.ok) return;
  const data = await r.json();
  S._importSettings = data;
  _renderImportSettingsPanel(data);
}

function _renderImportSettingsPanel(data) {
  const providersEl = document.getElementById('importSettingsProviders');
  const customEl    = document.getElementById('importSettingsCustomList');
  providersEl.innerHTML = data.providers.map(p => `
    <label class="lib-import-settings-provider">
      <input type="checkbox" data-provider-id="${esc(p.id)}" ${p.enabled ? 'checked' : ''}>
      ${esc(p.label)} <span class="lib-import-settings-host">(${esc(p.hostSuffix)})</span>
    </label>`).join('');
  providersEl.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', () => _saveProviderToggle(cb.dataset.providerId, cb.checked));
  });
  customEl.innerHTML = data.customShopifyDomains.length
    ? data.customShopifyDomains.map(d => `
        <div class="lib-import-settings-domain">
          <span>${esc(d)}</span>
          <button class="lib-import-settings-remove" data-domain="${esc(d)}" aria-label="${esc(t('lib_import_settings_remove'))}">×</button>
        </div>`).join('')
    : `<div class="lib-form-hint">${esc(t('lib_import_settings_none'))}</div>`;
  customEl.querySelectorAll('.lib-import-settings-remove').forEach(btn => {
    btn.addEventListener('click', () => _removeCustomShopifyDomain(btn.dataset.domain));
  });
}

async function _saveProviderToggle(providerId, enabled) {
  const current = S._importSettings || { providers: [], customShopifyDomains: [] };
  const disabledProviders = current.providers
    .map(p => p.id === providerId ? { ...p, enabled } : p)
    .filter(p => !p.enabled)
    .map(p => p.id);
  const r = await apiFetch('api/import/settings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ disabledProviders, customShopifyDomains: current.customShopifyDomains }),
  });
  if (r.ok) await _loadAndRenderImportSettings();
}

export async function addCustomShopifyDomain() {
  const input = document.getElementById('importSettingsDomainInput');
  const domain = input.value.trim();
  if (!domain) return;
  const current = S._importSettings || { providers: [], customShopifyDomains: [] };
  const domains = [...new Set([...current.customShopifyDomains, domain])];
  const r = await apiFetch('api/import/settings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ customShopifyDomains: domains }),
  });
  if (r.ok) {
    input.value = '';
    await _loadAndRenderImportSettings();
  } else {
    alert(t('lib_import_settings_invalid_domain'));
  }
}

async function _removeCustomShopifyDomain(domain) {
  const current = S._importSettings || { providers: [], customShopifyDomains: [] };
  const domains = current.customShopifyDomains.filter(d => d !== domain);
  const r = await apiFetch('api/import/settings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ customShopifyDomains: domains }),
  });
  if (r.ok) await _loadAndRenderImportSettings();
}

// ── Barcode / QR scanner ──────────────────────────────────────────────────
export async function openScanModal() {
  if (!('BarcodeDetector' in window)) {
    alert(t('scan_not_supported'));
    return;
  }
  const modal  = document.getElementById('scanModal');
  const video  = document.getElementById('scanVideo');
  const status = document.getElementById('scanStatus');
  status.textContent = t('scan_searching');
  status.className = '';
  modal.classList.add('open');
  try {
    S._scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    video.srcObject = S._scanStream;
  } catch (e) {
    status.textContent = t('scan_error');
    status.className = 'error';
    return;
  }
  S._scanActive   = true;
  S._scanDetector = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'qr_code', 'data_matrix'] });
  _runScanLoop();
}

export function closeScanModal() {
  S._scanActive = false;
  if (S._scanStream) { S._scanStream.getTracks().forEach(t => t.stop()); S._scanStream = null; }
  document.getElementById('scanModal').classList.remove('open');
  document.getElementById('scanVideo').srcObject = null;
}

export async function _runScanLoop() {
  const video  = document.getElementById('scanVideo');
  const status = document.getElementById('scanStatus');
  while (S._scanActive) {
    await new Promise(r => setTimeout(r, 300));
    if (!S._scanActive) break;
    try {
      const codes = await S._scanDetector.detect(video);
      if (!codes.length) continue;
      const raw = codes[0].rawValue;
      S._scanActive = false;
      await _handleScanResult(raw, status);
    } catch (e) { /* frame not ready yet */ }
  }
}

export async function _handleScanResult(raw, status) {
  const glp = parseGlpQrParams(raw);
  if (glp) {
    closeScanModal();
    openBeanForm();
    if (glp.name)      document.getElementById('beanFormName').value      = glp.name;
    if (glp.roaster)   document.getElementById('beanFormRoaster').value   = glp.roaster;
    if (glp.roastDate) document.getElementById('beanFormRoastDate').value = glp.roastDate;
    if (glp.notes)     document.getElementById('beanFormNotes').value     = glp.notes;
    status.textContent = t('scan_glp_imported');
    status.className = 'found';
    return;
  }
  // EAN/UPC → Open Food Facts
  status.textContent = t('scan_searching');
  try {
    const r    = await fetch(`https://world.openfoodfacts.org/api/v3/product/${encodeURIComponent(raw)}.json`);
    const data = await r.json();
    const p    = data?.product;
    if (p) {
      const name    = p.product_name || p.product_name_de || p.product_name_en || '';
      const roaster = p.brands || '';
      const notes   = [p.categories_tags?.find(c => c.startsWith('en:'))?.replace('en:', '') || '', p.labels || ''].filter(Boolean).join(', ');
      status.textContent = t('scan_found', name || raw);
      status.className = 'found';
      await new Promise(r => setTimeout(r, 1000));
      closeScanModal();
      openBeanForm();
      if (name)    document.getElementById('beanFormName').value    = name;
      if (roaster) document.getElementById('beanFormRoaster').value = roaster;
      if (notes)   document.getElementById('beanFormNotes').value   = notes;
    } else {
      status.textContent = t('scan_not_found');
      status.className = 'error';
      await new Promise(r => setTimeout(r, 1800));
      closeScanModal();
      openBeanForm();
    }
  } catch (e) {
    status.textContent = t('scan_error');
    status.className = 'error';
    await new Promise(r => setTimeout(r, 1800));
    closeScanModal();
    openBeanForm();
  }
}

// ── Recipes ───────────────────────────────────────────────────────────────

const BREW_METHOD_LABELS = {
  espresso: 'lib_brew_espresso', aeropress: 'lib_brew_aeropress', v60: 'lib_brew_v60',
  french_press: 'lib_brew_french_press', moka: 'lib_brew_moka',
  cold_brew: 'lib_brew_cold_brew', other: 'lib_brew_other',
};

export function renderRecipeList() {
  const el = document.getElementById('recipeListUI');
  if (!el) return;
  const recipes = S.coffeeLibrary.recipes || [];
  if (!recipes.length) {
    el.innerHTML = `<div class="lib-empty">${t('lib_empty_recipes')}</div>`;
    return;
  }
  el.innerHTML = recipes.map(r => {
    const brewLabel = r.brewMethod && BREW_METHOD_LABELS[r.brewMethod]
      ? `<span class="lib-brew-badge">${t(BREW_METHOD_LABELS[r.brewMethod])}</span>`
      : '';
    const meta = [r.drinkType, r.beanName, r.profileName].filter(Boolean).map(esc).join(' · ');
    const params = [
      r.targetDose_g  ? `${r.targetDose_g} g`    : null,
      r.targetYield_g ? `→ ${r.targetYield_g} g` : null,
      r.water_g       ? `💧 ${r.water_g} g`      : null,
      r.ice_g         ? `🧊 ${r.ice_g} g`        : null,
      r.targetTime_s  ? `${r.targetTime_s} s`    : null,
      r.waterTemp_c   ? `${r.waterTemp_c} °C`    : null,
      r.grindSize     ? esc(r.grindSize)          : null,
    ].filter(Boolean);
    const stepsHtml = Array.isArray(r.steps) && r.steps.length
      ? `<div class="lib-recipe-steps-list">${r.steps.map((s, i) => `
          <div class="lib-recipe-step">
            <span class="lib-recipe-step-n">${i + 1}.</span>
            <span>${esc(s.text)}</span>
            ${s.duration_s ? `<span class="lib-recipe-step-dur">${s.duration_s} s</span>` : ''}
          </div>`).join('')}</div>`
      : '';
    const linkedShots = (S.shots || []).filter(s => s.annotation?.recipeId === r.id);
    const shotCount   = linkedShots.length;
    const avgScore    = shotCount > 0
      ? (linkedShots.reduce((sum, s) => sum + (s.score ?? 0), 0) / shotCount).toFixed(1)
      : null;
    const shotsBadge  = shotCount > 0
      ? `<span class="lib-recipe-shots-badge">${shotCount} Shot${shotCount !== 1 ? 's' : ''}${avgScore !== null ? ` · Ø ${avgScore}` : ''}</span>`
      : '';
    return `<div class="lib-item">
      <div class="lib-item-info">
        <div class="lib-item-name">${brewLabel}${esc(r.name)}${shotsBadge}</div>
        ${meta ? `<div class="lib-item-sub">${meta}</div>` : ''}
        ${params.length ? `<div class="lib-recipe-params">${params.map(p => `<span>${p}</span>`).join('')}</div>` : ''}
        ${stepsHtml}
        ${r.notes ? `<div class="lib-item-sub" style="margin-top:4px">${esc(r.notes)}</div>` : ''}
        ${r.sourceUrl ? `<div class="lib-item-source"><a href="${esc(r.sourceUrl)}" target="_blank" rel="noopener">🔗 Quelle</a></div>` : ''}
      </div>
      <div class="lib-item-actions">
        <button class="lib-btn-sm lib-btn-icon" data-action="edit-recipe" data-id="${r.id}" title="${t('lib_btn_edit')}">${ICON_PENCIL}</button>
        <button class="lib-btn-sm del lib-btn-icon" data-action="delete-recipe" data-id="${r.id}" title="${t('lib_btn_delete')}">${ICON_TRASH}</button>
      </div>
    </div>`;
  }).join('');
}

function _renderStepRows(steps) {
  const list = document.getElementById('recipeStepsList');
  if (!list) return;
  list.innerHTML = (steps || []).map((s, i) => _stepRowHtml(i, s.text, s.duration_s)).join('');
}

function _stepRowHtml(i, text = '', dur = '') {
  return `<div class="lib-step-row" id="recipeStep${i}">
    <span class="lib-step-num">${i + 1}</span>
    <input class="lib-step-text" placeholder="${t('lib_recipe_step_ph')}" value="${esc(text)}">
    <input class="lib-step-dur" type="number" min="0" step="1" placeholder="${t('lib_recipe_step_dur')}" value="${dur ?? ''}">
    <button class="lib-btn-sm del lib-btn-icon" data-action="remove-recipe-step" data-idx="${i}">${ICON_TRASH}</button>
  </div>`;
}

export function addRecipeStep() {
  const list = document.getElementById('recipeStepsList');
  if (!list) return;
  const idx = list.children.length;
  list.insertAdjacentHTML('beforeend', _stepRowHtml(idx));
}

export function removeRecipeStep(i) {
  const row = document.getElementById(`recipeStep${i}`);
  if (row) row.remove();
  // Re-number remaining rows
  document.querySelectorAll('#recipeStepsList .lib-step-row').forEach((row, idx) => {
    row.id = `recipeStep${idx}`;
    row.querySelector('.lib-step-num').textContent = idx + 1;
    const delBtn = row.querySelector('.lib-btn-sm.del');
    delBtn.dataset.action = 'remove-recipe-step';
    delBtn.dataset.idx = String(idx);
  });
}

function _collectSteps() {
  return [...document.querySelectorAll('#recipeStepsList .lib-step-row')].map(row => ({
    text:       row.querySelector('.lib-step-text')?.value.trim() || '',
    duration_s: parseFloat(row.querySelector('.lib-step-dur')?.value) || null,
  })).filter(s => s.text);
}

export function openRecipeForm(recipe) {
  S.recipeEditId = recipe ? recipe.id : null;
  document.getElementById('recipeFormName').value         = recipe?.name          || '';
  document.getElementById('recipeFormBrewMethod').value   = recipe?.brewMethod    || 'espresso';
  document.getElementById('recipeFormDrinkType').value    = recipe?.drinkType     || '';
  document.getElementById('recipeFormDose').value         = recipe?.targetDose_g  ?? '';
  document.getElementById('recipeFormYield').value        = recipe?.targetYield_g ?? '';
  document.getElementById('recipeFormTime').value         = recipe?.targetTime_s  ?? '';
  document.getElementById('recipeFormWaterTemp').value    = recipe?.waterTemp_c   ?? '';
  document.getElementById('recipeFormWaterG').value       = recipe?.water_g       ?? '';
  document.getElementById('recipeFormIceG').value         = recipe?.ice_g         ?? '';
  document.getElementById('recipeFormGrind').value        = recipe?.grindSize     || '';
  document.getElementById('recipeFormSourceUrl').value    = recipe?.sourceUrl     || '';
  document.getElementById('recipeFormProfile').value      = recipe?.profileName   || '';
  document.getElementById('recipeFormBean').value         = recipe?.beanName      || '';
  document.getElementById('recipeFormNotes').value        = recipe?.notes         || '';
  _renderStepRows(recipe?.steps || []);
  document.getElementById('recipeAddForm').classList.add('open');
  document.getElementById('recipeAddTrigger').style.display = 'none';
  document.getElementById('recipeFormName').focus();
}

export function closeRecipeForm() {
  S.recipeEditId = null;
  document.getElementById('recipeAddForm').classList.remove('open');
  document.getElementById('recipeAddTrigger').style.display = '';
}

export function editRecipe(id) {
  const recipe = (S.coffeeLibrary.recipes || []).find(r => r.id === id);
  if (recipe) openRecipeForm(recipe);
}

export async function saveRecipe() {
  const name = document.getElementById('recipeFormName').value.trim();
  if (!name) { document.getElementById('recipeFormName').focus(); return; }
  const payload = {
    name,
    brewMethod:    document.getElementById('recipeFormBrewMethod').value,
    drinkType:     document.getElementById('recipeFormDrinkType').value.trim(),
    targetDose_g:  parseFloat(document.getElementById('recipeFormDose').value)      || null,
    targetYield_g: parseFloat(document.getElementById('recipeFormYield').value)     || null,
    targetTime_s:  parseFloat(document.getElementById('recipeFormTime').value)      || null,
    waterTemp_c:   parseFloat(document.getElementById('recipeFormWaterTemp').value) || null,
    water_g:       parseFloat(document.getElementById('recipeFormWaterG').value)    || null,
    ice_g:         parseFloat(document.getElementById('recipeFormIceG').value)      || null,
    grindSize:     document.getElementById('recipeFormGrind').value.trim(),
    sourceUrl:     document.getElementById('recipeFormSourceUrl').value.trim(),
    profileName:   document.getElementById('recipeFormProfile').value.trim(),
    beanName:      document.getElementById('recipeFormBean').value.trim(),
    notes:         document.getElementById('recipeFormNotes').value.trim(),
    steps:         _collectSteps(),
  };
  const url = S.recipeEditId ? `api/library/recipe/${S.recipeEditId}` : 'api/library/recipe';
  const r   = await apiFetch(url, { method: S.recipeEditId ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (!r.ok) return;
  const saved = await r.json();
  if (!Array.isArray(S.coffeeLibrary.recipes)) S.coffeeLibrary.recipes = [];
  if (S.recipeEditId) {
    const idx = S.coffeeLibrary.recipes.findIndex(r => r.id === S.recipeEditId);
    if (idx !== -1) S.coffeeLibrary.recipes[idx] = saved;
  } else {
    S.coffeeLibrary.recipes.push(saved);
  }
  closeRecipeForm();
  renderRecipeList();
}

export async function deleteRecipe(id) {
  if (!confirm(t('lib_confirm_delete_recipe'))) return;
  const r = await apiFetch(`api/library/recipe/${id}/delete`, { method: 'POST' });
  if (!r.ok) return;
  S.coffeeLibrary.recipes = (S.coffeeLibrary.recipes || []).filter(r => r.id !== id);
  renderRecipeList();
}

// ── Milk ─────────────────────────────────────────────────────────────────

export function renderMilkList() {
  const el = document.getElementById('milkListUI');
  if (!el) return;
  const milks = S.coffeeLibrary?.milks || [];
  if (!milks.length) { el.innerHTML = ''; return; }
  el.innerHTML = milks.map(m => {
    const pct = m.stockMl > 0 ? Math.min(100, m.stockMl / 20) : 0; // 2000ml = 100%
    const cls = m.stockMl <= 0 ? 'empty' : m.stockMl < 300 ? 'low' : 'ok';
    return `<div class="lib-milk-item">
      <div class="lib-milk-top">
        <span style="font-size:1.3rem">${esc(m.emoji || '🥛')}</span>
        <span class="lib-milk-name">${esc(m.name)}</span>
        <button class="lib-milk-del" data-action="delete-milk" data-id="${m.id}" title="${t('lib_milk_delete')}">✕</button>
      </div>
      <div class="lib-milk-stock-bar-wrap">
        <div class="lib-milk-stock-bar ${cls}" style="width:${pct}%"></div>
      </div>
      <div class="lib-milk-meta">
        <span><b>${m.stockMl ?? 0} ml</b> ${t('lib_milk_stock').replace(' (ml)','')}</span>
        ${m.stockMl < 300 ? `<span style="color:${m.stockMl <= 0 ? '#ef4444' : '#f59e0b'}">${m.stockMl <= 0 ? t('lib_milk_empty') : t('lib_milk_low')}</span>` : ''}
      </div>
      <div class="lib-milk-restock-row">
        <input class="lib-milk-restock-input" type="number" id="milkRestock_${m.id}" placeholder="ml" min="0" step="50">
        <button class="lib-btn-sm" data-action="restock-milk" data-id="${m.id}">${t('lib_milk_restock')}</button>
      </div>
    </div>`;
  }).join('');
}

export function openMilkForm() {
  document.getElementById('milkAddForm').classList.add('open');
  document.getElementById('milkAddTrigger').style.display = 'none';
}

export function closeMilkForm() {
  document.getElementById('milkAddForm').classList.remove('open');
  document.getElementById('milkAddTrigger').style.display = '';
  ['milkFormName','milkFormEmoji','milkFormStock'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
}

export async function saveMilk() {
  const name    = document.getElementById('milkFormName')?.value.trim();
  const emoji   = document.getElementById('milkFormEmoji')?.value.trim() || '🥛';
  const stockMl = parseFloat(document.getElementById('milkFormStock')?.value) || 0;
  if (!name) return;
  const r = await apiFetch('api/library/milk', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, emoji, stockMl }),
  });
  if (!r.ok) return;
  const saved = await r.json();
  if (!S.coffeeLibrary.milks) S.coffeeLibrary.milks = [];
  S.coffeeLibrary.milks.push(saved);
  closeMilkForm();
  renderMilkList();
}

export async function restockMilk(id) {
  const val = parseFloat(document.getElementById(`milkRestock_${id}`)?.value);
  if (!val || val <= 0) return;
  const r = await apiFetch(`api/library/milk/${id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ stockMl: val }),
  });
  if (!r.ok) return;
  const saved = await r.json();
  const idx = (S.coffeeLibrary.milks || []).findIndex(m => m.id === id);
  if (idx !== -1) S.coffeeLibrary.milks[idx] = saved;
  renderMilkList();
}

export async function deleteMilk(id) {
  if (!confirm(t('lib_milk_delete') + '?')) return;
  const r = await apiFetch(`api/library/milk/${id}`, { method: 'DELETE' });
  if (!r.ok) return;
  S.coffeeLibrary.milks = (S.coffeeLibrary.milks || []).filter(m => m.id !== id);
  renderMilkList();
}
