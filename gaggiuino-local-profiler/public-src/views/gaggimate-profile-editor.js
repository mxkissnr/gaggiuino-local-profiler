// GaggiMate profile editor — Standard + Pro. _profile is the source of
// truth; _render() rebuilds #gmEditorBody from it on every change.
import Chart from 'chart.js/auto';
import { S } from '../state.js';
import { t } from '../i18n.js';
import { apiFetch } from '../api.js';
import { esc } from '../utils.js';
import { phasePlugin, buildGmPhaseRanges } from '../constants.js';
import { loadMachineProfileList } from './library-profile-editor.js';
import { invalidateGmPhaseCache } from './shots/index.js';

// ── State ─────────────────────────────────────────────────────────────────

let _profile = null;
let _currentPhaseIdx = 0; // active phase for pro editor
let _saving = false;
let _chart = null;
let _inputsBound = false; // guards against accumulating body change-listeners across renders

// ── Entry points ──────────────────────────────────────────────────────────

export async function openGaggiMateProfileEditor(id) {
  const machineId = S.activeMachineId ?? '';
  const r = await apiFetch(`api/machine/profile/${id}?machineId=${machineId}`);
  if (!r.ok) { window.showToast?.(t('gm_toast_load_error')); return; }
  const profile = await r.json();
  _openEditor(profile);
}

export function openNewGaggiMateProfile() {
  _openEditor({
    label: t('gm_new_profile_label'),
    description: '',
    temperature: 93,
    type: 'standard',
    utility: false,
    favorite: false,
    phases: [_newStandardPhase(t('gm_phase_type_preinfusion'), 'preinfusion'), _newStandardPhase(t('gm_phase_type_brew'), 'brew')],
  });
}

export function closeGaggiMateEditor() {
  document.getElementById('gmProfileEditorModal').style.display = 'none';
  _profile = null;
  _saving = false;
  _inputsBound = false;
  if (_chart) { _chart.destroy(); _chart = null; }
}

export async function saveGaggiMateProfile() {
  if (!_profile || _saving) return;
  if (!_profile.label?.trim()) { window.showToast?.(t('gm_toast_name_required')); return; }
  if (!_profile.phases?.length) { window.showToast?.(t('gm_toast_phase_required')); return; }
  _saving = true;
  _render();

  const machineId = S.activeMachineId;
  const body = { ..._profile, machineId };
  const isEdit = _profile.id != null;
  const url = isEdit ? `api/machine/profile/${_profile.id}` : 'api/machine/profile';
  const method = isEdit ? 'PUT' : 'POST';

  try {
    const r = await apiFetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      window.showToast?.(err.error || t('gm_toast_save_error'));
      return;
    }
    invalidateGmPhaseCache(machineId);
    closeGaggiMateEditor();
    await loadMachineProfileList();
  } finally {
    // eslint-disable-next-line require-atomic-updates -- guarded by _saving check at entry
    _saving = false;
    if (_profile) _render();
  }
}

// ── Internal ──────────────────────────────────────────────────────────────

function _openEditor(profile) {
  _profile = profile;
  _currentPhaseIdx = 0;
  _saving = false;
  _inputsBound = false;
  const modal = document.getElementById('gmProfileEditorModal');
  modal.style.display = 'flex';
  document.getElementById('gmEditorTitle').textContent =
    profile.id != null ? t('gm_editor_title_edit', profile.label) : t('gm_editor_title_new');
  _render();
}

function _set(updates) {
  _profile = { ..._profile, ...updates };
  _render();
}

function _setPhase(idx, updates) {
  const phases = [...(_profile.phases || [])];
  phases[idx] = { ...phases[idx], ...updates };
  _profile = { ..._profile, phases };
  _render();
}

function _addPhase() {
  const isPro = _profile.type === 'pro';
  const phase = isPro ? _newProPhase(t('gm_new_phase_label'), 'brew') : _newStandardPhase(t('gm_new_phase_label'), 'brew');
  const phases = [...(_profile.phases || []), phase];
  _profile = { ..._profile, phases };
  _currentPhaseIdx = phases.length - 1;
  _render();
}

function _removePhase(idx) {
  const phases = (_profile.phases || []).filter((_, i) => i !== idx);
  _profile = { ..._profile, phases };
  _currentPhaseIdx = Math.min(_currentPhaseIdx, Math.max(0, phases.length - 1));
  _render();
}

function _newStandardPhase(name, phase) {
  return { name, phase, valve: 1, pump: 100, duration: 5, targets: [] };
}

function _newProPhase(name, phase) {
  return {
    name, phase, valve: 1, pump: 100, duration: 5, temperature: 0,
    targets: [],
    transition: { type: 'instant', duration: 0, adaptive: true, target: 'time' },
  };
}

