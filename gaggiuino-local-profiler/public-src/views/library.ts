import type { Basket, Milk, PuckScreen, Recipe } from '../api/types.js';
import type { BeanRow } from './library/bags.js';
import type { ShelfBean } from './library/shelf.js';
import { S } from '../state/index.js';
import type { ShotMeta } from '../state/index.js';
import { t, tHtml } from '../i18n.js';
import * as libraryApi from '../api/library.js';
import { esc, roastAgeDays, frozenPortionAgeDays, freshnessState, calcBeanRating, shouldShowFreshBadge, toIsoDateInput, todayIsoDate, isoDateInputToMs, html, joinHtml } from '../utils.js';
import type { Html } from '../utils.js';
import { COFFEE_COUNTRIES, VARIETY_SUGGESTIONS, PROCESS_SUGGESTIONS, localeFor, countryName } from '../constants.js';
import { setBeanFilter } from '../components/sidebar.js';
import { attachAutocomplete } from '../components/autocomplete.js';
import { switchMode } from '../components/mode.js';
import { loadBeanImageBlobUrl, invalidateBeanImage } from '../bean-image.js';
import { openImageCropEditor } from '../components/image-crop.js';
import { openLightbox } from '../components/lightbox.js';
import { generateBeanQR } from '../glp-qr.js';
import { calcBestGrindCombosForBean } from './shots/grind.js';
import { renderShotDefaultsSettingsCard } from '../components/shot-defaults-settings.js';
import { TARGET_ICON_SVG, SLIDERS_ICON_SVG, FLAVOR_WHEEL_ICON_SVG, COFFEE_ICON_SVG, SNOWFLAKE_ICON_SVG, STAR_ICON_SVG, CLOSE_ICON_SVG, EDIT_ICON_SVG } from '../icons.js';
import { renderRecipeList } from './library/recipes.js';
import { renderMilkList } from './library/milk.js';
import { renderBasketList } from './library/baskets.js';
import { renderPuckScreenList } from './library/puck-screens.js';
import { renderGrinderList } from './library/grinders.js';
import { classifyBeanBags, renderBagCard, _expandedPastSections } from './library/bags.js';
import {
  classifyBeanShelf, renderShelfTile,
  matchesShelfQuery, matchesShelfFilter, sortShelf, loadShelfPrefs, saveShelfPrefs,
} from './library/shelf.js';
import type { ShelfFilter, ShelfPrefs, ShelfSort } from './library/shelf.js';

const ICON_PENCIL = `<svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15" aria-hidden="true"><path d="M20.71,7.04C21.1,6.65 21.1,6 20.71,5.63L18.37,3.29C18,2.9 17.35,2.9 16.96,3.29L15.12,5.12L18.87,8.87M3,17.25V21H6.75L17.81,9.93L14.06,6.18L3,17.25Z"/></svg>` as Html;
const ICON_TRASH = `<svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15" aria-hidden="true"><path d="M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19M8,9H10V19H8V9M14,9H16V19H14V9M15.5,4L14.5,3H9.5L8.5,4H5V6H19V4H15.5Z"/></svg>` as Html;
const ICON_EYE = `<svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15" aria-hidden="true"><path d="M12,9A3,3 0 0,0 9,12A3,3 0 0,0 12,15A3,3 0 0,0 15,12A3,3 0 0,0 12,9M12,17A5,5 0 0,1 7,12A5,5 0 0,1 12,7A5,5 0 0,1 17,12A5,5 0 0,1 12,17M12,4.5C7,4.5 2.73,7.61 1,12C2.73,16.39 7,19.5 12,19.5C17,19.5 21.27,16.39 23,12C21.27,7.61 17,4.5 12,4.5Z"/></svg>` as Html;
const ICON_EYE_OFF = `<svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15" aria-hidden="true"><path d="M11.83,9L15,12.16C15,12.11 15,12.05 15,12A3,3 0 0,0 12,9C11.94,9 11.89,9 11.83,9M7.53,9.8L9.08,11.35C9.03,11.56 9,11.77 9,12A3,3 0 0,0 12,15C12.22,15 12.44,14.97 12.65,14.92L14.2,16.47C13.53,16.8 12.79,17 12,17A5,5 0 0,1 7,12C7,11.21 7.2,10.47 7.53,9.8M2,4.27L4.28,6.55L4.73,7C3.08,8.3 1.78,10 1,12C2.73,16.39 7,19.5 12,19.5C13.55,19.5 15.03,19.2 16.38,18.66L16.81,19.08L19.73,22L21,20.73L3.27,3M12,7A5,5 0 0,1 17,12C17,12.64 16.87,13.26 16.64,13.82L19.57,16.75C21.07,15.5 22.27,13.86 23,12C21.27,7.61 17,4.5 12,4.5C10.6,4.5 9.26,4.75 8,5.2L10.17,7.35C10.74,7.13 11.35,7 12,7Z"/></svg>` as Html;
const ICON_QR = `<svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15" aria-hidden="true"><path d="M3,11H5V13H3V11M11,5H13V9H11V5M9,11H13V15H11V13H9V11M15,11H17V13H19V11H21V13H19V15H21V19H19V21H17V19H13V21H11V17H15V15H17V13H15V11M19,19V15H17V19H19M15,3H21V9H15V3M17,5V7H19V5H17M3,3H9V9H3V3M5,5V7H7V5H5M3,15H9V21H3V15M5,17V19H7V17H5Z"/></svg>` as Html;
const ICON_PLUS = `<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14" aria-hidden="true"><path d="M19,13H13V19H11V13H5V11H11V5H13V11H19V13Z"/></svg>` as Html;

// ── Typed views of S ──────────────────────────────────────────────────────
// state/index.ts types library rows as opaque LibraryRow records; this view
// owns the bean shape plus the bag-level fields the backend attaches on read,
// reached through one typed view of the same array/state (same pattern as
// views/library/bags.ts).
type BeanListRow = BeanRow & {
  consumedG?: number | undefined;
  remainingG?: number | null | undefined;
};

function _beanList(): BeanListRow[] {
  return S.coffeeLibrary.beans as BeanListRow[];
}

// The generated Bean.bags item lags the backend: frozenPortion fields are all
// optional in the schema but always present at runtime — name what is read.
interface FrozenPortion {
  id: number;
  frozenAt: number;
  portionCount: number;
  portionWeight_g: number;
  remainingCount?: number;
  thawedAt?: number;
}

// A bean origin chip (blend-capable) — mirrors the flavor chips. The schema
// documents the weight as `pct`; the runtime payload carries `percent`.
interface OriginChip { code?: string | undefined; percent?: number | undefined }
interface OriginBean { origins?: OriginChip[] | undefined; origin?: string | undefined }

type BeanFormExtraRecipe = Record<string, unknown>;

interface LibraryState {
  coffeeLibrary: {
    recipes?: Recipe[] | undefined;
    milks?: Milk[] | undefined;
    baskets?: Basket[] | undefined;
    puckScreens?: PuckScreen[] | undefined;
  };
  _urlImportImageUrl?: string | null;
  _urlImportExtraRecipes?: BeanFormExtraRecipe[] | null;
}
function _state(): LibraryState { return S; }

// Shot rows are metadata-only (ShotMeta); the bean list reads the annotation's
// coffee/rating fields and the timestamp — named here, same convention as
// views/library/recipes.ts's RecipeShotRow.
type BeanShotRow = ShotMeta & {
  annotation: {
    grinder: string;
    grindSetting: string;
    beanId?: number | null;
    coffee?: string | null;
    rating?: string | null;
  };
};
function _shots(): BeanShotRow[] { return S.shots as BeanShotRow[]; }

// qrcode ships no type declarations; name the one call this view makes.
interface QrCodeModule {
  toCanvas(canvas: HTMLCanvasElement, text: string, options: {
    width: number; margin: number; errorCorrectionLevel: string;
    color: { dark: string; light: string };
  }): Promise<unknown>;
}

// Every form field read/written here is an <input>/<select>; the shared
// .value/.checked API is all that is used (same helper as grinders.ts).
function _field(id: string): HTMLInputElement {
  return document.getElementById(id) as HTMLInputElement;
}
function _el(id: string): HTMLElement {
  return document.getElementById(id) as HTMLElement;
}

// Bean origin display — beans predating the blend feature (or ones without an
// origins[] array yet) fall back to the legacy singular `origin` field.
function originDisplay(bean: OriginBean): string {
  const origins = Array.isArray(bean.origins) && bean.origins.length
    ? bean.origins
    : (bean.origin ? [{ code: bean.origin }] : []);
  return origins.map(o => {
    const label = countryName(o.code, S.currentLang);
    return o.percent != null ? `${label} ${o.percent}%` : label;
  }).join(' + ');
}

