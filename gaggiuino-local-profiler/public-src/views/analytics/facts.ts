import { S } from '../../state/index.js';
import { t } from '../../i18n.js';
import { localeFor } from '../../constants.js';
import { esc, html, joinHtml } from '../../utils.js';
import type { Html } from '../../utils.js';
import { computeFacts } from '../analytics-facts.js';
import type { Fact, FactIcon } from '../analytics-facts.js';
import { openDetailSheet } from '../../components/detail-sheet.js';
import { _shots } from './shared.js';

// ── "Did you know?" facts ────────────────────────────────────────────────────
// Four cards at a time out of computeFacts()'s list. Shuffle advances to the
// next four of a shuffled order and reshuffles once it runs past the end, so
// there are always four cards while at least four facts hold.
const FACTS_ICONS: Record<FactIcon, Html> = {
  moon: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a6.6 6.6 0 0 0 9.8 9.8Z"/></svg>`,
  cups: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9h12v6a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4V9Z"/><path d="M16 10h1.5a2.5 2.5 0 0 1 0 5H16"/><path d="M8 3v2M12 3v2"/></svg>`,
  clock: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/><path d="M12 8v4l2.5 1.5"/></svg>`,
  bolt: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M13 3 5 13h6l-1 8 8-10h-6l1-8Z"/></svg>`,
  cal: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="5" width="16" height="16" rx="2"/><path d="M4 9h16M8 3v4M16 3v4"/></svg>`,
  jug: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8h10l-1 11a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L6 8Z"/><path d="M16 10h1.5a2 2 0 0 1 0 4H16"/><path d="M9 4h4"/></svg>`,
  film: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 5v14M17 5v14M3 9h4M3 15h4M17 9h4M17 15h4"/></svg>`,
  suitcase: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="8" width="18" height="11" rx="2"/><path d="M9 8V6a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>`,
  snail: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17h11a4 4 0 1 0-3.6-5.8"/><path d="M14 11a2 2 0 1 0-1.4 3.4"/><path d="M19 9l-1.5 2L19 13"/></svg>`,
};

const _FACTS_PER_PAGE = 4;
let _factsList: Fact[] = [];
let _factsOrder: number[] = [];
let _factsShown = 0;

function _shuffledIndices(n: number): number[] {
  const order = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const a = order[i];
    const b = order[j];
    if (a === undefined || b === undefined) continue;
    order[i] = b;
    order[j] = a;
  }
  return order;
}

// Four faint stars for a night fact, positioned inline so they do not depend
// on the card's child order.
function _factStars(): Html {
  const spots: [number, number][] = [[12, 16], [26, 30], [42, 12], [18, 46]];
  return joinHtml(spots.map(([top, right]) =>
    html`<span class="analytics-fact-star" style="top:${esc(top)}px;right:${esc(right)}px"></span>`));
}

function _factCard(fact: Fact): Html {
  const sentence = t(fact.textKey, fact.vars);
  const gauge = fact.gauge !== undefined
    ? html`<span class="analytics-fact-gauge"><span class="analytics-fact-gauge-fill" style="width:${esc(Math.max(0, Math.min(100, fact.gauge)).toFixed(1))}%"></span></span>`
    : esc('');
  return html`<button type="button" class="analytics-fact${fact.night ? html` night` : esc('')}" data-action="analytics-fact" data-fact="${esc(fact.id)}">
    ${fact.night ? _factStars() : esc('')}
    <span class="analytics-fact-icon" aria-hidden="true">${FACTS_ICONS[fact.icon]}</span>
    <span class="analytics-fact-big serif-display">${esc(fact.big)}</span>
    <span class="analytics-fact-text">${esc(sentence)}</span>
    ${gauge}
  </button>`;
}

function _renderFactsPage(): void {
  const el = document.getElementById('analyticsFacts');
  if (!el) return;
  const n = _factsList.length;
  const take = Math.min(_FACTS_PER_PAGE, n);
  const cards: Html[] = [];
  for (let k = 0; k < take; k++) {
    const idx = _factsOrder[(_factsShown + k) % n];
    const fact = idx === undefined ? undefined : _factsList[idx];
    if (fact) cards.push(_factCard(fact));
  }
  el.innerHTML = html`${joinHtml(cards)}`;
}

export function buildFacts(): void {
  const card = document.getElementById('analyticsFactsCard');
  const el = document.getElementById('analyticsFacts');
  if (!card || !el) return;
  const facts = computeFacts(
    _shots(),
    s => (window.calcShotScore ? window.calcShotScore(s) : null),
    localeFor(S.currentLang),
  );
  _factsList = facts;
  if (facts.length < 3) {
    card.style.display = 'none';
    el.innerHTML = html``;
    return;
  }
  card.style.display = '';
  const countEl = document.getElementById('analyticsFactsCount');
  if (countEl) countEl.textContent = t('analytics_facts_count', facts.length);
  _factsOrder = _shuffledIndices(facts.length);
  _factsShown = 0;
  _renderFactsPage();
}

export function shuffleFacts(): void {
  const n = _factsList.length;
  if (n < 3) return;
  _factsShown += _FACTS_PER_PAGE;
  if (_factsShown >= n) {
    _factsOrder = _shuffledIndices(n);
    _factsShown = 0;
  }
  _renderFactsPage();
}

// Detail sheet for one fact: the big value as the title, the sentence as the
// subtitle and the fact's rows in the same markup the bean shelf uses.
export function openFactDetail(id: string, anchor: HTMLElement | null): void {
  const fact = _factsList.find(f => f.id === id);
  if (!fact) return;
  const sentence = t(fact.textKey, fact.vars);
  const rows = fact.rows.map(([label, value]) =>
    html`<div class="bests-row"><span class="bests-lbl">${esc(t(label))}</span><span class="bests-val">${esc(value)}</span></div>`);
  openDetailSheet({
    title: fact.big,
    sub: sentence,
    body: html`<div class="detail-rows">${joinHtml(rows)}</div>`,
    anchor,
  });
}