// ── Render ────────────────────────────────────────────────────────────────

function _render() {
  const body = document.getElementById('gmEditorBody');
  if (!body || !_profile) return;
  const isPro = _profile.type === 'pro';
  try {
    body.innerHTML = _renderBody(isPro);
    _initChart();
  } catch (e) {
    console.error('[GLP] GaggiMate editor render error:', e);
    body.innerHTML = `<div style="padding:1rem;color:var(--red-400)">Render-Fehler: ${e.message}</div>`;
  }
  _bindInputs();
}

function _renderBody(isPro) {
  const phases = _profile.phases || [];
  return `
    ${_renderInfo()}
    ${_renderChart()}
    ${isPro ? _renderProPhases(phases) : _renderStandardPhases(phases)}
    ${_saving ? '<div style="text-align:center;padding:.5rem;opacity:.6">Wird gespeichert…</div>' : ''}
  `;
}

// ── Profile chart (Chart.js) ───────────────────────────────────────────────

const MAX_PHASE_DUR = 300; // s — chart preview cap; prevents multi-million-point arrays on typos
function _phaseDur(ph) { return Math.min(ph.duration || 5, MAX_PHASE_DUR); }

function _easeLinear(x) { return x; }
function _easeIn(x) { return x * x; }
function _easeOut(x) { return 1 - (1 - x) * (1 - x); }
function _easeInOut(x) { return x < 0.5 ? 2 * x * x : 1 - 2 * (1 - x) * (1 - x); }
function _applyEasing(x, type) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  switch (type) {
    case 'linear': return _easeLinear(x);
    case 'ease-in': return _easeIn(x);
    case 'ease-out': return _easeOut(x);
    case 'ease-in-out': return _easeInOut(x);
    case 'instant':
    default: return 1;
  }
}

const CHART_POINT_INTERVAL = 0.1; // s — matches GaggiMate's ExtendedProfileChart

// Port of GaggiMate's ExtendedProfileChart.jsx prepareData(). `target` on
// each point marks whether it's the phase's actively controlled parameter
// (drawn solid) vs a held/incidental value (drawn dashed).
function _preparePumpSeries(phases, target) {
  if (!phases.length) return [];
  const data = [];
  let time = 0, phaseTime = 0, phaseIndex = 0;
  let currentPhase = phases[phaseIndex];
  let currentPressure, currentFlow;
  let phaseStartFlow = 0, phaseStartPressure = 0;
  let effectiveFlow = currentPhase.pump?.flow || 0;
  let effectivePressure = currentPhase.pump?.pressure || 0;

  do {
    currentPhase = phases[phaseIndex];
    const dur = _phaseDur(currentPhase);
    const alpha = _applyEasing(
      phaseTime / (currentPhase.transition?.duration || dur),
      currentPhase?.transition?.type || 'linear',
    );
    currentFlow = currentPhase.pump?.target === 'flow'
      ? phaseStartFlow + (effectiveFlow - phaseStartFlow) * alpha
      : (currentPhase.pump?.flow || 0);
    currentPressure = currentPhase.pump?.target === 'pressure'
      ? phaseStartPressure + (effectivePressure - phaseStartPressure) * alpha
      : (currentPhase.pump?.pressure || 0);
    data.push({
      x: time,
      y: target === 'pressure' ? currentPressure : currentFlow,
      target: currentPhase.pump?.target === target,
    });
    time += CHART_POINT_INTERVAL;
    phaseTime += CHART_POINT_INTERVAL;
    if (phaseTime >= dur) {
      phaseTime = 0;
      phaseIndex++;
      if (phaseIndex < phases.length) {
        phaseStartFlow = currentFlow;
        phaseStartPressure = currentPressure;
        const nextPhase = phases[phaseIndex];
        effectiveFlow = nextPhase.pump?.flow === -1 ? currentFlow : (nextPhase.pump?.flow || 0);
        effectivePressure = nextPhase.pump?.pressure === -1 ? currentPressure : (nextPhase.pump?.pressure || 0);
      }
    }
  } while (phaseIndex < phases.length);

  return data;
}

