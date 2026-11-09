// Settings → "Shot logging defaults" card (#654): lets the user configure
// optional default values (Drink Type, Coffee/Bean, Basket, Puck Screen,
// Grinder, Dose) that get auto-prefilled into a brand-new shot's annotation
// panel — see views/shots/annotation.ts's _applyShotDefaults(), which is the
// only place that actually applies them. This module only loads/saves the
// settings themselves and keeps S.shotDefaults (loaded once at app init by
// loadShotDefaults()) in sync after a save.
//
// The grinder entry is not a stored name anymore (#1954): it drives the
// library's single default-grinder flag, which every prefill path reads.
import { saveShotDefaults } from '../api/shots.js';
import { saveGrinder } from '../api/library.js';
import { S } from '../state/index.js';
import type { LibraryRow } from '../state/index.js';
import { t, tHtml } from '../i18n.js';
import { esc, html, joinHtml } from '../utils.js';
import { loadShotDefaults, loadDrinkMenu } from '../views/shots/annotation.js';
import { CHECK_ICON_SVG } from '../icons.js';
import type { ShotDefaults } from '../api/types.js';

// state/index.ts types these rows loosely as Record<string, unknown>; the
// lookups below read the same menu/bean/basket/puck-screen entries
// views/shots/annotation.ts and views/library.ts populate.
type DrinkRow = LibraryRow & { id: string; name: string; emoji?: string };
type CatalogRow = LibraryRow & { id: number; name: string };
interface CatalogLibrary { beans?: LibraryRow[]; baskets?: LibraryRow[]; puckScreens?: LibraryRow[] }
function _catalog(rows: LibraryRow[] | undefined): CatalogRow[] { return (rows || []) as CatalogRow[]; }

// The dropdown's option for a saved grinder name that is not in the library (#1954).
const LEGACY_GRINDER_VALUE = 'legacy';
type GrinderOption = CatalogRow & { isDefault?: boolean };

function _grinderRows(): GrinderOption[] {
  return (S.coffeeLibrary?.grinders || []) as GrinderOption[];
}

function _flaggedGrinder(rows: GrinderOption[]): GrinderOption | undefined {
  return rows.find(g => g.isDefault === true);
}

// Same matching as the prefill's: trimmed, ignoring case.
function _grinderByName(rows: GrinderOption[], name: string): GrinderOption | undefined {
  const wanted = name.trim().toLowerCase();
  return wanted ? rows.find(g => String(g.name).trim().toLowerCase() === wanted) : undefined;
}

// The PUT response only returns the saved grinder, so the other rows are
// cleared here, as the server has just done.
function _setLocalDefault(id: number | null): void {
  for (const g of _grinderRows()) {
    if (g.id === id) g.isDefault = true;
    else delete g.isDefault;
  }
}

export function renderShotDefaultsSettingsCard(): void {
  const d = (S.shotDefaults || {}) as Partial<ShotDefaults>;
  const lib: CatalogLibrary = S.coffeeLibrary || {};

  const drinkSelect = document.getElementById('sdDrinkType');
  if (drinkSelect) {
    const options = (S.drinkMenu || []) as DrinkRow[];
    // codeql[js/xss-through-dom] false positive: esc()/escapeHtml() already applied, see #760
    drinkSelect.innerHTML = html`<option value="">${esc(t('sd_none'))}</option>${joinHtml(
      options.map(m => html`<option value="${esc(m.id)}"${d.drinkType === m.id ? html` selected` : html``}>${esc(m.emoji)} ${esc(m.name)}</option>`))}`;
  }

  const coffeeSelect = document.getElementById('sdCoffee');
  if (coffeeSelect) {
    const beans = _catalog(lib.beans);
    // #1960: a saved bean that left the library keeps its own option, or saving
    // this card would silently drop it.
    const staleCoffee = d.coffee && !beans.some(b => b.name === d.coffee) ? d.coffee : '';
    // codeql[js/xss-through-dom] false positive: esc()/escapeHtml() already applied, see #760
    coffeeSelect.innerHTML = html`<option value="">${esc(t('sd_none'))}</option>${joinHtml(
      beans.map(b => html`<option value="${esc(b.name)}" data-bean-id="${esc(b.id)}"${d.coffee === b.name ? html` selected` : html``}>${esc(b.name)}</option>`))}${
      staleCoffee ? html`<option value="${esc(staleCoffee)}"${d.beanId != null ? html` data-bean-id="${esc(d.beanId)}"` : html``} selected>${esc(staleCoffee)}</option>` : html``}`;
  }

  const basketSelect = document.getElementById('sdBasket');
  if (basketSelect) {
    const baskets = _catalog(lib.baskets);
    // codeql[js/xss-through-dom] false positive: esc()/escapeHtml() already applied, see #760
    basketSelect.innerHTML = html`<option value="">${esc(t('ann_basket_none'))}</option>${joinHtml(
      baskets.map(b => html`<option value="${esc(b.id)}"${d.basketId === b.id ? html` selected` : html``}>${esc(b.name)}</option>`))}`;
  }

  const puckSelect = document.getElementById('sdPuckScreen');
  if (puckSelect) {
    const puckScreens = _catalog(lib.puckScreens);
    // codeql[js/xss-through-dom] false positive: esc()/escapeHtml() already applied, see #760
    puckSelect.innerHTML = html`<option value="">${esc(t('ann_puckscreen_none'))}</option>${joinHtml(
      puckScreens.map(p => html`<option value="${esc(p.id)}"${d.puckScreenId === p.id ? html` selected` : html``}>${esc(p.name)}</option>`))}`;
  }

  const grinderSelect = document.getElementById('sdGrinder');
  if (grinderSelect) {
    const grinders = _grinderRows();
    const savedName = (d.grinder || '').trim();
    const selected = _flaggedGrinder(grinders) ?? _grinderByName(grinders, savedName);
    const legacyName = selected ? '' : savedName;
    // codeql[js/xss-through-dom] false positive: esc()/escapeHtml() already applied, see #760
    grinderSelect.innerHTML = html`<option value="">${esc(t('sd_none'))}</option>${joinHtml(
      grinders.map(g => html`<option value="${esc(g.id)}"${selected?.id === g.id ? html` selected` : html``}>${esc(g.name)}</option>`))}${
      legacyName ? html`<option value="${esc(LEGACY_GRINDER_VALUE)}" selected>${esc(legacyName)}</option>` : html``}`;
  }

  const doseInput = document.getElementById('sdDose') as HTMLInputElement | null;
  if (doseInput) doseInput.value = d.dose != null ? String(d.dose) : '';

  void _adoptSavedGrinderAsDefault();
}

