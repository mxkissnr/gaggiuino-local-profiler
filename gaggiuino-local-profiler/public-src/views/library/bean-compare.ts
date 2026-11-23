// Compare two beans side by side (#2119): a full view inside the library,
// opened from a bean sheet's overflow menu after picking the second bean.
// The numbers come from the pure stats module next to this one; this module
// renders them and remembers which two beans are shown. While the page is
// open the library view carries data-compare, and the stylesheet hides the
// library's tabs and lists behind it. Back returns to the shelf with the
// starting bean's sheet open again.
import { S } from '../../state/index.js';
import { t, tHtml } from '../../i18n.js';
import { esc, html, joinHtml, normalizeRoastLevel, scoreClass } from '../../utils.js';
import type { Html } from '../../utils.js';
import { openDetailSheet, closeDetailSheet } from '../../components/detail-sheet.js';
import { miniWheelSvg } from '../../components/flavor-mini-wheel.js';
import { TASTE_TAG_LABELS } from '../shots/grind.js';
import { shelfBagImage } from './shelf.js';
import { originDisplay } from './bean-card.js';
import { openBeanSheet } from './bean-sheet.js';
import { _beanList } from './bean-shared.js';
import type { BeanListRow } from './bean-shared.js';
import {
  aromaKey, betterSide, computeBeanComparison, freshnessRank, FRESHNESS_TEXT_KEYS, MIN_VERDICT_SHOTS,
} from './bean-compare-stats.js';
import type { BeanCompareStats, BeanComparison, Side, VerdictReason } from './bean-compare-stats.js';
import * as libraryView from '../library.js';

// Circular with library.ts (it imports this module): the namespace is read
// only at call time, never copied at module load.

// Two columns side by side: the overflow menu entry.
const ICON_COMPARE = `<svg class="rail-icon sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h6v14H4zM14 5h6v14h-6z"/></svg>` as Html;
// Two opposite arrows: the bar's swap action.
const ICON_SWAP = `<svg class="rail-icon sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7h12M15 3l4 4-4 4M17 17H5M9 13l-4 4 4 4"/></svg>` as Html;
// The back chevron of the settings sub-pages.
const ICON_BACK = `<svg class="rail-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>` as Html;

const DASH = '–';

const REASON_KEYS: Record<VerdictReason, string> = {
  'dialin-same-grinder': 'bean_cmp_reason_dialin_same_grinder',
  dialin: 'bean_cmp_reason_dialin',
  best: 'bean_cmp_reason_best',
  rating: 'bean_cmp_reason_rating',
  score: 'bean_cmp_reason_score',
};

// The two beans on the page (a left, b right) and the bean the comparison was
// started from, which Back reopens. Null while the page is closed.
let _pair: { a: number; b: number; from: number } | null = null;
// The left bean while the picker chooses the right one.
let _pickFor: number | null = null;

// The bean sheet's overflow entry; nothing while the library holds no second bean.
export function beanCompareMenuItem(id: number): Html {
  if (_beanList().length < 2) return html``;
  return html`<button type="button" class="lib-sheet-menu-item" data-action="compare-bean" data-id="${esc(id)}">${ICON_COMPARE} ${tHtml('bean_cmp_menu')}</button>`;
}

function _pickerRow(b: BeanListRow): Html {
  return html`<button type="button" class="settings-row" data-action="compare-pick-bean" data-id="${esc(b.id)}">
    <span class="lib-compare-pick-photo">${shelfBagImage(b)}</span>
    <span class="settings-row-text"><span class="settings-row-title">${esc(b.name)}</span>${b.roaster ? html`<span class="settings-row-sub">${esc(b.roaster)}</span>` : esc('')}</span>
  </button>`;
}

// The bean picker in the shared detail sheet: every library bean not already
// on the page, the ones in use before the archived ones, each group by name.
function _openPicker(exclude: number[]): void {
  const beans = _beanList()
    .filter(b => !exclude.includes(b.id))
    .sort((x, y) => Number(x.enabled === false) - Number(y.enabled === false) || x.name.localeCompare(y.name));
  openDetailSheet({
    title: t('bean_cmp_pick_title'),
    body: beans.length
      ? html`<div class="settings-group">${joinHtml(beans.map(_pickerRow))}</div>`
      : html`<p class="empty-note">${tHtml('bean_cmp_pick_empty')}</p>`,
    dialog: true,
  });
  libraryView.loadBeanThumbnails();
}

