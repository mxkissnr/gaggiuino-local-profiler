import { S } from '../../state/index.js';
import { tHtml } from '../../i18n.js';
import { esc, html, joinHtml } from '../../utils.js';
import { CLOSE_ICON_SVG } from '../../icons.js';
import { COFFEE_COUNTRIES, VARIETY_SUGGESTIONS, PROCESS_SUGGESTIONS, countryName } from '../../constants.js';
import { attachAutocomplete } from '../../components/autocomplete.js';
import { _field, _el } from './bean-shared.js';
import type { OriginChip, OriginBean } from './bean-shared.js';

// ── Flavor chips input ────────────────────────────────────────────────────
// Module-level working array; rendered into #beanFormFlavorChips before the
// text input. Enter/comma commits the typed value, × removes a chip.
let _formFlavors: string[] = [];
let _flavorInputBound = false;

function renderFlavorChips(): void {
  const wrap = _el('beanFormFlavorChips');
  if (!wrap) return;
  wrap.querySelectorAll('.flavor-chip').forEach(el => el.remove());
  const input = _field('beanFormFlavorInput');
  for (const [i, f] of _formFlavors.entries()) {
    const chip = document.createElement('span');
    chip.className = 'flavor-chip';
    chip.innerHTML = html`${esc(f)} <button type="button" class="flavor-chip-x" data-flavor-idx="${esc(i)}">${CLOSE_ICON_SVG}</button>`;
    wrap.insertBefore(chip, input);
  }
}

export function commitFlavorInput(): void {
  const input = _field('beanFormFlavorInput');
  if (!input) return;
  const val = input.value.trim().replace(/,+$/, '').trim();
  input.value = '';
  if (!val || val.length > 50 || _formFlavors.length >= 20) return;
  if (_formFlavors.some(f => f.toLowerCase() === val.toLowerCase())) return;
  _formFlavors.push(val);
  renderFlavorChips();
}

export function setFormFlavors(flavors?: string[] | null): void {
  _formFlavors = Array.isArray(flavors) ? [...flavors] : [];
  renderFlavorChips();
}

export function bindFlavorInput(): void {
  if (_flavorInputBound) return;
  const input = _field('beanFormFlavorInput');
  const wrap  = _el('beanFormFlavorChips');
  if (!input || !wrap) return;
  _flavorInputBound = true;
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commitFlavorInput(); }
    else if (e.key === 'Backspace' && !input.value && _formFlavors.length) {
      _formFlavors.pop();
      renderFlavorChips();
    }
  });
  input.addEventListener('blur', commitFlavorInput);
  wrap.addEventListener('click', e => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('.flavor-chip-x');
    if (!btn) return;
    _formFlavors.splice(Number(btn.dataset.flavorIdx), 1);
    renderFlavorChips();
  });
}

// ── Bean form: origin (blend-capable chips, mirrors the flavor chips) ──────
// Each chip is a country code with an optional weighting percent, used by
// the world map to split a blend's shots across its origin countries.
let _formOrigins: OriginChip[] = [];
let _originInputBound = false;

export function populateOriginSelect(): void {
  const sel = _field('beanFormOrigin');
  if (!sel) return;
  const options = COFFEE_COUNTRIES
    .map(c => ({ code: c.code, label: countryName(c.code, S.currentLang) }))
    .sort((a, b) => a.label.localeCompare(b.label, S.currentLang));
  sel.innerHTML = html`<option value="">${tHtml('lib_bean_origin_none')}</option>${joinHtml(options.map(o => html`<option value="${esc(o.code)}">${esc(o.label)}</option>`))}`;
  sel.value = '';
}

function renderOriginChips(): void {
  const wrap = _el('beanFormOriginChips');
  if (!wrap) return;
  // codeql[js/xss-through-dom] false positive: esc()/escapeHtml() already applied, see #760
  wrap.innerHTML = joinHtml(_formOrigins.map((o, i) => html`
    <span class="flavor-chip origin-chip">${esc(countryName(o.code, S.currentLang))}
      <input type="number" class="origin-chip-percent" data-origin-idx="${esc(i)}" min="0" max="100" step="1" placeholder="%" value="${esc(o.percent ?? '')}">
      <button type="button" class="flavor-chip-x" data-origin-idx-remove="${esc(i)}">${CLOSE_ICON_SVG}</button>
    </span>`));
}

export function setFormOrigins(bean?: OriginBean | null): void {
  const origins = Array.isArray(bean?.origins) && bean.origins.length
    ? bean.origins
    : (bean?.origin ? [{ code: bean.origin }] : []);
  _formOrigins = origins.map(o => ({ ...o }));
  renderOriginChips();
}

export function bindOriginInput(): void {
  if (_originInputBound) return;
  const sel  = _field('beanFormOrigin');
  const wrap = _el('beanFormOriginChips');
  if (!sel || !wrap) return;
  _originInputBound = true;
  sel.addEventListener('change', () => {
    const code = sel.value;
    sel.value = '';
    if (!code || _formOrigins.some(o => o.code === code) || _formOrigins.length >= 5) return;
    _formOrigins.push({ code });
    renderOriginChips();
  });
  wrap.addEventListener('click', e => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-origin-idx-remove]');
    if (!btn) return;
    _formOrigins.splice(Number(btn.dataset.originIdxRemove), 1);
    renderOriginChips();
  });
  wrap.addEventListener('change', e => {
    const input = (e.target as HTMLElement).closest<HTMLInputElement>('.origin-chip-percent');
    if (!input) return;
    const i = Number(input.dataset.originIdx);
    const n = parseFloat(input.value);
    const origin = _formOrigins[i];
    if (origin) origin.percent = Number.isFinite(n) && n >= 0 && n <= 100 ? n : undefined;
  });
}

export function populateSuggestionDatalists(): void {
  attachAutocomplete(_field('beanFormVariety'), () => VARIETY_SUGGESTIONS);
  attachAutocomplete(_field('beanFormProcess'), () => PROCESS_SUGGESTIONS);
}

// saveBean sends the chips' working arrays as they are.
export function formFlavors(): string[] { return _formFlavors; }
export function formOrigins(): OriginChip[] { return _formOrigins; }
