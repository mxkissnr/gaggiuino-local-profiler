import { S }                              from '../../state/index.js';
import type { LibraryRow }                from '../../state/index.js';
import { t }                              from '../../i18n.js';
import { getMenu }                        from '../../api/system.js';
import { deductMilk, adjustFrozenPortion, listMilks } from '../../api/library.js';
import { annotateShot, getShotDefaults, postShotImage, deleteShotImage } from '../../api/shots.js';
import type { ShotAnnotation, ShotDefaults } from '../../api/types.js';
import { esc, germanToIso }               from '../../utils.js';
import { renderSidebar, updateSidebarHighlighting } from '../../components/sidebar.js';
import { calcBeanAgeAtShot, _roastDateFromLibrary } from './utils.js';
import { suggestGrindDoseForBean } from './grind.js';
import { loadShotImageBlobUrl, invalidateShotImage } from '../../bean-image.js';
import { openImageCropEditor } from '../../components/image-crop.js';
import { openLightbox } from '../../components/lightbox.js';
import { COFFEE_ICON_SVG, CHECK_ICON_SVG } from '../../icons.js';
import { localeFor } from '../../constants.js';
import { computeBeanRemaining } from '../../bean-math.js';

// state/index.ts types shot rows as metadata-only ShotMeta (id/timestamp plus
// an index signature) and the library rows as Record<string, unknown>; these
// local aliases name the fields this panel actually reads, same pattern as
// views/shots/utils.ts and components/shot-defaults-settings.ts.
interface OrderedBy {
  customer?: string;
  item?: string;
  variant?: string;
  note?: string;
}

interface AnnotationData {
  rating?: number | null;
  coffee?: string | null;
  beanId?: number | null;
  basketId?: number | null;
  puckScreenId?: number | null;
  grinder?: string | null;
  grindSetting?: string | number | null;
  dose?: number | null;
  tds?: number | null;
  notes?: string | null;
  drinkType?: string | null;
  milkType?: number | string | null;
  recipeId?: number | null;
  frozenPortionId?: number | null;
  orderedBy?: OrderedBy | null;
}

interface AnnotationShot {
  id: number;
  timestamp?: number;
  image?: string | null;
  annotation?: AnnotationData | null;
}

// What _buildAnnotationPayload() posts. Matches api/types.ts's ShotAnnotation
// except for the nullable fields the hand-maintained type (see its header) and
// the generated Annotation schema still type as non-nullable.
interface AnnotationPayload {
  rating: number | null;
  coffee: string;
  beanId: number | null;
  basketId: number | null;
  puckScreenId: number | null;
  grinder: string;
  grindSetting: string;
  dose: number | null;
  roastDate: string | null;
  tds: number | null;
  notes: string;
  drinkType: string | null;
  milkType: number | null;
  recipeId: number | null;
  beanAgeDays: number | null;
  frozenPortionId: number | null;
}

interface DrinkRow { id: string; name?: string; emoji?: string; milkMl?: number }
interface MilkRow { id: number; name?: string; emoji?: string }
interface CatalogRow { id: number; name: string }
interface CatalogLibrary {
  beans?: LibraryRow[];
  baskets?: LibraryRow[];
  puckScreens?: LibraryRow[];
  recipes?: CatalogRow[];
}

interface FrozenPortion { id: number; frozenAt: number; portionCount: number; remainingCount?: number | null }

// _renderBeanSelect's candidate list: a real bean (id set) or a stale/renamed
// selection carried over as a name-only entry.
interface BeanOption { name: string; id: number | null; empty: boolean }

// ── Auto-save ─────────────────────────────────────────────────────────────

let _autoSaveTimer: ReturnType<typeof setTimeout> | null = null;

// Deducts milk stock for a newly-assigned (or changed) drink+milk combo.
// Gated on drinkType OR milkType actually changing vs. the previously saved
// annotation, not just milkType changing — otherwise re-assigning the same
// milk to a newly-picked drink (the common case, since most people always
// use the same milk) would never fire. Shared by both the debounced
// auto-save and the explicit Save button so neither path can silently skip
// the deduction the other one handles.
export function _maybeDeductMilk(shot: AnnotationShot | undefined, payload: AnnotationPayload): void {
  const prevMilkType  = shot?.annotation?.milkType ?? null;
  const prevDrinkType = shot?.annotation?.drinkType ?? null;
  if (!payload.milkType || !payload.drinkType) return;
  if (payload.milkType === prevMilkType && payload.drinkType === prevDrinkType) return;
  const menuItem = ((S.drinkMenu || []) as unknown as DrinkRow[]).find(m => m.id === payload.drinkType);
  const milkMl = menuItem?.milkMl;
  if (!(milkMl && milkMl > 0)) return;
  deductMilk(payload.milkType, milkMl).then(updated => {
    if (!updated) return;
    if (S.milkTypes) {
      const mi = S.milkTypes.findIndex(m => (m.id as number) === updated.id);
      if (mi !== -1) S.milkTypes[mi] = updated;
    }
  }).catch(() => {});
}

