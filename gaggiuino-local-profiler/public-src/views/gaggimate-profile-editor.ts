// GaggiMate profile editor — Standard + Pro. _profile is the source of
// truth; _render() rebuilds #gmEditorBody from it on every change.
import Chart from 'chart.js/auto';
import type { ChartConfiguration } from 'chart.js';
import { S } from '../state/index.js';
import { t, tHtml } from '../i18n.js';
import * as machinesApi from '../api/machines.js';
import type { MachineProfile } from '../api/types.js';
import { esc, html, joinHtml } from '../utils.js';
import type { Html } from '../utils.js';
import { phasePlugin, buildGmPhaseRanges } from '../constants.js';
import { loadMachineProfileList } from './library-profile-editor.js';
import { invalidateGmPhaseCache } from './shots/index.js';

// The GaggiMate phase shape this editor reads and writes. api/types.ts's
// MachineProfile documents this variant (label/description/temperature/phases)
// but types `phases` as the Gaggiuino MachineProfileInput shape, so name the
// GaggiMate phase fields here — the same "local interface for the fields the
// view reads" pattern as views/shots/annotation.ts.
interface GmPump {
  target?: string | undefined;
  pressure?: number | undefined;
  flow?: number | undefined;
}

interface GmTarget {
  type?: string | undefined;
  operator?: string | undefined;
  value?: number | undefined;
}

interface GmTransition {
  type?: string | undefined;
  duration?: number | undefined;
  adaptive?: boolean | undefined;
  target?: string | undefined;
}

interface GmPhase {
  name?: string | undefined;
  phase?: string | undefined;
  valve?: number | undefined;
  pump?: number | GmPump | undefined;
  duration?: number | undefined;
  temperature?: number | undefined;
  targets?: GmTarget[] | undefined;
  transition?: GmTransition | undefined;
}

type Loose<T> = { [K in keyof T]?: T[K] | undefined };

interface GmProfile extends Loose<Pick<MachineProfile, 'id' | 'label' | 'description' | 'temperature' | 'type' | 'utility' | 'favorite'>> {
  phases?: GmPhase[] | undefined;
}

// ── State ─────────────────────────────────────────────────────────────────

let _profile: GmProfile | null = null;
let _currentPhaseIdx = 0; // active phase for pro editor
let _saving = false;
let _chart: Chart | null = null;
let _inputsBound = false; // guards against accumulating body change-listeners across renders

// ── Entry points ──────────────────────────────────────────────────────────

export async function openGaggiMateProfileEditor(id: string): Promise<void> {
  const machineId = S.activeMachineId ?? '';
  const profile = await machinesApi.getMachineProfile(id, machineId);
  if (!profile) { window.showToast?.(t('gm_toast_load_error')); return; }
  _openEditor(profile);
}

// Same "fresh unsaved copy" contract as library-profile-editor.js's
// duplicateProfile: id cleared so saveGaggiMateProfile() POSTs instead of
// PUTting over the original, label suffixed so it's never confused with
// its source in the list.
export async function duplicateGaggiMateProfile(id: string): Promise<void> {
  const machineId = S.activeMachineId ?? '';
  const profile = await machinesApi.getMachineProfile(id, machineId);
  if (!profile) { window.showToast?.(t('gm_toast_load_error')); return; }
  _openEditor({ ...profile, id: undefined, label: `${profile.label ?? ''}${t('profile_duplicate_suffix')}` });
}