function _buildChartData() {
  const phases = _profile?.phases || [];
  if (!phases.length) return null;
  const isPro = _profile.type === 'pro';

  const gmPhases = buildGmPhaseRanges(phases);
  const totalTime = gmPhases.length ? gmPhases[gmPhases.length - 1].t1 : 0;

  if (isPro) {
    const pressureData = _preparePumpSeries(phases, 'pressure');
    const flowData = _preparePumpSeries(phases, 'flow');
    return { pressureData, flowData, powerData: [], gmPhases, totalTime };
  }

  // Standard: pump is a plain 0-100 power % (0 = off). GaggiMate itself
  // doesn't chart these — GLP shows a simple stepped power line instead.
  const powerData = [];
  let running = 0, lastPct = 0;
  for (const ph of phases) {
    const pct = typeof ph.pump === 'number' ? ph.pump : 0;
    powerData.push({ x: running, y: pct });
    lastPct = pct;
    running += _phaseDur(ph);
  }
  if (powerData.length) powerData.push({ x: running, y: lastPct });

  return { pressureData: [], flowData: [], powerData, gmPhases, totalTime };
}

function _renderChart() {
  const phases = _profile?.phases || [];
  if (!phases.length) return '';
  return `<div class="gm-chart-container"><canvas id="gmProfileChart"></canvas></div>`;
}

function _initChart() {
  // #gmEditorBody's innerHTML is fully replaced each render, so this canvas
  // is always fresh — only our own tracked `_chart` needs disposal.
  const canvas = document.getElementById('gmProfileChart');
  if (!canvas) return;
  if (_chart) { _chart.destroy(); _chart = null; }

  const d = _buildChartData();
  if (!d) return;

  const { pressureData, flowData, powerData, gmPhases, totalTime } = d;
  const isPro = _profile.type === 'pro';

  // Dashed+dimmed where the point isn't the phase's controlled parameter.
  const dashed = (color) => (ctx) => (!ctx.p0.raw.target ? color : undefined);

  const datasets = [];
  if (isPro) {
    datasets.push({
      label: t('gm_chart_pressure'),
      data: pressureData,
      yAxisID: 'y',
      borderWidth: 2.5,
      tension: 0.4,
      cubicInterpolationMode: 'monotone',
      borderColor: '#3498db',
      backgroundColor: 'transparent',
      segment: {
        borderColor: dashed('rgba(52,152,219,0.45)'),
        borderDash: dashed([6, 6]),
      },
      spanGaps: true,
      fill: false,
      pointStyle: false,
    });
    datasets.push({
      label: t('gm_chart_flow'),
      data: flowData,
      yAxisID: 'y1',
      borderWidth: 2,
      tension: 0.4,
      cubicInterpolationMode: 'monotone',
      borderColor: '#f39c12',
      backgroundColor: 'transparent',
      segment: {
        borderColor: dashed('rgba(243,156,18,0.45)'),
        borderDash: dashed([6, 6]),
      },
      spanGaps: true,
      fill: false,
      pointStyle: false,
    });
  } else {
    datasets.push({
      label: t('gm_chart_power'),
      data: powerData,
      yAxisID: 'y',
      borderWidth: 2.5,
      tension: 0,
      stepped: true,
      borderColor: '#ed8936',
      backgroundColor: 'rgba(237,137,54,0.12)',
      fill: 'origin',
      pointStyle: false,
    });
  }

  const C = {
    tick: 'rgba(160,160,160,0.75)',
    grid: 'rgba(90,90,90,0.5)',
    text: 'rgba(180,180,180,0.85)',
  };

  const yMax = isPro ? 12 : 100;
  const y1Max = 10;
  const yTickCb = isPro ? v => `${v}` : v => `${v}%`;

  try {
    _chart = new Chart(canvas, {
      type: 'line',
      plugins: [phasePlugin],
      data: { datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        layout: { padding: { bottom: 4 } },
        interaction: { mode: 'index', intersect: false },
        plugins: {
          phases: { gaggimatePhases: gmPhases },
          legend: {
            display: isPro,
            position: 'bottom',
            labels: { color: C.text, font: { family: 'Figtree', size: 10 }, boxWidth: 10, padding: 6 },
          },
          tooltip: {
            callbacks: {
              title: ctx => {
                const time = ctx[0].parsed.x;
                const ph = gmPhases.find(p => time >= p.t0 && time <= p.t1);
                return ph?.name ? `${ph.name} — ${time.toFixed(1)}s` : `${time.toFixed(1)}s`;
              },
            },
          },
        },
        scales: {
          x: {
            type: 'linear', min: 0, max: totalTime, clip: false,
            ticks: { color: C.tick, font: { family: 'Figtree' }, stepSize: 5, callback: v => `${v}s`, maxTicksLimit: 10 },
            grid: { color: C.grid },
          },
          y: {
            type: 'linear', position: 'left', min: 0, max: yMax,
            ticks: { color: C.tick, maxTicksLimit: 6, callback: yTickCb },
            grid: { color: C.grid },
          },
          ...(isPro ? {
            y1: {
              type: 'linear', position: 'right', min: 0, max: y1Max,
              ticks: { color: C.tick, maxTicksLimit: 6 },
              grid: { drawOnChartArea: false },
            },
          } : {}),
        },
      },
    });
  } catch(e) {
    console.error('[GLP initChart] Chart.js error:', e.message, 'datasets:', datasets.length);
  }
}

