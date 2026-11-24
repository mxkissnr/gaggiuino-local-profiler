// The shot detail in the Home Assistant page pattern (#2152): the parts of
// the page that open a sheet or are built from data -- the notes sheet, the
// share menu, the compare sheet, the Process group, the verdict's comparison
// line and the similar-shots title. The static parts of the page are markup;
// updateView() fills them and calls the builders here.
import { S } from '../../state/index.js';
import { t, tHtml } from '../../i18n.js';
import { esc, formatDate, html, joinHtml, scoreClass } from '../../utils.js';
import type { Html } from '../../utils.js';
import { localeFor } from '../../constants.js';
import { LIGHTNING_ICON_SVG } from '../../icons.js';
import { openDetailSheet, closeDetailSheet } from '../../components/detail-sheet.js';
import { toggleCompare } from '../../components/sidebar.js';
import { beanLabel } from '../../shared/bean-mix.js';
import { annotationBusy, flushAutoSave } from './annotation.js';
import { shareCard } from './export.js';
import { calcShotScore } from './utils.js';
import { _shots } from './shared.js';
import type { ShotRow } from './shared.js';

// Two arrows: compare with another shot.
const ICON_COMPARE = html`<svg class="rail-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7h11l-3-3M17 17H6l3 3"/></svg>`;
// A cross: end the running comparison.
const ICON_COMPARE_END = html`<svg class="rail-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>`;

// How many of the newest shots the compare picker offers.
export const COMPARE_PICK_LIMIT = 30;

// ── Verdict ──────────────────────────────────────────────────────────────

// The verdict's sub line next to the score delta: which earlier shot the
// delta is measured against. Empty when there is none.
export function verdictComparisonText(found: { shot: { id?: number; nativeId?: number | null }; sameBean: boolean } | null): string {
  if (!found) return '';
  const n = found.shot.nativeId ?? found.shot.id;
  return t(found.sameBean ? 'shot_verdict_vs_bean' : 'shot_verdict_vs_profile', n);
}

// What the share card draws as its verdict (#2166): the page's sentence, the
// advice type, the score change and the line naming the compared shot.
// updateView() records it for the open shot, so the card shows exactly what
// the page shows without computing it a second time.
export interface CardVerdict {
  type: string;
  text: string;
  delta: number | null;
  vs: string;
}

let _cardVerdict: { shotId: number; verdict: CardVerdict } | null = null;

export function rememberShotVerdict(shotId: number, verdict: CardVerdict | null): void {
  _cardVerdict = verdict ? { shotId, verdict } : null;
}

export function cardVerdictFor(shotId: number | null): CardVerdict | null {
  return _cardVerdict && _cardVerdict.shotId === shotId ? _cardVerdict.verdict : null;
}

// ── Process ──────────────────────────────────────────────────────────────

// One row of the Process group: the label, the measured value against its
// target, the signed change against the compared shot (null: none) and, on
// the pressure row, the channeling warning.
export interface ProcessRow {
  titleKey: string;
  value: string;
  delta: string | null;
  deltaTitle: string;
  channeling?: boolean;
}

// The change is neutral (no quality judgment), so the badge has no colour.
export function processGroupHtml(rows: readonly ProcessRow[]): Html {
  return html`<h2 class="section-title">${tHtml('shot_section_process')}</h2>
    <div class="settings-group">${joinHtml(rows.map(r => html`<div class="settings-row settings-row-static">
      <span class="settings-row-text"><span class="settings-row-title">${tHtml(r.titleKey)}</span></span>
      <span class="settings-row-value">${esc(r.value)}</span>${r.delta !== null ? html`<span class="badge shot-delta" title="${esc(r.deltaTitle)}">${esc(r.delta)}</span>` : html``}${r.channeling ? html`<span class="badge badge--err">${LIGHTNING_ICON_SVG} Channeling</span>` : html``}
    </div>`))}</div>`;
}

// ── Similar shots ────────────────────────────────────────────────────────

export function similarShotsTitle(count: number): string {
  return t('shot_similar_title', count);
}

// ── Compare ──────────────────────────────────────────────────────────────

// The picker's rows: the newest shots other than the open one, newest first.
export function comparePickerHtml(shots: readonly ShotRow[], primaryId: number | null): Html {
  const rows = shots
    .filter(s => s.id !== primaryId)
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, COMPARE_PICK_LIMIT);
  if (!rows.length) return html`<p class="settings-card-desc">${tHtml('shot_compare_none')}</p>`;
  const locale = localeFor(S.currentLang);
  return html`<div class="settings-group">${joinHtml(rows.map(s => {
    const name = s.profile?.name || s.profileName || t('profile_unknown');
    const sub = [formatDate(s.timestamp * 1000, locale, 'short', true), beanLabel(s.annotation)].filter(Boolean).join(' · ');
    const score = calcShotScore(s);
    return html`<button type="button" class="settings-row" data-action="pick-compare-shot" data-id="${esc(s.id)}">
      <span class="settings-row-text"><span class="settings-row-title">${esc(name)} · Shot ${esc(s.nativeId ?? s.id)}</span><span class="settings-row-sub">${esc(sub)}</span></span>
      ${score !== null ? html`<span class="settings-row-value ${esc(scoreClass(score))}">${esc(score)}</span>` : html``}
    </button>`;
  }))}</div>`;
}

