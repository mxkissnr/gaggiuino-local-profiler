// Machine profile editor (#307) — visual editor for Gaggiuino machine
// profiles, backed by the WebSocket/Protobuf backend from #306
// (GET/POST/PUT/DELETE /api/machine/profile[/:id]).
//
// Phase editing follows the same DOM-as-state pattern as the recipe-step
// editor in library.js (_renderStepRows/addRecipeStep/removeRecipeStep/
// _collectSteps): the rows in #profilePhaseList are the source of truth at
// save time, no separate JS array is kept in sync. removeProfilePhase()
// renumbers all remaining rows/ids/data-idx after a removal, same as
// removeRecipeStep().
import { S } from '../state.js';
import { t } from '../i18n.js';
import { apiFetch } from '../api.js';
import { esc } from '../utils.js';
import { suggestProfileFromBean } from '../profile-suggestion.js';

const ICON_PENCIL = `<svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15" aria-hidden="true"><path d="M20.71,7.04C21.1,6.65 21.1,6 20.71,5.63L18.37,3.29C18,2.9 17.35,2.9 16.96,3.29L15.12,5.12L18.87,8.87M3,17.25V21H6.75L17.81,9.93L14.06,6.18L3,17.25Z"/></svg>`;
const ICON_TRASH  = `<svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15" aria-hidden="true"><path d="M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19M8,9H10V19H8V9M14,9H16V19H14V9M15.5,4L14.5,3H9.5L8.5,4H5V6H19V4H15.5Z"/></svg>`;

const PHASE_TYPES = ['FLOW', 'PRESSURE', 'MANUAL'];
const CURVES      = ['EASE_IN_OUT', 'EASE_IN', 'EASE_OUT', 'LINEAR', 'INSTANT'];

// ── Profile list (Library "Profiles" tab) ───────────────────────────────
export async function loadMachineProfileList() {
  const r = await apiFetch('api/machine/profiles');
  if (!r.ok) return;
  const data = await r.json();
  S.machineProfiles = Array.isArray(data.optionsRaw) ? data.optionsRaw : [];
  renderProfileList();
  updateProfileDatalist();
}

export function updateProfileDatalist() {
  const dl = document.getElementById('profileList');
  if (dl) dl.innerHTML = S.machineProfiles.map(p => `<option value="${esc(p.name)}">`).join('');
}

export function renderProfileList() {
  const el = document.getElementById('profileListUI');
  if (!el) return;
  if (!S.machineProfiles.length) {
    el.innerHTML = `<div class="lib-empty">${t('lib_empty_profiles')}</div>`;
    return;
  }
  el.innerHTML = S.machineProfiles.map(p => `<div class="lib-item">
      <div class="lib-item-info">
        <div class="lib-item-name">${esc(p.name)}</div>
      </div>
      <div class="lib-item-actions">
        <button class="lib-btn-sm lib-btn-icon" data-action="edit-profile" data-id="${p.id}" title="${t('lib_btn_edit')}">${ICON_PENCIL}</button>
        <button class="lib-btn-sm del lib-btn-icon" data-action="delete-profile" data-id="${p.id}" title="${t('lib_btn_delete')}">${ICON_TRASH}</button>
      </div>
    </div>`).join('');
}

export async function editProfile(id) {
  const r = await apiFetch(`api/machine/profile/${id}`);
  if (!r.ok) { window.showToast?.(t('profile_load_error')); return; }
  const profile = await r.json();
  openProfileForm(profile);
}

export async function deleteMachineProfile(id) {
  if (!confirm(t('profile_confirm_delete'))) return;
  const r = await apiFetch(`api/machine/profile/${id}`, { method: 'DELETE' });
  if (!r.ok) { window.showToast?.(t('profile_send_error')); return; }
  await loadMachineProfileList();
}