// Shared toggle-button-group markup. `idx` omitted for profile-level toggles.
function _toggleGroup(action, options, activeVal, idx) {
  const idxAttr = idx != null ? ` data-idx="${idx}"` : '';
  return `<div class="gm-toggle-group">${options.map(o =>
    `<button type="button" class="lib-btn-sm${o.val === activeVal ? ' active' : ''}" data-action="${action}"${idxAttr} data-val="${o.val}">${o.label}</button>`
  ).join('')}</div>`;
}

// Identical between Standard and Pro phases (only data-action differs).
function _phaseTypeSelect(ph, i, action) {
  return `<select class="lib-select" data-action="${action}" data-idx="${i}">
      <option value="preinfusion"${ph.phase === 'preinfusion' ? ' selected' : ''}>${t('gm_phase_type_preinfusion')}</option>
      <option value="brew"${ph.phase === 'brew' ? ' selected' : ''}>${t('gm_phase_type_brew')}</option>
    </select>`;
}
function _durationField(ph, i, action) {
  return `<div class="lib-form-field">
      <label>${t('gm_field_duration')}</label>
      <input type="number" class="lib-input" value="${ph.duration ?? 0}" min="1" max="${MAX_PHASE_DUR}" step="1"
        data-action="${action}" data-idx="${i}">
    </div>`;
}
function _valveToggle(ph, i, action) {
  return _toggleGroup(action, [{ val: '0', label: t('gm_valve_closed') }, { val: '1', label: t('gm_valve_open') }], ph.valve ? '1' : '0', i);
}

// Pro layers hold-pressure/hold-flow detection on top of this.
function _pumpMode(ph) {
  const pump = ph.pump;
  const pumpIsNumber = typeof pump === 'number';
  return {
    pumpIsNumber,
    mode: pumpIsNumber ? (pump === 0 ? 'off' : 'power') : pump?.target,
    pumpPower: pumpIsNumber ? pump : 100,
  };
}

function _renderInfo() {
  return `
    <div class="lib-form-grid">
      <div class="lib-form-field">
        <label>${t('gm_field_name')}</label>
        <input type="text" id="gmLabel" value="${esc(_profile.label || '')}" maxlength="48" placeholder="${esc(t('gm_field_name_placeholder'))}">
      </div>
      <div class="lib-form-field">
        <label>${t('gm_field_description')}</label>
        <textarea id="gmDescription" class="lib-input" rows="2" style="width:100%;resize:vertical">${esc(_profile.description || '')}</textarea>
      </div>
      <div class="lib-form-field">
        <label>${t('gm_field_temperature')}</label>
        <input type="number" id="gmTemperature" value="${_profile.temperature ?? 93}" min="0" max="150" step="0.5">
      </div>
      <div class="lib-form-field">
        <label>${t('gm_field_type')}</label>
        ${_toggleGroup('gm-type', [{ val: 'standard', label: t('gm_type_standard') }, { val: 'pro', label: t('gm_type_pro') }], _profile.type)}
      </div>
      <div class="lib-form-field" style="flex-direction:row;align-items:center;gap:.75rem">
        <label style="margin:0">${t('gm_field_favorite')}</label>
        <input type="checkbox" id="gmFavorite" class="toggle toggle-sm" ${_profile.favorite ? 'checked' : ''}>
        <label style="margin:0;margin-left:1rem">${t('gm_field_utility')}</label>
        <input type="checkbox" id="gmUtility" class="toggle toggle-sm" ${_profile.utility ? 'checked' : ''}>
      </div>
    </div>
  `;
}

// ── Standard profile phases ───────────────────────────────────────────────

function _renderStandardPhases(phases) {
  const rows = phases.map((ph, i) => _renderStandardPhase(ph, i)).join(
    '<div style="text-align:center;padding:.25rem;opacity:.4">↓</div>'
  );
  return `
    <div class="lib-recipe-steps-section">
      <div class="lib-recipe-steps-header">
        <span>${t('gm_phases_header')}</span>
        <button class="lib-btn-sm" data-action="gm-add-phase">${t('gm_add_phase')}</button>
      </div>
      <div id="gmPhaseList">${rows || `<div style="opacity:.5;padding:.5rem">${t('gm_no_phases')}</div>`}</div>
    </div>
  `;
}