// Finds a frozen-portion entry by id across every bean/bag — portion ids are
// globally unique (generated from frozenAt), so no beanId is needed to
// locate one. Returns { bean, portion } or null.
function _findFrozenPortion(portionId: number): { bean: LibraryRow; portion: LibraryRow } | null {
  for (const bean of S.coffeeLibrary?.beans || []) {
    for (const bag of (bean.bags as LibraryRow[] | undefined) || []) {
      const portion = ((bag.frozenPortions as LibraryRow[] | undefined) || []).find(p => p.id === portionId);
      if (portion) return { bean, portion };
    }
  }
  return null;
}

// #502: mirrors _maybeDeductMilk's shape exactly — compares the previous vs.
// new frozenPortionId so re-saving the same choice never double-counts, and
// switching choices (including back to "not frozen", i.e. null) correctly
// reverses the previous decrement. Uses the existing adjust-frozen-portion
// endpoint (absolute remainingCount) rather than a delta endpoint, computing
// the target value from the client's already-loaded S.coffeeLibrary state.
function _adjustFrozenPortionRemaining(portionId: number, delta: number): void {
  const found = _findFrozenPortion(portionId);
  if (!found) return;
  const { bean, portion } = found;
  const current = Number.isFinite(portion.remainingCount) ? portion.remainingCount as number : portion.portionCount as number;
  const remainingCount = Math.min(Math.max(current + delta, 0), portion.portionCount as number);
  adjustFrozenPortion(bean.id as number, { portionId, remainingCount }).then(updated => {
    if (!updated) return;
    const idx = S.coffeeLibrary.beans.findIndex(b => b.id === bean.id);
    if (idx !== -1) S.coffeeLibrary.beans[idx] = updated;
  }).catch(() => {});
}

export function _maybeAdjustFrozenPortion(shot: AnnotationShot | undefined, payload: AnnotationPayload): void {
  const prevPortionId = shot?.annotation?.frozenPortionId ?? null;
  const newPortionId  = payload.frozenPortionId ?? null;
  if (prevPortionId === newPortionId) return;
  if (prevPortionId != null) _adjustFrozenPortionRemaining(prevPortionId, +1);
  if (newPortionId != null) _adjustFrozenPortionRemaining(newPortionId, -1);
}

// Reads every annotation field's current DOM value into the API payload
// shape — the single source of truth for both the debounced auto-save and
// its immediate flush, so neither path can silently build a different
// payload than the other (#430, was previously duplicated between
// scheduleAutoSave and the now-removed explicit saveAnnotation()).
function _buildAnnotationPayload(shot: AnnotationShot | undefined): AnnotationPayload {
  const coffeeSelect = document.getElementById('annCoffee') as HTMLSelectElement;
  const coffee = coffeeSelect.value.trim();
  // #456: the select's chosen <option> carries data-bean-id (see
  // _renderBeanSelect) when the value matches a real library bean — null for
  // an empty selection or a stale name no longer in the library.
  const beanIdAttr = coffeeSelect.selectedOptions[0]?.dataset.beanId;
  const beanId = beanIdAttr ? parseInt(beanIdAttr, 10) : null;
  // #635: same data-attribute pattern as beanId above — real <select>s, ID-
  // based, no free-text/name matching involved.
  const basketSelect = document.getElementById('annBasket') as HTMLSelectElement | null;
  const basketIdAttr = basketSelect?.selectedOptions[0]?.dataset.basketId;
  const basketId = basketIdAttr ? parseInt(basketIdAttr, 10) : null;
  const puckScreenSelect = document.getElementById('annPuckScreen') as HTMLSelectElement | null;
  const puckScreenIdAttr = puckScreenSelect?.selectedOptions[0]?.dataset.puckscreenId;
  const puckScreenId = puckScreenIdAttr ? parseInt(puckScreenIdAttr, 10) : null;
  return {
    rating:       S.currentRating || null,
    coffee,
    beanId,
    basketId,
    puckScreenId,
    grinder:      (document.getElementById('annGrinder') as HTMLInputElement).value.trim(),
    grindSetting: (document.getElementById('annGrindSetting') as HTMLInputElement).value.trim(),
    dose:         parseFloat((document.getElementById('annDose') as HTMLInputElement).value) || null,
    roastDate:    germanToIso(_roastDateFromLibrary(coffee, shot?.timestamp, beanId) || '') || null,
    tds:          parseFloat((document.getElementById('annTds') as HTMLInputElement).value) || null,
    notes:        (document.getElementById('annNotes') as HTMLInputElement).value.trim(),
    drinkType:    (document.getElementById('annDrinkType') as HTMLSelectElement | null)?.value || null,
    milkType:     (document.getElementById('annMilkType') as HTMLSelectElement | null)?.value ? parseInt((document.getElementById('annMilkType') as HTMLSelectElement).value) : null,
    recipeId:     parseInt((document.getElementById('annRecipe') as HTMLSelectElement | null)?.value as string) || null,
    beanAgeDays:  calcBeanAgeAtShot(coffee, shot?.timestamp, beanId) ?? null,
    frozenPortionId: parseInt((document.getElementById('annFrozenPortionId') as HTMLSelectElement | null)?.value as string, 10) || null,
  };
}