// ── Editor modal ─────────────────────────────────────────────────────────
export function openProfileForm(profile, beanId) {
  S.profileEditId     = profile?.id ?? null;
  S.profileEditBeanId = beanId ?? null;
  document.getElementById('profileFormName').value       = profile?.name ?? '';
  document.getElementById('profileFormWaterTemp').value   = profile?.waterTemperature ?? '';
  document.getElementById('profileFormCoffeeIn').value    = profile?.recipe?.coffeeIn ?? '';
  document.getElementById('profileFormCoffeeOut').value   = profile?.recipe?.coffeeOut ?? '';
  document.getElementById('profileFormRatio').value       = profile?.recipe?.ratio ?? '';
  document.getElementById('profileFormWeight').value      = profile?.globalStopConditions?.weight ?? '';
  _renderPhaseRows(profile?.phases || []);
  document.getElementById('profileApplySuggestionBtn').style.display = beanId != null ? '' : 'none';
  document.getElementById('profileEditorModal').classList.add('open');
  document.getElementById('profileEditorModal').style.display = 'flex';
  renderProfilePreviewChart();
  document.getElementById('profileFormName').focus();
}

export function closeProfileForm() {
  S.profileEditId     = null;
  S.profileEditBeanId = null;
  document.getElementById('profileEditorModal').classList.remove('open');
  document.getElementById('profileEditorModal').style.display = 'none';
  if (S.profilePreviewChart) { S.profilePreviewChart.destroy(); S.profilePreviewChart = null; }
}

export function openNewProfileForm() {
  openProfileForm(null, null);
}

// Opened from a bean card's "Create profile" button — empty editor with the
// bean's suggestion pre-filled, so Max never has to re-type Sertao's shape.
export function createProfileFromBean(beanId) {
  const bean = S.coffeeLibrary.beans.find(b => b.id === beanId);
  if (!bean) return;
  openProfileForm(null, beanId);
  _applySuggestion(bean);
}

export function applyBeanSuggestion() {
  const bean = S.coffeeLibrary.beans.find(b => b.id === S.profileEditBeanId);
  if (!bean) return;
  _applySuggestion(bean);
}

function _applySuggestion(bean) {
  const suggestion = suggestProfileFromBean(bean);
  document.getElementById('profileFormName').value      = suggestion.name;
  document.getElementById('profileFormWaterTemp').value = suggestion.waterTemperature;
  document.getElementById('profileFormCoffeeIn').value  = suggestion.recipe.coffeeIn;
  document.getElementById('profileFormCoffeeOut').value = suggestion.recipe.coffeeOut;
  document.getElementById('profileFormRatio').value     = suggestion.recipe.ratio;
  document.getElementById('profileFormWeight').value    = suggestion.globalStopConditions.weight;
  _renderPhaseRows(suggestion.phases);
  renderProfilePreviewChart();
}

// ── Phase editor (DOM-as-state, mirrors library.js's recipe-step editor) ──
function _renderPhaseRows(phases) {
  const list = document.getElementById('profilePhaseList');
  if (!list) return;
  list.innerHTML = (phases || []).map((p, i) => _phaseRowHtml(i, p)).join('');
}

