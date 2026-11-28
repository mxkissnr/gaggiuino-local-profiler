// The grind-setting field (#1961): free text without a grinder scale, a
// dropdown of valid clicks on a stepped grinder, a validated number on a
// stepless one, a validated reading on a dial (#2225; a dropdown only for a
// stepped dial with few readings), plus the scale fields of the grinder form.
// An unedited field always reads back the stored string byte for byte.
import { S } from '../../state/index.js';
import { t, tHtml } from '../../i18n.js';
import { esc, html, joinHtml } from '../../utils.js';
import type { Html } from '../../utils.js';
import { formatGrind, grindValues, normalizeGrindInput, numericGrind, parseGrind, parseGrindScale, scaleForGrinder, storedGrindScale } from '../../grind-scale.js';
import type { GrindScale, StoredGrindScale } from '../../grind-scale.js';

interface FieldState {
  scale: GrindScale;
  stored: string;     // what renderGrindField was given
  shown: string;      // what the control shows for it
  lastGood: string;   // what to save while the input is invalid
  dropdown: boolean;  // the select shows the value, not the text input
}

// #2225: more readings than this and a dial is typed, not picked.
const MAX_DIAL_DROPDOWN_VALUES = 100;

function usesDropdown(scale: GrindScale): boolean {
  if (scale.type === 'stepless') return false;
  if (!scale.dial) return true;
  return !scale.dial.stepless && (scale.max - scale.min) / scale.step + 1 <= MAX_DIAL_DROPDOWN_VALUES;
}

// Only fields currently on a scale are in here.
const fields = new Map<string, FieldState>();

export function grindSelectId(inputId: string): string { return `grindSelect-${inputId}`; }

const inputOf  = (id: string): HTMLInputElement | null => document.getElementById(id) as HTMLInputElement | null;
const selectOf = (id: string): HTMLSelectElement | null => document.getElementById(grindSelectId(id)) as HTMLSelectElement | null;

function setHint(inputId: string, text: string): void {
  const el = document.getElementById(`grindHint-${inputId}`);
  if (!el) return;
  el.textContent = text;
  el.hidden = !text;
}

function showAsText(input: HTMLInputElement, select: HTMLSelectElement | null): void {
  if (select) select.hidden = true;
  input.hidden = false;
}

export function renderGrindField(inputId: string, grinderName: string | null | undefined, value: string | number | null | undefined): void {
  const input = inputOf(inputId);
  if (!input) return;
  const stored = String(value ?? '');
  const scale = scaleForGrinder(S.coffeeLibrary?.grinders, grinderName);
  if (!scale) {
    if (fields.delete(inputId)) {
      showAsText(input, selectOf(inputId));
      input.removeAttribute('inputmode');
      setHint(inputId, '');
    }
    input.value = stored;
    return;
  }
  const select = selectOf(inputId);
  const state: FieldState = { scale, stored, shown: stored, lastGood: stored, dropdown: !!select && usesDropdown(scale) };
  fields.set(inputId, state);
  setHint(inputId, '');
  if (!state.dropdown || !select) {
    showAsText(input, select);
    // A dial reading needs both "." and "," (8.2,5) or a letter (12E).
    input.setAttribute('inputmode', scale.dial ? 'text' : 'decimal');
    input.value = stored;
    return;
  }
  const values = grindValues(scale);
  const position = parseGrind(scale, stored);
  const match  = position === null ? undefined : values.find(v => parseGrind(scale, v) === position);
  const offList = stored !== '' && match === undefined;
  state.shown = match ?? stored;
  const options = document.createDocumentFragment();
  options.append(new Option('', ''));
  if (offList) options.append(new Option(t('grind_scale_off_list', stored), stored));
  for (const v of values) options.append(new Option(v, v));
  select.replaceChildren(options);
  select.value  = state.shown;
  select.hidden = false;
  input.hidden  = true;
  input.value   = state.shown;
  select.onchange = () => { input.value = select.value; };
}