// #430: #autoSaveStatus is now the only save feedback (the explicit Save
// button is gone) — it carries the full lifecycle: pending while a save is
// in flight, a confirmation on success, hidden otherwise. 'idle' explicitly
// hides it, used when a freshly-selected shot has no in-flight save of its
// own to report.
type AutoSaveState = 'pending' | 'saved' | 'idle';

// #autoSaveStatus carries its own hide timer on the element (the untyped .js
// read/wrote status._hideTimer directly).
interface AutoSaveStatusEl extends HTMLElement { _hideTimer?: ReturnType<typeof setTimeout> }

function _setAutoSaveStatus(state: AutoSaveState): void {
  const status: AutoSaveStatusEl | null = document.getElementById('autoSaveStatus');
  if (!status) return;
  clearTimeout(status._hideTimer);
  if (state === 'pending') {
    status.textContent = t('autosave_pending');
    status.classList.add('visible');
  } else if (state === 'saved') {
    status.innerHTML = `${CHECK_ICON_SVG} ${esc(t('autosave_saved'))}`;
    status.classList.add('visible');
    status._hideTimer = setTimeout(() => status.classList.remove('visible'), 1800);
  } else {
    status.classList.remove('visible');
  }
}

async function _performAnnotationSave(): Promise<void> {
  if (!S.primaryShotId) return;
  const id   = S.primaryShotId;
  const shot = S.shots.find(s => s.id === id) as unknown as AnnotationShot | undefined;
  const payload = _buildAnnotationPayload(shot);
  try {
    const r = await annotateShot(id, payload as unknown as ShotAnnotation);
    if (r.ok) {
      _maybeDeductMilk(shot, payload);
      _maybeAdjustFrozenPortion(shot, payload);
      const idx = S.shots.findIndex(s => s.id === id);
      if (idx !== -1) S.shots[idx].annotation = payload;
      renderSidebar();
      updateSidebarHighlighting();
      _setAutoSaveStatus('saved');
    } else {
      _setAutoSaveStatus('idle');
    }
  } catch { _setAutoSaveStatus('idle'); }
}

export function scheduleAutoSave(): void {
  clearTimeout(_autoSaveTimer ?? undefined);
  _setAutoSaveStatus('pending');
  _autoSaveTimer = setTimeout(() => { _autoSaveTimer = null; void _performAnnotationSave(); }, 1000);
}

// Immediately runs a pending debounced save instead of waiting out the rest
// of its 1s delay — called on field blur, tab/page hide (visibilitychange)
// and mode-switch away from Shots (#430). Without this, editing a field and
// switching away inside that 1s window used to silently drop the edit; the
// removed explicit Save button was the only thing that had covered that gap
// before, so this flush takes over that responsibility explicitly rather
// than leaving it implicit in a button click.
export function flushAutoSave(): void {
  if (!_autoSaveTimer) return;
  clearTimeout(_autoSaveTimer);
  _autoSaveTimer = null;
  void _performAnnotationSave();
}

// ── Drink & milk pills ────────────────────────────────────────────────────

export async function loadDrinkMenu(): Promise<void> {
  try {
    const r = await getMenu();
    if (r.ok) S.drinkMenu = await r.json() as LibraryRow[];
  } catch { /* non-critical */ }
}

