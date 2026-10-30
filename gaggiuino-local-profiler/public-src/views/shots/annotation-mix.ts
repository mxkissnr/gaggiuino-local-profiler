// Bean-mix editor rows (#1837): the second to fourth bean of a mixed shot's
// dose. Row 1 has no select of its own — it is the annotation panel's own bean
// <select> (#annCoffee) — so this module renders every row's grams input and
// the extra rows' bean selects, while the row state stays authoritative.
//
// It deliberately does not import annotation.ts (annotation.ts imports this
// module for the payload, which would close an import cycle): initBeanMix()
// receives the library <select> renderer and the panel's auto-save scheduler.
import { t } from '../../i18n.js';
import { esc, html, joinHtml } from '../../utils.js';
import { beanMix } from '../../shared/bean-mix.js';
import type { BeanMixAnnotation, BeanMixPart, BeanMixPartInput } from '../../shared/bean-mix.js';

/** A shot's dose splits over at most four beans (the server's limit). */
export const MAX_MIX_ROWS = 4;

/** annotation.ts's _renderBeanSelect, injected by initBeanMix(). */
export type BeanSelectRenderer =
  (selectedName: string | null, selectedBeanId: number | null, selectId?: string) => void;

interface MixRow {
  coffee: string;
  beanId: number | null;
  grams: string;
}

const singleRow = (): MixRow[] => [{ coffee: '', beanId: null, grams: '' }];

let _rows: MixRow[] = singleRow();
let _renderBeanSelect: BeanSelectRenderer | null = null;
let _scheduleAutoSave: (() => void) | null = null;
let _primaryWired = false;

const _gramsId  = (i: number): string => `annMixGrams${i}`;
const _selectId = (i: number): string => `annMixBean${i}`;

function _el<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

// A bean select's chosen option carries data-bean-id only for a real library
// bean (see _renderBeanSelect) — the same contract _buildAnnotationPayload uses.
function _beanIdOf(select: HTMLSelectElement | null): number | null {
  const raw = select?.selectedOptions[0]?.dataset.beanId;
  if (raw == null || raw === '') return null;
  const id = parseInt(String(raw), 10);
  return Number.isFinite(id) ? id : null;
}

function _rowSelect(i: number): HTMLSelectElement | null {
  return _el<HTMLSelectElement>(i === 0 ? 'annCoffee' : _selectId(i));
}

function _gramsOf(row: MixRow): number {
  const grams = parseFloat(row.grams);
  return Number.isFinite(grams) ? grams : 0;
}

/**
 * The mix rows as payload parts: every row with a bean name and grams above
 * zero. Fewer than two such rows describe no mix, and the caller sends null.
 */
export function mixParts(): BeanMixPart[] {
  const parts: BeanMixPart[] = [];
  for (const row of _rows) {
    const coffee = row.coffee.trim();
    const grams = _gramsOf(row);
    if (coffee && grams > 0) parts.push({ beanId: row.beanId, coffee, grams });
  }
  return parts;
}

/** Sum of the parts' grams, rounded to the 0.1 g the dose field shows. */
export function mixPartsTotal(parts: readonly BeanMixPart[]): number {
  const total = parts.reduce((sum, p) => sum + p.grams, 0);
  return Math.round(total * 10) / 10;
}

/**
 * The part with the most grams — the shot's primary bean, which the top-level
 * beanId/coffee mirror. A tie keeps the earlier row.
 */
export function primaryMixPart(parts: readonly BeanMixPart[]): BeanMixPart | null {
  let best: BeanMixPart | null = null;
  for (const part of parts) {
    if (!best || part.grams > best.grams) best = part;
  }
  return best;
}

/** Number of rows currently shown (1 = a single bean, no mix). */
export function mixRowCount(): number {
  return _rows.length;
}

/** Whether the editor shows a mix, i.e. more than the primary bean's row. */
export function isMixActive(): boolean {
  return _rows.length >= 2;
}

/**
 * Grams typed into one row. The number input has no other channel into the
 * state: a programmatic value change fires no event.
 */
export function setMixRowGrams(index: number, grams: string | number): void {
  const row = _rows[index];
  if (!row) return;
  row.grams = String(grams);
  _syncDose();
}

/** The bean chosen in one extra row (row 1's bean is the panel's own select). */
export function setMixRowBean(index: number, coffee: string, beanId: number | null): void {
  const row = _rows[index];
  if (!row) return;
  row.coffee = coffee.trim();
  row.beanId = beanId;
}

/** The applied mix for a save: null for anything below two usable parts. */
export interface MixFields {
  beanMix: BeanMixPartInput[];
  coffee: string;
  beanId: number | null;
  dose: number;
}

/**
 * What a save sends for a mixed shot: the rows as `beanMix`, the dose as their
 * sum, and the top-level bean as the part with the most grams.
 */
export function mixFields(parts: readonly BeanMixPart[]): MixFields | null {
  if (parts.length < 2) return null;
  const primary = primaryMixPart(parts);
  return {
    beanMix: parts.map(p => ({ beanId: p.beanId, coffee: p.coffee, grams: p.grams })),
    coffee: primary?.coffee ?? '',
    beanId: primary?.beanId ?? null,
    dose: mixPartsTotal(parts),
  };
}

// In a mix the dose is always the rows' sum and therefore read-only; back on a
// single row the field keeps its value and becomes editable again.
function _syncDose(): void {
  const doseEl = _el<HTMLInputElement>('annDose');
  if (!doseEl) return;
  if (!isMixActive()) { doseEl.readOnly = false; return; }
  const total = mixPartsTotal(mixParts());
  doseEl.readOnly = true;
  doseEl.value = total > 0 ? String(total) : '';
}