function _renderStandardPhase(ph, i) {
  const { mode, pumpPower } = _pumpMode(ph);
  const volTarget = (ph.targets || []).find(tg => tg.type === 'volumetric');
  const volValue = volTarget?.value ?? 0;

  return `
    <div class="gm-phase" data-phase-idx="${i}">
      <div style="display:flex;gap:.5rem;margin-bottom:.5rem">
        ${_phaseTypeSelect(ph, i, 'gm-std-phase-type')}
        <input type="text" class="lib-input flex-1" value="${esc(ph.name || '')}"
          data-action="gm-std-phase-name" data-idx="${i}" placeholder="${esc(t('gm_phase_name_placeholder'))}">
        <button class="lib-btn-sm del" data-action="gm-remove-phase" data-idx="${i}" title="${esc(t('gm_remove_phase_title'))}">✕</button>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:.5rem;margin-bottom:.5rem">
        ${_durationField(ph, i, 'gm-std-duration')}
        <div class="lib-form-field">
          <label>${t('gm_field_stop_weight')}</label>
          <input type="number" class="lib-input" value="${volValue}" min="0" step="0.1"
            data-action="gm-std-vol-target" data-idx="${i}">
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:.5rem">
        <div class="lib-form-field">
          <label>${t('gm_field_valve')}</label>
          ${_valveToggle(ph, i, 'gm-std-valve')}
        </div>
        <div class="lib-form-field">
          <label>${t('gm_field_pump')}</label>
          ${_toggleGroup('gm-std-pump-mode', [{ val: 'off', label: t('gm_pump_off') }, { val: 'power', label: t('gm_pump_power') }], mode, i)}
        </div>
      </div>
      ${mode === 'power' ? `
        <div class="lib-form-field" style="margin-top:.5rem">
          <label>${t('gm_field_pump_power')}</label>
          <input type="number" class="lib-input" value="${pumpPower}" min="0" max="100" step="1"
            data-action="gm-std-pump-power" data-idx="${i}">
        </div>` : ''}
    </div>
  `;
}

// ── Pro (Extended) profile phases ─────────────────────────────────────────

// Function, not a constant — labels must re-resolve on language change.
function _targetTypes() {
  return [
    { label: t('gm_target_pumped_gte'),     type: 'pumped',     operator: 'gte', unit: 'ml'   },
    { label: t('gm_target_volumetric_gte'), type: 'volumetric', operator: 'gte', unit: 'g'    },
    { label: t('gm_target_pressure_gte'),   type: 'pressure',   operator: 'gte', unit: 'bar'  },
    { label: t('gm_target_pressure_lte'),   type: 'pressure',   operator: 'lte', unit: 'bar'  },
    { label: t('gm_target_flow_gte'),       type: 'flow',       operator: 'gte', unit: 'ml/s' },
    { label: t('gm_target_flow_lte'),       type: 'flow',       operator: 'lte', unit: 'ml/s' },
  ];
}

function _renderProPhases(phases) {
  const n = phases.length;
  const i = _currentPhaseIdx;
  const ph = phases[i];
  const nav = `
    <div class="gm-phase-nav">
      <button class="lib-btn-sm" data-action="gm-phase-prev" ${i === 0 ? 'disabled' : ''}>◀</button>
      <span>${n > 0 ? `${i + 1} / ${n}` : '0 / 0'}</span>
      <button class="lib-btn-sm" data-action="gm-phase-next" ${i >= n - 1 ? 'disabled' : ''}>▶</button>
      <button class="lib-btn-sm" data-action="gm-add-phase">${t('gm_add_phase')}</button>
      <button class="lib-btn-sm del" data-action="gm-remove-phase" data-idx="${i}" ${n === 0 ? 'disabled' : ''}>✕ ${t('gm_remove_phase_label')}</button>
    </div>
  `;
  return `
    <div class="lib-recipe-steps-section">
      <div class="lib-recipe-steps-header"><span>${t('gm_phases_pro_header')}</span></div>
      ${nav}
      <div id="gmProPhaseDetail">
        ${ph ? _renderProPhase(ph, i) : `<div style="opacity:.5;padding:.5rem">${t('gm_no_phases_add')}</div>`}
      </div>
    </div>
  `;
}