// #654: optional per-install defaults auto-prefilled into a brand-new shot's
// annotation panel — loaded once at app init (main.js), same as
// loadDrinkMenu()/loadMilkTypes() above, and refreshed by
// components/shot-defaults-settings.js whenever the Settings card saves.
export async function loadShotDefaults(): Promise<void> {
  try {
    const defaults = await getShotDefaults();
    if (defaults) S.shotDefaults = defaults as unknown as Record<string, unknown>;
  } catch { /* non-critical */ }
}

// Merges the configured shot defaults into a shot's annotation, but only
// when that annotation is genuinely empty — i.e. this shot has never been
// annotated (see go/internal/shots: a synced-but-untouched shot's annotation
// is always {}). Any existing annotation, even a single field, is returned
// completely untouched: a configured default must never overwrite something
// the user already recorded. Applied fields stay fully editable afterward —
// this only changes what the form starts out showing.
export function _applyShotDefaults(ann: AnnotationData | null | undefined): AnnotationData | null | undefined {
  if (ann && Object.keys(ann).length > 0) return ann;
  const d = S.shotDefaults as unknown as Partial<ShotDefaults> | null;
  if (!d) return ann;
  return {
    drinkType:    d.drinkType    || null,
    coffee:       d.coffee       || null,
    beanId:       d.beanId       ?? null,
    basketId:     d.basketId     ?? null,
    puckScreenId: d.puckScreenId ?? null,
    grinder:      d.grinder      || '',
    dose:         d.dose         ?? null,
  };
}

export async function loadMilkTypes(): Promise<void> {
  try {
    const milks = await listMilks();
    if (milks) S.milkTypes = milks;
  } catch { /* non-critical */ }
}

export function _renderDrinkPills(selectedId: string): void {
  const container = document.getElementById('drinkPillsContainer');
  const hidden    = document.getElementById('annDrinkType') as HTMLInputElement | null;
  if (!container) return;
  if (!S.drinkMenu?.length) { container.innerHTML = ''; return; }
  container.innerHTML = (S.drinkMenu as unknown as DrinkRow[]).map(m =>
    `<button type="button" class="drink-pill${selectedId === m.id ? ' active' : ''}"
      data-action="select-drink" data-id="${esc(m.id)}">${esc(m.emoji)} ${esc(m.name)}</button>`
  ).join('');
  if (hidden) hidden.value = selectedId || '';
}

export function selectDrinkType(id: string): void {
  const hidden = document.getElementById('annDrinkType') as HTMLInputElement | null;
  if (!hidden) return;
  const newVal = hidden.value === id ? '' : id;
  _renderDrinkPills(newVal);
  _updateMilkFieldVisibility();
  scheduleAutoSave();
}

export function _renderMilkPills(selectedId: string): void {
  const container = document.getElementById('milkPillsContainer');
  const hidden    = document.getElementById('annMilkType') as HTMLInputElement | null;
  if (!container) return;
  if (!S.milkTypes?.length) { container.innerHTML = ''; return; }
  container.innerHTML = (S.milkTypes as unknown as MilkRow[]).map(m =>
    `<button type="button" class="drink-pill${selectedId === String(m.id) ? ' active' : ''}"
      data-action="select-milk" data-id="${esc(String(m.id))}">${esc(m.emoji || '🥛')} ${esc(m.name)}</button>`
  ).join('');
  if (hidden) hidden.value = selectedId || '';
}

export function selectMilkType(id: string): void {
  const hidden = document.getElementById('annMilkType') as HTMLInputElement | null;
  if (!hidden) return;
  const newVal = hidden.value === id ? '' : id;
  _renderMilkPills(newVal);
  scheduleAutoSave();
}

// ── Frozen-portion pill (which pool of this bean's stock a shot used) ──────

// Bags/portions active as of a given shot's timestamp — mirrors the
// activeBag resolution in main.js's annCoffee change handler (openedAt <=
// shotMs, most recent first), so the frozen-portion choices reflect what
// was actually in the freezer at brew time, not just "now". Only portions
// with remaining stock are offered (a fully-thawed one has nothing left to
// pick).
function _activeFrozenPortionsForBean(bean: LibraryRow | null | undefined, shotMs: number): FrozenPortion[] {
  if (!bean) return [];
  const bags = Array.isArray(bean.bags) ? bean.bags as LibraryRow[] : [];
  const activeBag = bags.filter(b => ((b.openedAt as number) || 0) <= shotMs).sort((a, b) => (b.openedAt as number) - (a.openedAt as number))[0];
  const portions = Array.isArray(activeBag?.frozenPortions) ? activeBag.frozenPortions as FrozenPortion[] : [];
  return portions.filter(p => (Number.isFinite(p.remainingCount) ? p.remainingCount as number : p.portionCount) > 0);
}