// Most recently used grind setting for a bean (#829). Deliberately reads
// S.shots' own annotations rather than bean.knownGrindSettings: that array
// is only written by the Guided Dial-In wizard's explicit "Save known grind"
// button (dialin-wizard.js's dialinSaveKnownGrind, POST .../known-grind) —
// it stays empty for the common case of a bean that's only ever been
// annotated on normal shots, which would make "last used" silently blank
// for most beans. Same beanId-first, name-fallback matching convention as
// calcBestGrindCombosForBean/suggestGrindDoseForBean's preferMostRecent path
// (#456), and the same "most recent shot for this bean" concept as that
// function's lastForBean — just without its dose/priority-fallback logic,
// since this only ever wants the plain last annotated grind.
function lastUsedGrindForBean(bean: BeanListRow, shots: BeanShotRow[]): { grinder: string; grindSetting: string; timestamp: number } | null {
  const name = bean.name?.trim().toLowerCase();
  const match = (shots || [])
    .filter(s => {
      const a = s.annotation || {};
      if (!a.grinder?.trim() || !a.grindSetting) return false;
      return bean.id != null && a.beanId != null
        ? a.beanId === bean.id
        : (a.coffee || '').trim().toLowerCase() === name;
    })
    .sort((a, b) => b.timestamp - a.timestamp)[0];
  return match
    ? { grinder: match.annotation.grinder.trim(), grindSetting: match.annotation.grindSetting, timestamp: match.timestamp }
    : null;
}

// ── Library load ──────────────────────────────────────────────────────────
export async function loadLibrary(): Promise<void> {
  try {
    const library = await libraryApi.getLibrary();
    if (!library) return;
    S.coffeeLibrary = library as typeof S.coffeeLibrary;
    const lib = _state().coffeeLibrary;
    if (!lib.recipes)     lib.recipes     = [];
    if (!lib.milks)       lib.milks       = [];
    if (!lib.baskets)     lib.baskets     = [];
    if (!lib.puckScreens) lib.puckScreens = [];
    updateLibraryDatalist();
    renderRecipeList();
    renderMilkList();
    renderBasketList();
    renderPuckScreenList();
    // #526: this fetch is fired unawaited from main.js's init sequence, racing
    // switchMode('library') (mode.js), which renders the bean/grinder lists
    // straight off S.coffeeLibrary the moment the user opens Library — before
    // this promise resolves, that render sees the still-empty default
    // ({ beans: [], grinders: [] }, state.js) and, since nothing re-renders it
    // afterwards, the flavor-wheel button (and everything else data-dependent)
    // stays invisible for the rest of the session even once the data arrives.
    // Re-render here too so a load that finishes after the user is already on
    // Library corrects itself; a cheap no-op re-render if they aren't there yet.
    renderBeanList();
    renderGrinderList();
    // #654: same race — the shot-defaults Settings card's bean/basket/puck-
    // screen <select>s are also populated straight off S.coffeeLibrary at
    // init, before this fetch necessarily resolves.
    renderShotDefaultsSettingsCard();
  } catch { /* ignore */ }
}

// Bean/grinder names feed the annGrinder (main.js) and recipeFormBean
// autocompletes (components/autocomplete.js) — both read S.coffeeLibrary
// live, so nothing needs to be "populated" ahead of time. This just
// re-renders whichever of those is currently open, so a save/delete
// elsewhere in the library shows up immediately if the user has one open.
export function updateLibraryDatalist(): void {
  (document.getElementById('annGrinder') as HTMLInputElement | null)?._autocomplete?.refresh();
  (document.getElementById('recipeFormBean') as HTMLInputElement | null)?._autocomplete?.refresh();
}

export function switchLibTab(tab: string): void {
  _el('libTabBeans').classList.toggle('active',       tab === 'beans');
  _el('libTabGrinders').classList.toggle('active',    tab === 'grinders');
  _el('libTabRecipes').classList.toggle('active',     tab === 'recipes');
  _el('libTabMilk')?.classList.toggle('active',      tab === 'milk');
  _el('libTabBaskets')?.classList.toggle('active',   tab === 'baskets');
  _el('libTabPuckScreens')?.classList.toggle('active', tab === 'puckscreens');
  _el('libTabProfiles')?.classList.toggle('active',  tab === 'profiles');
  _el('libSectionBeans').classList.toggle('active',   tab === 'beans');
  _el('libSectionGrinders').classList.toggle('active', tab === 'grinders');
  _el('libSectionRecipes').classList.toggle('active', tab === 'recipes');
  _el('libSectionMilk')?.classList.toggle('active',  tab === 'milk');
  _el('libSectionBaskets')?.classList.toggle('active', tab === 'baskets');
  _el('libSectionPuckScreens')?.classList.toggle('active', tab === 'puckscreens');
  _el('libSectionProfiles')?.classList.toggle('active', tab === 'profiles');
}

// Bean ids with an in-flight toggle-active request — disables the eye icon
// button for that bean so a slow connection can't double-fire the toggle
// before the first request's re-render lands.
const _pendingBeanActiveToggles = new Set<number>();

