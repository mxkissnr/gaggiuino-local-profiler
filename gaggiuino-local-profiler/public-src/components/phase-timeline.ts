// Profile editors (#2154): the pieces the Gaggiuino and the GaggiMate editor
// share, so both look and behave the same: the phase timeline under the
// preview chart (one chip per phase, as wide as its share of the planned
// time), the head of the selected phase, the folded stop conditions, the
// remove button and the recipe title. Pure markup builders without DOM
// access; each editor renders them and routes the clicks through its own
// actions. The layout lives in the stylesheet ("Machine profile editors").
import { t, tHtml } from '../i18n.js';
import { esc, html, joinHtml } from '../utils.js';
import type { Html } from '../utils.js';
import { ICON_TRASH } from '../icons.js';

const ICON_PLUS: Html = html`<svg class="rail-icon sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>`;

export interface TimelinePhase {
  // The phase's own name; an empty one shows as "Phase N".
  name: string;
  // Its planned length in seconds; 0 for a phase that does not run.
  seconds: number;
  // Shown under the name instead of the length (the Gaggiuino "Skip").
  sub?: string;
}

export interface TimelineOptions {
  // The section title above the chips; also the group's accessible name.
  title: string;
  // data-action of a phase chip; the chip carries data-idx.
  selectAction: string;
  // data-action and aria-label of the "+" button.
  addAction: string;
  addLabel: string;
  // Shown in place of the chips while there is no phase.
  emptyText: string;
}

// Each phase's share of the total planned time, rounded to 4 decimals. A
// phase without time (skipped, blank or invalid) gets 0; when no phase has
// any time, every phase gets an equal share.
export function phaseShares(seconds: readonly number[]): number[] {
  const clean = seconds.map(s => (Number.isFinite(s) && s > 0 ? s : 0));
  const total = clean.reduce((a, b) => a + b, 0);
  if (total <= 0) return clean.map(() => Math.round(10000 / clean.length) / 10000);
  return clean.map(s => Math.round((s / total) * 10000) / 10000);
}

// "18 s"; a phase under 10 s keeps one decimal; no time reads "0 s".
export function phaseSecondsText(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0 s';
  return `${seconds >= 10 ? Math.round(seconds) : Math.round(seconds * 10) / 10} s`;
}

// The name a chip shows: the phase's own, else "Phase N" (1-based).
export function phaseLabel(name: string | undefined, index: number): string {
  const trimmed = (name ?? '').trim();
  return trimmed || t('pe_phase_fallback', index + 1);
}

export function phaseTimelineHtml(phases: readonly TimelinePhase[], selected: number, opts: TimelineOptions): Html {
  const shares = phaseShares(phases.map(p => p.seconds));
  const chips = phases.map((p, i) => html`<button type="button" class="chip phase-timeline-item" aria-pressed="${esc(i === selected ? 'true' : 'false')}" data-action="${esc(opts.selectAction)}" data-idx="${esc(i)}" style="--phase-share:${esc(shares[i] ?? 0)}"><span class="phase-timeline-name">${esc(phaseLabel(p.name, i))}</span><span class="phase-timeline-sub">${esc(p.sub ?? phaseSecondsText(p.seconds))}</span></button>`);
  return html`<div class="section-title"><span>${esc(opts.title)}</span></div>
    <div class="phase-timeline" role="group" aria-label="${esc(opts.title)}">
      ${phases.length ? joinHtml(chips) : html`<span class="phase-timeline-empty">${esc(opts.emptyText)}</span>`}
      <button type="button" class="btn btn--quiet btn--icon phase-timeline-add" data-action="${esc(opts.addAction)}" aria-label="${esc(opts.addLabel)}" title="${esc(opts.addLabel)}">${ICON_PLUS}</button>
    </div>`;
}

// "Phase 3 of 4" above the selected phase's fields (index is 0-based).
export function phaseHeadHtml(index: number, count: number): Html {
  return html`<h4 class="section-title pe-phase-head">${tHtml('pe_phase_of', index + 1, count)}</h4>`;
}

// The stop conditions, folded until opened.
export function stopsFoldHtml(body: Html, open: boolean): Html {
  return html`<details class="pe-stops"${open ? html` open` : html``}><summary class="section-title pe-stops-summary"><span>${tHtml('gm_stop_conditions')}</span></summary>${body}</details>`;
}

export function removePhaseButtonHtml(action: string, index: number): Html {
  return html`<button type="button" class="btn btn--danger pe-remove-phase" data-action="${esc(action)}" data-idx="${esc(index)}">${ICON_TRASH} ${tHtml('gm_remove_phase_title')}</button>`;
}

export function recipeTitleHtml(): Html {
  return html`<h4 class="section-title">${tHtml('pe_recipe')}</h4>`;
}