// #502: an explicit "not frozen" pill is always offered alongside any active
// frozen batches — Max wants that to be a deliberate recorded choice, not
// just the absence of a selection. The whole field hides when the bean has
// no active frozen stock at all, since there'd be nothing to choose between.
export function _renderFrozenPortionPills(beanName: string | null, shotMs: number, selectedId: number | string | null | undefined): void {
  const field     = document.getElementById('frozenPortionField');
  const container = document.getElementById('frozenPortionPillsContainer');
  const hidden    = document.getElementById('annFrozenPortionId') as HTMLInputElement | null;
  if (!field || !container || !hidden) return;
  const bean = beanName ? S.coffeeLibrary?.beans?.find(b => b.name === beanName) : null;
  const portions = _activeFrozenPortionsForBean(bean, shotMs ?? Date.now());
  if (!portions.length) { field.style.display = 'none'; container.innerHTML = ''; hidden.value = ''; return; }
  field.style.display = '';
  const locale = localeFor(S.currentLang);
  const selected = selectedId != null ? String(selectedId) : '';
  const options = [{ id: '', label: t('ann_frozen_portion_none') }, ...portions.map(p => {
    const dateStr    = new Date(p.frozenAt).toLocaleDateString(locale, { day: '2-digit', month: '2-digit', year: '2-digit' });
    const remaining  = Number.isFinite(p.remainingCount) ? p.remainingCount as number : p.portionCount;
    // #811: no glyph in the label -- this string is rendered as an <option>
    // text node in one place and as escaped markup in another, and an <option>
    // cannot carry an inline SVG. The frozen state is already carried by the
    // portion count and date, and by the icon on the badge itself.
    return { id: String(p.id), label: `${remaining}/${p.portionCount} · ${dateStr}` };
  })];
  container.innerHTML = options.map(o =>
    `<button type="button" class="drink-pill${selected === o.id ? ' active' : ''}" data-action="select-frozen-portion" data-id="${esc(o.id)}">${esc(o.label)}</button>`
  ).join('');
  hidden.value = selected;
}

export function selectFrozenPortion(id: string | null | undefined): void {
  const hidden = document.getElementById('annFrozenPortionId');
  if (!hidden) return;
  const beanName = (document.getElementById('annCoffee') as HTMLInputElement | null)?.value?.trim() || null;
  const shot     = S.primaryShotId ? S.shots.find(s => s.id === S.primaryShotId) : null;
  _renderFrozenPortionPills(beanName, shot ? shot.timestamp * 1000 : Date.now(), id || null);
  scheduleAutoSave();
}

function _updateMilkFieldVisibility(): void {
  const field   = document.getElementById('milkTypeField');
  if (!field) return;
  const drinkId = (document.getElementById('annDrinkType') as HTMLSelectElement | null)?.value;
  field.style.display = (S.milkTypes?.length && drinkId) ? '' : 'none';
}

// selectedBeanId, when given, takes priority over selectedName: id survives
// a bean rename, name does not. Without it (or when it no longer resolves
// in the current library — e.g. a deleted bean), falls back to matching by
// name, same as before this second parameter existed.
export function _renderBeanSelect(selectedName: string | null, selectedBeanId: number | null): void {
  const select = document.getElementById('annCoffee') as HTMLSelectElement | null;
  if (!select) return;
  const allBeans = (S.coffeeLibrary?.beans || []);
  // #933 (was #915): exhausted (zero-stock) beans used to be dropped from
  // the candidate list entirely -- but that also blocked logging the very
  // last shot against a bean that's genuinely down to 0 g. They now stay
  // selectable, just sorted after every in-stock bean and labelled "Empty"
  // so the common case (picking an in-stock bean) still reads cleanly.
  // null means untracked/unlimited stock and always sorts as in-stock.
  // doseRows mirrors library.js's own adapter from S.shots' { annotation,
  // timestamp } shape.
  const doseRows = (S.shots as unknown as AnnotationShot[])
    .filter(s => s.annotation?.coffee != null)
    .map(s => ({ coffee: s.annotation?.coffee, beanId: s.annotation?.beanId, dose: s.annotation?.dose, timestamp: s.timestamp }));
  const inStock: LibraryRow[] = [];
  const exhausted: LibraryRow[] = [];
  for (const b of allBeans) {
    const remaining = computeBeanRemaining(b, doseRows, allBeans);
    (remaining === null || remaining > 0 ? inStock : exhausted).push(b);
  }
  // #456: data-bean-id lets _buildAnnotationPayload read off the currently
  // selected bean's stable id — only real library beans get one; a stale
  // name kept around because it no longer matches any current bean does not.
  const options: BeanOption[] = [
    ...inStock.map(b => ({ name: b.name as string, id: b.id as number, empty: false })),
    ...exhausted.map(b => ({ name: b.name as string, id: b.id as number, empty: true })),
  ];
  // A stale/renamed selection (no longer matching any current bean by name)
  // still needs its own carve-out entry, same as before #933.
  if (selectedName && !options.some(o => o.name === selectedName)) {
    const stale = allBeans.find(b => b.name === selectedName);
    options.push({ name: selectedName, id: stale ? stale.id as number : null, empty: false });
  }
  const byId = selectedBeanId != null ? options.find(o => o.id === selectedBeanId) : null;
  const selected = byId ? byId.name : selectedName;
  // #946: built via the DOM API rather than an innerHTML string — every value
  // is already esc()'d, but the innerHTML sink makes CodeQL re-raise
  // js/xss-through-dom on every code move (#760, #93). textContent/value
  // assignments carry no such sink.
  const frag = document.createDocumentFragment();
  frag.append(new Option('', ''));
  for (const o of options) {
    const label = o.name + (o.empty ? ` (${t('lib_milk_empty')})` : '');
    const opt = new Option(label, o.name, false, o.name === selected);
    if (o.id != null) (opt.dataset as Record<string, unknown>).beanId = o.id;
    frag.append(opt);
  }
  select.replaceChildren(frag);
}