function renderBeanCard(b: BeanListRow, beans: BeanListRow[]): Html {
  const bags = Array.isArray(b.bags) ? b.bags : [];
  // consumedG/remainingG (bean-level totals) and every bag's own
  // consumedG/remainingG/current are computed server-side (see
  // decorateBeanStatus, go/internal/library/handlers.go's getLibrary) and
  // attached to every bean/bag on load — no client-side dose replay.
  const totalConsumed = Math.round(b.consumedG ?? 0);
  const remaining = b.remainingG ?? null;
  const { current, upcoming, past } = classifyBeanBags(b);
  const activeBag = current?.bg || null;

  // Stock %/bar is scoped to the CURRENT bag only (how far through the
  // bag actually being drawn from) — the headline g-numbers above stay
  // bean-wide totals (sum across all bags).
  let invHtml: Html = html``;
  if (remaining != null || totalConsumed > 0) {
    const isLow = remaining != null && remaining < 100;
    const rem = Math.max(0, remaining ?? 0);
    const stockPct = current && current.stockG != null && current.stockG > 0
      ? Math.max(0, Math.min(100, Math.round(((current.remaining ?? 0) / current.stockG) * 100)))
      : 0;
    invHtml = html`<div class="lib-inv-block">
      ${remaining != null ? html`<div class="lib-inv-bar-row">
        <div class="lib-stock-bar-md" title="${esc(stockPct)}%"><div class="lib-stock-bar-fill-md${esc(isLow ? ' low' : '')}" style="width:${esc(stockPct)}%"></div></div>
        <span class="lib-inv-pct${esc(isLow ? ' low' : '')}">${esc(stockPct)}%</span>
      </div>` : esc('')}
      <div class="lib-inv-nums">
        ${remaining != null ? html`<span class="lib-inv-remaining${esc(isLow ? ' low' : '')}">${tHtml('lib_inv_remaining', rem)} g</span><span class="lib-inv-sep">·</span>` : esc('')}
        <span class="lib-inv-consumed">${tHtml('lib_inv_consumed', totalConsumed)} g</span>
        ${bags.length > 1 ? html`<span class="lib-inv-sep">·</span><span class="lib-inv-total">${tHtml('lib_inv_bags', bags.length)}</span>` : esc('')}
        ${isLow ? html`<span class="lib-inv-reorder">${tHtml('lib_inv_reorder')}</span>` : esc('')}
      </div>
    </div>`;
  }

  // Bag-level actions (new bag / freeze portions) live right next to the
  // inventory display now, not in the generic actions toolbar — they act
  // ON the packaging shown right above, so they read as one unit instead
  // of being scattered into an unrelated meta-actions row. Rendered
  // unconditionally (unlike invHtml) so a bean with zero bags yet still
  // gets an obvious "add the first one" affordance.
  const bagActionsHtml: Html = html`<div class="lib-bag-toolbar">
    <button class="lib-btn-sm lib-bag-toolbar-btn" data-action="open-new-bag" data-id="${esc(b.id)}" title="${tHtml('lib_new_bag')}">${ICON_PLUS} ${tHtml('lib_new_bag_title')}</button>
    ${activeBag ? html`<button class="lib-btn-sm lib-bag-toolbar-btn" data-action="open-freeze-form" data-id="${esc(b.id)}" title="${tHtml('bag_freeze_btn')}">${SNOWFLAKE_ICON_SVG} ${tHtml('bag_freeze_btn')}</button>` : esc('')}
  </div>`;

  const bagHistoryHtml: Html = bags.length >= 1 ? (() => {
    const parts: Html[] = [];
    if (current) parts.push(renderBagCard(b, current, 'current', beans, false));
    // data-bag-drag-list marks the container main.js's drag-reorder
    // handler watches for drop targets — only "upcoming" bags participate.
    const upcomingHtml = joinHtml(upcoming.map(entry => renderBagCard(b, entry, 'upcoming', beans, true)));
    if (upcomingHtml) parts.push(html`<div class="lib-bag-drag-list" data-bag-drag-list data-bean-id="${esc(b.id)}">${upcomingHtml}</div>`);
    // Past bags: only rendered once the section has ever been opened for
    // this bean (_expandedPastSections, same Set-backed pattern as
    // _expandedBagCards in library/bags.ts) — a bean with a long bag history still
    // avoids the DOM-build cost until someone actually opens it, but the
    // open/closed state now survives the full renderBeanList() rebuild
    // that clicking ANY bag card triggers (toggleBagCard -> renderBeanList
    // regenerates this whole card's HTML from scratch every time — with
    // the old DOM-only classList/dataset.built approach, clicking a bag
    // card that happened to live INSIDE an opened past section wiped the
    // section back to collapsed, since nothing re-rendered it as open;
    // 2026-09-09 mobile bug report). Material "expansion panel": a
    // chip-style trigger row (chevron rotates via CSS transform) driving
    // a grid-template-rows 0fr/1fr wrapper for a real animated open/close.
    const pastExpanded = _expandedPastSections.has(b.id);
    const pastBagsHtml = pastExpanded ? joinHtml(past.map(entry => renderBagCard(b, entry, 'past', beans, true))) : esc('');
    const pastSection: Html = past.length
      ? html`<div class="lib-bag-history-toggle${esc(pastExpanded ? ' expanded' : '')}" data-action="toggle-past-bags" data-id="${esc(b.id)}">
           <span class="lib-bag-chevron">▸</span>
           <span>${tHtml('lib_bag_state_past')}</span>
           <span class="lib-bag-past-count">${esc(past.length)}</span>
         </div>
         <div class="lib-bag-history-past-wrap${esc(pastExpanded ? ' expanded' : '')}">
           <div class="lib-bag-history-past">${pastBagsHtml}</div>
         </div>`
      : esc('');
    return html`<div class="lib-bag-history">${joinHtml(parts)}</div>${pastSection}`;
  })() : html`<div class="lib-bag-empty-note">${tHtml('lib_bag_empty')}</div>`;

  // #477: the bag's own freshness badge is always the real calendar age —
  // freezing part of the bag must not make the coffee still in normal use
  // read as fresher than it is. Frozen portions get their own effective
  // age (frozenPortionAgeDays, below) instead of discounting this one.
  const roastAge = roastAgeDays(activeBag?.roastDate || b.roastDate);
  const freshBadge: Html = (roastAge != null && shouldShowFreshBadge(b.stock_g, remaining))
    ? html` <span class="lib-fresh-badge fresh-${esc(freshnessState(roastAge))}" title="${esc(t('freshness_title', roastAge))}">${esc(roastAge)}d</span>`
    : esc('');

  const locale = localeFor(S.currentLang);
  const frozenPortions = (activeBag && Array.isArray(activeBag.frozenPortions) ? activeBag.frozenPortions : []) as FrozenPortion[];
  // #472: date badges include the year (a portion can stay frozen well
  // past 12 months) and, while still frozen, show remaining/total so a
  // single "auftauen" click reads as "pull one portion out", not "close
  // out the whole batch" — matches decrementing thaw-portion server-side.
  const frozenHtml: Html = frozenPortions.length ? html`<div class="lib-frozen-row">${joinHtml(frozenPortions.map(fp => {
    const frozenStr = new Date(fp.frozenAt).toLocaleDateString(locale, { day: '2-digit', month: '2-digit', year: '2-digit' });
    const remaining = Number.isFinite(fp.remainingCount) ? fp.remainingCount : fp.portionCount;
    const editForm: Html = html`
      <div id="editFrozenForm${esc(fp.id)}" class="lib-new-bag-form" style="display:none">
        <div class="lib-new-bag-fields">
          <input type="number" class="lib-new-bag-input" id="editFrozenRemaining${esc(fp.id)}" placeholder="${tHtml('bag_freeze_count')}" min="0" max="${esc(fp.portionCount)}" step="1" value="${esc(remaining)}">
          <input type="number" class="lib-new-bag-input" id="editFrozenWeight${esc(fp.id)}" placeholder="${tHtml('bag_freeze_weight')}" min="0.1" step="0.1" value="${esc(fp.portionWeight_g)}">
          <input type="date" class="lib-new-bag-input" id="editFrozenDate${esc(fp.id)}" value="${esc(toIsoDateInput(new Date(fp.frozenAt).toISOString()))}" max="${esc(todayIsoDate())}">
        </div>
        <div class="lib-form-actions">
          <button class="lib-btn-sm" data-action="close-edit-frozen-form" data-portion-id="${esc(fp.id)}">${tHtml('lib_cancel')}</button>
          <button class="lib-save-btn" data-action="save-edit-frozen-form" data-id="${esc(b.id)}" data-portion-id="${esc(fp.id)}">${tHtml('bag_freeze_save')}</button>
        </div>
      </div>`;
    // #477: each portion's own effective age (its clock only runs while
    // not frozen) — separate from the bag's badge above, which is never
    // discounted by this.
    const fpAge = frozenPortionAgeDays(activeBag?.roastDate || b.roastDate, fp);
    const fpTitle = fpAge != null
      ? `${t('bag_frozen_portion_title', fp.portionCount, fp.portionWeight_g)} — ${t('bag_frozen_portion_age', fpAge)}`
      : t('bag_frozen_portion_title', fp.portionCount, fp.portionWeight_g);
    // #856: the portion's paused age is now also a visible badge (reusing
    // the bag-level fresh-badge color tiers), not just a tooltip — without
    // it, a frozen portion looked like it kept aging same as the bag.
    const fpAgeBadge: Html = fpAge != null
      ? html` <span class="lib-fresh-badge fresh-${esc(freshnessState(fpAge))}" title="${esc(t('bag_frozen_portion_age', fpAge))}">${esc(fpAge)}d</span>`
      : esc('');
    if (fp.thawedAt) {
      const thawedStr = new Date(fp.thawedAt).toLocaleDateString(locale, { day: '2-digit', month: '2-digit', year: '2-digit' });
      return html`<span class="lib-frozen-badge thawed" title="${esc(fpTitle)}">${tHtml('bag_frozen_thawed_badge', thawedStr)}${fpAgeBadge}
        <button class="lib-frozen-edit-btn" data-action="open-edit-frozen-form" data-portion-id="${esc(fp.id)}" title="${tHtml('bag_frozen_edit_btn')}">${EDIT_ICON_SVG}</button></span>${editForm}`;
    }
    return html`<span class="lib-frozen-badge" title="${esc(fpTitle)}">${SNOWFLAKE_ICON_SVG} ${esc(remaining)}/${esc(fp.portionCount)} ${tHtml('bag_frozen_badge', frozenStr)}${fpAgeBadge}
      <button class="lib-frozen-thaw-btn" data-action="thaw-portion" data-bean-id="${esc(b.id)}" data-portion-id="${esc(fp.id)}" title="${tHtml('bag_thaw_btn')}">${tHtml('bag_thaw_btn')}</button>
      <button class="lib-frozen-edit-btn" data-action="open-edit-frozen-form" data-portion-id="${esc(fp.id)}" title="${tHtml('bag_frozen_edit_btn')}">${EDIT_ICON_SVG}</button></span>${editForm}`;
  }))}</div>` : esc('');

  const rating = calcBeanRating(b.name, _shots());
  const ratingHtml: Html = rating ? html`<div class="lib-rating-row" title="${esc(t('bean_rating_tooltip', rating.count))}">
    ${joinHtml(Array.from({ length: 5 }, (_, i) => html`<span class="lib-star${esc(i < Math.round(rating.avg) ? ' on' : '')}">${STAR_ICON_SVG}</span>`))}
    <span class="lib-rating-num">${esc(rating.avg.toFixed(1))}</span>
  </div>` : esc('');

  // Only the single best combo is shown — with several grinders/grind
  // settings tested per bean this can get noisy fast, and "the one thing
  // to try next" is more useful at a glance than a ranked list.
  const bestCombos = calcBestGrindCombosForBean(b.name, _shots(), b.id);
  const bestCombo = bestCombos?.[0];
  const bestComboHtml: Html = bestCombo ? html`<div class="lib-best-combo-row" title="${esc(t('bean_best_combo_tooltip', bestCombo.shotCount))}">
    <span class="lib-best-combo-label">${tHtml('bean_best_combo_label')}</span>
    <span class="lib-best-combo-value">${esc(t('bean_best_combo_value', bestCombo.grinder, bestCombo.grindSetting))}</span>
    <span class="lib-best-combo-score">${tHtml('bean_best_combo_score', bestCombo.avgScore)}</span>
  </div>` : esc('');

  // Last-used grind setting (#829) — separate from bestComboHtml above:
  // that's the highest-*scoring* combo across history, this is simply
  // whatever was dialed in most recently, which is what "what did I have
  // this on last time" actually means when picking up a bean again.
  const lastGrind = lastUsedGrindForBean(b, _shots());
  const lastGrindHtml: Html = lastGrind ? (() => {
    const usedAtMs = lastGrind.timestamp * 1000;
    const ageDays = Math.floor((Date.now() - usedAtMs) / 86400000);
    const dateStr = new Date(usedAtMs).toLocaleDateString(locale, { day: '2-digit', month: '2-digit', year: '2-digit' });
    return html`<div class="lib-last-grind-row" title="${esc(t('bean_last_grind_tooltip', dateStr))}">
    <span class="lib-last-grind-label">${tHtml('bean_last_grind_label')}</span>
    <span class="lib-last-grind-value">${esc(t('bean_best_combo_value', lastGrind.grinder, lastGrind.grindSetting))}</span>
    <span class="lib-last-grind-ago">${tHtml('bean_last_grind_ago', ageDays)}</span>
  </div>`;
  })() : esc('');

  const extraParts = [
    b.altitude_m ? t('bean_altitude_display', b.altitude_m) : '',
    b.producer, b.importer ? t('bean_importer_display', b.importer) : '',
    b.harvest ? t('bean_harvest_display', b.harvest) : '',
    b.certification, b.price_eur ? `${b.price_eur.toFixed(2)} €` : '',
    activeBag?.batchNumber ? t('bag_batch_number_display', activeBag.batchNumber) : '',
  ].filter(Boolean);
  const extraHtml: Html = extraParts.length
    ? html`<div class="lib-item-sub lib-item-extra">${joinHtml(extraParts.map((p, i) => i ? html` · ${esc(p)}` : esc(p)))}</div>` : esc('');

  const brewParts = [
    b.brewTempC ? t('bean_brew_temp_display', b.brewTempC) : '',
    b.brewRatio,
    b.brewTimeS ? t('bean_brew_time_display', b.brewTimeS) : '',
  ].filter(Boolean);
  const brewHtml: Html = brewParts.length || b.brewNotes
    ? html`<div class="lib-item-sub lib-item-brew">${COFFEE_ICON_SVG} ${joinHtml([...brewParts, b.brewNotes].filter(Boolean).map((p, i) => i ? html` · ${esc(p)}` : esc(p)))}</div>`
    : esc('');

  const disabled = b.enabled === false;
  // #404: origin moves out of the generic lib-item-sub line into its own
  // small eyebrow above the (now serif) bean name.
  const origin = originDisplay(b);
  const originEyebrow: Html = origin ? html`<div class="lib-item-origin-eyebrow">${esc(origin)}</div>` : esc('');
  // Meta-actions (profile/dial-in/QR/flavor-wheel/visibility/edit/delete)
  // now live in a compact header toolbar next to the bean name — anchored
  // at a fixed spot regardless of card content height, instead of the old
  // single flex row that vertically centered on the WHOLE card and ended
  // up floating in empty space next to whatever happened to be tallest
  // (usually the bag cards). Delete sits behind a visual divider so it
  // doesn't read as "just another icon" among the safe actions.
  const toolbarHtml: Html = html`<div class="lib-item-toolbar">
    ${Array.isArray(b.flavors) && b.flavors.length ? html`<button class="lib-btn-sm lib-btn-icon" data-action="open-flavor-wheel" data-id="${esc(b.id)}" title="${tHtml('flavor_wheel_btn')}">${FLAVOR_WHEEL_ICON_SVG}</button>` : esc('')}
    <button class="lib-btn-sm lib-btn-icon" data-action="create-profile-from-bean" data-id="${esc(b.id)}" title="${tHtml('profile_create_from_bean')}">${SLIDERS_ICON_SVG}</button>
    <button class="lib-btn-sm lib-btn-icon" data-action="start-dialin-from-bean" data-id="${esc(b.id)}" title="${tHtml('dialin_wizard_start_from_bean')}">${TARGET_ICON_SVG}</button>
    <button class="lib-btn-sm lib-btn-icon" data-action="toggle-bean-qr" data-id="${esc(b.id)}" title="${tHtml('bean_qr_label')}">${ICON_QR}</button>
    <button class="lib-btn-sm lib-btn-icon" data-action="toggle-bean-active" data-id="${esc(b.id)}" title="${tHtml(disabled ? 'lib_btn_enable' : 'lib_btn_disable')}"${esc(_pendingBeanActiveToggles.has(b.id) ? ' disabled' : '')}>${disabled ? ICON_EYE_OFF : ICON_EYE}</button>
    <button class="lib-btn-sm lib-btn-icon" data-action="edit-bean" data-id="${esc(b.id)}" title="${tHtml('lib_btn_edit')}">${ICON_PENCIL}</button>
    <span class="lib-toolbar-sep"></span>
    <button class="lib-btn-sm del lib-btn-icon" data-action="delete-bean" data-id="${esc(b.id)}" title="${tHtml('lib_btn_delete')}">${ICON_TRASH}</button>
  </div>`;
  return html`<div class="lib-item${esc(disabled ? ' lib-item-disabled' : '')}">
    ${b.image ? html`<img class="lib-bean-thumb" data-bean-id="${esc(b.id)}" alt="">` : esc('')}
    <div class="lib-item-info">
      ${originEyebrow}
      <div class="lib-item-header">
        <div class="lib-item-name"><span class="serif-display lib-bean-name-link" data-action="filter-by-bean" data-id="${esc(b.id)}" title="${tHtml('bean_filter_hint')}">${esc(b.name)}</span>${freshBadge}${b.roastType ? html` <span class="lib-roast-badge">${esc(t('roast_type_' + b.roastType))}</span>` : esc('')}${b.decaf ? html` <span class="lib-decaf-badge">DECAF</span>` : esc('')}${disabled ? html` <span class="lib-disabled-badge">${tHtml('lib_bean_disabled_badge')}</span>` : esc('')}</div>
        ${toolbarHtml}
      </div>
      <div class="lib-item-sub">${joinHtml([
        b.region, b.species, b.variety, b.process, b.roaster, b.roastDate, b.notes,
      ].filter(Boolean).map((p, i) => i ? html` · ${esc(p)}` : esc(p)))}</div>
      ${extraHtml}
      ${brewHtml}
      ${ratingHtml}
      ${bestComboHtml}
      ${lastGrindHtml}
      ${Array.isArray(b.flavors) && b.flavors.length ? html`<div class="lib-flavor-row">${joinHtml(b.flavors.map(f => html`<span class="flavor-chip flavor-chip-static">${esc(f)}</span>`))}</div>` : esc('')}
      ${invHtml}
      ${bagActionsHtml}
      ${frozenHtml}
      ${bagHistoryHtml}
      ${b.source ? html`<div class="lib-item-source">${tHtml('lib_imported_from',
        b.sourceUrl ? html`<a href="${esc(b.sourceUrl)}" target="_blank" rel="noopener">${esc(b.source)}</a>` : esc(b.source),
        esc(b.importedAt || ''))}</div>` : esc('')}
    </div>
    <div id="newBagForm${esc(b.id)}" class="lib-new-bag-form" style="display:none">
      <div class="lib-new-bag-fields">
        <input type="date" class="lib-new-bag-input" id="newBagRoastDate${esc(b.id)}" title="${tHtml('lib_bag_roast_date')}" max="${esc(todayIsoDate())}">
        <input type="number" class="lib-new-bag-input" id="newBagStock${esc(b.id)}" placeholder="${tHtml('lib_bag_stock')}" min="0" step="1">
        <input type="text" class="lib-new-bag-input" id="newBagBatchNumber${esc(b.id)}" placeholder="${tHtml('lib_bag_batch_number')}" maxlength="50">
      </div>
      <div class="lib-form-actions">
        <button class="lib-btn-sm" data-action="close-new-bag" data-id="${esc(b.id)}">${tHtml('lib_cancel')}</button>
        <button class="lib-save-btn" data-action="save-new-bag" data-id="${esc(b.id)}">${tHtml('lib_new_bag_save')}</button>
      </div>
    </div>
    <div id="freezeForm${esc(b.id)}" class="lib-new-bag-form" style="display:none">
      <div class="lib-new-bag-fields">
        <input type="number" class="lib-new-bag-input" id="freezePortionCount${esc(b.id)}" placeholder="${tHtml('bag_freeze_count')}" min="1" step="1">
        <input type="number" class="lib-new-bag-input" id="freezePortionWeight${esc(b.id)}" placeholder="${tHtml('bag_freeze_weight')}" min="0.1" step="0.1">
        <input type="date" class="lib-new-bag-input" id="freezeDate${esc(b.id)}" title="${tHtml('bag_freeze_date')}" value="${esc(todayIsoDate())}" max="${esc(todayIsoDate())}">
      </div>
      <div class="lib-form-actions">
        <button class="lib-btn-sm" data-action="close-freeze-form" data-id="${esc(b.id)}">${tHtml('lib_cancel')}</button>
        <button class="lib-save-btn" data-action="save-freeze-form" data-id="${esc(b.id)}">${tHtml('bag_freeze_save')}</button>
      </div>
    </div>
    <div class="bean-qr-wrap" id="beanQR${esc(b.id)}" style="display:none">
      <canvas id="beanQRCanvas${esc(b.id)}"></canvas>
      <span class="bean-qr-label">${tHtml('bean_qr_label')}</span>
    </div>
  </div>`;
}