// "Compare" in a bean sheet's menu: pick the bean to compare it with.
export function startBeanCompare(id: number): void {
  closeBeanCompare();
  _pickFor = id;
  _openPicker([id]);
}

// The right bean's sticker: pick another bean for the right side.
export function pickOtherBeanCompare(): void {
  if (!_pair) return;
  _pickFor = _pair.a;
  _openPicker([_pair.a, _pair.b]);
}

// A picker row: show the page (or update it) with that bean on the right.
export function chooseBeanCompare(id: number): void {
  const a = _pickFor;
  _pickFor = null;
  closeDetailSheet();
  if (a === null || a === id) return;
  const enter = _pair === null;
  _pair = { a, b: id, from: _pair?.from ?? a };
  renderBeanCompare(enter);
}

export function swapBeanCompare(): void {
  if (!_pair) return;
  _pair = { a: _pair.b, b: _pair.a, from: _pair.from };
  renderBeanCompare();
}

// Closes the page and returns the bean it was started from.
export function closeBeanCompare(): number | null {
  const from = _pair?.from ?? null;
  _pair = null;
  _pickFor = null;
  const host = document.getElementById('libCompare');
  if (host) {
    host.innerHTML = html``;
    host.hidden = true;
  }
  document.getElementById('library-view')?.removeAttribute('data-compare');
  return from;
}

// The bar's Back: the shelf again, with the starting bean's sheet open.
export function backFromBeanCompare(): void {
  const from = closeBeanCompare();
  if (from !== null) openBeanSheet(from);
}

export function beanCompareOpen(): boolean {
  return _pair !== null;
}

// Every library re-render: redraw an open page, close it when one of its
// beans has left the library.
export function refreshBeanCompare(): void {
  const pair = _pair;
  if (!pair) return;
  const beans = _beanList();
  if (!beans.some(b => b.id === pair.a) || !beans.some(b => b.id === pair.b)) {
    closeBeanCompare();
    return;
  }
  renderBeanCompare();
}

function _fmt(v: number | null, format: (n: number) => string): string {
  return v === null ? DASH : format(v);
}

function _score(v: number | null): Html {
  return v === null ? esc(DASH) : html`<span class="${esc(scoreClass(v))}">${esc(v)}</span>`;
}

function _row(label: string, a: Html, b: Html, better: Side | null): Html {
  const dot = html`<span class="lib-compare-dot" role="img" aria-label="${tHtml('bean_cmp_better')}"></span>`;
  return html`<div class="lib-compare-row">
    <span class="lib-compare-label">${esc(label)}</span>
    <span class="lib-compare-val">${a}${better === 'a' ? dot : esc('')}</span>
    <span class="lib-compare-val">${b}${better === 'b' ? dot : esc('')}</span>
  </div>`;
}

// A bean without shots says so once, in the first row of Results and of
// Dial-in; its other cells there show a dash.
function _cell(s: BeanCompareStats, value: Html, first: boolean): Html {
  if (s.shots > 0) return value;
  return first ? esc(t('bean_cmp_no_shots')) : esc(DASH);
}

function _section(titleKey: string, body: Html, count: string | null): Html {
  return html`<section>
    <div class="section-title"><span>${tHtml(titleKey)}</span>${count !== null ? html`<span class="section-title__count">${esc(count)}</span>` : esc('')}</div>
    ${body}
  </section>`;
}