// #946: shared builder for the pure ID-based library <select>s below. `data`
// keys become data-* attributes (dataset.basketId -> data-basket-id), read
// back by _buildAnnotationPayload via selectedOptions[0].dataset.
function _fillIdSelect(select: HTMLSelectElement, noneLabel: string, items: LibraryRow[], selectedId: number | null, datasetKey: 'basketId' | 'puckscreenId'): void {
  const frag = document.createDocumentFragment();
  frag.append(new Option(noneLabel, ''));
  for (const it of items) {
    const opt = new Option(it.name as string, String(it.id), false, selectedId === it.id);
    // Raw value, exactly as the untyped .js assigned it: the real DOMStringMap
    // stringifies, while the select tests' fake DOM stores it verbatim — hence
    // the Record cast off DOMStringMap's string-only type.
    (opt.dataset as Record<string, unknown>)[datasetKey] = it.id;
    frag.append(opt);
  }
  select.replaceChildren(frag);
}

// #635: baskets/puck screens are pure ID-based library selections (unlike
// beans, there's no free-text legacy value to preserve) — value and
// data-basket-id/data-puckscreen-id both carry the id, mirroring
// _renderBeanSelect's data-attribute pattern for _buildAnnotationPayload.
export function _renderBasketSelect(selectedId: number | null): void {
  const select = document.getElementById('annBasket') as HTMLSelectElement | null;
  if (!select) return;
  const lib = (S.coffeeLibrary || {}) as unknown as CatalogLibrary;
  _fillIdSelect(select, t('ann_basket_none'), lib.baskets || [], selectedId, 'basketId');
}

export function _renderPuckScreenSelect(selectedId: number | null): void {
  const select = document.getElementById('annPuckScreen') as HTMLSelectElement | null;
  if (!select) return;
  const lib = (S.coffeeLibrary || {}) as unknown as CatalogLibrary;
  _fillIdSelect(select, t('ann_puckscreen_none'), lib.puckScreens || [], selectedId, 'puckscreenId');
}

export function _renderRecipeSelect(selectedId: number | null): void {
  const field  = document.getElementById('recipeField');
  const select = document.getElementById('annRecipe') as HTMLSelectElement | null;
  if (!field || !select) return;
  const lib = (S.coffeeLibrary || {}) as unknown as CatalogLibrary;
  const recipes = lib.recipes || [];
  if (!recipes.length) { field.style.display = 'none'; return; }
  field.style.display = '';
  // #946: DOM API, not an innerHTML string (see _renderBeanSelect). Recipes
  // carry no data-* attribute — _buildAnnotationPayload reads annRecipe.value.
  const frag = document.createDocumentFragment();
  frag.append(new Option(t('ann_recipe_none'), ''));
  for (const r of recipes) frag.append(new Option(r.name, String(r.id), false, r.id === selectedId));
  select.replaceChildren(frag);
}

// ── Annotation panel ──────────────────────────────────────────────────────

export function renderStars(rating: number): void {
  document.querySelectorAll<HTMLElement>('#starRating .star').forEach(s => {
    s.classList.toggle('active', parseInt(s.dataset.val as string) <= rating);
  });
}