// ── Bean list ─────────────────────────────────────────────────────────────
// Beans expanded from a Stock / Empty & archive shelf tile. Module-level like
// _expandedPastSections so the choice survives renderBeanList()'s full rebuild.
const _expandedShelfBeans = new Set<number>();
// Open state of the collapsed "Empty & archive" <details>; the element is
// rebuilt on every render, so its meaning has to live outside the DOM.
let _shelfArchiveOpen = false;

// Active shelf toolbar state, loaded lazily: loadShelfPrefs() reads shelf.ts's
// module bindings, which the shelf.ts -> bags.ts -> library.ts -> shelf.ts
// import cycle leaves uninitialized during module evaluation. Only filter/sort
// are persisted (shelf.ts's saveShelfPrefs); the query is session-only so a
// stale search can't silently hide beans after a reload.
let _shelfPrefsLazy: ShelfPrefs | null = null;
function shelfPrefs(): ShelfPrefs {
  return (_shelfPrefsLazy ??= loadShelfPrefs());
}

function _shelfHeading(key: string, count?: number): Html {
  return html`<div class="lib-shelf-heading"><span>${tHtml(key)}</span>${count != null ? html`<span class="lib-shelf-count">${esc(count)}</span>` : esc('')}</div>`;
}

function renderShelfToolbar(prefs: ShelfPrefs): Html {
  const chip = (filter: ShelfFilter, key: string): Html =>
    html`<button type="button" class="lib-shelf-chip" data-shelf-filter="${esc(filter)}" aria-pressed="${esc(prefs.filter === filter ? 'true' : 'false')}">${tHtml(key)}</button>`;
  return html`<div class="lib-shelf-toolbar">
    <input type="search" id="libShelfSearch" class="lib-shelf-search" placeholder="${tHtml('lib_shelf_search_ph')}" aria-label="${tHtml('lib_shelf_search_ph')}" value="${esc(prefs.query)}">
    <div class="lib-shelf-chips">${chip('all', 'lib_shelf_all')}${chip('espresso', 'roast_type_espresso')}${chip('filter', 'roast_type_filter')}${chip('decaf', 'lib_bean_decaf')}</div>
    <select id="libShelfSort" class="lib-shelf-sort">
      <option value="fresh" ${esc(prefs.sort === 'fresh' ? 'selected' : '')}>${tHtml('lib_shelf_sort_fresh')}</option>
      <option value="name" ${esc(prefs.sort === 'name' ? 'selected' : '')}>${tHtml('lib_shelf_sort_name')}</option>
      <option value="remaining" ${esc(prefs.sort === 'remaining' ? 'selected' : '')}>${tHtml('lib_shelf_sort_remaining')}</option>
    </select>
  </div>`;
}

