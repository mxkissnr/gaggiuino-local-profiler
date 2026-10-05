import { t, tHtml } from '../../i18n.js';
import * as libraryApi from '../../api/library.js';
import { S } from '../../state/index.js';
import type { ShotMeta } from '../../state/index.js';
import { localeFor, countryName } from '../../constants.js';
import { esc, roastAgeDays, frozenPortionAgeDays, freshnessState, calcBeanRating, shouldShowFreshBadge, isoDateInputToMs, toIsoDateInput, todayIsoDate, html, joinHtml } from '../../utils.js';
import type { Html } from '../../utils.js';
import { generateBeanQR } from '../../glp-qr.js';
import { miniWheelSvg, flavorChipsHtml } from '../../components/flavor-mini-wheel.js';
import { calcBestGrindCombosForBean } from '../shots/grind.js';
import { COFFEE_ICON_SVG, SNOWFLAKE_ICON_SVG, STAR_ICON_SVG, EDIT_ICON_SVG } from '../../icons.js';
import { classifyBeanBags, renderBagCard, _expandedPastSections } from './bags.js';
import { _beanList, _field, _el } from './bean-shared.js';
import type { BeanListRow, OriginBean } from './bean-shared.js';
import * as libraryView from '../library.js';

// Circular with library.ts (it re-exports this module): only ever touched at
// call time, never read at module load.
const library = libraryView;

