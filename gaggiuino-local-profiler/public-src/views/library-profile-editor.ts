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
import Chart from 'chart.js/auto';
import { S } from '../state/index.js';
import type { MachineProfileRow } from '../state/index.js';
import * as chartRegistry from '../state/charts.js';
import { t } from '../i18n.js';
import * as machinesApi from '../api/machines.js';
import type { MachineProfile, MachineProfileList } from '../api/types.js';
import { esc } from '../utils.js';
import { suggestProfileFromBean } from '../profile-suggestion.js';
import type { ProfileSuggestion } from '../profile-suggestion.js';
import { TARGET_ICON_SVG } from '../icons.js';

const ICON_PENCIL = `<svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15" aria-hidden="true"><path d="M20.71,7.04C21.1,6.65 21.1,6 20.71,5.63L18.37,3.29C18,2.9 17.35,2.9 16.96,3.29L15.12,5.12L18.87,8.87M3,17.25V21H6.75L17.81,9.93L14.06,6.18L3,17.25Z"/></svg>`;
const ICON_TRASH  = `<svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15" aria-hidden="true"><path d="M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19M8,9H10V19H8V9M14,9H16V19H14V9M15.5,4L14.5,3H9.5L8.5,4H5V6H19V4H15.5Z"/></svg>`;

const PHASE_TYPES = ['FLOW', 'PRESSURE', 'MANUAL'];
const CURVES      = ['EASE_IN_OUT', 'EASE_IN', 'EASE_OUT', 'LINEAR', 'INSTANT'];

// One phase as the editor both renders it (from the API or a suggestion) and
// reads it back off the DOM — every field is optional because a blank input
// row or a partial suggestion omits them, hence the `?? ''` fallbacks.
interface PhaseTarget {
  start?: number;
  end?: number;
  curve?: string | number;
  time?: number;
  volume?: number;
}

interface PhaseStopConditions {
  time?: number;
  pressureAbove?: number;
  pressureBelow?: number;
  flowAbove?: number;
  flowBelow?: number;
  weight?: number;
  waterPumpedInPhase?: number;
}

interface Phase {
  name?: string;
  type?: string | number;
  target?: PhaseTarget;
  restriction?: number;
  waterTemperature?: number;
  stopConditions?: PhaseStopConditions;
  skip?: boolean;
}

interface ProfileDraft {
  name: string;
  waterTemperature: number;
  recipe: { coffeeIn: number; coffeeOut: number; ratio: number };
  globalStopConditions: { weight: number };
  phases: Phase[];
}

interface SeriesPoint {
  x: number;
  y: number;
  type: string | number | undefined;
}

// ── Profile list (Library "Profiles" tab) ───────────────────────────────
// Guards against overlapping calls (unawaited init/machine-switch calls
// racing with awaited deleteMachineProfile()/sendProfileToMachine() calls):
// a monotonic token is captured before the fetch and only the call that is
// still the latest one when its response lands is allowed to write state.
let _profileListReqToken = 0;

// Kept as its own (non-async) function so the read of S.activeMachineId
// happens in a separate code path from loadMachineProfileList's own —
// otherwise eslint's require-atomic-updates can't tell that the later
// S.machineProfiles write is guarded by the token check below, not racing
// on this read.
function _profileListRequest(): Promise<MachineProfileList | null> {
  return machinesApi.listMachineProfiles(S.activeMachineId ?? '');
}

export async function loadMachineProfileList(): Promise<void> {
  const token = ++_profileListReqToken;
  const data = await _profileListRequest();
  if (!data) return;
  if (token !== _profileListReqToken) return;
  S.machineProfiles = Array.isArray(data.optionsRaw) ? data.optionsRaw as MachineProfileRow[] : [];
  S.machineProfilesStale = !!data.stale;
  renderProfileList();
  updateProfileDatalist();
}

// recipeFormProfile's autocomplete (components/autocomplete.js, library.js)
// reads S.machineProfiles live — this just re-renders it if it's currently
// open, so a profile list refresh elsewhere shows up immediately.
export function updateProfileDatalist(): void {
  (document.getElementById('recipeFormProfile') as HTMLInputElement | null)?._autocomplete?.refresh();
}

