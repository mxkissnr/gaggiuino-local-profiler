// Recipes section of the Library view, split out of views/library.js.
// Pure move + type port (Part of #1115); no behavior change.
import { S } from '../../state/index.js';
import { t, tHtml } from '../../i18n.js';
import * as libraryApi from '../../api/library.js';
import { esc, html, joinHtml } from '../../utils.js';
import type { Html } from '../../utils.js';
import { WATER_DROP_ICON_SVG, SNOWFLAKE_ICON_SVG, LINK_ICON_SVG } from '../../icons.js';
import { attachAutocomplete } from '../../components/autocomplete.js';
import type { Recipe } from '../../api/types.js';
import type { ShotMeta } from '../../state/index.js';

const ICON_PENCIL: Html = html`<svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15" aria-hidden="true"><path d="M20.71,7.04C21.1,6.65 21.1,6 20.71,5.63L18.37,3.29C18,2.9 17.35,2.9 16.96,3.29L15.12,5.12L18.87,8.87M3,17.25V21H6.75L17.81,9.93L14.06,6.18L3,17.25Z"/></svg>`;
const ICON_TRASH: Html  = html`<svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15" aria-hidden="true"><path d="M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19M8,9H10V19H8V9M14,9H16V19H14V9M15.5,4L14.5,3H9.5L8.5,4H5V6H19V4H15.5Z"/></svg>`;

// state/index.ts's CoffeeLibrary only declares beans/grinders and it has no
// recipeEditId (unlike the basket/puck-screen edit ids); this section owns the
// recipe collection and that id, reached through one typed view of S (same
// pattern as views/shots/index.ts's _libCollection).
interface RecipeState {
  recipeEditId?: number | null;
  coffeeLibrary: { recipes?: Recipe[] };
}
function _state(): RecipeState {
  return S as unknown as RecipeState;
}

// Shot rows are typed metadata-only (ShotMeta); this section reads the
// annotation's recipeId and the score, so name them here — same convention as
// views/shots/index.ts.
interface RecipeShotRow extends ShotMeta {
  annotation?: { recipeId?: number | null } | null;
  score?: number | null;
}
function _shots(): RecipeShotRow[] {
  return S.shots;
}

const BREW_METHOD_LABELS: Record<string, string> = {
  espresso: 'lib_brew_espresso', aeropress: 'lib_brew_aeropress', v60: 'lib_brew_v60',
  french_press: 'lib_brew_french_press', moka: 'lib_brew_moka',
  cold_brew: 'lib_brew_cold_brew', other: 'lib_brew_other',
};

export function renderRecipeList(): void {
  const el = document.getElementById('recipeListUI');
  if (!el) return;
  const recipes = _state().coffeeLibrary.recipes || [];
  if (!recipes.length) {
    el.innerHTML = html`<div class="lib-empty">${tHtml('lib_empty_recipes')}</div>`;
    return;
  }
  // codeql[js/xss-through-dom] false positive: esc()/escapeHtml() already applied, see #760
  el.innerHTML = joinHtml(recipes.map(r => {
    const brewMethodLabel = r.brewMethod ? BREW_METHOD_LABELS[r.brewMethod] : undefined;
    const brewLabel = brewMethodLabel
      ? html`<span class="lib-brew-badge">${tHtml(brewMethodLabel)}</span>`
      : html``;
    const metaParts = [r.drinkType, r.beanName, r.profileName].filter(Boolean).map(esc);
    const meta = metaParts.length ? joinHtml(metaParts.map((p, i) => (i ? html` · ${p}` : p))) : null;
    const params: Html[] = [
      r.targetDose_g  ? html`${esc(r.targetDose_g)} g`    : null,
      r.targetYield_g ? html`→ ${esc(r.targetYield_g)} g` : null,
      r.water_g       ? html`${WATER_DROP_ICON_SVG} ${esc(r.water_g)} g` : null,
      r.ice_g         ? html`${SNOWFLAKE_ICON_SVG} ${esc(r.ice_g)} g`     : null,
      r.targetTime_s  ? html`${esc(r.targetTime_s)} s`    : null,
      r.waterTemp_c   ? html`${esc(r.waterTemp_c)} °C`    : null,
      r.grindSize     ? esc(r.grindSize)          : null,
    ].filter((p): p is Html => Boolean(p));
    const stepsHtml = Array.isArray(r.steps) && r.steps.length
      ? html`<div class="lib-recipe-steps-list">${joinHtml(r.steps.map((s, i) => html`
          <div class="lib-recipe-step">
            <span class="lib-recipe-step-n">${esc(i + 1)}.</span>
            <span>${esc(s.text)}</span>
            ${s.duration_s ? html`<span class="lib-recipe-step-dur">${esc(s.duration_s)} s</span>` : html``}
          </div>`))}</div>`
      : html``;
    const linkedShots = _shots().filter(s => s.annotation?.recipeId === r.id);
    const shotCount   = linkedShots.length;
    const avgScore    = shotCount > 0
      ? (linkedShots.reduce((sum, s) => sum + (s.score ?? 0), 0) / shotCount).toFixed(1)
      : null;
    const shotsBadge  = shotCount > 0
      ? html`<span class="lib-recipe-shots-badge">${esc(shotCount)} Shot${shotCount !== 1 ? html`s` : html``}${avgScore !== null ? html` · Ø ${esc(avgScore)}` : html``}</span>`
      : html``;
    return html`<div class="lib-item">
      <div class="lib-item-info">
        <div class="lib-item-name">${brewLabel}${esc(r.name)}${shotsBadge}</div>
        ${meta ? html`<div class="lib-item-sub">${meta}</div>` : html``}
        ${params.length ? html`<div class="lib-recipe-params">${joinHtml(params.map(p => html`<span>${p}</span>`))}</div>` : html``}
        ${stepsHtml}
        ${r.notes ? html`<div class="lib-item-sub" style="margin-top:4px">${esc(r.notes)}</div>` : html``}
        ${r.sourceUrl ? html`<div class="lib-item-source"><a href="${esc(r.sourceUrl)}" target="_blank" rel="noopener">${LINK_ICON_SVG} Quelle</a></div>` : html``}
      </div>
      <div class="lib-item-actions">
        <button class="lib-btn-sm lib-btn-icon" data-action="edit-recipe" data-id="${esc(r.id)}" title="${tHtml('lib_btn_edit')}">${ICON_PENCIL}</button>
        <button class="lib-btn-sm del lib-btn-icon" data-action="delete-recipe" data-id="${esc(r.id)}" title="${tHtml('lib_btn_delete')}">${ICON_TRASH}</button>
      </div>
    </div>`;
  }));
}