// For a field whose markup was just re-created: it starts as plain text again.
export function forgetGrindField(inputId: string): void {
  fields.delete(inputId);
}

// The value to save. An invalid entry on a stepless field yields the last
// valid value, so autosave never loses it or blocks the other fields.
export function getGrindFieldValue(inputId: string): string {
  const input = inputOf(inputId);
  if (!input) return '';
  const state = fields.get(inputId);
  if (!state) return input.value.trim();
  const select = state.dropdown ? selectOf(inputId) : null;
  const current = (select ? select.value : input.value).trim();
  if (current === state.shown) return state.stored;
  const normalized = select ? current : normalizeGrindInput(state.scale, current);
  if (normalized === null) return state.lastGood;
  state.lastGood = normalized;
  return normalized;
}

export function grindFieldInvalid(inputId: string): boolean {
  const state = fields.get(inputId);
  if (!state || state.dropdown) return false;
  const current = inputOf(inputId)?.value.trim() ?? '';
  return current !== state.shown && normalizeGrindInput(state.scale, current) === null;
}

export function checkGrindField(inputId: string): void {
  const state = fields.get(inputId);
  if (!state) return;
  const { scale } = state;
  const hint = !grindFieldInvalid(inputId) ? ''
    : scale.dial ? t('grind_scale_invalid_dial', scale.dial.min, scale.dial.max, formatGrind(scale, scale.min + scale.step))
    : t('grind_scale_invalid', scale.min, scale.max, scale.step);
  setHint(inputId, hint);
}

// Shows a valid entry in its stored form once the user has left the field.
export function tidyGrindField(inputId: string): void {
  const state = fields.get(inputId);
  const input = inputOf(inputId);
  if (!state || !input || state.dropdown || input.value.trim() === state.shown) return;
  const normalized = normalizeGrindInput(state.scale, input.value);
  if (normalized !== null) input.value = normalized;
}

// After the grinder or the library changed. Keeps the value, and leaves a field
// alone while the user is in it.
export function refreshGrindField(inputId: string, grinderName: string | null | undefined): void {
  if (!fields.has(inputId) && !scaleForGrinder(S.coffeeLibrary?.grinders, grinderName)) return;
  const active = document.activeElement;
  if (active && (active === inputOf(inputId) || active === selectOf(inputId))) return;
  renderGrindField(inputId, grinderName, getGrindFieldValue(inputId));
}

// ── Grinder form ──────────────────────────────────────────────────────────

const SCALE_DEFAULTS: Partial<Record<GrindScale['type'], { min: number; max: number; step: number }>> = {
  stepped:  { min: 0, max: 40, step: 1 },
  stepless: { min: 0, max: 10, step: 0.1 },
};

const SCALE_TYPE_PILLS: readonly (readonly [string, string])[] = [
  ['', 'lib_grinder_scale_none'],
  ['stepped', 'lib_grinder_scale_stepped'],
  ['stepless', 'lib_grinder_scale_stepless'],
  ['dial', 'lib_grinder_scale_dial'],
];

// #2225: common layouts. A preset only fills the fields below, every field
// stays editable, and none names a grinder model.
const SCALE_PRESETS: readonly (readonly [string, string, Record<string, unknown>])[] = [
  ['number_stepped', 'lib_grinder_scale_preset_number_stepped', { type: 'stepped', min: 1, max: 40, step: 1 }],
  ['number_stepless', 'lib_grinder_scale_preset_number_stepless', { type: 'stepless', min: 0, max: 10, step: 0.1 }],
  ['clicks', 'lib_grinder_scale_preset_clicks', { type: 'stepped', min: 0, max: 60, step: 1 }],
  ['rotation', 'lib_grinder_scale_preset_rotation', { type: 'dial', parts: [{ count: null, start: 0 }, { count: 10 }, { count: 10 }], min: '0.0.0', max: '4.9.9' }],
  ['ring', 'lib_grinder_scale_preset_ring', { type: 'dial', parts: [{ count: null, start: 0 }, { count: 6 }], min: '0.0', max: '12.5', stepless: true, resolution: 2 }],
  ['letter', 'lib_grinder_scale_preset_letter', { type: 'dial', parts: [{ count: null, start: 1 }, { count: 9, labels: 'letter' }], min: '1A', max: '31I' }],
];