function _renderProPhase(ph, i) {
  const { pumpIsNumber, pumpPower, mode: baseMode } = _pumpMode(ph);
  let mode = baseMode;
  const pressure = pumpIsNumber ? 0 : (ph.pump?.pressure ?? 0);
  const flow = pumpIsNumber ? 0 : (ph.pump?.flow ?? 0);
  if (mode === 'pressure' && pressure === -1) mode = 'hold-pressure';
  if (mode === 'flow' && flow === -1) mode = 'hold-flow';
  const trans = ph.transition || {};
  const rampType = trans.type || 'instant';
  const rampTarget = trans.target || 'time';
  const rampUnit = rampTarget === 'volumetric' ? 'g' : rampTarget === 'pumped' ? 'ml' : 's';
  const targets = ph.targets || [];
  const usedKeys = new Set(targets.map(tg => `${tg.type}:${tg.operator}`));
  const availTargets = _targetTypes().filter(tt => !usedKeys.has(`${tt.type}:${tt.operator}`));

  return `
    <div class="gm-phase">
      <div style="display:flex;gap:.5rem;margin-bottom:.5rem">
        ${_phaseTypeSelect(ph, i, 'gm-pro-phase-type')}
        <input type="text" class="lib-input flex-1" value="${esc(ph.name || '')}"
          data-action="gm-pro-phase-name" data-idx="${i}" placeholder="${esc(t('gm_phase_name_placeholder'))}">
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:.5rem;margin-bottom:.5rem">
        ${_durationField(ph, i, 'gm-pro-duration')}
        <div class="lib-form-field">
          <label>${t('gm_field_temperature_pro')}</label>
          <input type="number" class="lib-input" value="${ph.temperature ?? 0}" min="0" max="150" step="0.5"
            data-action="gm-pro-temperature" data-idx="${i}">
        </div>
      </div>

      <div class="lib-form-field" style="margin-bottom:.5rem">
        <label>${t('gm_field_valve')}</label>
        ${_valveToggle(ph, i, 'gm-pro-valve')}
      </div>

      <div class="lib-form-field" style="margin-bottom:.5rem">
        <label>${t('gm_field_pump_mode')}</label>
        ${_toggleGroup('gm-pro-pump-mode', [
          { val: 'off', label: t('gm_pump_off') }, { val: 'power', label: t('gm_pump_power') },
          { val: 'pressure', label: t('gm_pump_pressure') }, { val: 'flow', label: t('gm_pump_flow') },
          { val: 'hold-pressure', label: t('gm_pump_hold_pressure') }, { val: 'hold-flow', label: t('gm_pump_hold_flow') },
        ], mode, i)}
      </div>

      ${mode === 'power' ? `
        <div class="lib-form-field" style="margin-bottom:.5rem">
          <label>${t('gm_field_pump_power')}</label>
          <input type="number" class="lib-input" value="${pumpPower}" min="0" max="100" step="1"
            data-action="gm-pro-pump-power" data-idx="${i}">
        </div>` : ''}

      ${(mode === 'pressure' || mode === 'flow') ? `
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:.5rem;margin-bottom:.5rem">
          <div class="lib-form-field">
            <label>${mode === 'pressure' ? t('gm_field_pressure_target') : t('gm_field_pressure_max')} (bar)</label>
            <input type="number" class="lib-input" value="${pressure}" min="0.1" step="0.01"
              data-action="gm-pro-pressure" data-idx="${i}">
          </div>
          <div class="lib-form-field">
            <label>${mode === 'flow' ? t('gm_field_flow_target') : t('gm_field_flow_max')} (ml/s)</label>
            <input type="number" class="lib-input" value="${flow}" min="0.1" step="0.01"
              data-action="gm-pro-flow" data-idx="${i}">
          </div>
        </div>` : ''}

      <div class="lib-form-field" style="margin-bottom:.5rem">
        <label>${t('gm_field_ramp_style')}</label>
        ${_toggleGroup('gm-pro-ramp-type',
          ['instant', 'linear', 'ease-in', 'ease-out', 'ease-in-out'].map(v => ({ val: v, label: _rampLabel(v) })),
          rampType, i)}
      </div>

      ${rampType !== 'instant' ? `
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:.5rem;margin-bottom:.5rem">
          <div class="lib-form-field">
            <label>${t('gm_field_ramp_length')} (${rampUnit})</label>
            <input type="number" class="lib-input" value="${trans.duration ?? 0}" min="0" step="0.1"
              data-action="gm-pro-ramp-duration" data-idx="${i}">
          </div>
          <div class="lib-form-field">
            <label>${t('gm_field_ramp_start')}</label>
            ${_toggleGroup('gm-pro-ramp-adaptive',
              [{ val: '0', label: t('gm_ramp_start_prev') }, { val: '1', label: t('gm_ramp_start_current') }],
              trans.adaptive ? '1' : '0', i)}
          </div>
        </div>
        <div class="lib-form-field" style="margin-bottom:.5rem">
          <label>${t('gm_field_ramp_target')}</label>
          ${_toggleGroup('gm-pro-ramp-target',
            ['time', 'volumetric', 'pumped'].map(v => ({ val: v, label: _rampTargetLabel(v) })),
            rampTarget, i)}
        </div>` : ''}

      <div style="margin-top:.5rem">
        <div style="display:flex;align-items:center;gap:.5rem;margin-bottom:.25rem">
          <span style="font-weight:500">${t('gm_stop_conditions')}</span>
          ${availTargets.length ? `
            <div class="gm-dropdown">
              <button type="button" class="lib-btn-sm" data-action="gm-pro-target-menu" data-idx="${i}">${t('gm_add_condition')}</button>
              <ul class="gm-dropdown-menu" id="gmTargetMenu${i}" style="display:none">
                ${availTargets.map(tt => `
                  <li><button type="button" class="gm-dropdown-item" data-action="gm-pro-add-target"
                    data-idx="${i}" data-type="${tt.type}" data-op="${tt.operator}">${esc(tt.label)}</button></li>`).join('')}
              </ul>
            </div>` : ''}
        </div>
        ${targets.map((tg, ti) => _renderProTarget(tg, i, ti)).join(`<div style="text-align:center;font-size:.8em;opacity:.5">${t('gm_or')}</div>`)}
        ${!targets.length ? `<div style="opacity:.5;font-size:.85em">${t('gm_no_stop_conditions')}</div>` : ''}
      </div>
    </div>
  `;
}