export function initBeanMix(renderBeanSelect: BeanSelectRenderer, scheduleAutoSave: () => void): void {
  _renderBeanSelect = renderBeanSelect;
  _scheduleAutoSave = scheduleAutoSave;
}

// Row 1's bean is the panel's own #annCoffee select, which outlives every
// render here — so its listener is attached once, not per render. In a mix a
// bean change re-labels row 1 and recomputes the dose, and the panel's own
// bean-change handler must then leave the dose alone (see boot/annotation.ts).
function _wirePrimarySelect(select: HTMLSelectElement | null): void {
  if (!select || _primaryWired || typeof select.addEventListener !== 'function') return;
  _primaryWired = true;
  select.addEventListener('change', () => {
    if (!isMixActive()) return;
    const row = _rows[0];
    if (row) {
      row.coffee = String(select.value).trim();
      row.beanId = _beanIdOf(select);
    }
    renderBeanMix();
    _scheduleAutoSave?.();
  });
}

/** Re-renders the rows from the state and keeps the dose in sync. */
export function renderBeanMix(): void {
  _wirePrimarySelect(_el<HTMLSelectElement>('annCoffee'));
  _syncDose();

  const addBtn = _el<HTMLButtonElement>('annMixAddBtn');
  if (addBtn) addBtn.style.display = _rows.length >= MAX_MIX_ROWS ? 'none' : '';
  const container = _el<HTMLElement>('annMixRows');
  if (!container) return;
  container.style.display = isMixActive() ? '' : 'none';
  if (!isMixActive()) { container.innerHTML = html``; return; }

  container.innerHTML = joinHtml(_rows.map((row, i) => html`<div class="ann-mix-row">
    ${i === 0
      ? html`<span class="ann-mix-row-name">${esc(row.coffee || '—')}</span>`
      : html`<select id="${esc(_selectId(i))}" class="ann-mix-row-select" data-mix-bean="${esc(String(i))}" aria-label="${esc(t('ann_coffee'))}"></select>`}
    <input type="number" id="${esc(_gramsId(i))}" class="ann-mix-row-grams" data-mix-row="${esc(String(i))}"
      value="${esc(row.grams)}" step="0.1" min="0" max="100" inputmode="decimal"
      aria-label="${esc(t('ann_dose'))}" placeholder="${esc(t('ann_dose_ph'))}">
    ${i === 0
      ? html`<span class="ann-mix-row-spacer"></span>`
      : html`<button type="button" class="lib-btn-sm del" data-mix-remove="${esc(String(i))}"
          aria-label="${esc(t('ann_remove_bean'))}" title="${esc(t('ann_remove_bean'))}">✕</button>`}
  </div>`));

  // The extra rows' selects are filled by the panel's own bean renderer, so
  // one in-stock/exhausted bean listing serves the whole sheet.
  for (let i = 1; i < _rows.length; i++) {
    const row = _rows[i];
    if (row) _renderBeanSelect?.(row.coffee || null, row.beanId, _selectId(i));
  }
  container.querySelectorAll<HTMLSelectElement>('select[data-mix-bean]').forEach(select => {
    select.addEventListener('change', () => {
      setMixRowBean(Number(select.dataset.mixBean), String(select.value), _beanIdOf(select));
      _scheduleAutoSave?.();
    });
  });
  container.querySelectorAll<HTMLInputElement>('input[data-mix-row]').forEach(input => {
    input.addEventListener('input', () => setMixRowGrams(Number(input.dataset.mixRow), input.value));
    input.addEventListener('blur', () => _scheduleAutoSave?.());
  });
  container.querySelectorAll<HTMLElement>('button[data-mix-remove]').forEach(btn => {
    btn.addEventListener('click', () => removeMixRow(Number(btn.dataset.mixRemove)));
  });
}

/**
 * Adds a row below the primary bean's, up to MAX_MIX_ROWS. The first split
 * starts from what the single-bean panel already shows: the bean select's
 * value and the dose, which become row 1's bean and grams.
 */
export function addMixRow(): void {
  if (_rows.length >= MAX_MIX_ROWS) return;
  const row = _rows[0];
  if (_rows.length === 1 && row) {
    const primary = _rowSelect(0);
    const doseEl = _el<HTMLInputElement>('annDose');
    if (primary && String(primary.value)) {
      row.coffee = String(primary.value).trim();
      row.beanId = _beanIdOf(primary);
    }
    if (!row.grams && doseEl && String(doseEl.value)) row.grams = String(doseEl.value);
  }
  _rows.push({ coffee: '', beanId: null, grams: '' });
  renderBeanMix();
  _scheduleAutoSave?.();
}

/** Removes one of the extra rows; row 1 is the primary bean and stays. */
export function removeMixRow(index: number): void {
  if (index < 1 || index >= _rows.length) return;
  _rows.splice(index, 1);
  renderBeanMix();
  _scheduleAutoSave?.();
}

/** Back to a single bean — used on shot switch and by the quick-clone action. */
export function resetBeanMix(): void {
  _rows = singleRow();
  renderBeanMix();
}

/**
 * Restores the rows of a saved mix. The primary bean (the part with the most
 * grams) becomes row 1, because row 1 is the panel's own bean select and
 * annotation.ts renders that from the annotation's top-level beanId/coffee.
 */
export function loadBeanMix(ann: BeanMixAnnotation | null | undefined): void {
  const parts = beanMix(ann);
  if (!parts) { resetBeanMix(); return; }
  const primary = primaryMixPart(parts);
  const ordered = primary ? [primary, ...parts.filter(p => p !== primary)] : parts;
  _rows = ordered.slice(0, MAX_MIX_ROWS).map(p => ({ coffee: p.coffee, beanId: p.beanId, grams: String(p.grams) }));
  renderBeanMix();
}