export function renderProfileList(): void {
  const el = document.getElementById('profileListUI');
  if (!el) return;
  if (!S.machineProfiles.length) {
    el.innerHTML = `<div class="lib-empty">${t(S.machineProfilesStale ? 'lib_profiles_offline' : 'lib_empty_profiles')}</div>`;
    return;
  }
  // codeql[js/xss-through-dom] false positive: esc()/escapeHtml() already applied, see #760
  el.innerHTML = S.machineProfiles.map(p => `<div class="lib-item${p.utility ? ' lib-item-utility' : ''}">
      <div class="lib-item-info">
        <div class="lib-item-name-row">
          <span class="lib-item-name">${esc(p.name)}</span>
          ${p.utility ? `<span class="lib-utility-badge">${t('profile_utility_badge')}</span>` : ''}
        </div>
      </div>
      <div class="lib-item-actions">
        <button class="lib-btn-sm" data-action="start-profile-dialin" data-id="${esc(p.id as string | number)}" title="${t('profile_dialin_start')}">${TARGET_ICON_SVG}</button>
        <button class="lib-btn-sm lib-btn-icon" data-action="edit-profile" data-id="${esc(p.id as string | number)}" title="${t('lib_btn_edit')}">${ICON_PENCIL}</button>
        <button class="lib-btn-sm del lib-btn-icon" data-action="delete-profile" data-id="${esc(p.id as string | number)}" title="${t('lib_btn_delete')}">${ICON_TRASH}</button>
      </div>
    </div>`).join('');
}

export async function editProfile(id: string): Promise<void> {
  const profile = await machinesApi.getMachineProfile(id, S.activeMachineId ?? '');
  if (!profile) { window.showToast?.(t('profile_load_error')); return; }
  openProfileForm(profile);
}

export async function deleteMachineProfile(id: string): Promise<void> {
  if (!confirm(t('profile_confirm_delete'))) return;
  const r = await machinesApi.deleteMachineProfile(id, S.activeMachineId ?? '');
  if (!r.ok) { window.showToast?.(t('profile_send_error')); return; }
  await loadMachineProfileList();
}

// ── Editor modal ──────────────────────────────────────────────────────
export function openProfileForm(profile?: MachineProfile | null, beanId?: string | number | null): void {
  S.profileEditId     = (profile?.id ?? null) as number | null;
  S.profileEditBeanId = (beanId ?? null) as number | null;
  (document.getElementById('profileFormName') as HTMLInputElement).value       = profile?.name ?? '';
  (document.getElementById('profileFormWaterTemp') as HTMLInputElement).value   = String(profile?.waterTemperature ?? '');
  (document.getElementById('profileFormCoffeeIn') as HTMLInputElement).value    = String(profile?.recipe?.coffeeIn ?? '');
  (document.getElementById('profileFormCoffeeOut') as HTMLInputElement).value   = String(profile?.recipe?.coffeeOut ?? '');
  (document.getElementById('profileFormRatio') as HTMLInputElement).value       = String(profile?.recipe?.ratio ?? '');
  (document.getElementById('profileFormWeight') as HTMLInputElement).value      = String(profile?.globalStopConditions?.weight ?? '');
  _renderPhaseRows(profile?.phases || []);
  (document.getElementById('profileApplySuggestionBtn') as HTMLElement).style.display = beanId != null ? '' : 'none';
  (document.getElementById('profileEditorModal') as HTMLElement).classList.add('open');
  (document.getElementById('profileEditorModal') as HTMLElement).style.display = 'flex';
  renderProfilePreviewChart();
  (document.getElementById('profileFormName') as HTMLInputElement).focus();
}

export function closeProfileForm(): void {
  S.profileEditId     = null;
  S.profileEditBeanId = null;
  (document.getElementById('profileEditorModal') as HTMLElement).classList.remove('open');
  (document.getElementById('profileEditorModal') as HTMLElement).style.display = 'none';
  chartRegistry.dispose('profilePreviewChart');
}