function _phaseRowHtml(i, p = {}) {
  const target = p.target || {};
  const stop   = p.stopConditions || {};
  const type   = typeof p.type === 'string' ? p.type : PHASE_TYPES[p.type] || 'FLOW';
  const curve  = typeof target.curve === 'string' ? target.curve : CURVES[target.curve] || 'LINEAR';
  return `<div class="pp-row" id="profilePhase${i}">
    <div class="pp-header">
      <span class="pp-num">${i + 1}</span>
      <input class="pp-name" placeholder="${t('profile_phase_name')}" value="${esc(p.name || '')}">
      <select class="pp-type">
        ${PHASE_TYPES.map(pt => `<option value="${pt}" ${pt === type ? 'selected' : ''}>${t('phase_type_' + pt.toLowerCase())}</option>`).join('')}
      </select>
      <label class="lib-check-label pp-skip-label">
        <input type="checkbox" class="pp-skip" ${p.skip ? 'checked' : ''}>
        <span>${t('profile_phase_skip')}</span>
      </label>
      <button class="lib-btn-sm del lib-btn-icon" data-action="remove-profile-phase" data-idx="${i}">${ICON_TRASH}</button>
    </div>
    <div class="pp-grid">
      <div class="pp-field"><label>${t('profile_phase_target_start')}</label><input type="number" step="0.1" class="pp-target-start" value="${target.start ?? ''}"></div>
      <div class="pp-field"><label>${t('profile_phase_target_end')}</label><input type="number" step="0.1" class="pp-target-end" value="${target.end ?? ''}"></div>
      <div class="pp-field"><label>${t('profile_phase_target_curve')}</label>
        <select class="pp-target-curve">${CURVES.map(c => `<option value="${c}" ${c === curve ? 'selected' : ''}>${t('curve_' + c.toLowerCase())}</option>`).join('')}</select>
      </div>
      <div class="pp-field"><label>${t('profile_phase_target_time')}</label><input type="number" step="1" class="pp-target-time" value="${target.time ?? ''}"></div>
      <div class="pp-field"><label>${t('profile_phase_restriction')}</label><input type="number" step="0.1" class="pp-restriction" value="${p.restriction ?? ''}"></div>
      <div class="pp-field"><label>${t('profile_stop_time')}</label><input type="number" step="1" class="pp-stop-time" value="${stop.time ?? ''}"></div>
      <div class="pp-field"><label>${t('profile_stop_pressure_above')}</label><input type="number" step="0.1" class="pp-stop-pressure-above" value="${stop.pressureAbove ?? ''}"></div>
      <div class="pp-field"><label>${t('profile_stop_pressure_below')}</label><input type="number" step="0.1" class="pp-stop-pressure-below" value="${stop.pressureBelow ?? ''}"></div>
      <div class="pp-field"><label>${t('profile_stop_flow_above')}</label><input type="number" step="0.1" class="pp-stop-flow-above" value="${stop.flowAbove ?? ''}"></div>
      <div class="pp-field"><label>${t('profile_stop_flow_below')}</label><input type="number" step="0.1" class="pp-stop-flow-below" value="${stop.flowBelow ?? ''}"></div>
      <div class="pp-field"><label>${t('profile_stop_weight')}</label><input type="number" step="0.1" class="pp-stop-weight" value="${stop.weight ?? ''}"></div>
      <div class="pp-field"><label>${t('profile_stop_water_pumped')}</label><input type="number" step="0.1" class="pp-stop-water-pumped" value="${stop.waterPumpedInPhase ?? ''}"></div>
    </div>
  </div>`;
}

export function addProfilePhase() {
  const list = document.getElementById('profilePhaseList');
  if (!list) return;
  const idx = list.children.length;
  list.insertAdjacentHTML('beforeend', _phaseRowHtml(idx));
}

export function removeProfilePhase(i) {
  const row = document.getElementById(`profilePhase${i}`);
  if (row) row.remove();
  // Re-number remaining rows — same detail as removeRecipeStep() in
  // library.js: ids and the delete button's data-idx must stay in sync
  // with DOM order since the DOM is the only source of truth.
  document.querySelectorAll('#profilePhaseList .pp-row').forEach((row, idx) => {
    row.id = `profilePhase${idx}`;
    row.querySelector('.pp-num').textContent = idx + 1;
    const delBtn = row.querySelector('.lib-btn-sm.del');
    delBtn.dataset.action = 'remove-profile-phase';
    delBtn.dataset.idx = String(idx);
  });
  renderProfilePreviewChart();
}

function _collectPhases() {
  return [...document.querySelectorAll('#profilePhaseList .pp-row')].map(row => ({
    name: row.querySelector('.pp-name')?.value.trim() || '',
    type: row.querySelector('.pp-type')?.value || 'FLOW',
    target: {
      start: parseFloat(row.querySelector('.pp-target-start')?.value) || 0,
      end:   parseFloat(row.querySelector('.pp-target-end')?.value) || 0,
      curve: row.querySelector('.pp-target-curve')?.value || 'LINEAR',
      time:  parseFloat(row.querySelector('.pp-target-time')?.value) || 0,
    },
    restriction: parseFloat(row.querySelector('.pp-restriction')?.value) || 0,
    stopConditions: {
      time:               parseFloat(row.querySelector('.pp-stop-time')?.value) || 0,
      pressureAbove:      parseFloat(row.querySelector('.pp-stop-pressure-above')?.value) || 0,
      pressureBelow:      parseFloat(row.querySelector('.pp-stop-pressure-below')?.value) || 0,
      flowAbove:          parseFloat(row.querySelector('.pp-stop-flow-above')?.value) || 0,
      flowBelow:          parseFloat(row.querySelector('.pp-stop-flow-below')?.value) || 0,
      weight:             parseFloat(row.querySelector('.pp-stop-weight')?.value) || 0,
      waterPumpedInPhase: parseFloat(row.querySelector('.pp-stop-water-pumped')?.value) || 0,
    },
    skip: !!row.querySelector('.pp-skip')?.checked,
  }));
}

