import { S } from '../state.js';
import { t } from '../i18n.js';
import { apiFetch } from '../api.js';
import { esc } from '../utils.js';

const ICON_PENCIL = `<svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15" aria-hidden="true"><path d="M20.71,7.04C21.1,6.65 21.1,6 20.71,5.63L18.37,3.29C18,2.9 17.35,2.9 16.96,3.29L15.12,5.12L18.87,8.87M3,17.25V21H6.75L17.81,9.93L14.06,6.18L3,17.25Z"/></svg>`;
const ICON_TRASH  = `<svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15" aria-hidden="true"><path d="M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19M8,9H10V19H8V9M14,9H16V19H14V9M15.5,4L14.5,3H9.5L8.5,4H5V6H19V4H15.5Z"/></svg>`;

// ── Library load ──────────────────────────────────────────────────────────
export async function loadLibrary() {
  try {
    const r = await apiFetch('api/library');
    if (!r.ok) return;
    S.coffeeLibrary = await r.json();
    if (!S.coffeeLibrary.recipes) S.coffeeLibrary.recipes = [];
    updateLibraryDatalist();
    renderRecipeList();
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
  document.getElementById('libSectionBeans').classList.toggle('active',   tab === 'beans');
  document.getElementById('libSectionGrinders').classList.toggle('active', tab === 'grinders');
  document.getElementById('libSectionRecipes').classList.toggle('active', tab === 'recipes');
}

// ── Bean list ─────────────────────────────────────────────────────────────
export function renderBeanList() {
  const el = document.getElementById('beanListUI');
  if (!el) return;
  if (!S.coffeeLibrary.beans.length) {
    el.innerHTML = `<div class="lib-empty">${t('lib_empty_beans')}</div>`;
    return;
  }
  el.innerHTML = S.coffeeLibrary.beans.map(b => {
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

    let invHtml = '';
    if (b.stock_g) {
      const remaining = Math.round(b.stock_g - activeBagConsumed);
      const isLow = remaining < 100;
      invHtml = `<div class="lib-inv-stats">
        <span>${t('lib_inv_consumed', activeBagConsumed)}</span>
        <span class="lib-inv-remaining${isLow ? ' low' : ''}">${t('lib_inv_remaining', remaining)}</span>
        ${isLow ? `<span class="lib-inv-reorder">${t('lib_inv_reorder')}</span>` : ''}
        ${bags.length > 1 ? `<span class="lib-inv-total">${t('lib_inv_total_consumed', totalConsumed)} · ${t('lib_inv_bags', bags.length)}</span>` : ''}
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
          </div>`).join('')}
      </div>
      <button class="lib-btn-sm lib-bag-history-btn" onclick="toggleBagHistory(${b.id})" id="bagHistoryBtn${b.id}">▸ ${t('lib_bag_history')}</button>` : '';

    return `<div class="lib-item">
      <div class="lib-item-info">
        <div class="lib-item-name">${esc(b.name)}${b.decaf ? ` <span class="lib-decaf-badge">DECAF</span>` : ''}</div>
        <div class="lib-item-sub">${[b.roaster, b.roastDate, b.notes].filter(Boolean).map(esc).join(' · ')}</div>
        ${invHtml}
        ${bagHistoryHtml}
        ${b.source ? `<div class="lib-item-source">${t('lib_imported_from', b.source, b.importedAt || '')}</div>` : ''}
      </div>
      <div class="lib-item-actions">
        <button class="lib-btn-sm" onclick="openNewBagForm(${b.id})" title="${t('lib_new_bag')}">${t('lib_new_bag')}</button>
        <button class="lib-btn-sm" onclick="toggleBeanQR(${b.id})" title="${t('bean_qr_label')}">QR</button>
        <button class="lib-btn-sm lib-btn-icon" onclick="editBean(${b.id})" title="${t('lib_btn_edit')}">${ICON_PENCIL}</button>
        <button class="lib-btn-sm del lib-btn-icon" onclick="deleteBean(${b.id})" title="${t('lib_btn_delete')}">${ICON_TRASH}</button>
      </div>
      <div id="newBagForm${b.id}" class="lib-new-bag-form" style="display:none">
        <div class="lib-new-bag-fields">
          <input type="text" class="lib-new-bag-input" id="newBagRoastDate${b.id}" placeholder="${t('lib_bag_roast_date')} (TT.MM.JJJJ)">
          <input type="number" class="lib-new-bag-input" id="newBagStock${b.id}" placeholder="${t('lib_bag_stock')}" min="0" step="1">
        </div>
        <div class="lib-form-actions">
          <button class="lib-btn-sm" onclick="closeNewBagForm(${b.id})">${t('lib_cancel')}</button>
          <button class="lib-save-btn" onclick="saveNewBag(${b.id})">${t('lib_new_bag_save')}</button>
        </div>
      </div>
      <div class="bean-qr-wrap" id="beanQR${b.id}" style="display:none">
        <canvas id="beanQRCanvas${b.id}"></canvas>
        <span class="bean-qr-label">${t('bean_qr_label')}</span>
      </div>
    </div>`;
  }).join('');
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

export async function saveNewBag(id) {
  const roastDate = document.getElementById(`newBagRoastDate${id}`)?.value.trim() || '';
  const stock_g   = parseFloat(document.getElementById(`newBagStock${id}`)?.value) || null;
  const r = await apiFetch(`api/library/bean/${id}/new-bag`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ roastDate, stock_g }),
  });
  if (!r.ok) return;
  const saved = await r.json();
  const idx = S.coffeeLibrary.beans.findIndex(b => b.id === id);
  if (idx !== -1) S.coffeeLibrary.beans[idx] = saved;
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
  QRCode.toCanvas(canvas, generateBeanQR(bean), { width: 140, margin: 1, color: { dark: '#e4e4e7', light: '#18181b' } });
}

export function generateBeanQR(bean) {
  const params = new URLSearchParams();
  if (bean.name)      params.set('name',      bean.name);
  if (bean.roaster)   params.set('roaster',   bean.roaster);
  if (bean.roastDate) params.set('roastDate', bean.roastDate);
  if (bean.notes)     params.set('notes',     bean.notes);
  return `glp://coffee?${params.toString()}`;
}

// ── Grinder list ──────────────────────────────────────────────────────────
export function renderGrinderList() {
  const el = document.getElementById('grinderListUI');
  if (!el) return;
  if (!S.coffeeLibrary.grinders.length) {
    el.innerHTML = `<div class="lib-empty">${t('lib_empty_grinders')}</div>`;
    return;
  }
  el.innerHTML = S.coffeeLibrary.grinders.map(g => `
    <div class="lib-item">
      <div class="lib-item-info">
        <div class="lib-item-name">${esc(g.name)}</div>
        ${g.notes ? `<div class="lib-item-sub">${esc(g.notes)}</div>` : ''}
      </div>
      <div class="lib-item-actions">
        <button class="lib-btn-sm lib-btn-icon" onclick="editGrinder(${g.id})" title="${t('lib_btn_edit')}">${ICON_PENCIL}</button>
        <button class="lib-btn-sm del lib-btn-icon" onclick="deleteGrinder(${g.id})" title="${t('lib_btn_delete')}">${ICON_TRASH}</button>
      </div>
    </div>`).join('');
}

// ── Bean form ─────────────────────────────────────────────────────────────
export function openBeanForm(bean) {
  S.beanEditId = bean ? bean.id : null;
  document.getElementById('beanFormName').value      = bean?.name      || '';
  document.getElementById('beanFormRoaster').value   = bean?.roaster   || '';
  document.getElementById('beanFormRoastDate').value = bean?.roastDate || '';
  document.getElementById('beanFormNotes').value     = bean?.notes     || '';
  document.getElementById('beanFormStock').value     = bean?.stock_g   || '';
  document.getElementById('beanFormDecaf').checked   = !!bean?.decaf;
  document.getElementById('beanAddForm').classList.add('open');
  document.getElementById('beanAddTrigger').style.display = 'none';
  document.getElementById('beanFormName').focus();
}

export function closeBeanForm() {
  S.beanEditId       = null;
  S._urlImportSource = null;
  S._urlImportedAt   = null;
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
  const decaf     = document.getElementById('beanFormDecaf').checked;
  if (!name) { document.getElementById('beanFormName').focus(); return; }
  const payload = { name, roaster, roastDate, notes, stock_g, decaf };
  if (!S.beanEditId && S._urlImportSource) { payload.source = S._urlImportSource; payload.importedAt = S._urlImportedAt; }
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

// ── Grinder form ──────────────────────────────────────────────────────────
export function openGrinderForm(grinder) {
  S.grinderEditId = grinder ? grinder.id : null;
  document.getElementById('grinderFormName').value  = grinder?.name  || '';
  document.getElementById('grinderFormNotes').value = grinder?.notes || '';
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
  const name  = document.getElementById('grinderFormName').value.trim();
  const notes = document.getElementById('grinderFormNotes').value.trim();
  if (!name) { document.getElementById('grinderFormName').focus(); return; }
  const body = JSON.stringify({ name, notes });
  const url  = S.grinderEditId ? `api/library/grinder/${S.grinderEditId}` : 'api/library/grinder';
  const r    = await apiFetch(url, { method: S.grinderEditId ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body });
  if (!r.ok) return;
  const saved = await r.json();
  if (S.grinderEditId) {
    const idx = S.coffeeLibrary.grinders.findIndex(g => g.id === S.grinderEditId);
    if (idx !== -1) S.coffeeLibrary.grinders[idx] = saved;
  } else {
    S.coffeeLibrary.grinders.push(saved);
  }
  updateLibraryDatalist();
  closeGrinderForm();
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
    S._urlImportSource = data.source    || null;
    S._urlImportedAt   = data.importedAt || null;
    openBeanForm();
    if (data.name)    document.getElementById('beanFormName').value    = data.name;
    if (data.roaster) document.getElementById('beanFormRoaster').value = data.roaster;
    if (data.notes)   document.getElementById('beanFormNotes').value   = data.notes;
    input.value = '';
    document.getElementById('urlImportRow').style.display = 'none';
  } catch {
    alert(t('lib_url_error'));
  } finally {
    btn.textContent = t('lib_url_btn');
    btn.disabled = false;
  }
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
  // GLP QR schema: glp://coffee?name=...&roaster=...&notes=...&roastDate=...
  if (raw.startsWith('glp://coffee')) {
    const params = new URLSearchParams(raw.replace('glp://coffee?', ''));
    closeScanModal();
    openBeanForm();
    if (params.get('name'))      document.getElementById('beanFormName').value      = params.get('name');
    if (params.get('roaster'))   document.getElementById('beanFormRoaster').value   = params.get('roaster');
    if (params.get('roastDate')) document.getElementById('beanFormRoastDate').value = params.get('roastDate');
    if (params.get('notes'))     document.getElementById('beanFormNotes').value     = params.get('notes');
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
    return `<div class="lib-item">
      <div class="lib-item-info">
        <div class="lib-item-name">${brewLabel}${esc(r.name)}</div>
        ${meta ? `<div class="lib-item-sub">${meta}</div>` : ''}
        ${params.length ? `<div class="lib-recipe-params">${params.map(p => `<span>${p}</span>`).join('')}</div>` : ''}
        ${stepsHtml}
        ${r.notes ? `<div class="lib-item-sub" style="margin-top:4px">${esc(r.notes)}</div>` : ''}
      </div>
      <div class="lib-item-actions">
        <button class="lib-btn-sm lib-btn-icon" onclick="editRecipe(${r.id})" title="${t('lib_btn_edit')}">${ICON_PENCIL}</button>
        <button class="lib-btn-sm del lib-btn-icon" onclick="deleteRecipe(${r.id})" title="${t('lib_btn_delete')}">${ICON_TRASH}</button>
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
    <button class="lib-btn-sm del lib-btn-icon" onclick="removeRecipeStep(${i})">${ICON_TRASH}</button>
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
    row.querySelector('.lib-btn-sm.del').setAttribute('onclick', `removeRecipeStep(${idx})`);
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
  document.getElementById('recipeFormGrind').value        = recipe?.grindSize     || '';
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
    grindSize:     document.getElementById('recipeFormGrind').value.trim(),
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