const LABEL_OPTIONS: readonly (readonly [string, string])[] = [
  ['number', 'lib_grinder_scale_labels_number'],
  ['letter', 'lib_grinder_scale_labels_letter'],
];

const BETWEEN_OPTIONS: readonly (readonly [string, string])[] = [
  ['1', 'lib_grinder_scale_between_none'],
  ['2', 'lib_grinder_scale_between_half'],
  ['4', 'lib_grinder_scale_between_quarter'],
];

// The grinder form exists once, so its one choice can live here.
let scaleFormType = '';

function scaleTextField(id: string, labelKey: string, value: string | number | null | undefined, inputmode = 'decimal'): Html {
  return html`<div class="lib-form-field" id="${esc(id)}Field">
    <label for="${esc(id)}" data-i18n="${esc(labelKey)}">${tHtml(labelKey)}</label>
    <input type="text" inputmode="${esc(inputmode)}" id="${esc(id)}" value="${esc(value ?? '')}">
  </div>`;
}

function scaleSelectField(id: string, labelKey: string, options: readonly (readonly [string, string])[], value: string): Html {
  return html`<div class="lib-form-field" id="${esc(id)}Field">
    <label for="${esc(id)}" data-i18n="${esc(labelKey)}">${tHtml(labelKey)}</label>
    <select class="lib-select" id="${esc(id)}">${joinHtml(options.map(([v, key]) =>
      html`<option value="${esc(v)}"${v === value ? html` selected` : html``} data-i18n="${esc(key)}">${tHtml(key)}</option>`))}</select>
  </div>`;
}

function textField(id: string): HTMLInputElement | null {
  return document.getElementById(id) as HTMLInputElement | null;
}

function fieldValue(id: string): string {
  return (document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null)?.value.trim() ?? '';
}

function setFieldValue(id: string, value: string | number | null | undefined): void {
  const field = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
  if (field) field.value = value === null || value === undefined ? '' : String(value);
}

function renderScaleTypePills(): void {
  const group = document.getElementById('grinderFormScaleType');
  if (!group) return;
  group.innerHTML = joinHtml(SCALE_TYPE_PILLS.map(([value, key]) =>
    html`<button type="button" class="chip" aria-pressed="${esc(String(scaleFormType === value))}" data-scale-type="${esc(value)}" data-i18n="${esc(key)}">${tHtml(key)}</button>`));
}

// The range shows for every scale, the step only for a one-part scale, the
// parts only for a dial, the third part's notation only with its count, and
// an example of the settings once the fields form a scale (#2233).
function showScaleFields(): void {
  const range = document.getElementById('grinderFormScaleRange');
  if (range) range.hidden = !scaleFormType;
  const step = document.getElementById('grinderFormScaleStepField');
  if (step) step.hidden = scaleFormType === 'dial';
  const dial = document.getElementById('grinderFormScaleDial');
  if (dial) dial.hidden = scaleFormType !== 'dial';
  const part2Labels = document.getElementById('grinderFormScalePart2LabelsField');
  if (part2Labels) part2Labels.hidden = fieldValue('grinderFormScalePart2Count') === '';
  for (const id of ['grinderFormScaleMin', 'grinderFormScaleMax']) textField(id)?.setAttribute('inputmode', scaleFormType === 'dial' ? 'text' : 'decimal');
  const example = document.getElementById('grinderFormScaleExample');
  if (!example) return;
  const scale = scaleFromForm();
  example.textContent = scale ? t('lib_grinder_scale_example', scaleExample(scale)) : '';
  example.hidden = !scale;
}