export function openNewGaggiMateProfile(): void {
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

export function closeGaggiMateEditor(): void {
  (document.getElementById('gmProfileEditorModal') as HTMLElement).style.display = 'none';
  _profile = null;
  _saving = false;
  _inputsBound = false;
  if (_chart) { _chart.destroy(); _chart = null; }
}

export async function saveGaggiMateProfile(): Promise<void> {
  if (!_profile || _saving) return;
  if (!_profile.label?.trim()) { window.showToast?.(t('gm_toast_name_required')); return; }
  if (!_profile.phases?.length) { window.showToast?.(t('gm_toast_phase_required')); return; }
  _saving = true;
  _render();

  const machineId = S.activeMachineId;
  const body = { ..._profile, machineId };

  try {
    const r = await machinesApi.saveMachineProfile(_profile.id ?? null, body);
    if (!r.ok) {
      const errBody: unknown = await r.json().catch(() => null);
      const err = (errBody as { error?: string } | null)?.error;
      window.showToast?.(err || t('gm_toast_save_error'));
      return;
    }
    // The backend now saves locally first and only degrades to
    // syncStatus !== 'synced' when the machine itself couldn't be reached —
    // still a 200, not an error (see handlers_profiles.go's offline-editor
    // rework). Only a real validation/unsupported error (400/501, handled
    // above) is still a hard failure here.
    const savedBody: unknown = await r.json().catch(() => null);
    invalidateGmPhaseCache(machineId as number);
    closeGaggiMateEditor();
    await loadMachineProfileList();
    const syncStatus = (savedBody as { syncStatus?: string } | null)?.syncStatus;
    if (syncStatus && syncStatus !== 'synced') {
      window.showToast?.(t('gm_toast_saved_offline'));
    }
  } finally {
    // eslint-disable-next-line require-atomic-updates -- guarded by _saving check at entry
    _saving = false;
    if (_profile) _render();
  }
}

// ── Internal ──────────────────────────────────────────────────────────────

function _openEditor(profile: GmProfile): void {
  _profile = profile;
  _currentPhaseIdx = 0;
  _saving = false;
  _inputsBound = false;
  const modal = document.getElementById('gmProfileEditorModal') as HTMLElement;
  modal.style.display = 'flex';
  (document.getElementById('gmEditorTitle') as HTMLElement).textContent =
    profile.id != null ? t('gm_editor_title_edit', profile.label) : t('gm_editor_title_new');
  _render();
}

function _set(updates: Partial<GmProfile>): void {
  _profile = { ..._profile, ...updates };
  _render();
}

function _setPhase(idx: number, updates: Partial<GmPhase>): void {
  const phases = [...(_profile!.phases || [])];
  const prev = phases[idx] ?? {};
  phases[idx] = { ...prev, ...updates };
  _profile = { ..._profile, phases };
  _render();
}

function _addPhase(): void {
  const isPro = _profile!.type === 'pro';
  const phase = isPro ? _newProPhase(t('gm_new_phase_label'), 'brew') : _newStandardPhase(t('gm_new_phase_label'), 'brew');
  const phases = [...(_profile!.phases || []), phase];
  _profile = { ..._profile, phases };
  _currentPhaseIdx = phases.length - 1;
  _render();
}

function _removePhase(idx: number): void {
  const phases = (_profile!.phases || []).filter((_, i) => i !== idx);
  _profile = { ..._profile, phases };
  _currentPhaseIdx = Math.min(_currentPhaseIdx, Math.max(0, phases.length - 1));
  _render();
}

function _newStandardPhase(name: string, phase: string): GmPhase {
  return { name, phase, valve: 1, pump: 100, duration: 5, targets: [] };
}

function _newProPhase(name: string, phase: string): GmPhase {
  return {
    name, phase, valve: 1, pump: 100, duration: 5, temperature: 0,
    targets: [],
    transition: { type: 'instant', duration: 0, adaptive: true, target: 'time' },
  };
}

// ── Render ────────────────────────────────────────────────────────────────

function _render(): void {
  const body = document.getElementById('gmEditorBody');
  if (!body || !_profile) return;
  const isPro = _profile.type === 'pro';
  try {
    body.innerHTML = _renderBody(isPro);
    _initChart();
  } catch (e) {
    console.error('[GLP] GaggiMate editor render error:', e);
    body.innerHTML = html`<div style="padding:1rem;color:var(--red-400)">Render-Fehler: ${esc(e instanceof Error ? e.message : String(e))}</div>`;
  }
  _bindInputs();
}

function _renderBody(isPro: boolean): Html {
  const phases = _profile!.phases || [];
  return html`
    ${_renderInfo()}
    ${_renderChart()}
    ${isPro ? _renderProPhases(phases) : _renderStandardPhases(phases)}
    ${_saving ? html`<div style="text-align:center;padding:.5rem;opacity:.6">Wird gespeichert…</div>` : html``}
  `;
}

// ── Profile chart (Chart.js) ───────────────────────────────────────────────

const MAX_PHASE_DUR = 300; // s — chart preview cap; prevents multi-million-point arrays on typos
function _phaseDur(ph: GmPhase): number { return Math.min(ph.duration || 5, MAX_PHASE_DUR); }

function _easeLinear(x: number): number { return x; }
function _easeIn(x: number): number { return x * x; }
function _easeOut(x: number): number { return 1 - (1 - x) * (1 - x); }
function _easeInOut(x: number): number { return x < 0.5 ? 2 * x * x : 1 - 2 * (1 - x) * (1 - x); }
function _applyEasing(x: number, type: string | undefined): number {
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
function _preparePumpSeries(phases: GmPhase[], target: string): { x: number; y: number; target: boolean }[] {
  if (!phases.length) return [];
  const data: { x: number; y: number; target: boolean }[] = [];
  let time = 0, phaseTime = 0, phaseIndex = 0;
  const firstPhase = phases[phaseIndex];
  if (!firstPhase) return [];
  let currentPressure: number, currentFlow: number;
  let phaseStartFlow = 0, phaseStartPressure = 0;
  let effectiveFlow = (firstPhase.pump as GmPump | undefined)?.flow || 0;
  let effectivePressure = (firstPhase.pump as GmPump | undefined)?.pressure || 0;

  do {
    const currentPhase = phases[phaseIndex];
    if (!currentPhase) break;
    const dur = _phaseDur(currentPhase);
    const alpha = _applyEasing(
      phaseTime / (currentPhase.transition?.duration || dur),
      currentPhase.transition?.type || 'linear',
    );
    currentFlow = (currentPhase.pump as GmPump | undefined)?.target === 'flow'
      ? phaseStartFlow + (effectiveFlow - phaseStartFlow) * alpha
      : ((currentPhase.pump as GmPump | undefined)?.flow || 0);
    currentPressure = (currentPhase.pump as GmPump | undefined)?.target === 'pressure'
      ? phaseStartPressure + (effectivePressure - phaseStartPressure) * alpha
      : ((currentPhase.pump as GmPump | undefined)?.pressure || 0);
    data.push({
      x: time,
      y: target === 'pressure' ? currentPressure : currentFlow,
      target: (currentPhase.pump as GmPump | undefined)?.target === target,
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
        if (nextPhase) {
          const nextPump = nextPhase.pump as GmPump | undefined;
          effectiveFlow = nextPump?.flow === -1 ? currentFlow : (nextPump?.flow || 0);
          effectivePressure = nextPump?.pressure === -1 ? currentPressure : (nextPump?.pressure || 0);
        }
      }
    }
  } while (phaseIndex < phases.length);

  return data;
}

function _buildChartData() {
  const phases = _profile?.phases || [];
  if (!phases.length) return null;
  const isPro = _profile!.type === 'pro';

  const gmPhases = buildGmPhaseRanges(phases);
  const lastGmPhase = gmPhases.at(-1);
  const totalTime = lastGmPhase ? lastGmPhase.t1 : 0;

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

function _renderChart(): Html {
  const phases = _profile?.phases || [];
  if (!phases.length) return html``;
  return html`<div class="gm-chart-container"><canvas id="gmProfileChart"></canvas></div>`;
}

function _initChart(): void {
  // #gmEditorBody's innerHTML is fully replaced each render, so this canvas
  // is always fresh — only our own tracked `_chart` needs disposal.
  const canvas = document.getElementById('gmProfileChart');
  if (!canvas) return;
  if (_chart) { _chart.destroy(); _chart = null; }

  const d = _buildChartData();
  if (!d) return;

  const { pressureData, flowData, powerData, gmPhases, totalTime } = d;
  const isPro = _profile!.type === 'pro';

  // Dashed+dimmed where the point isn't the phase's controlled parameter.
  const dashed = (color: string | number[]) => (ctx: { p0: { raw: { target: boolean } } }): string | number[] | undefined =>
    (!ctx.p0.raw.target ? color : undefined);

  const datasets: Record<string, unknown>[] = [];
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
  const yTickCb = isPro ? (v: number): string => `${v}` : (v: number): string => `${v}%`;

  try {
    _chart = new Chart(canvas as HTMLCanvasElement, {
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
              title: (ctx: { parsed: { x: number } }[]) => {
                const time = ctx[0]?.parsed.x ?? 0;
                const ph = gmPhases.find(p => time >= p.t0 && time <= p.t1);
                return ph?.name ? `${ph.name} — ${time.toFixed(1)}s` : `${time.toFixed(1)}s`;
              },
            },
          },
        },
        scales: {
          x: {
            type: 'linear', min: 0, max: totalTime, clip: false,
            ticks: { color: C.tick, font: { family: 'Figtree' }, stepSize: 5, callback: (v: number): string => `${v}s`, maxTicksLimit: 10 },
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
    } as unknown as ChartConfiguration<'line'>);
  } catch(e) {
    console.error('[GLP initChart] Chart.js error:', e instanceof Error ? e.message : e, 'datasets:', datasets.length);
  }
}

// Shared toggle-button-group markup. `idx` omitted for profile-level toggles.
function _toggleGroup(action: string, options: { val: string; label: string }[], activeVal: string | number | undefined, idx?: number): Html {
  const idxAttr: Html = idx != null ? html` data-idx="${esc(idx)}"` : html``;
  return html`<div class="gm-toggle-group">${joinHtml(options.map(o =>
    html`<button type="button" class="lib-btn-sm${o.val === activeVal ? html` active` : html``}" data-action="${esc(action)}"${idxAttr} data-val="${esc(o.val)}">${esc(o.label)}</button>`
  ))}</div>`;
}

// Identical between Standard and Pro phases (only data-action differs).
function _phaseTypeSelect(ph: GmPhase, i: number, action: string): Html {
  return html`<select class="lib-select" data-action="${esc(action)}" data-idx="${esc(i)}">
      <option value="preinfusion"${ph.phase === 'preinfusion' ? html` selected` : html``}>${tHtml('gm_phase_type_preinfusion')}</option>
      <option value="brew"${ph.phase === 'brew' ? html` selected` : html``}>${tHtml('gm_phase_type_brew')}</option>
    </select>`;
}
function _durationField(ph: GmPhase, i: number, action: string): Html {
  return html`<div class="lib-form-field">
      <label>${tHtml('gm_field_duration')}</label>
      <input type="number" class="lib-input" value="${esc(ph.duration ?? 0)}" min="1" max="${esc(MAX_PHASE_DUR)}" step="1"
        data-action="${esc(action)}" data-idx="${esc(i)}">
    </div>`;
}
function _valveToggle(ph: GmPhase, i: number, action: string): Html {
  return _toggleGroup(action, [{ val: '0', label: t('gm_valve_closed') }, { val: '1', label: t('gm_valve_open') }], ph.valve ? '1' : '0', i);
}

// Pro layers hold-pressure/hold-flow detection on top of this.
function _pumpMode(ph: GmPhase): { pumpIsNumber: boolean; mode: string | undefined; pumpPower: number } {
  const pump = ph.pump;
  const pumpIsNumber = typeof pump === 'number';
  return {
    pumpIsNumber,
    mode: pumpIsNumber ? (pump === 0 ? 'off' : 'power') : pump?.target,
    pumpPower: pumpIsNumber ? pump : 100,
  };
}

function _renderInfo(): Html {
  return html`
    <div class="lib-form-grid">
      <div class="lib-form-field">
        <label>${tHtml('gm_field_name')}</label>
        <input type="text" id="gmLabel" value="${esc(_profile!.label || '')}" maxlength="48" placeholder="${esc(t('gm_field_name_placeholder'))}">
      </div>
      <div class="lib-form-field">
        <label>${tHtml('gm_field_description')}</label>
        <textarea id="gmDescription" class="lib-input" rows="2" style="width:100%;resize:vertical">${esc(_profile!.description || '')}</textarea>
      </div>
      <div class="lib-form-field">
        <label>${tHtml('gm_field_temperature')}</label>
        <input type="number" id="gmTemperature" value="${esc(_profile!.temperature ?? 93)}" min="0" max="150" step="0.5">
      </div>
      <div class="lib-form-field">
        <label>${tHtml('gm_field_type')}</label>
        ${_toggleGroup('gm-type', [{ val: 'standard', label: t('gm_type_standard') }, { val: 'pro', label: t('gm_type_pro') }], _profile!.type)}
      </div>
      <div class="lib-form-field" style="flex-direction:row;align-items:center;gap:.75rem">
        <label style="margin:0">${tHtml('gm_field_favorite')}</label>
        <input type="checkbox" id="gmFavorite" class="toggle toggle-sm" ${_profile!.favorite ? html`checked` : html``}>
        <label style="margin:0;margin-left:1rem">${tHtml('gm_field_utility')}</label>
        <input type="checkbox" id="gmUtility" class="toggle toggle-sm" ${_profile!.utility ? html`checked` : html``}>
      </div>
    </div>
  `;
}

// ── Standard profile phases ───────────────────────────────────────────────

function _renderStandardPhases(phases: GmPhase[]): Html {
  const sep = html`<div style="text-align:center;padding:.25rem;opacity:.4">↓</div>`;
  const rows = joinHtml(phases.map((ph, i) => (i ? html`${sep}${_renderStandardPhase(ph, i)}` : _renderStandardPhase(ph, i))));
  return html`
    <div class="lib-recipe-steps-section">
      <div class="lib-recipe-steps-header">
        <span>${tHtml('gm_phases_header')}</span>
        <button class="lib-btn-sm" data-action="gm-add-phase">${tHtml('gm_add_phase')}</button>
      </div>
      <div id="gmPhaseList">${rows || html`<div style="opacity:.5;padding:.5rem">${tHtml('gm_no_phases')}</div>`}</div>
    </div>
  `;
}

function _renderStandardPhase(ph: GmPhase, i: number): Html {
  const { mode, pumpPower } = _pumpMode(ph);
  const volTarget = (ph.targets || []).find(tg => tg.type === 'volumetric');
  const volValue = volTarget?.value ?? 0;

  return html`
    <div class="gm-phase" data-phase-idx="${esc(i)}">
      <div style="display:flex;gap:.5rem;margin-bottom:.5rem">
        ${_phaseTypeSelect(ph, i, 'gm-std-phase-type')}
        <input type="text" class="lib-input flex-1" value="${esc(ph.name || '')}"
          data-action="gm-std-phase-name" data-idx="${esc(i)}" placeholder="${esc(t('gm_phase_name_placeholder'))}">
        <button class="lib-btn-sm del" data-action="gm-remove-phase" data-idx="${esc(i)}" title="${esc(t('gm_remove_phase_title'))}">✕</button>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:.5rem;margin-bottom:.5rem">
        ${_durationField(ph, i, 'gm-std-duration')}
        <div class="lib-form-field">
          <label>${tHtml('gm_field_stop_weight')}</label>
          <input type="number" class="lib-input" value="${esc(volValue)}" min="0" step="0.1"
            data-action="gm-std-vol-target" data-idx="${esc(i)}">
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:.5rem">
        <div class="lib-form-field">
          <label>${tHtml('gm_field_valve')}</label>
          ${_valveToggle(ph, i, 'gm-std-valve')}
        </div>
        <div class="lib-form-field">
          <label>${tHtml('gm_field_pump')}</label>
          ${_toggleGroup('gm-std-pump-mode', [{ val: 'off', label: t('gm_pump_off') }, { val: 'power', label: t('gm_pump_power') }], mode, i)}
        </div>
      </div>
      ${mode === 'power' ? html`
        <div class="lib-form-field" style="margin-top:.5rem">
          <label>${tHtml('gm_field_pump_power')}</label>
          <input type="number" class="lib-input" value="${esc(pumpPower)}" min="0" max="100" step="1"
            data-action="gm-std-pump-power" data-idx="${esc(i)}">
        </div>` : html``}
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

function _renderProPhases(phases: GmPhase[]): Html {
  const n = phases.length;
  const i = _currentPhaseIdx;
  const ph = phases[i];
  const nav: Html = html`
    <div class="gm-phase-nav">
      <button class="lib-btn-sm" data-action="gm-phase-prev" ${i === 0 ? html`disabled` : html``}>◀</button>
      <span>${n > 0 ? html`${esc(i + 1)} / ${esc(n)}` : html`0 / 0`}</span>
      <button class="lib-btn-sm" data-action="gm-phase-next" ${i >= n - 1 ? html`disabled` : html``}>▶</button>
      <button class="lib-btn-sm" data-action="gm-add-phase">${tHtml('gm_add_phase')}</button>
      <button class="lib-btn-sm del" data-action="gm-remove-phase" data-idx="${esc(i)}" ${n === 0 ? html`disabled` : html``}>✕ ${tHtml('gm_remove_phase_label')}</button>
    </div>
  `;
  return html`
    <div class="lib-recipe-steps-section">
      <div class="lib-recipe-steps-header"><span>${tHtml('gm_phases_pro_header')}</span></div>
      ${nav}
      <div id="gmProPhaseDetail">
        ${ph ? _renderProPhase(ph, i) : html`<div style="opacity:.5;padding:.5rem">${tHtml('gm_no_phases_add')}</div>`}
      </div>
    </div>
  `;
}

function _renderProPhase(ph: GmPhase, i: number): Html {
  const { pumpIsNumber, pumpPower, mode: baseMode } = _pumpMode(ph);
  let mode = baseMode;
  const pressure = pumpIsNumber ? 0 : ((ph.pump as GmPump | undefined)?.pressure ?? 0);
  const flow = pumpIsNumber ? 0 : ((ph.pump as GmPump | undefined)?.flow ?? 0);
  if (mode === 'pressure' && pressure === -1) mode = 'hold-pressure';
  if (mode === 'flow' && flow === -1) mode = 'hold-flow';
  const trans: GmTransition = ph.transition || {};
  const rampType = trans.type || 'instant';
  const rampTarget = trans.target || 'time';
  const rampUnit = rampTarget === 'volumetric' ? 'g' : rampTarget === 'pumped' ? 'ml' : 's';
  const targets = ph.targets || [];
  const usedKeys = new Set(targets.map(tg => `${tg.type ?? ''}:${tg.operator ?? ''}`));
  const availTargets = _targetTypes().filter(tt => !usedKeys.has(`${tt.type}:${tt.operator}`));

  return html`
    <div class="gm-phase">
      <div style="display:flex;gap:.5rem;margin-bottom:.5rem">
        ${_phaseTypeSelect(ph, i, 'gm-pro-phase-type')}
        <input type="text" class="lib-input flex-1" value="${esc(ph.name || '')}"
          data-action="gm-pro-phase-name" data-idx="${esc(i)}" placeholder="${esc(t('gm_phase_name_placeholder'))}">
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:.5rem;margin-bottom:.5rem">
        ${_durationField(ph, i, 'gm-pro-duration')}
        <div class="lib-form-field">
          <label>${tHtml('gm_field_temperature_pro')}</label>
          <input type="number" class="lib-input" value="${esc(ph.temperature ?? 0)}" min="0" max="150" step="0.5"
            data-action="gm-pro-temperature" data-idx="${esc(i)}">
        </div>
      </div>

      <div class="lib-form-field" style="margin-bottom:.5rem">
        <label>${tHtml('gm_field_valve')}</label>
        ${_valveToggle(ph, i, 'gm-pro-valve')}
      </div>

      <div class="lib-form-field" style="margin-bottom:.5rem">
        <label>${tHtml('gm_field_pump_mode')}</label>
        ${_toggleGroup('gm-pro-pump-mode', [
          { val: 'off', label: t('gm_pump_off') }, { val: 'power', label: t('gm_pump_power') },
          { val: 'pressure', label: t('gm_pump_pressure') }, { val: 'flow', label: t('gm_pump_flow') },
          { val: 'hold-pressure', label: t('gm_pump_hold_pressure') }, { val: 'hold-flow', label: t('gm_pump_hold_flow') },
        ], mode, i)}
      </div>

      ${mode === 'power' ? html`
        <div class="lib-form-field" style="margin-bottom:.5rem">
          <label>${tHtml('gm_field_pump_power')}</label>
          <input type="number" class="lib-input" value="${esc(pumpPower)}" min="0" max="100" step="1"
            data-action="gm-pro-pump-power" data-idx="${esc(i)}">
        </div>` : html``}

      ${(mode === 'pressure' || mode === 'flow') ? html`
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:.5rem;margin-bottom:.5rem">
          <div class="lib-form-field">
            <label>${mode === 'pressure' ? tHtml('gm_field_pressure_target') : tHtml('gm_field_pressure_max')} (bar)</label>
            <input type="number" class="lib-input" value="${esc(pressure)}" min="0.1" step="0.01"
              data-action="gm-pro-pressure" data-idx="${esc(i)}">
          </div>
          <div class="lib-form-field">
            <label>${mode === 'flow' ? tHtml('gm_field_flow_target') : tHtml('gm_field_flow_max')} (ml/s)</label>
            <input type="number" class="lib-input" value="${esc(flow)}" min="0.1" step="0.01"
              data-action="gm-pro-flow" data-idx="${esc(i)}">
          </div>
        </div>` : html``}

      <div class="lib-form-field" style="margin-bottom:.5rem">
        <label>${tHtml('gm_field_ramp_style')}</label>
        ${_toggleGroup('gm-pro-ramp-type',
          ['instant', 'linear', 'ease-in', 'ease-out', 'ease-in-out'].map(v => ({ val: v, label: _rampLabel(v) })),
          rampType, i)}
      </div>

      ${rampType !== 'instant' ? html`
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:.5rem;margin-bottom:.5rem">
          <div class="lib-form-field">
            <label>${tHtml('gm_field_ramp_length')} (${esc(rampUnit)})</label>
            <input type="number" class="lib-input" value="${esc(trans.duration ?? 0)}" min="0" step="0.1"
              data-action="gm-pro-ramp-duration" data-idx="${esc(i)}">
          </div>
          <div class="lib-form-field">
            <label title="${tHtml('gm_ramp_start_hint')}">${tHtml('gm_field_ramp_start')} <span class="gm-field-hint">ⓘ</span></label>
            ${_toggleGroup('gm-pro-ramp-adaptive',
              [{ val: '0', label: t('gm_ramp_start_prev') }, { val: '1', label: t('gm_ramp_start_current') }],
              trans.adaptive ? '1' : '0', i)}
          </div>
        </div>
        <div class="lib-form-field" style="margin-bottom:.5rem">
          <label>${tHtml('gm_field_ramp_target')}</label>
          ${_toggleGroup('gm-pro-ramp-target',
            ['time', 'volumetric', 'pumped'].map(v => ({ val: v, label: _rampTargetLabel(v) })),
            rampTarget, i)}
        </div>` : html``}

      <div style="margin-top:.5rem">
        <div style="display:flex;align-items:center;gap:.5rem;margin-bottom:.25rem">
          <span style="font-weight:500">${tHtml('gm_stop_conditions')}</span>
          ${availTargets.length ? html`
            <div class="gm-dropdown">
              <button type="button" class="lib-btn-sm" data-action="gm-pro-target-menu" data-idx="${esc(i)}">${tHtml('gm_add_condition')}</button>
              <ul class="gm-dropdown-menu" id="gmTargetMenu${esc(i)}" style="display:none">
                ${joinHtml(availTargets.map(tt => html`
                  <li><button type="button" class="gm-dropdown-item" data-action="gm-pro-add-target"
                    data-idx="${esc(i)}" data-type="${esc(tt.type)}" data-op="${esc(tt.operator)}">${esc(tt.label)}</button></li>`))}
              </ul>
            </div>` : html``}
        </div>
        ${joinHtml(targets.map((tg, ti) => (ti ? html`<div style="text-align:center;font-size:.8em;opacity:.5">${tHtml('gm_or')}</div>${_renderProTarget(tg, i, ti)}` : _renderProTarget(tg, i, ti))))}
        ${!targets.length ? html`<div style="opacity:.5;font-size:.85em">${tHtml('gm_no_stop_conditions')}</div>` : html``}
      </div>
    </div>
  `;
}

function _renderProTarget(tg: GmTarget, phaseIdx: number, targetIdx: number): Html {
  const types = _targetTypes();
  const tt = types.find(o => o.type === tg.type && o.operator === (tg.operator || 'gte')) ?? types[0];
  if (!tt) return html``;
  return html`
    <div style="display:flex;align-items:center;gap:.5rem;margin-bottom:.25rem">
      <span style="flex:1;font-size:.9em">${esc(tt.label)}</span>
      <input type="number" class="lib-input" style="width:80px" value="${esc(tg.value ?? 0)}" min="0" step="0.1"
        data-action="gm-pro-target-value" data-idx="${esc(phaseIdx)}" data-tidx="${esc(targetIdx)}">
      <span style="opacity:.6;font-size:.85em">${esc(tt.unit)}</span>
      <button type="button" class="lib-btn-sm del" data-action="gm-pro-remove-target"
        data-idx="${esc(phaseIdx)}" data-tidx="${esc(targetIdx)}">✕</button>
    </div>
  `;
}

function _rampLabel(v: string): string {
  return ({
    instant: t('gm_ramp_instant'), linear: t('gm_ramp_linear'), 'ease-in': t('gm_ramp_ease_in'),
    'ease-out': t('gm_ramp_ease_out'), 'ease-in-out': t('gm_ramp_ease_in_out'),
  } as Record<string, string>)[v] || v;
}
function _rampTargetLabel(v: string): string {
  return ({ time: t('gm_ramp_target_time'), volumetric: t('gm_ramp_target_volumetric'), pumped: t('gm_ramp_target_pumped') } as Record<string, string>)[v] || v;
}

// ── Input bindings (called after each _render) ────────────────────────────

function _bindInputs(): void {
  // `change`, not `input` — every callback triggers a full _render() that
  // replaces innerHTML, so `input` (fires per keystroke) dropped focus mid-type.
  _bind('gmLabel', 'change', e => _set({ label: (e.target as HTMLInputElement).value }));
  _bind('gmDescription', 'change', e => _set({ description: (e.target as HTMLInputElement).value }));
  _bind('gmTemperature', 'change', e => _set({ temperature: parseFloat((e.target as HTMLInputElement).value) || 0 }));
  _bind('gmFavorite', 'change', e => _set({ favorite: (e.target as HTMLInputElement).checked }));
  _bind('gmUtility', 'change', e => _set({ utility: (e.target as HTMLInputElement).checked }));

  // One delegated `change` listener for every phase field, keyed by data-action.
  // #gmEditorBody itself is never replaced (only its innerHTML), so guard against
  // accumulating a new listener on every render call.
  if (_inputsBound) return;
  _inputsBound = true;
  const body = document.getElementById('gmEditorBody');
  body?.addEventListener('change', e => {
    const el = e.target as HTMLInputElement;
    const action = el.dataset.action;
    if (!action) return;
    const idx = Number(el.dataset.idx);
    const ph = (): GmPhase => (_profile!.phases || [])[idx] ?? {};
    const num = () => parseFloat(el.value) || 0;

    switch (action) {
      case 'gm-std-phase-name':
      case 'gm-pro-phase-name':   _setPhase(idx, { name: el.value }); break;
      case 'gm-std-duration':
      case 'gm-pro-duration':     _setPhase(idx, { duration: num() }); break;
      case 'gm-pro-temperature':  _setPhase(idx, { temperature: num() }); break;
      case 'gm-std-pump-power':
      case 'gm-pro-pump-power': { const pv = parseFloat(el.value); _setPhase(idx, { pump: isNaN(pv) ? 100 : pv }); break; }
      case 'gm-pro-pressure': { const pump = ph().pump; _setPhase(idx, { pump: { ...(typeof pump === 'object' ? pump : {}), pressure: num() } }); break; }
      case 'gm-pro-flow':     { const pump = ph().pump; _setPhase(idx, { pump: { ...(typeof pump === 'object' ? pump : {}), flow: num() } }); break; }
      case 'gm-pro-ramp-duration':
        _setPhase(idx, { transition: { ...(ph().transition ?? {}), duration: num() } });
        break;
      case 'gm-std-vol-target': {
        const val = num();
        _setPhase(idx, { targets: val > 0 ? [{ type: 'volumetric', operator: 'gte', value: val }] : [] });
        break;
      }
      case 'gm-pro-target-value': {
        const tidx = Number(el.dataset.tidx);
        const targets = [...(ph().targets || [])];
        const prevTarget = targets[tidx] ?? {};
        targets[tidx] = { ...prevTarget, value: num() };
        _setPhase(idx, { targets });
        break;
      }
    }
  });
}

function _bind(id: string, evt: string, fn: (e: Event) => void): void {
  const el = document.getElementById(id);
  if (el) el.addEventListener(evt, fn);
}

// ── Event delegation (wired by main.js via body click) ────────────────────

export function handleGmEditorAction(action: string, el: HTMLElement): void {
  if (!_profile) return;
  const idx = Number(el.dataset.idx ?? 0);
  const ph = (): GmPhase => (_profile!.phases || [])[idx] ?? {};
  const existingPower = (): number => {
    const pump = ph().pump;
    return typeof pump === 'number' && pump > 0 ? pump : 100;
  };

  switch (action) {
    case 'gm-editor-close': closeGaggiMateEditor(); break;
    case 'gm-editor-save':  void saveGaggiMateProfile(); break;

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
    case 'gm-pro-phase-type': _setPhase(idx, { phase: (el as HTMLInputElement).value }); break;
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
      const existingP = typeof pump === 'object' ? ((pump.pressure ?? 0) > 0 ? (pump.pressure ?? 0) : 0) : 0;
      const existingF = typeof pump === 'object' ? ((pump.flow ?? 0) > 0 ? (pump.flow ?? 0) : 0) : 0;
      let next: number | GmPump;
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
      _setPhase(idx, { transition: { ...(ph().transition ?? {}), type: rt, duration: rt === 'instant' ? 0 : ph().transition?.duration || 0 } });
      break;
    }
    case 'gm-pro-ramp-adaptive':
      _setPhase(idx, { transition: { ...(ph().transition ?? {}), adaptive: el.dataset.val === '1' } });
      break;
    case 'gm-pro-ramp-target':
      _setPhase(idx, { transition: { ...(ph().transition ?? {}), target: el.dataset.val } });
      break;
    case 'gm-pro-target-menu': {
      const menu = document.getElementById(`gmTargetMenu${idx}`);
      if (!menu) break;
      const opening = menu.style.display === 'none';
      if (opening) {
        // The trigger ("+ Hinzufügen") usually sits near the bottom of a
        // long scrollable phase-editor panel — always opening downward
        // (the CSS default, top:100%) routinely pushed the menu past the
        // panel/viewport bottom, forcing a scroll to even see it (2026-09-09
        // bug report). Flip to open upward when there isn't enough room
        // below, same as any standard dropdown/select would.
        menu.classList.remove('gm-dropdown-menu-up');
        menu.style.display = 'block';
        const fitsBelow = menu.getBoundingClientRect().bottom <= window.innerHeight;
        menu.classList.toggle('gm-dropdown-menu-up', !fitsBelow);
      } else {
        menu.style.display = 'none';
      }
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