// The shelves live in their own container so toolbar events can rebuild just
// them — rebuilding the whole view on every keystroke would drop the caret.
function _shelfSectionsMount(): HTMLElement | null {
  const el = document.getElementById('beanListUI');
  if (!el) return null;
  if (typeof el.querySelector !== 'function') return el;
  return el.querySelector<HTMLElement>('#libShelfSections') || el;
}

function wireShelfToolbar(): void {
  const prefs = shelfPrefs();
  const search = document.getElementById('libShelfSearch') as HTMLInputElement | null;
  if (search?.addEventListener) {
    search.value = prefs.query;
    search.addEventListener('input', () => {
      prefs.query = search.value;
      renderShelfSections();
    });
  }
  const sort = document.getElementById('libShelfSort') as HTMLSelectElement | null;
  if (sort?.addEventListener) {
    sort.value = prefs.sort;
    sort.addEventListener('change', () => {
      prefs.sort = (sort.value as ShelfSort) || 'fresh';
      saveShelfPrefs(prefs);
      renderShelfSections();
    });
  }
  document.querySelectorAll<HTMLButtonElement>('[data-shelf-filter]').forEach(chip => {
    if (!chip.addEventListener) return;
    chip.addEventListener('click', () => {
      prefs.filter = (chip.dataset.shelfFilter as ShelfFilter) || 'all';
      saveShelfPrefs(prefs);
      document.querySelectorAll<HTMLButtonElement>('[data-shelf-filter]').forEach(c => {
        c.setAttribute('aria-pressed', c.dataset.shelfFilter === prefs.filter ? 'true' : 'false');
      });
      renderShelfSections();
    });
  });
}

function renderShelfSections(): void {
  const mount = _shelfSectionsMount();
  if (!mount) return;
  // Beans are a shared consumable, not scoped to the active machine — always
  // render the full library regardless of S.activeMachineId. This reverts
  // the display-filtering part of #334; see #339 for why that filter was
  // wrong (it hid nearly the whole library once a second machine existed).
  const beans = _beanList();
  const prefs = shelfPrefs();
  const queried = beans.filter(b => matchesShelfQuery(b, prefs.query));
  const { inUse, stock, emptyArchive } = classifyBeanShelf(queried);
  // Filter/sort apply to Stock and Empty & archive; In use keeps its order.
  const stockRows = sortShelf(stock.filter(b => matchesShelfFilter(b, prefs.filter)), prefs.sort);
  const archiveRows = sortShelf(emptyArchive.filter(b => matchesShelfFilter(b, prefs.filter)), prefs.sort);

  const expandedCards = (rows: ShelfBean[]): Html =>
    joinHtml(rows.filter(b => _expandedShelfBeans.has(b.id)).map(b => renderBeanCard(b, beans)));

  const inUseHtml: Html = inUse.length
    ? html`<section class="lib-shelf-section">${_shelfHeading('lib_shelf_in_use')}${joinHtml(inUse.map(b => renderBeanCard(b, beans)))}</section>`
    : esc('');

  const stockHtml: Html = stockRows.length
    ? html`<section class="lib-shelf-section">${_shelfHeading('lib_shelf_stock', stockRows.length)}
        ${stockRows.length >= 10 ? html`<div class="lib-shelf-full-note">${tHtml('lib_shelf_full')}</div>` : esc('')}
        <div class="lib-shelf">${joinHtml(stockRows.map(b => renderShelfTile(b, { muted: false, expanded: _expandedShelfBeans.has(b.id) })))}</div>
        ${expandedCards(stockRows)}</section>`
    : esc('');

  const archiveHtml: Html = archiveRows.length
    ? html`<details class="lib-shelf-archive"${esc(_shelfArchiveOpen ? ' open' : '')}>
        <summary class="lib-shelf-heading lib-shelf-archive-summary"><span>${tHtml('lib_shelf_archive')}</span><span class="lib-shelf-count">${esc(archiveRows.length)}</span></summary>
        <div class="lib-shelf">${joinHtml(archiveRows.map(b => renderShelfTile(b, { muted: true, expanded: _expandedShelfBeans.has(b.id) })))}</div>
        ${expandedCards(archiveRows)}</details>`
    : esc('');

  const filtersActive = prefs.query.trim() !== '' || prefs.filter !== 'all';
  const noMatchHtml: Html = filtersActive && !inUse.length && !stockRows.length && !archiveRows.length
    ? html`<div class="lib-shelf-no-match">${tHtml('lib_shelf_no_match')}</div>`
    : esc('');

  // codeql[js/xss-through-dom] false positive: esc()/escapeHtml() already applied, see #760
  mount.innerHTML = html`${inUseHtml}${noMatchHtml}${stockHtml}${archiveHtml}`;

  // Remember the archive section's open state; the <details> is recreated on
  // every render, so the native toggle event is re-wired here each time. The
  // typeof guard keeps the lightweight fake DOMs the tests install working
  // (they give the element innerHTML but no querySelector).
  const archive = typeof mount.querySelector === 'function'
    ? mount.querySelector<HTMLDetailsElement>('.lib-shelf-archive')
    : null;
  if (archive) archive.ontoggle = () => { _shelfArchiveOpen = archive.open; };

  loadBeanThumbnails();
}