function _resultsRows({ a, b }: BeanComparison): Html {
  const rating = (s: BeanCompareStats): Html => esc(_fmt(s.rating, n => `${n.toFixed(1)} / 5`));
  const taste = (s: BeanCompareStats): Html => esc(s.taste ? t(TASTE_TAG_LABELS[s.taste]) : DASH);
  return joinHtml([
    _row(t('bean_stat_avg'), _cell(a, _score(a.avgScore), true), _cell(b, _score(b.avgScore), true), betterSide(a.avgScore, b.avgScore, 'higher')),
    _row(t('bean_cmp_best_shot'), _cell(a, _score(a.best), false), _cell(b, _score(b.best), false), betterSide(a.best, b.best, 'higher')),
    _row(t('bean_cmp_rating'), _cell(a, rating(a), false), _cell(b, rating(b), false), betterSide(a.rating, b.rating, 'higher')),
    _row(t('bean_stat_shots'), _cell(a, esc(a.shots), false), _cell(b, esc(b.shots), false), null),
    _row(t('bean_cmp_taste'), _cell(a, taste(a), false), _cell(b, taste(b), false), null),
  ]);
}

function _dialinRows({ a, b, grinder }: BeanComparison): Html {
  // On a shared grinder its name heads the section, so the setting alone is enough.
  const grind = (s: BeanCompareStats): Html => esc(!s.bestGrind ? DASH
    : grinder !== null ? String(s.bestGrind.grindSetting)
      : t('bean_best_combo_value', s.bestGrind.grinder, s.bestGrind.grindSetting));
  const recipe = (s: BeanCompareStats): Html => esc(s.dose === null ? DASH
    : s.yield === null ? `${s.dose.toFixed(1)} g` : `${s.dose.toFixed(1)} g → ${s.yield.toFixed(1)} g`);
  const time = (s: BeanCompareStats): Html => esc(_fmt(s.avgTime, n => `${n} s`));
  const firstGood = (s: BeanCompareStats): Html => esc(_fmt(s.firstGood, n => String(n)));
  return joinHtml([
    _row(t('bean_cmp_best_grind'), _cell(a, grind(a), true), _cell(b, grind(b), true), null),
    _row(t('recipe_dose_yield'), _cell(a, recipe(a), false), _cell(b, recipe(b), false), null),
    _row(t('bean_cmp_shot_time'), _cell(a, time(a), false), _cell(b, time(b), false), null),
    _row(t('bean_cmp_first_good'), _cell(a, firstGood(a), false), _cell(b, firstGood(b), false), betterSide(a.firstGood, b.firstGood, 'lower')),
  ]);
}

function _beanRows({ a, b }: BeanComparison, beanA: BeanListRow, beanB: BeanListRow): Html {
  const age = (s: BeanCompareStats): Html => esc(s.roastAgeDays === null || s.freshness === null
    ? DASH : t(FRESHNESS_TEXT_KEYS[s.freshness], s.roastAgeDays));
  const price = (s: BeanCompareStats): Html => esc(_fmt(s.pricePerShot, n => `${n.toFixed(2)} €`));
  const grams = (s: BeanCompareStats): Html => esc(_fmt(s.gramsLeft, n => `${n} g`));
  return joinHtml([
    _row(t('lib_bean_origin'), esc(originDisplay(beanA) || DASH), esc(originDisplay(beanB) || DASH), null),
    _row(t('bean_cmp_roast_age'), age(a), age(b), betterSide(freshnessRank(a.freshness), freshnessRank(b.freshness), 'lower')),
    _row(t('bean_cmp_price_per_shot'), price(a), price(b), betterSide(a.pricePerShot, b.pricePerShot, 'lower')),
    _row(t('bean_cmp_grams_left'), grams(a), grams(b), null),
  ]);
}

// One bean's mini flavour wheel and its aromas; the ones both beans list are
// highlighted. Static chips: the sheet's highlight buttons need a sheet.
function _aromaSide(bean: BeanListRow, shared: Set<string>): Html {
  const flavors = bean.flavors ?? [];
  if (!flavors.length) return html`<div class="lib-compare-aroma"><p class="empty-note">${tHtml('bean_cmp_no_aromas')}</p></div>`;
  const chips = flavors.map(f => html`<span class="chip--input${esc(shared.has(aromaKey(f)) ? ' is-shared' : '')}">${esc(f)}</span>`);
  return html`<div class="lib-compare-aroma">${miniWheelSvg(flavors, 120)}<div class="lib-compare-aroma-chips">${joinHtml(chips)}</div></div>`;
}

function _beanMeta(b: BeanListRow): string {
  const level = normalizeRoastLevel(b.roastLevel);
  return [b.roaster, b.process, level ? t('roast_level_' + level.replace(/-/g, '_')) : '']
    .filter(Boolean).join(' · ');
}