function _renderProTarget(tg, phaseIdx, targetIdx) {
  const types = _targetTypes();
  const tt = types.find(o => o.type === tg.type && o.operator === (tg.operator || 'gte')) || types[0];
  return `
    <div style="display:flex;align-items:center;gap:.5rem;margin-bottom:.25rem">
      <span style="flex:1;font-size:.9em">${esc(tt.label)}</span>
      <input type="number" class="lib-input" style="width:80px" value="${tg.value ?? 0}" min="0" step="0.1"
        data-action="gm-pro-target-value" data-idx="${phaseIdx}" data-tidx="${targetIdx}">
      <span style="opacity:.6;font-size:.85em">${tt.unit}</span>
      <button type="button" class="lib-btn-sm del" data-action="gm-pro-remove-target"
        data-idx="${phaseIdx}" data-tidx="${targetIdx}">✕</button>
    </div>
  `;
}

function _rampLabel(v) {
  return {
    instant: t('gm_ramp_instant'), linear: t('gm_ramp_linear'), 'ease-in': t('gm_ramp_ease_in'),
    'ease-out': t('gm_ramp_ease_out'), 'ease-in-out': t('gm_ramp_ease_in_out'),
  }[v] || v;
}
function _rampTargetLabel(v) {
  return { time: t('gm_ramp_target_time'), volumetric: t('gm_ramp_target_volumetric'), pumped: t('gm_ramp_target_pumped') }[v] || v;
}

// ── Input bindings (called after each _render) ────────────────────────────

function _bindInputs() {
  // `change`, not `input` — every callback triggers a full _render() that
  // replaces innerHTML, so `input` (fires per keystroke) dropped focus mid-type.
  _bind('gmLabel', 'change', e => _set({ label: e.target.value }));
  _bind('gmDescription', 'change', e => _set({ description: e.target.value }));
  _bind('gmTemperature', 'change', e => _set({ temperature: parseFloat(e.target.value) || 0 }));
  _bind('gmFavorite', 'change', e => _set({ favorite: e.target.checked }));
  _bind('gmUtility', 'change', e => _set({ utility: e.target.checked }));

  // One delegated `change` listener for every phase field, keyed by data-action.
  // #gmEditorBody itself is never replaced (only its innerHTML), so guard against
  // accumulating a new listener on every render call.
  if (_inputsBound) return;
  _inputsBound = true;
  const body = document.getElementById('gmEditorBody');
  body?.addEventListener('change', e => {
    const el = e.target;
    const action = el.dataset.action;
    if (!action) return;
    const idx = Number(el.dataset.idx);
    const ph = () => (_profile.phases || [])[idx];
    const num = () => parseFloat(el.value) || 0;

    switch (action) {
      case 'gm-std-phase-name':
      case 'gm-pro-phase-name':   _setPhase(idx, { name: el.value }); break;
      case 'gm-std-duration':
      case 'gm-pro-duration':     _setPhase(idx, { duration: num() }); break;
      case 'gm-pro-temperature':  _setPhase(idx, { temperature: num() }); break;
      case 'gm-std-pump-power':
      case 'gm-pro-pump-power':   _setPhase(idx, { pump: parseFloat(el.value) || 100 }); break;
      case 'gm-pro-pressure':     _setPhase(idx, { pump: { ...ph().pump, pressure: num() } }); break;
      case 'gm-pro-flow':         _setPhase(idx, { pump: { ...ph().pump, flow: num() } }); break;
      case 'gm-pro-ramp-duration':
        _setPhase(idx, { transition: { ...ph().transition, duration: num() } });
        break;
      case 'gm-std-vol-target': {
        const val = num();
        _setPhase(idx, { targets: val > 0 ? [{ type: 'volumetric', operator: 'gte', value: val }] : [] });
        break;
      }
      case 'gm-pro-target-value': {
        const tidx = Number(el.dataset.tidx);
        const targets = [...(ph().targets || [])];
        targets[tidx] = { ...targets[tidx], value: num() };
        _setPhase(idx, { targets });
        break;
      }
    }
  });
}