export function updateDegassing(val: string | null | undefined): void {
  const tracker = document.getElementById('degassingTracker') as HTMLElement;
  const fill    = document.getElementById('degassingFill') as HTMLElement;
  const label   = document.getElementById('degassingLabel') as HTMLElement;
  const parseDMY = (s: string | null | undefined): Date | null => {
    if (!s) return null;
    const m = s.match(/^(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{2,4})$/);
    if (!m) return null;
    const y = m[3].length === 2 ? 2000 + parseInt(m[3]) : parseInt(m[3]);
    const d = new Date(y, parseInt(m[2]) - 1, parseInt(m[1]));
    return isNaN(d.getTime()) ? null : d;
  };
  const date = parseDMY(val);
  if (!date) { tracker.style.display = 'none'; return; }
  const days = Math.floor((Date.now() - date.getTime()) / 86400000);
  if (days < 0 || days > 180) { tracker.style.display = 'none'; return; }
  tracker.style.display = 'block';
  const pct = Math.min(100, (days / 42) * 100);
  fill.style.width = pct + '%';
  let color: string, text: string;
  if      (days < 4)  { color = '#52525b'; text = t('degas_too_fresh', days); }
  else if (days < 7)  { color = '#eab308'; text = t('degas_almost',    days); }
  else if (days <= 21){ color = '#22c55e'; text = t('degas_optimal',   days); }
  else if (days <= 35){ color = '#f97316'; text = t('degas_aging',     days); }
  else                { color = '#ef4444'; text = t('degas_old',       days); }
  fill.style.background = color;
  label.style.color     = color;
  label.textContent     = text;
}

// ── Shot photo ────────────────────────────────────────────────────────────

function _renderShotPhoto(shot: AnnotationShot): void {
  const thumb  = document.getElementById('annPhotoThumb') as HTMLImageElement;
  const remove = document.getElementById('annPhotoRemoveBtn') as HTMLElement;
  if (!thumb || !remove) return;
  if (shot.image) {
    thumb.style.display  = '';
    remove.style.display = '';
    thumb.setAttribute('data-clickable', '');
    void loadShotImageBlobUrl(shot.id).then(url => { if (url) thumb.src = url; });
  } else {
    thumb.style.display  = 'none';
    thumb.removeAttribute('src');
    thumb.removeAttribute('data-clickable');
    remove.style.display = 'none';
  }
}

export function openShotPhotoLightbox(): void {
  const thumb = document.getElementById('annPhotoThumb') as HTMLImageElement | null;
  if (!thumb || !thumb.hasAttribute('data-clickable') || !thumb.src) return;
  openLightbox(thumb.src);
}

export async function uploadShotImage(input: HTMLInputElement): Promise<void> {
  const file = input.files?.[0];
  if (!file || !S.primaryShotId) return;
  const id = S.primaryShotId;
  const blob = await openImageCropEditor(file, { shape: 'circle' });

  input.value = '';
  if (!blob) return;
  const r = await postShotImage(id, blob);
  if (!r.ok) {
    const body: unknown = await r.json().catch(() => null);
    const err = (body as { error?: string } | null)?.error;
    alert(t('error_generic', err || r.statusText));
    return;
  }
  const saved = await r.json() as { image?: string | null };
  const idx = S.shots.findIndex(s => s.id === id);
  if (idx !== -1) S.shots[idx].image = saved.image;
  invalidateShotImage(id);
  _renderShotPhoto(saved as unknown as AnnotationShot);
  renderSidebar();
  updateSidebarHighlighting();
}

export async function removeShotImage(): Promise<void> {
  if (!S.primaryShotId) return;
  const id = S.primaryShotId;
  const r = await deleteShotImage(id);
  if (!r.ok) return;
  const idx = S.shots.findIndex(s => s.id === id);
  if (idx !== -1) delete S.shots[idx].image;
  invalidateShotImage(id);
  _renderShotPhoto({ id, image: null });
  renderSidebar();
  updateSidebarHighlighting();
}

