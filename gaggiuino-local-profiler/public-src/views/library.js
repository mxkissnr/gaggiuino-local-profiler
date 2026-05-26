import { S } from '../state.js';
import { t } from '../i18n.js';
import { apiFetch } from '../api.js';
import { esc } from '../utils.js';

// ── Library load ──────────────────────────────────────────────────────────
export async function loadLibrary() {
  try {
    const r = await apiFetch('api/library');
    if (!r.ok) return;
    S.coffeeLibrary = await r.json();
    updateLibraryDatalist();
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
  document.getElementById('libSectionBeans').classList.toggle('active',   tab === 'beans');
  document.getElementById('libSectionGrinders').classList.toggle('active', tab === 'grinders');
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
    const consumed = S.shots.reduce((sum, s) => {
      const d = parseFloat(s.annotation?.dose);
      const match = (s.annotation?.coffee || '').toLowerCase() === b.name.toLowerCase();
      return (match && d) ? sum + d : sum;
    }, 0);
    const consumedRnd = Math.round(consumed);
    let invHtml = '';
    if (b.stock_g) {
      const remaining = Math.round(b.stock_g - consumed);
      const isLow = remaining < 100;
      invHtml = `<div class="lib-inv-stats">
        <span>${t('lib_inv_consumed', consumedRnd)}</span>
        <span class="lib-inv-remaining${isLow ? ' low' : ''}">${t('lib_inv_remaining', remaining)}</span>
        ${isLow ? `<span class="lib-inv-reorder">${t('lib_inv_reorder')}</span>` : ''}
      </div>`;
    } else if (consumedRnd > 0) {
      invHtml = `<div class="lib-inv-stats"><span>${t('lib_inv_consumed', consumedRnd)}</span></div>`;
    }
    return `<div class="lib-item">
      <div class="lib-item-info">
        <div class="lib-item-name">${esc(b.name)}</div>
        <div class="lib-item-sub">${[b.roaster, b.roastDate, b.notes].filter(Boolean).map(esc).join(' · ')}</div>
        ${invHtml}
        ${b.source ? `<div class="lib-item-source">${t('lib_imported_from', b.source, b.importedAt || '')}</div>` : ''}
      </div>
      <div class="lib-item-actions">
        <button class="lib-btn-sm" onclick="toggleBeanQR(${b.id})" title="${t('bean_qr_label')}">QR</button>
        <button class="lib-btn-sm" onclick="editBean(${b.id})">${t('lib_btn_edit')}</button>
        <button class="lib-btn-sm del" onclick="deleteBean(${b.id})">${t('lib_btn_delete')}</button>
      </div>
      <div class="bean-qr-wrap" id="beanQR${b.id}" style="display:none">
        <canvas id="beanQRCanvas${b.id}"></canvas>
        <span class="bean-qr-label">${t('bean_qr_label')}</span>
      </div>
    </div>`;
  }).join('');
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
        <button class="lib-btn-sm" onclick="editGrinder(${g.id})">${t('lib_btn_edit')}</button>
        <button class="lib-btn-sm del" onclick="deleteGrinder(${g.id})">${t('lib_btn_delete')}</button>
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
  if (!name) { document.getElementById('beanFormName').focus(); return; }
  const payload = { name, roaster, roastDate, notes, stock_g };
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