function _collectProfile() {
  const name = document.getElementById('profileFormName').value.trim();
  return {
    name,
    waterTemperature: parseFloat(document.getElementById('profileFormWaterTemp').value) || 0,
    recipe: {
      coffeeIn:  parseFloat(document.getElementById('profileFormCoffeeIn').value) || 0,
      coffeeOut: parseFloat(document.getElementById('profileFormCoffeeOut').value) || 0,
      ratio:     parseFloat(document.getElementById('profileFormRatio').value) || 0,
    },
    globalStopConditions: {
      weight: parseFloat(document.getElementById('profileFormWeight').value) || 0,
    },
    phases: _collectPhases(),
  };
}

// ── "Send to machine" ───────────────────────────────────────────────────
export async function sendProfileToMachine() {
  const profile = _collectProfile();
  if (!profile.name) { document.getElementById('profileFormName').focus(); return; }
  if (!profile.phases.length) { window.showToast?.(t('profile_no_phases_error')); return; }
  if (!confirm(t('profile_confirm_send'))) return;

  const url    = S.profileEditId ? `api/machine/profile/${S.profileEditId}` : 'api/machine/profile';
  const method = S.profileEditId ? 'PUT' : 'POST';
  const r = await apiFetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(profile) });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    window.showToast?.(t('profile_send_error') + (body.error ? `: ${body.error}` : ''));
    return;
  }
  closeProfileForm();
  await loadMachineProfileList();
}

// ── Preview chart ─────────────────────────────────────────────────────────
// Synthesizes a time series from the phase list — pro-Phase target.curve
// interpolation from start→end over target.time ms — and draws it exactly
// like the shot-detail chart draws its dashed target-curves (destroy-before-
// recreate, see public-src/views/shots/index.js's espressoShotChart setup).
function _curveInterpolate(curve, frac) {
  switch (curve) {
    case 'INSTANT': return 1;
    case 'EASE_IN':  return frac * frac;
    case 'EASE_OUT': return 1 - (1 - frac) * (1 - frac);
    case 'EASE_IN_OUT': return frac < 0.5 ? 2 * frac * frac : 1 - Math.pow(-2 * frac + 2, 2) / 2;
    case 'LINEAR':
    default: return frac;
  }
}

function _synthesizeSeries(phases) {
  const points = [];
  let tMs = 0;
  for (const p of phases) {
    if (p.skip) continue;
    const target   = p.target || {};
    const start    = target.start ?? 0;
    const end      = target.end ?? start;
    const duration = target.time || (p.stopConditions?.time) || 1000;
    const steps    = Math.max(2, Math.round(duration / 250));
    for (let s = 0; s <= steps; s++) {
      const frac  = s / steps;
      const value = start + (end - start) * _curveInterpolate(target.curve, frac);
      points.push({ x: (tMs + frac * duration) / 1000, y: value, type: p.type });
    }
    tMs += duration;
  }
  return points;
}

export function renderProfilePreviewChart() {
  const ctx = document.getElementById('profilePreviewChart');
  if (!ctx || typeof Chart === 'undefined') return;
  const existing = Chart.getChart(ctx);
  if (existing) existing.destroy();
  S.profilePreviewChart = null;

  const phases = _collectPhases();
  const series = _synthesizeSeries(phases);
  if (!series.length) return;

  S.profilePreviewChart = new Chart(ctx, {
    type: 'line',
    data: {
      datasets: [{
        label: t('profile_preview_label'),
        data: series.map(pt => ({ x: pt.x, y: pt.y })),
        borderColor: '#3498db',
        backgroundColor: 'transparent',
        borderWidth: 2,
        tension: 0.15,
        pointStyle: false,
        stepped: false,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      scales: {
        x: { type: 'linear', title: { display: true, text: t('profile_preview_x_axis') } },
        y: { title: { display: true, text: t('profile_preview_y_axis') } },
      },
    },
  });
}