export function renderAnnotationPanel(shot: AnnotationShot): void {
  const ann = _applyShotDefaults(shot.annotation || {}) || {};
  _renderShotPhoto(shot);
  S.currentRating = ann.rating || 0;
  renderStars(S.currentRating);
  _renderBeanSelect(ann.coffee || null, ann.beanId ?? null);
  _renderBasketSelect(ann.basketId ?? null);
  _renderPuckScreenSelect(ann.puckScreenId ?? null);
  _renderFrozenPortionPills(ann.coffee || null, shot?.timestamp ? shot.timestamp * 1000 : Date.now(), ann.frozenPortionId ?? null);
  (document.getElementById('annGrinder') as HTMLInputElement).value      = ann.grinder      || '';
  (document.getElementById('annGrindSetting') as HTMLInputElement).value = String(ann.grindSetting || '');
  (document.getElementById('annDose') as HTMLInputElement).value         = String(ann.dose        || '');
  updateDegassing(_roastDateFromLibrary(ann.coffee, shot?.timestamp, ann.beanId) || '');
  (document.getElementById('annTds') as HTMLInputElement).value          = String(ann.tds         || '');
  (document.getElementById('annNotes') as HTMLInputElement).value        = ann.notes        || '';
  _renderDrinkPills(ann.drinkType || '');
  _renderMilkPills(ann.milkType ? String(ann.milkType) : '');
  _updateMilkFieldVisibility();
  _renderRecipeSelect(ann.recipeId || null);
  _setAutoSaveStatus('idle'); // #430: clear any leftover status from the previously viewed shot
  const badge = document.getElementById('orderedByBadge');
  if (badge) {
    const ob = ann.orderedBy;
    if (ob?.customer) {
      const drink = ob.item ? (ob.variant ? `${ob.item} · ${ob.variant}` : ob.item) : null;
      badge.innerHTML = `${COFFEE_ICON_SVG} ${esc(ob.customer)}${drink ? ` · ${esc(drink)}` : ''}${ob.note ? ` · ${esc(ob.note)}` : ''}`;
      badge.style.display = '';
    } else {
      badge.style.display = 'none';
    }
  }
}

export function quickClone(): void {
  const primaryId = S.primaryShotId;
  if (!primaryId) return;
  const prev = (S.shots as unknown as AnnotationShot[]).filter(s => s.id < primaryId).sort((a, b) => b.id - a.id)[0];
  if (!prev) return;
  const ann         = prev.annotation || {};
  const currentShot = (S.shots as unknown as AnnotationShot[]).find(s => s.id === primaryId);
  // Prefer the currently-viewed shot's own bean when it already has one
  // annotated — only fall back to the previous shot's bean otherwise (#389).
  const currentAnn   = currentShot?.annotation || {};
  const useCurrentAnn = !!currentAnn.coffee;
  const beanName      = currentAnn.coffee || ann.coffee || null;
  // #456: beanId mirrors the same currentAnn/ann precedence as beanName.
  // Passed into _renderBeanSelect() below so it matches by id against the
  // CURRENT library (handles a bean renamed since either annotation was
  // saved), and passed through explicitly too for the grind/degassing
  // lookups that run before the DOM has been re-rendered with the new
  // selection.
  const beanId = useCurrentAnn ? (currentAnn.beanId ?? null) : (ann.beanId ?? null);
  _renderBeanSelect(beanName, beanId);
  // Grinder/grind setting/dose come from this bean's own history, not
  // blindly from prev — prev may have used a different bean entirely.
  // "↩ Letzten" means the grind last used for this bean, so prefer the
  // bean's most recently annotated shot over the best-scoring combo here.
  const suggested = beanName
    ? suggestGrindDoseForBean(beanName, S.coffeeLibrary, S.shots, { preferMostRecent: true, beanId })
    : { grinder: '', grindSetting: '', dose: '' };
  (document.getElementById('annGrinder') as HTMLInputElement).value      = suggested.grinder      || ann.grinder      || '';
  (document.getElementById('annGrindSetting') as HTMLInputElement).value = String(suggested.grindSetting || ann.grindSetting || '');
  (document.getElementById('annDose') as HTMLInputElement).value         = String(suggested.dose         || ann.dose         || '');
  updateDegassing(_roastDateFromLibrary(beanName, currentShot?.timestamp, beanId) || '');
  // Basket/puck screen are equipment, not per-shot state — carried over from
  // the previous shot like the grinder above, rather than reset like the
  // frozen-portion choice below.
  _renderBasketSelect(ann.basketId ?? null);
  _renderPuckScreenSelect(ann.puckScreenId ?? null);
  _renderDrinkPills(ann.drinkType || '');
  _renderMilkPills('');
  _updateMilkFieldVisibility();
  _renderRecipeSelect(ann.recipeId || null);
  // Frozen-portion choice is per-shot, not carried over from prev — a clone
  // starts unset (like milk above), even if prev used a frozen portion.
  _renderFrozenPortionPills(beanName, currentShot?.timestamp ? currentShot.timestamp * 1000 : Date.now(), null);
  // #430: quickClone sets field values programmatically (no 'input' event
  // fires), so it must schedule the save itself — there's no explicit Save
  // button left to catch this otherwise.
  scheduleAutoSave();
}