function _bind(id, evt, fn) {
  const el = document.getElementById(id);
  if (el) el.addEventListener(evt, fn);
}

// ── Event delegation (wired by main.js via body click) ────────────────────

export function handleGmEditorAction(action, el) {
  if (!_profile) return;
  const idx = Number(el.dataset.idx ?? 0);
  const ph = () => (_profile.phases || [])[idx];
  const existingPower = () => (typeof ph().pump === 'number' && ph().pump > 0 ? ph().pump : 100);

  switch (action) {
    case 'gm-editor-close': closeGaggiMateEditor(); break;
    case 'gm-editor-save':  saveGaggiMateProfile(); break;

    case 'gm-type': {
      const val = el.dataset.val;
      // Converting to pro: give every phase a transition field if it lacks one.
      const phases = (_profile.phases || []).map(p => {
        if (val === 'pro' && !p.transition) {
          return { ...p, temperature: p.temperature ?? 0, transition: { type: 'instant', duration: 0, adaptive: true, target: 'time' } };
        }
        return p;
      });
      _profile = { ..._profile, type: val, phases };
      _render();
      break;
    }

    case 'gm-add-phase':     _addPhase(); break;
    case 'gm-remove-phase':  _removePhase(idx); break;
    case 'gm-phase-prev':    _currentPhaseIdx = Math.max(0, _currentPhaseIdx - 1); _render(); break;
    case 'gm-phase-next':    _currentPhaseIdx = Math.min((_profile.phases?.length ?? 1) - 1, _currentPhaseIdx + 1); _render(); break;

    // Shared between Standard and Pro — identical body either way.
    case 'gm-std-phase-type':
    case 'gm-pro-phase-type': _setPhase(idx, { phase: el.value }); break;
    case 'gm-std-valve':
    case 'gm-pro-valve':      _setPhase(idx, { valve: Number(el.dataset.val) }); break;

    case 'gm-std-pump-mode': {
      const v = el.dataset.val;
      _setPhase(idx, { pump: v === 'off' ? 0 : v === 'power' ? existingPower() : { target: v, pressure: 0, flow: 0 } });
      break;
    }
    case 'gm-pro-pump-mode': {
      const v = el.dataset.val;
      const pump = ph().pump;
      const existingP = typeof pump === 'object' ? (pump.pressure > 0 ? pump.pressure : 0) : 0;
      const existingF = typeof pump === 'object' ? (pump.flow > 0 ? pump.flow : 0) : 0;
      let next;
      if (v === 'off') next = 0;
      else if (v === 'power') next = existingPower();
      else if (v === 'hold-pressure') next = { target: 'pressure', pressure: -1, flow: existingF };
      else if (v === 'hold-flow')     next = { target: 'flow', pressure: existingP, flow: -1 };
      else next = { target: v, pressure: existingP, flow: existingF };
      _setPhase(idx, { pump: next });
      break;
    }
    case 'gm-pro-ramp-type': {
      const rt = el.dataset.val;
      _setPhase(idx, { transition: { ...ph().transition, type: rt, duration: rt === 'instant' ? 0 : ph().transition?.duration || 0 } });
      break;
    }
    case 'gm-pro-ramp-adaptive':
      _setPhase(idx, { transition: { ...ph().transition, adaptive: el.dataset.val === '1' } });
      break;
    case 'gm-pro-ramp-target':
      _setPhase(idx, { transition: { ...ph().transition, target: el.dataset.val } });
      break;
    case 'gm-pro-target-menu': {
      const menu = document.getElementById(`gmTargetMenu${idx}`);
      if (menu) menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
      break;
    }
    case 'gm-pro-add-target':
      _setPhase(idx, { targets: [...(ph().targets || []), { type: el.dataset.type, operator: el.dataset.op, value: 0 }] });
      break;
    case 'gm-pro-remove-target': {
      const tidx = Number(el.dataset.tidx);
      _setPhase(idx, { targets: (ph().targets || []).filter((_, i) => i !== tidx) });
      break;
    }
  }
}