// #1954: an install that saved a grinder name before the library owned the
// flag gets migrated here, because this render is where the settings load and
// the library load converge — loadShotDefaultsSettingsCard(), the re-render
// loadLibrary() does, and a completed restore all end in it. Idempotent by its
// data: it only acts while no grinder is flagged and the saved value matches
// one, and success blanks the saved value, so the condition can never hold
// again — not even after the user later picks "none". Until the library has
// loaded nothing matches, so nothing is written; a failed flag write changes
// nothing and is retried by the next render.
let _adopting = false;
async function _adoptSavedGrinderAsDefault(): Promise<void> {
  const name = (S.shotDefaults as Partial<ShotDefaults> | null)?.grinder;
  const grinders = _grinderRows();
  if (_adopting || !name || _flaggedGrinder(grinders)) return;
  const match = _grinderByName(grinders, name);
  if (!match) return;
  _adopting = true;
  try {
    if (!await saveGrinder(match.id, { isDefault: true }).catch(() => null)) return;
    _setLocalDefault(match.id);
    // The POST must send the whole set: shotDefaultsFromBody resets every key
    // missing from the body.
    const saved = await saveShotDefaults({ ...S.shotDefaults, grinder: '' } as ShotDefaults).catch(() => null);
    if (saved) S.shotDefaults = { ...saved };
    renderShotDefaultsSettingsCard();
  } finally {
    _adopting = false;
  }
}

// Makes the library flag match the dropdown. False when the write failed.
async function _syncDefaultGrinderFlag(value: string): Promise<boolean> {
  const id = /^\d+$/.test(value) ? Number(value) : null;
  const currentId = _flaggedGrinder(_grinderRows())?.id ?? null;
  if (id === currentId) return true;
  const target = (id ?? currentId) as number;
  if (!await saveGrinder(target, { isDefault: id != null }).catch(() => null)) return false;
  _setLocalDefault(id);
  return true;
}

// #526-style race: loadDrinkMenu() is also fired unawaited from the boot
// data chain (boot/data.ts) (for the annotation panel's drink pills) — awaiting it again
// here is a cheap no-op once it's already resolved, and guarantees this
// card's drink-type options aren't rendered off the still-empty S.drinkMenu
// default when this runs first. The coffeeLibrary half of the same race
// (beans/baskets/puckScreens) is covered by the re-render loadLibrary()
// itself does — see views/library.ts.
export async function loadShotDefaultsSettingsCard(): Promise<void> {
  await Promise.all([loadShotDefaults(), loadDrinkMenu()]);
  renderShotDefaultsSettingsCard();
}

export async function saveShotDefaultsSettings(): Promise<void> {
  const coffeeSelect = document.getElementById('sdCoffee') as HTMLSelectElement | null;
  const beanIdAttr   = coffeeSelect?.selectedOptions[0]?.dataset.beanId;

  const grinderValue = (document.getElementById('sdGrinder') as HTMLSelectElement | null)?.value ?? '';
  if (!await _syncDefaultGrinderFlag(grinderValue)) {
    // Nothing is half-saved: a failed flag write aborts the whole save.
    window.showToast?.(t('error_generic', ''));
    return;
  }

  const body: ShotDefaults = {
    drinkType:    (document.getElementById('sdDrinkType') as HTMLSelectElement | null)?.value || null,
    coffee:       coffeeSelect?.value || null,
    beanId:       beanIdAttr ? parseInt(beanIdAttr, 10) : null,
    basketId:     parseInt((document.getElementById('sdBasket') as HTMLSelectElement | null)?.value ?? '', 10) || null,
    puckScreenId: parseInt((document.getElementById('sdPuckScreen') as HTMLSelectElement | null)?.value ?? '', 10) || null,
    grinder:      grinderValue === LEGACY_GRINDER_VALUE ? ((S.shotDefaults as Partial<ShotDefaults> | null)?.grinder || '') : '',
    dose:         parseFloat((document.getElementById('sdDose') as HTMLInputElement | null)?.value ?? '') || null,
  };

  const saved = await saveShotDefaults(body).catch(() => null);
  if (!saved) {
    // saveShotDefaults() resolves to null on any non-ok (or thrown) response,
    // so a rejected save must not look successful.
    window.showToast?.(t('error_generic', ''));
    return;
  }
  S.shotDefaults = { ...saved };
  renderShotDefaultsSettingsCard();

  const btn = document.getElementById('shotDefaultsSaveBtn');
  if (btn) {
    btn.innerHTML = html`${CHECK_ICON_SVG} ${tHtml('sd_saved')}`;
    setTimeout(() => { btn.textContent = t('sd_save'); }, 2000);
  }
}