export function toggleShelfBean(beanId: number): void {
  if (_expandedShelfBeans.has(beanId)) _expandedShelfBeans.delete(beanId);
  else _expandedShelfBeans.add(beanId);
  renderBeanList();
}

export function renderBeanList(): void {
  const el = document.getElementById('beanListUI');
  if (!el) return;
  const beans = _beanList();
  if (!beans.length) {
    el.innerHTML = html`<div class="lib-empty">${tHtml('lib_empty_beans')}</div>`;
    return;
  }
  // #1329: three shelves — what you are drinking on top as full cards, the
  // rest of the stock as a photo grid, and spent/archived beans tidied into a
  // collapsed section. A tile tap expands the unchanged full card below it.
  // The toolbar rebuilds with the view; the shelves it filters live in their
  // own container so typing can re-render them without losing the caret.
  el.innerHTML = html`${renderShelfToolbar(shelfPrefs())}<div id="libShelfSections"></div>`;
  wireShelfToolbar();
  renderShelfSections();
}

// Bean images need the auth token, so <img src> can't point at the API
// directly (see bean-image.js) — set the blob-url src async after render.
// #440: click opens the same fullscreen lightbox already used for shot
// photos (sidebar.js) — stopPropagation mirrors that pattern in case a
// parent click handler is ever added to .lib-item.
function loadBeanThumbnails() {
  document.querySelectorAll<HTMLImageElement>('.lib-bean-thumb[data-bean-id], .lib-shelf-img[data-bean-id]').forEach(img => {
    const id = Number(img.dataset.beanId);
    void loadBeanImageBlobUrl(id).then(url => {
      if (!url) return;
      img.src = url;
      // A shelf tile's tap expands the bean, so only the list thumbnail opens
      // the lightbox (#1329).
      if (img.classList.contains('lib-bean-thumb')) {
        img.onclick = e => { e.stopPropagation(); openLightbox(img.src); };
      }
    });
  });
}

export function openNewBagForm(id: number): void {
  _el(`newBagForm${id}`).style.display = '';
}

export function closeNewBagForm(id: number): void {
  _el(`newBagForm${id}`).style.display = 'none';
}

export async function deleteBag(beanId: number, bagId: number): Promise<void> {
  const bean = _beanList().find(b => b.id === beanId);
  const bags = Array.isArray(bean?.bags) ? bean?.bags : [];
  if (!bean || bags.length <= 1) return;
  const { current } = classifyBeanBags(bean);
  if (current?.bg.id === bagId) return;
  if (!confirm(t('lib_bag_delete_confirm'))) return;
  const saved = await libraryApi.deleteBeanBag(beanId, bagId);
  if (!saved) return;
  const idx = _beanList().findIndex(b => b.id === beanId);
  if (idx !== -1) _beanList()[idx] = saved;
  renderBeanList();
}

export async function saveNewBag(id: number): Promise<void> {
  const roastDate   = _field(`newBagRoastDate${id}`)?.value.trim() || '';
  const stock_g     = parseFloat(_field(`newBagStock${id}`)?.value) || null;
  const batchNumber = _field(`newBagBatchNumber${id}`)?.value.trim() || '';
  const saved = await libraryApi.addBeanBag(id, { roastDate, stock_g, batchNumber });
  if (!saved) return;
  const idx = _beanList().findIndex(b => b.id === id);
  if (idx !== -1) _beanList()[idx] = saved;
  renderBeanList();
}

// Clicking a bean's name in the Library sets the sidebar's structured bean
// filter (state.js S.beanFilter / sidebar.js setBeanFilter()) and jumps to
// the Shots tab so the filtered history is immediately visible.
export function filterShotsByBean(id: number): void {
  const bean = _beanList().find(b => b.id === id);
  if (!bean) return;
  setBeanFilter(bean.id, bean.name);
  switchMode('shots');
}

export function openFreezeForm(id: number): void {
  _el(`freezeForm${id}`).style.display = '';
}

export function closeFreezeForm(id: number): void {
  _el(`freezeForm${id}`).style.display = 'none';
}

// Freezes a portion of the active bag: grams move into a dated frozen pool
// (see bag.frozenPortions in the schema) but stay counted in stock_g — the
// freeze doesn't consume anything, it just pauses that portion's own
// freshness clock (frozenPortionAgeDays(), utils.js, #477 — the bag's own
// badge is never affected by this) until it's thawed.
// frozenAt (#472) comes from the form's date picker (defaults to today, but
// editable for logging a portion frozen in the past) rather than always
// being "now".
export async function saveFreezePortions(id: number): Promise<void> {
  const portionCount    = parseInt(_field(`freezePortionCount${id}`)?.value, 10);
  const portionWeight_g = parseFloat(_field(`freezePortionWeight${id}`)?.value);
  const frozenAt = isoDateInputToMs(_field(`freezeDate${id}`)?.value) ?? Date.now();
  if (!(portionCount > 0) || !(portionWeight_g > 0)) return;
  const saved = await libraryApi.freezeBeanPortions(id, { portionCount, portionWeight_g, frozenAt });
  if (!saved) return;
  const idx = _beanList().findIndex(b => b.id === id);
  if (idx !== -1) _beanList()[idx] = saved;
  renderBeanList();
}

// Thaws one portion (#472) from a frozen-portion batch's remaining count —
// e.g. pulling a single 18.5g vacuum-sealed portion out before a shot,
// leaving the rest still frozen. The batch only stamps thawedAt (and its
// badge switches to the closed-out "thawed" style) once remainingCount
// reaches 0 server-side.
export async function thawPortion(beanId: number, portionId: number): Promise<void> {
  const saved = await libraryApi.thawBeanPortion(beanId, { portionId, count: 1 });
  if (!saved) return;
  const idx = _beanList().findIndex(b => b.id === beanId);
  if (idx !== -1) _beanList()[idx] = saved;
  renderBeanList();
}

export function openEditFrozenForm(portionId: number): void {
  const el = document.getElementById(`editFrozenForm${portionId}`);
  if (el) el.style.display = '';
}

export function closeEditFrozenForm(portionId: number): void {
  const el = document.getElementById(`editFrozenForm${portionId}`);
  if (el) el.style.display = 'none';
}

// Corrects a frozen-portion entry after the fact (#472) — wrong count,
// weight, or freeze date entered when it was first frozen. Raising
// remainingCount back above 0 on an already-thawed batch re-opens it
// (server clears thawedAt); this is the only place that can happen from.
export async function saveEditFrozenForm(beanId: number, portionId: number): Promise<void> {
  const remainingCount  = parseInt(_field(`editFrozenRemaining${portionId}`)?.value, 10);
  const portionWeight_g = parseFloat(_field(`editFrozenWeight${portionId}`)?.value);
  const frozenAt = isoDateInputToMs(_field(`editFrozenDate${portionId}`)?.value);
  const body: Record<string, number> = {};
  if (Number.isFinite(remainingCount)) body.remainingCount = remainingCount;
  if (portionWeight_g > 0) body.portionWeight_g = portionWeight_g;
  if (frozenAt != null) body.frozenAt = frozenAt;
  const saved = await libraryApi.adjustFrozenPortion(beanId, { portionId, ...body });
  if (!saved) return;
  const idx = _beanList().findIndex(b => b.id === beanId);
  if (idx !== -1) _beanList()[idx] = saved;
  renderBeanList();
}