// The bar's compare button: opens the picker, or ends a running comparison.
export function onShotCompareClick(anchor: HTMLElement | null): void {
  if (S.compareShotId != null) {
    toggleCompare(S.compareShotId);
    return;
  }
  openDetailSheet({
    title: t('shot_compare_pick'),
    body: comparePickerHtml(_shots(), S.primaryShotId),
    anchor,
  });
}

// A picker row: compare the open shot with that one.
export function pickCompareShot(id: number): void {
  closeDetailSheet();
  toggleCompare(id);
}

// updateView() keeps the button's icon and name in step with the comparison.
export function syncShotCompareButton(comparing: boolean): void {
  const btn = document.getElementById('shotCompareBtn');
  if (!btn) return;
  const label = t(comparing ? 'shot_compare_end' : 'shot_compare_pick');
  btn.setAttribute('aria-label', label);
  btn.title = label;
  btn.innerHTML = comparing ? ICON_COMPARE_END : ICON_COMPARE;
}

// ── Share ────────────────────────────────────────────────────────────────

// A share menu entry (#2165): share the card in that format. The shared
// menu component has already closed the menu.
export function chooseShareFormat(format: string): void {
  void shareCard(format, cardVerdictFor(S.primaryShotId));
}

// ── Notes ────────────────────────────────────────────────────────────────

// Runs fn once no annotation save waits or runs, checking every 100 ms for
// at most five seconds.
function _whenSaved(fn: () => void, tries = 50): void {
  if (!annotationBusy() || tries <= 0) { fn(); return; }
  setTimeout(() => _whenSaved(fn, tries - 1), 100);
}

// #2164: the Coffee rows open the notes sheet at their own field. Each entry
// lists the control ids to try in order; the first one that is shown gets the
// focus (the grinder falls back to its free-text input when the library has
// no grinders). Focusing writes nothing: the autosave only runs on a change.
const NOTES_FIELDS: Record<string, readonly string[]> = {
  bean: ['annCoffee'],
  grinder: ['annGrinder', 'annGrinderOther'],
};

function _focusNotesField(field: string): void {
  for (const id of NOTES_FIELDS[field] ?? []) {
    const el = document.getElementById(id);
    if (!el || el.hidden || el.style.display === 'none') continue;
    el.focus({ preventScroll: true });
    (el.closest('.annotation-field') ?? el).scrollIntoView({ block: 'center' });
    return;
  }
}

// #2164: what a Coffee row (bean, grinder) shows. A shot that names nothing
// yet shows what the notes sheet prefills from the shot logging defaults
// (#654, #1954), marked as a default, instead of a dash, so the row and the
// sheet never disagree.
export function coffeeRowText(label: string | null, prefill: string): { text: string; prefilled: boolean } {
  if (label) return { text: label, prefilled: false };
  if (prefill) return { text: prefill, prefilled: true };
  return { text: '–', prefilled: false };
}

// Writes one Coffee row: its title (muted while it only shows a default)
// and its "Default" hint. Nothing is saved by showing a default.
export function showCoffeeRow(valueId: string, hintId: string, label: string | null, prefill: string): void {
  const row = coffeeRowText(label, prefill);
  const value = document.getElementById(valueId);
  if (value) {
    value.textContent = row.text;
    value.className = row.prefilled ? 'settings-row-title settings-row-title--muted' : 'settings-row-title';
  }
  const hint = document.getElementById(hintId);
  if (hint) hint.hidden = !row.prefilled;
}

// "All notes" and the Coffee rows: every note field except the stars and the
// taste tag, in the shared detail sheet (a centred dialog on desktop, a
// bottom sheet on phones). The fields are the static form in #shotNotesPanel,
// moved in while the sheet is open, so their autosave keeps working
// unchanged. Closing saves a pending edit at once and, once the save has
// landed, redraws the page when the shot's saved notes changed, so the
// Coffee rows and the figures show them.
// #2164: a Coffee row passes its field, the sheet then opens at that field.
export function openShotNotes(field?: string): void {
  const panel = document.getElementById('shotNotesPanel');
  const id = S.primaryShotId;
  if (!panel || id == null) return;
  const saved = (): string => JSON.stringify(_shots().find(s => s.id === id)?.annotation ?? null);
  const before = saved();
  openDetailSheet({
    title: t('shot_notes_all'),
    body: html``,
    content: panel,
    dialog: true,
    onClose: () => {
      flushAutoSave();
      _whenSaved(() => {
        if (S.primaryShotId === id && !annotationBusy() && saved() !== before) window.updateView?.();
      });
    },
  });
  if (field) _focusNotesField(field);
}