// qrcode ships no type declarations; name the one call this view makes.
interface QrCodeModule {
  toCanvas(canvas: HTMLCanvasElement, text: string, options: {
    width: number; margin: number; errorCorrectionLevel: string;
    color: { dark: string; light: string };
  }): Promise<unknown>;
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

// Bean origin display — beans predating the blend feature (or ones without an
// origins[] array yet) fall back to the legacy singular `origin` field.
export function originDisplay(bean: OriginBean): string {
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

// The bag's real calendar age badge, shown in the detail sheet's head.
export function beanFreshBadge(b: BeanListRow): Html {
  const { current } = classifyBeanBags(b);
  const activeBag = current?.bg || null;
  const roastAge = roastAgeDays(activeBag?.roastDate || b.roastDate);
  const remaining = b.remainingG ?? null;
  return (roastAge != null && shouldShowFreshBadge(b.stock_g, remaining))
    ? html` <span class="lib-fresh-badge fresh-${esc(freshnessState(roastAge))}" title="${esc(t('freshness_title', roastAge))}">${esc(roastAge)}d</span>`
    : esc('');
}

// #1408: safeHttpUrl returns u only when it parses as an absolute http(s)
// URL, so a stored javascript:/data: value renders as plain text, never as a
// clickable link.
export function safeHttpUrl(u: string | null | undefined): string | null {
  if (!u) return null;
  try {
    const parsed = new URL(u);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return u;
  } catch { /* not a URL */ }
  return null;
}

export function renderBeanCard(b: BeanListRow, beans: BeanListRow[]): Html {
  const bags = Array.isArray(b.bags) ? b.bags : [];
  // consumedG/remainingG (bean-level totals) and every bag's own
  // consumedG/remainingG/current are computed server-side (see
  // decorateBeanStatus, go/internal/library/handlers.go's getLibrary) and
  // attached to every bean/bag on load — no client-side dose replay.
  const totalConsumed = Math.round(b.consumedG ?? 0);
  const remaining = b.remainingG ?? null;
  const { current, upcoming, past } = classifyBeanBags(b);
  const activeBag = current?.bg || null;
  const sourceHref = safeHttpUrl(b.sourceUrl);

  // Stock %/bar is scoped to the CURRENT bag only (how far through the
  // bag actually being drawn from) — the headline g-numbers above stay
  // bean-wide totals (sum across all bags).
  let invHtml: Html = html``;
  if (remaining != null || totalConsumed > 0) {
    const isLow = remaining != null && remaining < 100;
    const rem = Math.max(0, remaining ?? 0);
    // #1373/#1408: a bean imported from a shop page links its "reorder" badge
    // back there. safeHttpUrl restricts to http(s) so a stored javascript:/
    // data: value can never become a clickable link.
    const reorderUrl: string | null = isLow ? sourceHref : null;
    const stockPct = current && current.stockG != null && current.stockG > 0
      ? Math.max(0, Math.min(100, Math.round(((current.remaining ?? 0) / current.stockG) * 100)))
      : 0;
    invHtml = html`<div class="lib-inv-block">
      ${remaining != null ? html`<div class="lib-inv-bar-row">
        <div class="lib-stock-bar-md" title="${esc(stockPct)}%"><div class="lib-stock-bar-fill-md${esc(isLow ? ' low' : '')}" style="width:${esc(stockPct)}%"></div></div>
        <span class="lib-inv-pct${esc(isLow ? ' low' : '')}">${esc(stockPct)}%</span>
      </div>` : esc('')}
      <div class="lib-inv-nums">
        ${remaining != null ? html`<span class="lib-inv-remaining${esc(isLow ? ' low' : '')}">${tHtml('lib_inv_remaining', rem)}</span><span class="lib-inv-sep">·</span>` : esc('')}
        <span class="lib-inv-consumed">${tHtml('lib_inv_consumed', totalConsumed)}</span>
        ${bags.length > 1 ? html`<span class="lib-inv-sep">·</span><span class="lib-inv-total">${tHtml('lib_inv_bags', bags.length)}</span>` : esc('')}
        ${isLow ? (reorderUrl
          ? html`<a class="lib-inv-reorder" href="${esc(reorderUrl)}" target="_blank" rel="noopener noreferrer">${tHtml('lib_inv_reorder')}</a>`
          : html`<span class="lib-inv-reorder">${tHtml('lib_inv_reorder')}</span>`) : esc('')}
      </div>
    </div>`;
  }

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

  // #1350: the flavours render as an "Aromas" block — the inline mini wheel
  // plus chips that highlight their segment.
  const flavorBlockHtml: Html = (() => {
    const flavors = b.flavors;
    if (!Array.isArray(flavors) || flavors.length === 0) return esc('');
    return html`<div class="lib-sheet-aromas">
      <div class="lib-sheet-aromas-title">${tHtml('lib_sheet_aromas')}</div>
      <div class="lib-sheet-aromas-body">
        <button type="button" class="lib-aroma-wheel" data-action="open-flavor-wheel" data-id="${esc(b.id)}" aria-label="${tHtml('flavor_wheel_btn')}">${miniWheelSvg(flavors, 168)}</button>
        <div class="lib-aroma-chips">${flavorChipsHtml(flavors)}</div>
      </div>
    </div>`;
  })();

  return html`<div class="lib-item${esc(disabled ? ' lib-item-disabled' : '')} lib-item-in-sheet">
    <div class="lib-item-info">
      <div class="lib-item-sub">${joinHtml([
        b.region, b.species, b.variety, b.process, b.roaster, b.roastDate, b.notes,
      ].filter(Boolean).map((p, i) => i ? html` · ${esc(p)}` : esc(p)))}</div>
      ${extraHtml}
      ${brewHtml}
      ${ratingHtml}
      ${bestComboHtml}
      ${lastGrindHtml}
      ${flavorBlockHtml}
      ${invHtml}
      ${frozenHtml}
      ${bagHistoryHtml}
      ${b.source ? html`<div class="lib-item-source">${tHtml('lib_imported_from',
        sourceHref ? html`<a href="${esc(sourceHref)}" target="_blank" rel="noopener">${esc(b.source)}</a>` : esc(b.source),
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

export function openNewBagForm(id: number): void {
  const form = document.getElementById(`newBagForm${id}`);
  if (form) form.style.display = '';
}

export function closeNewBagForm(id: number): void {
  const form = document.getElementById(`newBagForm${id}`);
  if (form) form.style.display = 'none';
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
  library.renderBeanList();
}

export async function saveNewBag(id: number): Promise<void> {
  const roastDate   = _field(`newBagRoastDate${id}`)?.value.trim() || '';
  const stock_g     = parseFloat(_field(`newBagStock${id}`)?.value) || null;
  const batchNumber = _field(`newBagBatchNumber${id}`)?.value.trim() || '';
  const saved = await libraryApi.addBeanBag(id, { roastDate, stock_g, batchNumber });
  if (!saved) return;
  const idx = _beanList().findIndex(b => b.id === id);
  if (idx !== -1) _beanList()[idx] = saved;
  library.renderBeanList();
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
  library.renderBeanList();
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
  library.renderBeanList();
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
  library.renderBeanList();
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