function _renderStepRows(steps: Recipe['steps']): void {
  const list = document.getElementById('recipeStepsList');
  if (!list) return;
  // codeql[js/xss-through-dom] false positive: esc()/escapeHtml() already applied, see #760
  list.innerHTML = joinHtml((steps || []).map((s, i) => _stepRowHtml(i, s.text, s.duration_s)));
}

function _stepRowHtml(i: number, text: string | undefined = '', dur: number | string | null | undefined = ''): Html {
  return html`<div class="lib-step-row" id="recipeStep${esc(i)}">
    <span class="lib-step-num">${esc(i + 1)}</span>
    <input class="lib-step-text" placeholder="${tHtml('lib_recipe_step_ph')}" value="${esc(text)}">
    <input class="lib-step-dur" type="number" min="0" step="1" placeholder="${tHtml('lib_recipe_step_dur')}" value="${esc(dur ?? '')}">
    <button class="lib-btn-sm del lib-btn-icon" data-action="remove-recipe-step" data-idx="${esc(i)}">${ICON_TRASH}</button>
  </div>`;
}

export function addRecipeStep(): void {
  const list = document.getElementById('recipeStepsList');
  if (!list) return;
  const idx = list.children.length;
  list.insertAdjacentHTML('beforeend', _stepRowHtml(idx));
}

export function removeRecipeStep(i: number): void {
  const row = document.getElementById(`recipeStep${i}`);
  if (row) row.remove();
  // Re-number remaining rows
  document.querySelectorAll('#recipeStepsList .lib-step-row').forEach((row, idx) => {
    row.id = `recipeStep${idx}`;
    (row.querySelector('.lib-step-num') as HTMLElement).textContent = String(idx + 1);
    const delBtn = row.querySelector('.lib-btn-sm.del') as HTMLElement;
    delBtn.dataset.action = 'remove-recipe-step';
    delBtn.dataset.idx = String(idx);
  });
}

function _collectSteps(): { text: string; duration_s: number | null }[] {
  return [...document.querySelectorAll('#recipeStepsList .lib-step-row')].map(row => ({
    text:       row.querySelector<HTMLInputElement>('.lib-step-text')?.value.trim() || '',
    duration_s: parseFloat(row.querySelector<HTMLInputElement>('.lib-step-dur')?.value ?? '') || null,
  })).filter(s => s.text);
}

