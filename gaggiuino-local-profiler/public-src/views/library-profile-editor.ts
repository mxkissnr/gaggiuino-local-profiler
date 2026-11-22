// Machine profile editor (#307) — visual editor for Gaggiuino machine
// profiles, backed by the WebSocket/Protobuf backend from #306
// (GET/POST/PUT/DELETE /api/machine/profile[/:id]).
//
// Phase editing follows the same DOM-as-state pattern as the recipe-step
// editor in library.ts (_renderStepRows/addRecipeStep/removeRecipeStep/
// _collectSteps): the rows in #profilePhaseList are the source of truth at
// save time, no separate JS array is kept in sync. removeProfilePhase()
// renumbers all remaining rows/ids/data-idx after a removal, same as
// removeRecipeStep().
//
// #2154: chart first, then a phase timeline (the shared phase-timeline component)
// and only the selected phase's row; the other rows stay in the DOM with
// the hidden attribute, so _collectPhases still reads the whole profile.
import Chart from 'chart.js/auto';
import { S, concreteActiveMachineId } from '../state/index.js';
import * as chartRegistry from '../state/charts.js';
import { t, tHtml } from '../i18n.js';
import * as machinesApi from '../api/machines.js';
import type { MachineProfile, MachineProfileList } from '../api/types.js';
import { esc, html, joinHtml } from '../utils.js';
import type { Html } from '../utils.js';
import { suggestProfileFromBean } from '../profile-suggestion.js';
import type { ProfileSuggestion } from '../profile-suggestion.js';
import { TARGET_ICON_SVG, ICON_TRASH } from '../icons.js';
import { confirmDialog } from '../components/confirm-dialog.js';
import { markFieldInvalid } from '../components/field-error.js';
import { bindPillSelects } from '../components/pill-select.js';
import { phaseTimelineHtml, phaseHeadHtml, stopsFoldHtml, removePhaseButtonHtml } from '../components/phase-timeline.js';

const ICON_PENCIL: Html = html`<svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15" aria-hidden="true"><path d="M20.71,7.04C21.1,6.65 21.1,6 20.71,5.63L18.37,3.29C18,2.9 17.35,2.9 16.96,3.29L15.12,5.12L18.87,8.87M3,17.25V21H6.75L17.81,9.93L14.06,6.18L3,17.25Z"/></svg>`;
const ICON_COPY: Html   = html`<svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15" aria-hidden="true"><path d="M16,1H4A2,2 0 0,0 2,3V17H4V3H16V1M19,5H8A2,2 0 0,0 6,7V21A2,2 0 0,0 8,23H19A2,2 0 0,0 21,21V7A2,2 0 0,0 19,5M19,21H8V7H19V21Z"/></svg>`;

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

// The machine the profile form was opened for, captured at open so a topbar
// machine switch mid-edit cannot retarget the save (#1605). null = no explicit
// machine ('all'/none selected), so the save sends no machineId and the
// backend uses the default machine.
let _formMachineId: number | null = null;

// #2154: the phase whose row is visible (0-based); the timeline marks it.
let _selectedPhase = 0;

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
  S.machineProfiles = Array.isArray(data.optionsRaw) ? data.optionsRaw : [];
  S.machineProfilesStale = !!data.stale;
  renderProfileList();
  updateProfileDatalist();
}

// recipeFormProfile's autocomplete (components/autocomplete.ts, library.ts)
// reads S.machineProfiles live — this just re-renders it if it's currently
// open, so a profile list refresh elsewhere shows up immediately.
export function updateProfileDatalist(): void {
  (document.getElementById('recipeFormProfile') as HTMLInputElement | null)?._autocomplete?.refresh();
}

