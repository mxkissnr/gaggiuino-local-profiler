// The grind-setting field (#1961): free text without a grinder scale, a
// dropdown of valid clicks on a stepped grinder, a validated number on a
// stepless one, plus the scale fields of the grinder form. An unedited field
// always reads back the stored string byte for byte.
import { S } from '../../state/index.js';
import { t, tHtml } from '../../i18n.js';
import { esc, html, joinHtml } from '../../utils.js';
import type { Html } from '../../utils.js';
import { grindValues, normalizeGrindInput, numericGrind, parseGrindScale, scaleForGrinder } from '../../grind-scale.js';
import type { GrindScale } from '../../grind-scale.js';

interface FieldState {
  scale: GrindScale;
  stored: string;     // what renderGrindField was given
  shown: string;      // what the control shows for it
  lastGood: string;   // what to save while the input is invalid
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
  const state: FieldState = { scale, stored, shown: stored, lastGood: stored };
  fields.set(inputId, state);
  setHint(inputId, '');
  const select = selectOf(inputId);
  if (scale.type === 'stepless' || !select) {
    showAsText(input, select);
    input.setAttribute('inputmode', 'decimal');
    input.value = stored;
    return;
  }
  const values = grindValues(scale);
  const number = numericGrind(stored);
  const match  = number === null ? undefined : values.find(v => parseFloat(v) === number);
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
  const select = state.scale.type === 'stepped' ? selectOf(inputId) : null;
  const current = (select ? select.value : input.value).trim();
  if (current === state.shown) return state.stored;
  const normalized = select ? current : normalizeGrindInput(state.scale, current);
  if (normalized === null) return state.lastGood;
  state.lastGood = normalized;
  return normalized;
}

export function grindFieldInvalid(inputId: string): boolean {
  const state = fields.get(inputId);
  if (!state || state.scale.type === 'stepped') return false;
  const current = inputOf(inputId)?.value.trim() ?? '';
  return current !== state.shown && normalizeGrindInput(state.scale, current) === null;
}

export function checkGrindField(inputId: string): void {
  const state = fields.get(inputId);
  if (!state) return;
  setHint(inputId, grindFieldInvalid(inputId) ? t('grind_scale_invalid', state.scale.min, state.scale.max, state.scale.step) : '');
}

// Shows a valid entry in its stored form once the user has left the field.
export function tidyGrindField(inputId: string): void {
  const state = fields.get(inputId);
  const input = inputOf(inputId);
  if (!state || !input || state.scale.type === 'stepped' || input.value.trim() === state.shown) return;
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

const SCALE_DEFAULTS: Record<GrindScale['type'], { min: number; max: number; step: number }> = {
  stepped:  { min: 0, max: 40, step: 1 },
  stepless: { min: 0, max: 10, step: 0.1 },
};

const SCALE_TYPE_PILLS: readonly (readonly [string, string])[] = [
  ['', 'lib_grinder_scale_none'],
  ['stepped', 'lib_grinder_scale_stepped'],
  ['stepless', 'lib_grinder_scale_stepless'],
];

// The grinder form exists once, so its one choice can live here.
let scaleFormType = '';

function scaleNumberField(id: string, labelKey: string, value: number | undefined): Html {
  return html`<div class="lib-form-field">
    <label for="${esc(id)}" data-i18n="${esc(labelKey)}">${tHtml(labelKey)}</label>
    <input type="text" inputmode="decimal" id="${esc(id)}" value="${esc(value ?? '')}">
  </div>`;
}

function textField(id: string): HTMLInputElement | null {
  return document.getElementById(id) as HTMLInputElement | null;
}

function renderScaleTypePills(): void {
  const group = document.getElementById('grinderFormScaleType');
  if (!group) return;
  group.innerHTML = joinHtml(SCALE_TYPE_PILLS.map(([value, key]) =>
    html`<button type="button" class="drink-pill${esc(scaleFormType === value ? ' active' : '')}" aria-pressed="${esc(String(scaleFormType === value))}" data-scale-type="${esc(value)}" data-i18n="${esc(key)}">${tHtml(key)}</button>`));
}

function pickScaleType(type: string): void {
  scaleFormType = type;
  renderScaleTypePills();
  const range = document.getElementById('grinderFormScaleRange');
  if (range) range.hidden = !type;
  const defaults = SCALE_DEFAULTS[type as GrindScale['type']];
  if (!defaults) return;
  for (const [id, value] of [['grinderFormScaleMin', defaults.min], ['grinderFormScaleMax', defaults.max], ['grinderFormScaleStep', defaults.step]] as const) {
    const input = textField(id);
    if (input && !input.value.trim()) input.value = String(value);
  }
}

export function renderGrinderScaleForm(raw: unknown): void {
  const root = document.getElementById('grinderFormScale');
  if (!root) return;
  const scale = parseGrindScale(raw);
  scaleFormType = scale?.type ?? '';
  root.innerHTML = html`<div class="lib-form-field">
      <label id="grinderFormScaleLabel" data-i18n="lib_grinder_scale">${tHtml('lib_grinder_scale')}</label>
      <div class="drink-pills" id="grinderFormScaleType" role="group" aria-labelledby="grinderFormScaleLabel"></div>
    </div>
    <div class="lib-form-grid" id="grinderFormScaleRange">
      ${scaleNumberField('grinderFormScaleMin', 'lib_grinder_scale_min', scale?.min)}
      ${scaleNumberField('grinderFormScaleMax', 'lib_grinder_scale_max', scale?.max)}
      ${scaleNumberField('grinderFormScaleStep', 'lib_grinder_scale_step', scale?.step)}
    </div>
    <div class="bf-error" id="grinderFormScaleError" role="alert" hidden></div>`;
  renderScaleTypePills();
  (document.getElementById('grinderFormScaleRange') as HTMLElement).hidden = !scale;
  // onclick, not addEventListener: reopening the form must not stack handlers.
  root.onclick = e => {
    const pill = (e.target as HTMLElement).closest<HTMLElement>('[data-scale-type]');
    if (pill) pickScaleType(pill.dataset.scaleType ?? '');
  };
}

// null: no scale. undefined: invalid, the error is showing and nothing may be saved.
export function readGrinderScaleForm(): GrindScale | null | undefined {
  const error = document.getElementById('grinderFormScaleError');
  if (error) { error.textContent = ''; error.hidden = true; }
  if (!scaleFormType) return null;
  const read = (id: string): number | null => numericGrind(textField(id)?.value ?? '');
  const scale = parseGrindScale({ type: scaleFormType, min: read('grinderFormScaleMin'), max: read('grinderFormScaleMax'), step: read('grinderFormScaleStep') });
  if (scale) return scale;
  if (error) { error.textContent = t('lib_grinder_scale_invalid'); error.hidden = false; }
  return undefined;
}