export function openRecipeForm(recipe?: Recipe | null): void {
  _state().recipeEditId = recipe ? recipe.id : null;
  (document.getElementById('recipeFormName') as HTMLInputElement).value         = recipe?.name          || '';
  (document.getElementById('recipeFormBrewMethod') as HTMLInputElement).value   = recipe?.brewMethod    || 'espresso';
  (document.getElementById('recipeFormDrinkType') as HTMLInputElement).value    = recipe?.drinkType     || '';
  (document.getElementById('recipeFormDose') as HTMLInputElement).value         = String(recipe?.targetDose_g  ?? '');
  (document.getElementById('recipeFormYield') as HTMLInputElement).value        = String(recipe?.targetYield_g ?? '');
  (document.getElementById('recipeFormTime') as HTMLInputElement).value         = String(recipe?.targetTime_s  ?? '');
  (document.getElementById('recipeFormWaterTemp') as HTMLInputElement).value    = String(recipe?.waterTemp_c   ?? '');
  (document.getElementById('recipeFormWaterG') as HTMLInputElement).value       = String(recipe?.water_g       ?? '');
  (document.getElementById('recipeFormIceG') as HTMLInputElement).value         = String(recipe?.ice_g         ?? '');
  (document.getElementById('recipeFormGrind') as HTMLInputElement).value        = recipe?.grindSize     || '';
  (document.getElementById('recipeFormSourceUrl') as HTMLInputElement).value    = recipe?.sourceUrl     || '';
  (document.getElementById('recipeFormProfile') as HTMLInputElement).value      = recipe?.profileName   || '';
  attachAutocomplete(document.getElementById('recipeFormProfile') as HTMLInputElement, () => S.machineProfiles.map(p => p.name));
  (document.getElementById('recipeFormBean') as HTMLInputElement).value         = recipe?.beanName      || '';
  attachAutocomplete(document.getElementById('recipeFormBean') as HTMLInputElement, () => S.coffeeLibrary.beans.map(b => b.name));
  (document.getElementById('recipeFormNotes') as HTMLInputElement).value        = recipe?.notes         || '';
  _renderStepRows(recipe?.steps || []);
  (document.getElementById('recipeAddForm') as HTMLElement).classList.add('open');
  (document.getElementById('recipeAddTrigger') as HTMLElement).style.display = 'none';
  (document.getElementById('recipeFormName') as HTMLInputElement).focus();
}

export function closeRecipeForm(): void {
  _state().recipeEditId = null;
  (document.getElementById('recipeAddForm') as HTMLElement).classList.remove('open');
  (document.getElementById('recipeAddTrigger') as HTMLElement).style.display = '';
}

export function editRecipe(id: number): void {
  const recipe = (_state().coffeeLibrary.recipes || []).find(r => r.id === id);
  if (recipe) openRecipeForm(recipe);
}

export async function saveRecipe(): Promise<void> {
  const name = (document.getElementById('recipeFormName') as HTMLInputElement).value.trim();
  if (!name) { (document.getElementById('recipeFormName') as HTMLInputElement).focus(); return; }
  const payload = {
    name,
    brewMethod:    (document.getElementById('recipeFormBrewMethod') as HTMLInputElement).value,
    drinkType:     (document.getElementById('recipeFormDrinkType') as HTMLInputElement).value.trim(),
    targetDose_g:  parseFloat((document.getElementById('recipeFormDose') as HTMLInputElement).value)      || null,
    targetYield_g: parseFloat((document.getElementById('recipeFormYield') as HTMLInputElement).value)     || null,
    targetTime_s:  parseFloat((document.getElementById('recipeFormTime') as HTMLInputElement).value)      || null,
    waterTemp_c:   parseFloat((document.getElementById('recipeFormWaterTemp') as HTMLInputElement).value) || null,
    water_g:       parseFloat((document.getElementById('recipeFormWaterG') as HTMLInputElement).value)    || null,
    ice_g:         parseFloat((document.getElementById('recipeFormIceG') as HTMLInputElement).value)      || null,
    grindSize:     (document.getElementById('recipeFormGrind') as HTMLInputElement).value.trim(),
    sourceUrl:     (document.getElementById('recipeFormSourceUrl') as HTMLInputElement).value.trim(),
    profileName:   (document.getElementById('recipeFormProfile') as HTMLInputElement).value.trim(),
    beanName:      (document.getElementById('recipeFormBean') as HTMLInputElement).value.trim(),
    notes:         (document.getElementById('recipeFormNotes') as HTMLInputElement).value.trim(),
    steps:         _collectSteps(),
  };
  const saved = await libraryApi.saveRecipe(_state().recipeEditId ?? null, payload);
  if (!saved) return;
  const lib = _state().coffeeLibrary;
  const recipes = lib.recipes ?? [];
  lib.recipes = recipes;
  if (_state().recipeEditId) {
    const idx = recipes.findIndex(r => r.id === _state().recipeEditId);
    if (idx !== -1) recipes[idx] = saved;
  } else {
    recipes.push(saved);
  }
  closeRecipeForm();
  renderRecipeList();
}

export async function deleteRecipe(id: number): Promise<void> {
  if (!confirm(t('lib_confirm_delete_recipe'))) return;
  const r = await libraryApi.deleteRecipePermanently(id);
  if (!r.ok) return;
  _state().coffeeLibrary.recipes = (_state().coffeeLibrary.recipes || []).filter(r => r.id !== id);
  renderRecipeList();
}