export function toggleBeanQR(id: number): void {
  const wrap = _el(`beanQR${id}`);
  if (!wrap) return;
  if (wrap.style.display !== 'none') { wrap.style.display = 'none'; return; }
  const bean = _beanList().find(b => b.id === id);
  if (!bean) return;
  wrap.style.display = 'flex';
  const canvas = _el(`beanQRCanvas${id}`) as HTMLCanvasElement;
  const label = wrap.querySelector('.bean-qr-label');
  // qrcode is a dynamic import now (#797) — the label doubles as a loading
  // indicator while its chunk downloads, restored once the canvas is drawn
  // (or the attempt fails).
  if (label) label.textContent = t('bean_qr_loading');
  // toCanvas() with no callback returns a Promise — without this .catch(),
  // a rejection (e.g. QR data-capacity exceeded by a long notes field) was
  // an unhandled rejection: the canvas stayed silently blank, no error ever
  // reached the user.
  // @ts-expect-error -- qrcode ships no type declarations
  const qrModule = import('qrcode') as Promise<{ default: QrCodeModule }>;
  qrModule.then(({ default: QRCode }) =>
    // #814: this was drawn INVERTED — dark: '#e4e4e7' on light: '#18181b' means
    // light modules on a dark ground, to match the dark theme. The QR spec
    // assumes dark-on-light, and while many scanners cope with inversion,
    // plenty of older and simpler ones do not: a code that fails to scan on
    // someone's phone is a functional defect, not a theming preference.
    // Fixed polarity in both themes, deliberately NOT theme-aware.
    QRCode.toCanvas(canvas, generateBeanQR(bean), { width: 140, margin: 2, errorCorrectionLevel: 'L', color: { dark: '#000000', light: '#ffffff' } })
  ).then(() => {
    if (label) label.textContent = t('bean_qr_label');
  }).catch(() => {
    wrap.style.display = 'none';
    if (label) label.textContent = t('bean_qr_label');
    alert(t('bean_qr_error'));
  });
}

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