// The lowest setting, one whole unit above it and, between steps on a dial,
// the first in-between setting, as the scale writes them (#2233).
function scaleExample(scale: GrindScale): string {
  const positions = [scale.min, scale.min + (scale.dial ? 1 : scale.step)];
  if (scale.dial?.stepless) positions.push(scale.min + scale.step);
  return positions.filter(v => v <= scale.max + 1e-9).map(v => formatGrind(scale, v)).join(' · ');
}

// Writes every field from a scale, as a preset does.
function fillScaleFields(scale: GrindScale): void {
  const dial = scale.dial;
  setFieldValue('grinderFormScaleMin', dial ? dial.min : scale.min);
  setFieldValue('grinderFormScaleMax', dial ? dial.max : scale.max);
  setFieldValue('grinderFormScaleStep', dial ? '' : scale.step);
  setFieldValue('grinderFormScaleStart', dial?.parts[0]?.start ?? 0);
  setFieldValue('grinderFormScalePart1Count', dial?.parts[1]?.count);
  setFieldValue('grinderFormScalePart1Labels', dial?.parts[1]?.labels ?? 'number');
  setFieldValue('grinderFormScalePart2Count', dial?.parts[2]?.count);
  setFieldValue('grinderFormScalePart2Labels', dial?.parts[2]?.labels ?? 'number');
  setFieldValue('grinderFormScaleBetween', dial?.stepless ? dial.resolution : 1);
}

function applyScalePreset(id: string): void {
  const raw = SCALE_PRESETS.find(([key]) => key === id)?.[2];
  const scale = raw ? parseGrindScale(raw) : null;
  if (!scale) return;
  scaleFormType = scale.type;
  fillScaleFields(scale);
  renderScaleTypePills();
  showScaleFields();
  setFieldValue('grinderFormScalePreset', id);
}

function pickScaleType(type: string): void {
  // A dial without parts yet starts from the ring layout.
  if (type === 'dial' && !fieldValue('grinderFormScalePart1Count')) { applyScalePreset('ring'); return; }
  scaleFormType = type;
  setFieldValue('grinderFormScalePreset', '');
  renderScaleTypePills();
  const defaults = SCALE_DEFAULTS[type as GrindScale['type']];
  if (defaults) {
    for (const [id, value] of [['grinderFormScaleMin', defaults.min], ['grinderFormScaleMax', defaults.max], ['grinderFormScaleStep', defaults.step]] as const) {
      const input = textField(id);
      if (input && !input.value.trim()) input.value = String(value);
    }
  }
  showScaleFields();
}

// A field changed by hand: the form no longer shows a picked layout.
function scaleFieldEdited(): void {
  setFieldValue('grinderFormScalePreset', '');
  showScaleFields();
}