export function openNewProfileForm(): void {
  openProfileForm(null, null);
}

// Opened from a bean card's "Create profile" button — empty editor with the
// bean's suggestion pre-filled, so Max never has to re-type Sertao's shape.
export function createProfileFromBean(beanId: number): void {
  const bean = S.coffeeLibrary.beans.find(b => b.id === beanId);
  if (!bean) return;
  openProfileForm(null, beanId);
  const suggestion = suggestProfileFromBean(bean);
  _applySuggestion(suggestion);
}

export function applyBeanSuggestion(): void {
  const bean = S.coffeeLibrary.beans.find(b => b.id === S.profileEditBeanId);
  if (!bean) return;
  _applySuggestion(suggestProfileFromBean(bean));
}

function _applySuggestion(suggestion: ProfileSuggestion): void {
  (document.getElementById('profileFormName') as HTMLInputElement).value      = suggestion.name;
  (document.getElementById('profileFormWaterTemp') as HTMLInputElement).value = String(suggestion.waterTemperature);
  (document.getElementById('profileFormCoffeeIn') as HTMLInputElement).value  = String(suggestion.recipe.coffeeIn);
  (document.getElementById('profileFormCoffeeOut') as HTMLInputElement).value = String(suggestion.recipe.coffeeOut);
  (document.getElementById('profileFormRatio') as HTMLInputElement).value     = String(suggestion.recipe.ratio);
  (document.getElementById('profileFormWeight') as HTMLInputElement).value    = String(suggestion.globalStopConditions.weight);
  _renderPhaseRows(suggestion.phases);
  renderProfilePreviewChart();
}

// ── Phase editor (DOM-as-state, mirrors library.js's recipe-step editor) ──
// Accepts either the API's phase shape or a suggestion's — both are only
// read field-by-field with `?? ''` fallbacks (see Phase).
function _renderPhaseRows(phases: unknown[] | null | undefined): void {
  const list = document.getElementById('profilePhaseList');
  if (!list) return;
  list.innerHTML = (phases || []).map((p, i) => _phaseRowHtml(i, p as Phase)).join('');
}