export function renderProfileList(): void {
  const el = document.getElementById('profileListUI');
  if (!el) return;
  if (!S.machineProfiles.length) {
    el.innerHTML = html`<div class="lib-empty">${tHtml(S.machineProfilesStale ? 'lib_profiles_offline' : 'lib_empty_profiles')}</div>`;
    return;
  }
  // codeql[js/xss-through-dom] false positive: esc()/escapeHtml() already applied, see #760
  el.innerHTML = joinHtml(S.machineProfiles.map(p => html`<div class="lib-item${p.utility ? html` lib-item-utility` : html``}">
      <div class="lib-item-info">
        <div class="lib-item-name-row">
          <span class="lib-item-name">${esc(p.name)}</span>
          ${p.utility ? html`<span class="badge">${tHtml('profile_utility_badge')}</span>` : html``}
          ${p.syncStatus && p.syncStatus !== 'synced' ? html`<span class="badge badge--warn" title="${tHtml('profile_not_synced')}">⏳</span>` : html``}
        </div>
      </div>
      <div class="lib-item-actions">
        <button type="button" class="btn btn--quiet btn--icon" data-action="start-profile-dialin" data-id="${esc(p.id as string | number)}" title="${tHtml('profile_dialin_start')}">${TARGET_ICON_SVG}</button>
        <button type="button" class="btn btn--quiet btn--icon" data-action="edit-profile" data-id="${esc(p.id as string | number)}" title="${tHtml('lib_btn_edit')}">${ICON_PENCIL}</button>
        <button type="button" class="btn btn--quiet btn--icon" data-action="duplicate-profile" data-id="${esc(p.id as string | number)}" title="${tHtml('profile_btn_duplicate')}">${ICON_COPY}</button>
        <button type="button" class="btn btn--danger btn--icon" data-action="delete-profile" data-id="${esc(p.id as string | number)}" title="${tHtml('lib_btn_delete')}">${ICON_TRASH}</button>
      </div>
    </div>`));
}

// #2162: the one place that turns a profile GET into either a profile to
// open or a toast saying why not. Used by Edit/Duplicate here, by the
// GaggiMate editor and by the profile dial-in wizard. A 503 means the machine
// is off and GLP has no full local copy of the profile yet; every other
// failure shows the caller's own load-error toast.
export async function loadProfileForEditing(
  id: string | number,
  machineId: string | number | undefined,
  failedKey: string,
): Promise<MachineProfile | null> {
  const { profile, notStored } = await machinesApi.getMachineProfileResult(id, machineId);
  if (!profile) window.showToast?.(t(notStored ? 'profile_not_stored_offline' : failedKey));
  return profile;
}

export async function editProfile(id: string): Promise<void> {
  const profile = await loadProfileForEditing(id, S.activeMachineId ?? '', 'profile_load_error');
  if (!profile) return;
  // #2167: the machine's REST export has no `id`; keep the one we opened,
  // so the save PUTs over this profile instead of creating a copy.
  openProfileForm({ ...profile, id: profile.id ?? id });
}

// Opens a fresh (unsaved) editor pre-filled with an existing profile's
// values — id cleared so sendProfileToMachine() POSTs a new profile
// instead of PUTting over the original, name suffixed so the duplicate
// is never accidentally confused with its source in the list.
export async function duplicateProfile(id: string): Promise<void> {
  const profile = await loadProfileForEditing(id, S.activeMachineId ?? '', 'profile_load_error');
  if (!profile) return;
  const duplicate: MachineProfile = { ...profile };
  delete duplicate.id;
  openProfileForm({ ...duplicate, name: `${profile.name}${t('profile_duplicate_suffix')}` });
}

export async function deleteMachineProfile(id: string): Promise<void> {
  if (!await confirmDialog(t('profile_confirm_delete'), { confirmLabel: t('lib_btn_delete'), destructive: true })) return;
  const r = await machinesApi.deleteMachineProfile(id, S.activeMachineId ?? '');
  if (!r.ok) { window.showToast?.(t('profile_send_error')); return; }
  await loadMachineProfileList();
}

// ── Editor modal ──────────────────────────────────────────────────────
export function openProfileForm(profile?: MachineProfile | null, beanId?: string | number | null): void {
  _formMachineId      = concreteActiveMachineId();
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
  // #2154: the name row sits at the bottom of the phone sheet now; start
  // at the top, on the sheet's close button.
  document.getElementById('closeProfileFormBtn')?.focus();
}