export function renderGrinderScaleForm(raw: unknown): void {
  const root = document.getElementById('grinderFormScale');
  if (!root) return;
  const scale = parseGrindScale(raw);
  const dial = scale?.dial;
  scaleFormType = scale?.type ?? '';
  root.innerHTML = html`<div class="lib-form-field">
      <label id="grinderFormScaleLabel" data-i18n="lib_grinder_scale">${tHtml('lib_grinder_scale')}</label>
      <div class="drink-pills" id="grinderFormScaleType" role="group" aria-labelledby="grinderFormScaleLabel"></div>
    </div>
    ${scaleSelectField('grinderFormScalePreset', 'lib_grinder_scale_preset', [['', 'lib_grinder_scale_preset_pick'], ...SCALE_PRESETS.map(([key, label]) => [key, label] as const)], '')}
    <div class="lib-form-grid" id="grinderFormScaleRange">
      ${scaleTextField('grinderFormScaleMin', 'lib_grinder_scale_min', dial ? dial.min : scale?.min, dial ? 'text' : 'decimal')}
      ${scaleTextField('grinderFormScaleMax', 'lib_grinder_scale_max', dial ? dial.max : scale?.max, dial ? 'text' : 'decimal')}
      ${scaleTextField('grinderFormScaleStep', 'lib_grinder_scale_step', dial ? '' : scale?.step)}
    </div>
    <div class="lib-form-grid" id="grinderFormScaleDial">
      ${scaleTextField('grinderFormScaleStart', 'lib_grinder_scale_start', dial?.parts[0]?.start ?? 0, 'numeric')}
      ${scaleTextField('grinderFormScalePart1Count', 'lib_grinder_scale_part1', dial?.parts[1]?.count, 'numeric')}
      ${scaleSelectField('grinderFormScalePart1Labels', 'lib_grinder_scale_part1_labels', LABEL_OPTIONS, dial?.parts[1]?.labels ?? 'number')}
      ${scaleTextField('grinderFormScalePart2Count', 'lib_grinder_scale_part2', dial?.parts[2]?.count, 'numeric')}
      ${scaleSelectField('grinderFormScalePart2Labels', 'lib_grinder_scale_part2_labels', LABEL_OPTIONS, dial?.parts[2]?.labels ?? 'number')}
      ${scaleSelectField('grinderFormScaleBetween', 'lib_grinder_scale_between', BETWEEN_OPTIONS, String(dial?.stepless ? dial.resolution : 1))}
    </div>
    <p class="settings-card-desc" id="grinderFormScaleExample" aria-live="polite" hidden></p>
    <div class="bf-error" id="grinderFormScaleError" role="alert" hidden></div>`;
  renderScaleTypePills();
  showScaleFields();
  // onclick/onchange, not addEventListener: reopening the form must not stack handlers.
  root.onclick = e => {
    const pill = (e.target as HTMLElement).closest<HTMLElement>('[data-scale-type]');
    if (pill) pickScaleType(pill.dataset.scaleType ?? '');
  };
  root.onchange = e => {
    const target = e.target as HTMLSelectElement | null;
    if (target?.id === 'grinderFormScalePreset') applyScalePreset(target.value);
    else scaleFieldEdited();
  };
  root.oninput = e => {
    const target = e.target as HTMLElement | null;
    if (target?.id !== 'grinderFormScalePreset') scaleFieldEdited();
  };
}

// The dial fields as a stored dial scale, for parseGrindScale to check.
function readDialForm(): Record<string, unknown> {
  const whole = (id: string): number | null => numericGrind(fieldValue(id));
  const parts: Record<string, unknown>[] = [{ count: null, start: fieldValue('grinderFormScaleStart') === '' ? 0 : whole('grinderFormScaleStart') }];
  for (const n of [1, 2]) {
    if (fieldValue(`grinderFormScalePart${n}Count`) === '') continue;
    parts.push({ count: whole(`grinderFormScalePart${n}Count`), labels: fieldValue(`grinderFormScalePart${n}Labels`) || 'number' });
  }
  const between = Number(fieldValue('grinderFormScaleBetween')) || 1;
  return { type: 'dial', parts, min: fieldValue('grinderFormScaleMin'), max: fieldValue('grinderFormScaleMax'), stepless: between > 1, resolution: between };
}

// The scale the fields describe now, null when they do not form one.
function scaleFromForm(): GrindScale | null {
  if (!scaleFormType) return null;
  const read = (id: string): number | null => numericGrind(textField(id)?.value ?? '');
  return parseGrindScale(scaleFormType === 'dial' ? readDialForm()
    : { type: scaleFormType, min: read('grinderFormScaleMin'), max: read('grinderFormScaleMax'), step: read('grinderFormScaleStep') });
}

// null: no scale. undefined: invalid, the error is showing and nothing may be saved.
export function readGrinderScaleForm(): StoredGrindScale | null | undefined {
  const error = document.getElementById('grinderFormScaleError');
  if (error) { error.textContent = ''; error.hidden = true; }
  if (!scaleFormType) return null;
  const scale = scaleFromForm();
  if (scale) return storedGrindScale(scale);
  if (error) { error.textContent = t(scaleFormType === 'dial' ? 'lib_grinder_scale_invalid_dial' : 'lib_grinder_scale_invalid'); error.hidden = false; }
  return undefined;
}