function _phaseRowHtml(i: number, p: Phase = {}): string {
  const target = p.target || {};
  const stop   = p.stopConditions || {};
  const type   = typeof p.type === 'string' ? p.type : PHASE_TYPES[p.type as number] || 'FLOW';
  const curve  = typeof target.curve === 'string' ? target.curve : CURVES[target.curve as number] || 'LINEAR';
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
      <div class="pp-field"><label>${t('profile_phase_target_volume')}</label><input type="number" step="0.1" class="pp-target-volume" value="${target.volume ?? ''}"></div>
      <div class="pp-field"><label>${t('profile_phase_restriction')}</label><input type="number" step="0.1" class="pp-restriction" value="${p.restriction ?? ''}"></div>
      <div class="pp-field"><label>${t('profile_phase_water_temperature')}</label><input type="number" step="0.1" class="pp-water-temp" value="${p.waterTemperature ?? ''}"></div>
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

export function addProfilePhase(): void {
  const list = document.getElementById('profilePhaseList');
  if (!list) return;
  const idx = list.children.length;
  list.insertAdjacentHTML('beforeend', _phaseRowHtml(idx));
}

export function removeProfilePhase(i: number): void {
  const row = document.getElementById(`profilePhase${i}`);
  if (row) row.remove();
  // Re-number remaining rows — same detail as removeRecipeStep() in
  // library.js: ids and the delete button's data-idx must stay in sync
  // with DOM order since the DOM is the only source of truth.
  document.querySelectorAll<HTMLElement>('#profilePhaseList .pp-row').forEach((row, idx) => {
    row.id = `profilePhase${idx}`;
    (row.querySelector('.pp-num') as HTMLElement).textContent = String(idx + 1);
    const delBtn = row.querySelector('.lib-btn-sm.del') as HTMLElement;
    delBtn.dataset.action = 'remove-profile-phase';
    delBtn.dataset.idx = String(idx);
  });
  renderProfilePreviewChart();
}

// target.volume and phase-level waterTemperature are z.number().optional()
// in phaseSchema — unlike the required-with-0-fallback fields above, an
// empty input here must round-trip to "key absent" (JSON.stringify drops
// undefined values), not to 0, so a blank field truly means "not set".
function _optionalNumber(row: Element, selector: string): number | undefined {
  const raw = row.querySelector<HTMLInputElement>(selector)?.value;
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = parseFloat(raw);
  return Number.isNaN(n) ? undefined : n;
}

// The required-with-0-fallback reads below: parseFloat(undefined) is NaN,
// which || collapses to 0 exactly as the untyped .js did.
function _num(row: Element, selector: string): number {
  return parseFloat(row.querySelector<HTMLInputElement>(selector)?.value as string) || 0;
}

// Exported for testing — reads phase rows from the DOM (module-level
// document global), no separate JS state kept in sync.
export function _collectPhases(): Phase[] {
  return [...document.querySelectorAll<HTMLElement>('#profilePhaseList .pp-row')].map(row => ({
    name: row.querySelector<HTMLInputElement>('.pp-name')?.value.trim() || '',
    type: row.querySelector<HTMLSelectElement>('.pp-type')?.value || 'FLOW',
    target: {
      start:  _num(row, '.pp-target-start'),
      end:    _num(row, '.pp-target-end'),
      curve:  row.querySelector<HTMLSelectElement>('.pp-target-curve')?.value || 'LINEAR',
      time:   _num(row, '.pp-target-time'),
      volume: _optionalNumber(row, '.pp-target-volume'),
    },
    restriction: _num(row, '.pp-restriction'),
    waterTemperature: _optionalNumber(row, '.pp-water-temp'),
    stopConditions: {
      time:               _num(row, '.pp-stop-time'),
      pressureAbove:      _num(row, '.pp-stop-pressure-above'),
      pressureBelow:      _num(row, '.pp-stop-pressure-below'),
      flowAbove:          _num(row, '.pp-stop-flow-above'),
      flowBelow:          _num(row, '.pp-stop-flow-below'),
      weight:             _num(row, '.pp-stop-weight'),
      waterPumpedInPhase: _num(row, '.pp-stop-water-pumped'),
    },
    skip: !!row.querySelector<HTMLInputElement>('.pp-skip')?.checked,
  }));
}

function _collectProfile(): ProfileDraft {
  const name = (document.getElementById('profileFormName') as HTMLInputElement).value.trim();
  return {
    name,
    waterTemperature: parseFloat((document.getElementById('profileFormWaterTemp') as HTMLInputElement).value) || 0,
    recipe: {
      coffeeIn:  parseFloat((document.getElementById('profileFormCoffeeIn') as HTMLInputElement).value) || 0,
      coffeeOut: parseFloat((document.getElementById('profileFormCoffeeOut') as HTMLInputElement).value) || 0,
      ratio:     parseFloat((document.getElementById('profileFormRatio') as HTMLInputElement).value) || 0,
    },
    globalStopConditions: {
      weight: parseFloat((document.getElementById('profileFormWeight') as HTMLInputElement).value) || 0,
    },
    phases: _collectPhases(),
  };
}

// ── "Send to machine" ───────────────────────────────────────────────
export async function sendProfileToMachine(): Promise<void> {
  const profile = _collectProfile();
  if (!profile.name) { (document.getElementById('profileFormName') as HTMLInputElement).focus(); return; }
  if (!profile.phases.length) { window.showToast?.(t('profile_no_phases_error')); return; }
  if (!confirm(t('profile_confirm_send'))) return;

  const r = await machinesApi.saveMachineProfile(S.profileEditId ?? null, { ...profile, machineId: S.activeMachineId });
  if (!r.ok) {
    const body: unknown = await r.json().catch(() => null);
    const err = (body as { error?: string } | null)?.error;
    window.showToast?.(t('profile_send_error') + (err ? `: ${err}` : ''));
    return;
  }
  closeProfileForm();
  await loadMachineProfileList();
}

// ── Preview chart ─────────────────────────────────────────────────────
// Synthesizes a time series from the phase list — pro-Phase target.curve
// interpolation from start→end over target.time ms — and draws it exactly
// like the shot-detail chart draws its dashed target-curves (destroy-before-
// recreate, see public-src/views/shots/index.js's espressoShotChart setup).
function _curveInterpolate(curve: string | number | undefined, frac: number): number {
  switch (curve) {
    case 'INSTANT': return 1;
    case 'EASE_IN':  return frac * frac;
    case 'EASE_OUT': return 1 - (1 - frac) * (1 - frac);
    case 'EASE_IN_OUT': return frac < 0.5 ? 2 * frac * frac : 1 - Math.pow(-2 * frac + 2, 2) / 2;
    case 'LINEAR':
    default: return frac;
  }
}

// Exported for testing — pure, no DOM.
export function _synthesizeSeries(phases: Phase[]): SeriesPoint[] {
  const points: SeriesPoint[] = [];
  let tMs = 0;
  let prevType: string | number | null | undefined = null;
  let prevEnd: number | null = null;
  for (const p of phases) {
    if (p.skip) continue;
    const target = p.target || {};
    // A blank target.start should carry over the previous phase's resolved
    // end value when both phases share the same type (PRESSURE/PRESSURE or
    // FLOW/FLOW) — otherwise a phase-type change or the first phase has no
    // sensible carry-over and falls back to 0, as before.
    const carryOver: number = prevType !== null && prevType === p.type ? (prevEnd ?? 0) : 0;
    const start: number    = target.start ?? carryOver;
    const end: number      = target.end ?? start;
    const duration: number = target.time || (p.stopConditions?.time) || 1000;
    const steps: number    = Math.max(2, Math.round(duration / 250));
    for (let s = 0; s <= steps; s++) {
      const frac  = s / steps;
      const value = start + (end - start) * _curveInterpolate(target.curve, frac);
      points.push({ x: (tMs + frac * duration) / 1000, y: value, type: p.type });
    }
    tMs += duration;
    prevType = p.type;
    prevEnd  = end;
  }
  return points;
}

export function renderProfilePreviewChart(): void {
  const ctx = document.getElementById('profilePreviewChart') as HTMLCanvasElement | null;
  if (!ctx) return;
  chartRegistry.dispose('profilePreviewChart');

  const phases = _collectPhases();
  const series = _synthesizeSeries(phases);
  if (!series.length) return;

  // PRESSURE (bar) and FLOW (ml/s) are different physical units — plotting
  // them as one line made a phase-type transition (e.g. 7 bar → ~1.6 ml/s)
  // look like a value "crash" even though nothing is wrong. Split into two
  // datasets with distinct colors/legend labels, using null for the other
  // dataset's x-range (with spanGaps off) so no false connecting line is
  // drawn across a different-unit phase — the unit change reads as a break,
  // not a fault. MANUAL-type points render on the flow line (closest
  // existing visual bucket; MANUAL is rare and unitless here).
  const pressurePoints = series.map(pt => ({ x: pt.x, y: pt.type === 'PRESSURE' ? pt.y : null }));
  const flowPoints     = series.map(pt => ({ x: pt.x, y: pt.type !== 'PRESSURE' ? pt.y : null }));

  chartRegistry.set('profilePreviewChart', new Chart(ctx, {
    type: 'line',
    data: {
      datasets: [
        {
          label: t('profile_preview_label_pressure'),
          data: pressurePoints,
          borderColor: '#3498db',
          backgroundColor: 'transparent',
          borderWidth: 2,
          tension: 0.15,
          pointStyle: false,
          stepped: false,
          spanGaps: false,
        },
        {
          label: t('profile_preview_label_flow'),
          data: flowPoints,
          borderColor: '#e67e22',
          backgroundColor: 'transparent',
          borderWidth: 2,
          tension: 0.15,
          pointStyle: false,
          stepped: false,
          spanGaps: false,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { display: true },
      },
      scales: {
        x: { type: 'linear', title: { display: true, text: t('profile_preview_x_axis') } },
        y: { title: { display: true, text: t('profile_preview_y_axis') } },
      },
    },
  }));
}