// The right bean's sticker is the button that picks another bean.
function _headBean(b: BeanListRow, side: Side): Html {
  const sticker = side === 'b'
    ? html`<button type="button" class="lib-compare-sticker" data-action="compare-pick-other" aria-label="${esc(t('bean_cmp_pick_other', b.name))}">${shelfBagImage(b)}</button>`
    : html`<span class="lib-compare-sticker">${shelfBagImage(b)}</span>`;
  const meta = _beanMeta(b);
  return html`<div class="lib-compare-bean">${sticker}<h3 class="serif-display lib-compare-name">${esc(b.name)}</h3>${meta ? html`<div class="lib-compare-meta">${esc(meta)}</div>` : esc('')}</div>`;
}

// Verdict first: one sentence and one big number, the difference in average score.
function _verdict({ verdict }: BeanComparison, beanA: BeanListRow, beanB: BeanListRow): Html {
  const name = (side: Side): string => (side === 'a' ? beanA : beanB).name;
  const sentence = verdict.kind === 'few' ? t('bean_cmp_verdict_few', name(verdict.side), MIN_VERDICT_SHOTS)
    : verdict.kind === 'tie' ? t('bean_cmp_verdict_tie')
      : t('bean_cmp_verdict_winner', name(verdict.winner), t(REASON_KEYS[verdict.reason]));
  const num = verdict.kind === 'winner' ? String(verdict.diff) : verdict.kind === 'tie' ? '0' : DASH;
  return html`<section class="analytics-verdict-card lib-compare-verdict">
    <div class="analytics-verdict-head">
      <div class="analytics-verdict-text"><p class="analytics-verdict-title">${esc(sentence)}</p></div>
      <div class="analytics-verdict-score">
        <span class="analytics-verdict-score-num">${esc(num)}</span>
        <span class="analytics-verdict-score-lbl">${tHtml('bean_cmp_points')}</span>
      </div>
    </div>
  </section>`;
}

// `enter` (a fresh open) scrolls the library view back to the top.
export function renderBeanCompare(enter = false): void {
  const pair = _pair;
  const host = document.getElementById('libCompare');
  if (!pair || !host) return;
  const beans = _beanList();
  const beanA = beans.find(x => x.id === pair.a);
  const beanB = beans.find(x => x.id === pair.b);
  if (!beanA || !beanB) {
    closeBeanCompare();
    return;
  }
  const c = computeBeanComparison(beanA, beanB, S.shots);
  host.innerHTML = html`<div class="lib-compare-bar">
      <button type="button" class="lib-sheet-close" data-action="compare-back" aria-label="${tHtml('settings_back')}">${ICON_BACK}</button>
      <h2 class="lib-sheet-bar-title">${tHtml('bean_cmp_title')}</h2>
      <button type="button" class="lib-sheet-iconbtn" data-action="compare-swap" aria-label="${tHtml('bean_cmp_swap')}">${ICON_SWAP}</button>
    </div>
    <div class="lib-compare-head">${_headBean(beanA, 'a')}${_headBean(beanB, 'b')}</div>
    ${_verdict(c, beanA, beanB)}
    <div class="lib-compare-cols">
      <div class="lib-compare-col">
        ${_section('bean_cmp_section_results', _resultsRows(c), null)}
        ${_section('bean_cmp_section_dialin', _dialinRows(c), c.grinder ?? t('bean_cmp_no_shared_grinder'))}
      </div>
      <div class="lib-compare-col">
        ${_section('lib_sheet_aromas', html`<div class="lib-compare-aromas">${_aromaSide(beanA, c.sharedAromas)}${_aromaSide(beanB, c.sharedAromas)}</div>`, t('bean_cmp_shared_aromas', c.sharedAromas.size))}
        ${_section('bean_cmp_section_bean', _beanRows(c, beanA, beanB), null)}
      </div>
    </div>`;
  host.hidden = false;
  const view = document.getElementById('library-view');
  view?.setAttribute('data-compare', '');
  if (enter && view) view.scrollTop = 0;
  libraryView.loadBeanThumbnails();
}