export function closeProfileForm(): void {
  _formMachineId      = null;
  _selectedPhase      = 0;
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
// bean's suggestion pre-filled, so the maintainer never has to re-type Sertao's shape.
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

// ── Phase editor (DOM-as-state, mirrors library.ts's recipe-step editor) ──
// Accepts either the API's phase shape or a suggestion's — both are only
// read field-by-field with `?? ''` fallbacks (see Phase).
function _renderPhaseRows(phases: unknown[] | null | undefined): void {
  const list = document.getElementById('profilePhaseList');
  if (!list) return;
  _selectedPhase = 0;
  list.innerHTML = joinHtml((phases || []).map((p, i) => _phaseRowHtml(i, p as Phase, i === _selectedPhase)));
  _bindPhasePills();
}

// Stub DOMs in other views' tests hand over a phase list without querySelectorAll.
function _bindPhasePills(): void {
  const list = document.getElementById('profilePhaseList');
  if (typeof list?.querySelectorAll === 'function') bindPillSelects(list);
}

// `visible` = this is the selected phase; every other row carries hidden.
function _phaseRowHtml(i: number, p: Phase = {}, visible = true): Html {
  const target = p.target || {};
  const stop   = p.stopConditions || {};
  const type   = typeof p.type === 'string' ? p.type : PHASE_TYPES[p.type as number] || 'FLOW';
  const curve  = typeof target.curve === 'string' ? target.curve : CURVES[target.curve as number] || 'LINEAR';
  return html`<div class="pp-row" id="profilePhase${esc(i)}"${visible ? html`` : html` hidden`}>
    <div class="pp-header">
      <input class="pp-name" aria-label="${tHtml('profile_phase_name')}" placeholder="${tHtml('profile_phase_name')}" value="${esc(p.name || '')}">
      <select class="pp-type" data-pills aria-label="${tHtml('profile_phase_type')}">
        ${joinHtml(PHASE_TYPES.map(pt => html`<option value="${esc(pt)}" ${pt === type ? html`selected` : html``}>${tHtml('phase_type_' + pt.toLowerCase())}</option>`))}
      </select>
      <label class="lib-check-label pp-skip-label">
        <input type="checkbox" class="pp-skip" ${p.skip ? html`checked` : html``}>
        <span>${tHtml('profile_phase_skip')}</span>
      </label>
    </div>
    <div class="pp-grid">
      <div class="pp-field"><label for="profilePhase${esc(i)}-target-start">${tHtml('profile_phase_target_start')}</label><input type="number" step="0.1" min="0" max="20" id="profilePhase${esc(i)}-target-start" class="pp-target-start" value="${esc(target.start ?? '')}"></div>
      <div class="pp-field"><label for="profilePhase${esc(i)}-target-end">${tHtml('profile_phase_target_end')}</label><input type="number" step="0.1" min="0" max="20" id="profilePhase${esc(i)}-target-end" class="pp-target-end" value="${esc(target.end ?? '')}"></div>
      <div class="pp-field"><label for="profilePhase${esc(i)}-target-curve">${tHtml('profile_phase_target_curve')}</label>
        <select class="pp-target-curve" data-pills id="profilePhase${esc(i)}-target-curve">${joinHtml(CURVES.map(c => html`<option value="${esc(c)}" ${c === curve ? html`selected` : html``}>${tHtml('curve_' + c.toLowerCase())}</option>`))}</select>
      </div>
      <div class="pp-field"><label for="profilePhase${esc(i)}-target-time">${tHtml('profile_phase_target_time')}</label><input type="number" step="1" min="0" max="600000" id="profilePhase${esc(i)}-target-time" class="pp-target-time" value="${esc(target.time ?? '')}"></div>
      <div class="pp-field"><label for="profilePhase${esc(i)}-target-volume">${tHtml('profile_phase_target_volume')}</label><input type="number" step="0.1" min="0" max="2000" id="profilePhase${esc(i)}-target-volume" class="pp-target-volume" value="${esc(target.volume ?? '')}"></div>
      <div class="pp-field"><label for="profilePhase${esc(i)}-restriction">${tHtml('profile_phase_restriction')}</label><input type="number" step="0.1" min="0" max="20" id="profilePhase${esc(i)}-restriction" class="pp-restriction" value="${esc(p.restriction ?? '')}"></div>
      <div class="pp-field"><label for="profilePhase${esc(i)}-water-temp">${tHtml('profile_phase_water_temperature')}</label><input type="number" step="0.1" min="0" max="150" id="profilePhase${esc(i)}-water-temp" class="pp-water-temp" value="${esc(p.waterTemperature ?? '')}"></div>
    </div>
    ${stopsFoldHtml(html`<div class="pp-grid">
      <div class="pp-field"><label for="profilePhase${esc(i)}-stop-time">${tHtml('profile_stop_time')}</label><input type="number" step="1" min="0" max="600000" id="profilePhase${esc(i)}-stop-time" class="pp-stop-time" value="${esc(stop.time ?? '')}"></div>
      <div class="pp-field"><label for="profilePhase${esc(i)}-stop-pressure-above">${tHtml('profile_stop_pressure_above')}</label><input type="number" step="0.1" min="0" max="20" id="profilePhase${esc(i)}-stop-pressure-above" class="pp-stop-pressure-above" value="${esc(stop.pressureAbove ?? '')}"></div>
      <div class="pp-field"><label for="profilePhase${esc(i)}-stop-pressure-below">${tHtml('profile_stop_pressure_below')}</label><input type="number" step="0.1" min="0" max="20" id="profilePhase${esc(i)}-stop-pressure-below" class="pp-stop-pressure-below" value="${esc(stop.pressureBelow ?? '')}"></div>
      <div class="pp-field"><label for="profilePhase${esc(i)}-stop-flow-above">${tHtml('profile_stop_flow_above')}</label><input type="number" step="0.1" min="0" max="20" id="profilePhase${esc(i)}-stop-flow-above" class="pp-stop-flow-above" value="${esc(stop.flowAbove ?? '')}"></div>
      <div class="pp-field"><label for="profilePhase${esc(i)}-stop-flow-below">${tHtml('profile_stop_flow_below')}</label><input type="number" step="0.1" min="0" max="20" id="profilePhase${esc(i)}-stop-flow-below" class="pp-stop-flow-below" value="${esc(stop.flowBelow ?? '')}"></div>
      <div class="pp-field"><label for="profilePhase${esc(i)}-stop-weight">${tHtml('profile_stop_weight')}</label><input type="number" step="0.1" min="0" max="2000" id="profilePhase${esc(i)}-stop-weight" class="pp-stop-weight" value="${esc(stop.weight ?? '')}"></div>
      <div class="pp-field"><label for="profilePhase${esc(i)}-stop-water-pumped">${tHtml('profile_stop_water_pumped')}</label><input type="number" step="0.1" min="0" max="2000" id="profilePhase${esc(i)}-stop-water-pumped" class="pp-stop-water-pumped" value="${esc(stop.waterPumpedInPhase ?? '')}"></div>
    </div>`, false)}
    ${removePhaseButtonHtml('remove-profile-phase', i)}
  </div>`;
}

export function addProfilePhase(): void {
  const list = document.getElementById('profilePhaseList');
  if (!list) return;
  const idx = list.children.length;
  list.insertAdjacentHTML('beforeend', _phaseRowHtml(idx));
  _bindPhasePills();
  // #2154: the new phase is the one whose fields show.
  selectProfilePhase(idx);
  renderProfilePreviewChart();
}

export function removeProfilePhase(i: number): void {
  const row = document.getElementById(`profilePhase${i}`);
  if (row) row.remove();
  // Re-number remaining rows — same detail as removeRecipeStep() in
  // library.ts: ids and the delete button's data-idx must stay in sync
  // with DOM order since the DOM is the only source of truth.
  document.querySelectorAll<HTMLElement>('#profilePhaseList .pp-row').forEach((row, idx) => {
    row.id = `profilePhase${idx}`;
    const delBtn = row.querySelector('.btn--danger') as HTMLElement;
    delBtn.dataset.action = 'remove-profile-phase';
    delBtn.dataset.idx = String(idx);
    // The labelled fields' ids (and their labels' `for`) are keyed off this
    // row's index as well, so renumber them too — otherwise a later
    // addProfilePhase() would generate an id a shifted row still carries.
    row.querySelectorAll<HTMLElement>('[id^="profilePhase"]').forEach(el => {
      el.id = el.id.replace(/^profilePhase\d+/, `profilePhase${idx}`);
    });
    row.querySelectorAll<HTMLElement>('label[for^="profilePhase"]').forEach(el => {
      const forAttr = el.getAttribute('for') ?? '';
      el.setAttribute('for', forAttr.replace(/^profilePhase\d+/, `profilePhase${idx}`));
    });
  });
  // #2154: keep a phase selected: the one that moved into the removed
  // slot, else the new last one.
  selectProfilePhase(i < _selectedPhase ? _selectedPhase - 1 : _selectedPhase);
  renderProfilePreviewChart();
}

// #2154: show one phase's row; the timeline marks it. The index is
// clamped to the rows that exist.
export function selectProfilePhase(i: number): void {
  const rows = [...document.querySelectorAll<HTMLElement>('#profilePhaseList .pp-row')];
  _selectedPhase = rows.length ? Math.max(0, Math.min(i, rows.length - 1)) : 0;
  rows.forEach((row, idx) => { row.hidden = idx !== _selectedPhase; });
  _renderPhaseNav();
}

// A phase's planned length in ms: the rule the preview chart draws with.
function _phaseMs(p: Phase): number {
  return p.target?.time || (p.stopConditions?.time) || 1000;
}

// The timeline (one chip per phase, as wide as its share of the time)
// and the head of the selected phase, both read off the phase rows.
function _renderPhaseNav(phases: Phase[] = _collectPhases()): void {
  const timeline = document.getElementById('profilePhaseTimeline');
  if (timeline) {
    // codeql[js/xss-through-dom] false positive: esc()/escapeHtml() already applied, see #760
    timeline.innerHTML = phaseTimelineHtml(phases.map(p => ({
      name: p.name ?? '',
      seconds: p.skip ? 0 : _phaseMs(p) / 1000,
      ...(p.skip ? { sub: t('profile_phase_skip') } : {}),
    })), _selectedPhase, {
      title: t('profile_phases_title'),
      selectAction: 'select-profile-phase',
      addAction: 'add-profile-phase',
      addLabel: t('profile_add_phase'),
      emptyText: t('gm_no_phases_add'),
    });
  }
  const head = document.getElementById('profilePhaseHead');
  if (head) head.innerHTML = phases.length ? phaseHeadHtml(_selectedPhase, phases.length) : html``;
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

function optionalKey<K extends string>(key: K, v: number | undefined): { [P in K]?: number } {
  return v === undefined ? {} : { [key]: v } as { [P in K]?: number };
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
      ...optionalKey('volume', _optionalNumber(row, '.pp-target-volume')),
    },
    restriction: _num(row, '.pp-restriction'),
    ...optionalKey('waterTemperature', _optionalNumber(row, '.pp-water-temp')),
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
  if (!profile.name) { markFieldInvalid(document.getElementById('profileFormName')); return; }
  if (!profile.phases.length) { window.showToast?.(t('profile_no_phases_error')); return; }
  if (!await confirmDialog(t('profile_confirm_send'), { destructive: true })) return;

  // Target the machine the form was opened for, not whatever is active now
  // (#1605). With none captured, send no machineId so the backend uses the
  // default machine.
  const body = _formMachineId != null ? { ...profile, machineId: _formMachineId } : { ...profile };
  const r = await machinesApi.saveMachineProfile(S.profileEditId ?? null, body);
  if (!r.ok) {
    const body: unknown = await r.json().catch(() => null);
    const err = (body as { error?: string } | null)?.error;
    window.showToast?.(t('profile_send_error') + (err ? `: ${err}` : ''));
    return;
  }
  // Same offline-editor contract as gaggimate-profile-editor.ts's
  // saveGaggiMateProfile: the backend saved locally first, this 200 might
  // just mean "queued, machine unreachable right now" — surface that
  // distinctly from a silent success.
  const saved: unknown = await r.json().catch(() => null);
  closeProfileForm();
  await loadMachineProfileList();
  const syncStatus = (saved as { syncStatus?: string } | null)?.syncStatus;
  if (syncStatus && syncStatus !== 'synced') {
    window.showToast?.(t('gm_toast_saved_offline'));
  }
}

// ── Preview chart ─────────────────────────────────────────────────────
// Synthesizes a time series from the phase list — pro-Phase target.curve
// interpolation from start→end over target.time ms — and draws it exactly
// like the shot-detail chart draws its dashed target-curves (destroy-before-
// recreate, see public-src/views/shots/index.ts's espressoShotChart setup).
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
    const duration: number = _phaseMs(p);
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
  // #2154: every edit also redraws the timeline and the phase head.
  const phases = _collectPhases();
  _renderPhaseNav(phases);
  const ctx = document.getElementById('profilePreviewChart') as HTMLCanvasElement | null;
  if (!ctx) return;
  chartRegistry.dispose('profilePreviewChart');

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