function commitFlavorInput(): void {
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

function bindFlavorInput(): void {
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

function populateOriginSelect(): void {
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

function bindOriginInput(): void {
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

function populateSuggestionDatalists(): void {
  attachAutocomplete(_field('beanFormVariety'), () => VARIETY_SUGGESTIONS);
  attachAutocomplete(_field('beanFormProcess'), () => PROCESS_SUGGESTIONS);
}

export function openBeanForm(bean?: BeanRow | null): void {
  S.beanEditId = bean ? bean.id : null;
  const importNotice = document.getElementById('beanFormImportNotice');
  if (importNotice) { importNotice.style.display = 'none'; importNotice.innerHTML = html``; }
  const dupWarning = document.getElementById('beanFormDuplicateWarning');
  if (dupWarning) { dupWarning.style.display = 'none'; dupWarning.innerHTML = html``; }
  const extraRecipes = document.getElementById('beanFormExtraRecipes');
  if (extraRecipes) { extraRecipes.style.display = 'none'; extraRecipes.innerHTML = html``; }
  _state()._urlImportExtraRecipes = null;
  _field('beanFormName').value      = bean?.name      || '';
  _field('beanFormRoaster').value   = bean?.roaster   || '';
  _field('beanFormRoastDate').value = toIsoDateInput(bean?.roastDate);
  _field('beanFormNotes').value     = bean?.notes     || '';
  // Stock and batch number are bag-only now (see classifyBeanBags/
  // renderBagCard's own "Bestand anpassen"/bag-dialog fields) — neither
  // field exists on the bean form at all.
  const activeEditBag = bean ? classifyBeanBags(bean).current?.bg : null;
  _field('beanFormDecaf').checked   = !!bean?.decaf;
  populateOriginSelect();
  bindOriginInput();
  setFormOrigins(bean);
  populateSuggestionDatalists();
  _field('beanFormVariety').value   = bean?.variety || '';
  _field('beanFormSpecies').value   = bean?.species || '';
  _field('beanFormCategory').value  = bean?.category || 'normal';
  _field('beanFormProcess').value   = bean?.process || '';
  bindFlavorInput();
  setFormFlavors(bean?.flavors);
  _field('beanFormFlavorInput').value = '';
  _field('beanFormRoastType').value = bean?.roastType || '';
  _field('beanFormRegion').value    = bean?.region || '';
  _field('beanFormAltitude').value      = String(bean?.altitude_m ?? '');
  _field('beanFormImporter').value      = bean?.importer || '';
  _field('beanFormHarvest').value       = bean?.harvest || '';
  _field('beanFormPrice').value = String(activeEditBag?.price_eur ?? bean?.price_eur ?? '');
  _field('beanFormProducer').value      = bean?.producer || '';
  _field('beanFormCertification').value = bean?.certification || '';
  _field('beanFormBrewTemp').value  = String(bean?.brewTempC ?? '');
  _field('beanFormBrewRatio').value = bean?.brewRatio || '';
  _field('beanFormBrewTime').value  = String(bean?.brewTimeS ?? '');
  _field('beanFormBrewNotes').value = bean?.brewNotes || '';
  // #1329 part 2: the photo picker is offered when creating too — the chosen
  // (cropped) blob is staged and uploaded right after the bean is saved.
  _el('beanFormImageField').style.display = '';
  const stagedHint = document.getElementById('beanFormImageStaged');
  if (stagedHint) stagedHint.style.display = 'none';
  // Edit mode keeps a single Speichern; creating a new bean instead offers
  // "Speichern und Packung hinzufügen" / "Speichern ohne Packung" — there's
  // nothing to combine-with-a-bag-dialog once the bean already exists.
  // Reads S.beanEditId (set above), not the raw `bean` param — the
  // "+ Bohne hinzufügen" trigger button is wired directly as a click
  // listener, so `bean` there is the MouseEvent, not undefined/null.
  const isEdit = S.beanEditId != null;
  const saveBtn       = document.getElementById('saveBeanBtn');
  const saveNoBagBtn  = document.getElementById('saveBeanNoBagBtn');
  const saveAddBagBtn = document.getElementById('saveBeanAddBagBtn');
  if (saveBtn)       saveBtn.style.display       = isEdit ? '' : 'none';
  if (saveNoBagBtn)  saveNoBagBtn.style.display  = isEdit ? 'none' : '';
  if (saveAddBagBtn) saveAddBagBtn.style.display = isEdit ? 'none' : '';
  _el('beanAddForm').classList.add('open');
  _el('beanAddTrigger').style.display = 'none';
  _field('beanFormName').focus();
}

export function closeBeanForm(): void {
  S.beanEditId        = null;
  S._urlImportSource   = null;
  S._urlImportedAt     = null;
  _state()._urlImportImageUrl = null;
  S._urlImportSourceUrl = null;
  _state()._urlImportExtraRecipes = null;
  _stagedBeanImageBlob = null;
  const stagedHint = document.getElementById('beanFormImageStaged');
  if (stagedHint) stagedHint.style.display = 'none';
  const extraEl = document.getElementById('beanFormExtraRecipes');
  if (extraEl) { extraEl.style.display = 'none'; extraEl.innerHTML = html``; }
  _el('beanAddForm').classList.remove('open');
  _el('beanAddTrigger').style.display = '';
}

export function editBean(id: number): void {
  const bean = _beanList().find(b => b.id === id);
  if (bean) openBeanForm(bean);
}

export async function saveBean(): Promise<void> { return saveBeanInternal(false); }
// Create-only entry points (see openBeanForm's mode-conditional buttons) —
// both save the bean identically, they only differ in what happens right
// after: opening the existing new-bag dialog, or not.
export async function saveBeanNoBag(): Promise<void> { return saveBeanInternal(false); }
export async function saveBeanAddBag(): Promise<void> { return saveBeanInternal(true); }

async function saveBeanInternal(openBagDialogAfter: boolean): Promise<void> {
  const name      = _field('beanFormName').value.trim();
  const roaster   = _field('beanFormRoaster').value.trim();
  const roastDate = _field('beanFormRoastDate').value.trim();
  const notes     = _field('beanFormNotes').value.trim();
  const decaf     = _field('beanFormDecaf').checked;
  const variety   = _field('beanFormVariety').value.trim();
  const species   = _field('beanFormSpecies').value;
  const category  = _field('beanFormCategory').value;
  const process   = _field('beanFormProcess').value.trim();
  const roastType = _field('beanFormRoastType').value;
  const region    = _field('beanFormRegion').value.trim();
  const altitude_m    = _field('beanFormAltitude').value;
  const importer      = _field('beanFormImporter').value.trim();
  const harvest       = _field('beanFormHarvest').value.trim();
  const price_eur     = _field('beanFormPrice').value;
  const producer      = _field('beanFormProducer').value.trim();
  const certification = _field('beanFormCertification').value.trim();
  const brewTempC  = _field('beanFormBrewTemp').value;
  const brewRatio  = _field('beanFormBrewRatio').value.trim();
  const brewTimeS  = _field('beanFormBrewTime').value;
  const brewNotes  = _field('beanFormBrewNotes').value.trim();
  commitFlavorInput(); // take a still-typed flavor along
  if (!name) { _field('beanFormName').focus(); return; }
  const payload: Record<string, unknown> = {
    name, roaster, roastDate, notes, decaf, origins: _formOrigins, variety, species, category, process, flavors: _formFlavors, roastType, region,
    altitude_m, importer, harvest, price_eur, producer, certification,
    brewTempC, brewRatio, brewTimeS, brewNotes,
  };
  if (!S.beanEditId && S._urlImportSource) {
    payload.source     = S._urlImportSource;
    payload.importedAt = S._urlImportedAt;
    // A photo the user staged for this create wins over the import's image URL.
    if (_state()._urlImportImageUrl && !_stagedBeanImageBlob) payload.imageUrl = _state()._urlImportImageUrl;
    if (S._urlImportSourceUrl) payload.sourceUrl = S._urlImportSourceUrl;
  }
  // #451: capture which opt-in Brew Guide recipe candidates are still
  // checked before closeBeanForm() clears both the DOM and this state.
  const extraRecipesToImport = (_state()._urlImportExtraRecipes || []).filter((_, i) =>
    document.querySelector<HTMLInputElement>(`[data-extra-recipe-idx="${i}"]`)?.checked);
  const saved = await libraryApi.saveBean(S.beanEditId, payload);
  if (!saved) return;
  if (S.beanEditId) {
    const idx = _beanList().findIndex(b => b.id === S.beanEditId);
    if (idx !== -1) _beanList()[idx] = saved;
  } else {
    _beanList().push(saved);
  }
  const wasCreate = !S.beanEditId;
  // #1329 part 2: upload a photo staged while creating, now that the bean has
  // an id. A failed upload must not lose the bean — it stays in the list and
  // the user gets the same generic error an edit-mode upload shows.
  if (wasCreate && _stagedBeanImageBlob) {
    const staged = _stagedBeanImageBlob;
    _stagedBeanImageBlob = null;
    const uploaded = await libraryApi.uploadBeanImage(saved.id, staged);
    if (uploaded.ok) {
      const withImage = (await uploaded.json()) as BeanListRow;
      const imgIdx = _beanList().findIndex(b => b.id === saved.id);
      if (imgIdx !== -1) _beanList()[imgIdx] = withImage;
      invalidateBeanImage(saved.id);
    } else {
      const err = (await uploaded.json().catch(() => ({}))) as { error?: string };
      alert(t('error_generic', err.error || uploaded.statusText));
    }
  }
  for (const recipe of extraRecipesToImport) {
    const importedRecipe = await libraryApi.saveRecipe(null, { ...recipe, brewMethod: 'espresso', beanName: saved.name });
    if (importedRecipe) {
      const lib = _state().coffeeLibrary;
      if (!lib.recipes) lib.recipes = [];
      lib.recipes.push(importedRecipe);
    }
  }
  // Also persist price_eur to the current bag so per-bag price stays in sync
  if (S.beanEditId && price_eur) {
    const activeBagForSave = classifyBeanBags(saved).current?.bg || null;
    if (activeBagForSave) {
      const savedWithBag = await libraryApi.updateBeanBag(S.beanEditId, activeBagForSave.id as number, {
        roastDate: activeBagForSave.roastDate || '', stock_g: activeBagForSave.stock_g ?? null,
        batchNumber: activeBagForSave.batchNumber || '', price_eur: parseFloat(price_eur) || null,
      });
      if (savedWithBag) {
        const idx2 = _beanList().findIndex(b => b.id === S.beanEditId);
        if (idx2 !== -1) _beanList()[idx2] = savedWithBag;
      }
    }
  }
  updateLibraryDatalist();
  closeBeanForm();
  renderBeanList();
  if (extraRecipesToImport.length) renderRecipeList();
  // openNewBagForm toggles the new bean's own card's inline
  // #newBagForm<id> (renderBeanList above must run first so that card
  // exists) — NOT openNewBagDialog, a modal-overlay entry point left over
  // from an earlier design that has no matching HTML in index.html at all
  // (dead code: calling it was a silent no-op, the actual bug report).
  if (wasCreate && openBagDialogAfter) openNewBagForm(saved.id);
}

export async function deleteBean(id: number): Promise<void> {
  if (!confirm(t('lib_confirm_delete_bean'))) return;
  const r = await libraryApi.deleteBeanPermanently(id);
  if (!r.ok) return;
  S.coffeeLibrary.beans = S.coffeeLibrary.beans.filter(b => b.id !== id);
  updateLibraryDatalist();
  renderBeanList();
}

// Manual override for the order card's bean picker — independent of stock.
// The bean stays fully visible/editable in the library either way; only its
// presence in /api/orders/active-beans changes.
export async function toggleBeanActive(id: number): Promise<void> {
  if (_pendingBeanActiveToggles.has(id)) return;
  _pendingBeanActiveToggles.add(id);
  renderBeanList();
  try {
    const saved = await libraryApi.toggleBeanActive(id);
    if (!saved) return;
    const idx = _beanList().findIndex(b => b.id === id);
    if (idx !== -1) _beanList()[idx] = saved;
  } finally {
    _pendingBeanActiveToggles.delete(id);
    renderBeanList();
  }
}

// Photo chosen while *creating* a bean: the crop result can't be uploaded yet
// (no id), so it waits here until saveBeanInternal has created the bean.
let _stagedBeanImageBlob: Blob | null = null;

export async function stageNewBeanImage(input: HTMLInputElement): Promise<void> {
  const file = input.files?.[0];
  if (!file) return;
  const blob = await openImageCropEditor(file, { shape: 'square' });
  // eslint-disable-next-line require-atomic-updates -- `input` is a per-call function parameter (the DOM element passed in), not shared state
  input.value = '';
  if (!blob) return;
  _stagedBeanImageBlob = blob;
  const hint = document.getElementById('beanFormImageStaged');
  if (hint) hint.style.display = '';
}

export async function uploadBeanImage(id: number, input: HTMLInputElement): Promise<void> {
  const file = input.files?.[0];
  if (!file) return;
  const blob = await openImageCropEditor(file, { shape: 'square' });
  // eslint-disable-next-line require-atomic-updates -- `input` is a per-call function parameter (the DOM element passed in), not shared state
  input.value = '';
  if (!blob) return;
  const r = await libraryApi.uploadBeanImage(id, blob);
  if (!r.ok) {
    const err = (await r.json().catch(() => ({}))) as { error?: string };
    alert(t('error_generic', err.error || r.statusText));
    return;
  }
  const saved = (await r.json()) as BeanListRow;
  const idx = _beanList().findIndex(b => b.id === id);
  if (idx !== -1) _beanList()[idx] = saved;
  invalidateBeanImage(id);
  renderBeanList();
}

// Section symbols moved to ./library/* — re-exported so existing importers
// of views/library.js (main.ts et al.) keep working.
export {
  renderRecipeList, addRecipeStep, removeRecipeStep, openRecipeForm, closeRecipeForm,
  editRecipe, saveRecipe, deleteRecipe,
} from './library/recipes.js';
export { renderMilkList, openMilkForm, closeMilkForm, saveMilk, restockMilk, deleteMilk } from './library/milk.js';
export { renderBasketList, openBasketForm, closeBasketForm, editBasket, saveBasket, uploadBasketImage, deleteBasket } from './library/baskets.js';
export { renderPuckScreenList, openPuckScreenForm, closePuckScreenForm, editPuckScreen, savePuckScreen, uploadPuckScreenImage, deletePuckScreen } from './library/puck-screens.js';
export {
  renderGrinderList, openGrinderForm, closeGrinderForm, editGrinder, deleteGrinderZeroPointEntry,
  saveGrinder, resetGrinderBurrs, uploadGrinderImage, deleteGrinder,
} from './library/grinders.js';
export {
  toggleUrlImport, importFromUrl, toggleImportSettings, addCustomShopifyDomain,
  openScanModal, closeScanModal, _runScanLoop, _handleScanResult,
} from './library/import.js';
export {
  toggleBagCard, openBagStockEdit, closeBagStockEdit, openEditBag, closeEditBag,
  saveEditBag, saveBagStock, markBagEmpty, togglePastBags, reorderBags,
} from './library/bags.js';
