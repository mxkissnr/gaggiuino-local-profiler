// #812: the achievements ("stamp card") view. Renders the 64-badge catalogue
// (go/internal/achievements) as a
// printed cardboard card, per PLAN.md section 5 — not an app panel, not a
// level/score UI. Eight categories sit side by side from the very first
// visit (CARD_KEYS below, mirrored from the backend) so an unlockable-only-
// by-chance secret badge never strands anyone on one page.
//
// The card is a depicted object and stays paper-colored in the dark theme
// too — its colors are hardcoded (see the --ach-* custom properties in
// style.css's "Achievements view" section), never the app's --gray-*/--err
// etc. theme tokens.
//
// #1465: the page follows the Home Assistant page pattern from
// docs/DESIGN.md — the settings top app bar, the library shelf's chip control
// for the eight categories and for All / Collected / Open, the statistics
// verdict as the one-line answer, and the shared detail sheet for a stamp's
// details. The card itself is unchanged.
import { S } from '../state/index.js';
import { t, tHtml } from '../i18n.js';
import { getAchievements } from '../api/system.js';
import { localeFor } from '../constants.js';
import { esc, formatDate, html, joinHtml } from '../utils.js';
import type { Html } from '../utils.js';
import { openDetailSheet } from '../components/detail-sheet.js';

// The badge record as GET /api/achievements serves it (see
// AchievementService.getState): only unlocked/secret badges carry name and
// description.
export interface Achievement {
  id: string;
  card: string;
  stamp: string;
  secret?: boolean;
  unlocked?: boolean;
  unlockedAt?: number | null;
  name?: string | null;
  description?: string | null;
  progress?: { current: number; target: number } | null;
}

const CARD_KEYS: string[] = ['basics', 'craft', 'beans', 'endurance', 'moments', 'care', 'house', 'secret'];
const CARD_NAME_KEYS: Record<string, string> = {
  basics: 'ach_card_basics', craft: 'ach_card_craft', beans: 'ach_card_beans',
  endurance: 'ach_card_endurance', moments: 'ach_card_moments', care: 'ach_card_care',
  house: 'ach_card_house', secret: 'ach_card_secret',
};

// Stamp motifs — ported from redesign-2026-08/build-prototype.py's
// STAMP_INNER dict (see PLAN.md section 5), lowercased to match
// the registry's `stamp` field values. A badge whose `stamp` isn't one of
// these keys (e.g. '90', '1:2', '30d', '5x') renders as plain ink text
// instead — see stampInnerSvg() below. Paths are authored for the 54×54
// viewBox stampSvg() wraps them in; they are not general-purpose nav icons
// (no independent viewBox/currentColor sizing), which is why they live here
// rather than in icons.ts alongside the *_ICON_SVG rail-icon exports.
const ACH_STAMP_MOTIFS: Record<string, Html> = {
  gear:   html`<circle cx="27" cy="26.6" r="3.4"/><path d="M27 17.6v3M27 32.6v3M18 26.6h3M33 26.6h3M20.6 20.2l2.1 2.1M31.3 30.9l2.1 2.1M33.4 20.2l-2.1 2.1M22.7 30.9l-2.1 2.1"/>`,
  scale:  html`<path d="M27 17.4v18.4M20 21.4h14"/><path d="M18.4 21.4 15 28a3.4 3.4 0 0 0 6.8 0z"/><path d="M35.6 21.4 39 28a3.4 3.4 0 0 1-6.8 0z"/>`,
  bolt:   html`<path d="M28.4 16.6 20 30.2h6l-1 9 8.4-13.6h-6z"/>`,
  leaf:   html`<path d="M35.4 18.6c0 9.4-5 14.4-12.2 14.4a5.6 5.6 0 0 1 0-11.2c5 0 8.6-1.2 12.2-3.2z"/><path d="M20.4 36.4c2-6.4 6-10.4 11.6-13"/>`,
  map:    html`<path d="M18.6 20.4 24.6 18l6.6 2.6 6-2.4v15.4l-6 2.4-6.6-2.6-6 2.4z"/><path d="M24.6 18v17.4M31.2 20.6V38"/>`,
  shield: html`<path d="M27 16.6 36 20v6.6c0 5.4-3.8 9.6-9 11-5.2-1.4-9-5.6-9-11V20z"/><path d="m23 26.6 3 3 5-5.6"/>`,
  star:   html`<path d="m27 17.6 2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z"/>`,
  link:   html`<path d="m23.4 30.6 7.2-7.2"/><path d="M25.6 20.4 27.8 18a4.9 4.9 0 0 1 7 7l-2.2 2.2"/><path d="m28.4 33.6-2.2 2.2a4.9 4.9 0 0 1-7-7l2.2-2.2"/>`,
  drop:   html`<path d="M27 16.6s7.4 8 7.4 13.4a7.4 7.4 0 0 1-14.8 0c0-5.4 7.4-13.4 7.4-13.4z"/>`,
  book:   html`<path d="M19.4 18.2A1.8 1.8 0 0 1 21.2 16.4h14v21.2h-14a1.8 1.8 0 0 1-1.8-1.8z"/><path d="M25.4 16.4v21.2"/>`,
  cup:    html`<path d="M33.6 21.6h1.8a3.4 3.4 0 0 1 0 6.8h-1.8M18.6 21.6h15v8a4.6 4.6 0 0 1-4.6 4.6h-5.8a4.6 4.6 0 0 1-4.6-4.6z"/><path d="M23.4 15.4v2.6M28.2 15.4v2.6"/>`,
  target: html`<circle cx="27" cy="26.6" r="8.4"/><circle cx="27" cy="26.6" r="4"/><circle cx="27" cy="26.6" r=".9"/>`,
  bean:   html`<path d="M19 26.6c0-4.6 3.4-8.4 7.8-8.4s7.8 3.8 7.8 8.4-3.8 8-8.4 8a7.2 7.2 0 0 1-7.2-8z"/><path d="M22 30.4c2.3-1.2 3.4-3.5 3.4-6.9"/>`,
  moon:   html`<path d="M36 30.4A9.4 9.4 0 0 1 24.4 18.8a9.4 9.4 0 1 0 11.6 11.6z"/>`,
  globe:  html`<circle cx="27" cy="26.6" r="8.4"/><path d="M18.6 26.6h16.8"/><path d="M27 18.2c2.2 2.3 3.4 5.3 3.4 8.4s-1.2 6.1-3.4 8.4c-2.2-2.3-3.4-5.3-3.4-8.4s1.2-6.1 3.4-8.4z"/>`,
  flame:  html`<path d="M27 17.4c3 3.6 5.6 6.3 5.6 9.9a5.6 5.6 0 1 1-11.2 0c0-3.6 2.6-6.3 5.6-9.9z"/><path d="M27 33.6a2.7 2.7 0 0 0 2.7-2.7c0-1.7-1.4-2.7-2.7-4.4-1.3 1.7-2.7 2.7-2.7 4.4a2.7 2.7 0 0 0 2.7 2.7z"/>`,
  jug:    html`<path d="M21.6 18.4h8.6l-1 14.4a2 2 0 0 1-2 1.9h-2.6a2 2 0 0 1-2-1.9z"/><path d="M21.6 18.4 18 20.8l4 1.8"/><path d="M30.2 21.8a3.6 3.6 0 0 1 0 7.4"/>`,
  wrench: html`<path d="M31.4 20.2a4.5 4.5 0 0 1-6.1 6.1l-6 6 3.2 3.2 6-6a4.5 4.5 0 0 1 6.1-6.1l-2.8 2.8-2.3-2.3z"/>`,
  sun:    html`<circle cx="27" cy="26.6" r="4.3"/><path d="M27 15.9v2.8M27 34.5v2.8M19.1 18.7l2 2M32.9 32.5l2 2M16.3 26.6h2.8M34.9 26.6h2.8M19.1 34.5l2-2M32.9 20.7l2-2"/>`,
  roast:  html`<circle cx="27" cy="24.6" r="6.4"/><path d="M23.8 24.6a3.2 3.2 0 0 1 6.4 0"/><path d="M22.6 33.6c1.3 1.5 2.7 2.2 4.4 2.2s3.1-.7 4.4-2.2"/>`,
  slider: html`<path d="M20 17.4v6.6M20 28.4v8.2M27 17.4v2.4M27 24.4v12.2M34 17.4v11M34 32v.7"/><circle cx="20" cy="26.2" r="2.2"/><circle cx="27" cy="21.9" r="2.2"/><circle cx="34" cy="30.5" r="2.2"/>`,
  clock:  html`<circle cx="27" cy="26.6" r="8.4"/><path d="M27 20.9v5.7l4 2.3"/>`,
};

function stampInnerSvg(stampKey: string): Html {
  const motif = ACH_STAMP_MOTIFS[stampKey];
  if (motif) return motif;
  // Text stamps ('90', '1:2', '30d', …) need no artwork — '5x' is the one
  // exception that's spelled out differently than it's stored, matching
  // the prototype's __STAMP_X5__.
  const txt = stampKey === '5x' ? '5×' : String(stampKey);
  const size = txt.length <= 2 ? 13 : (txt.length === 3 ? 11 : 9.4);
  return html`<text x="27" y="27" text-anchor="middle" dominant-baseline="central" font-size="${esc(size)}" font-weight="700" fill="currentColor" stroke="none" style="font-family:Figtree,sans-serif;letter-spacing:-.02em">${esc(txt)}</text>`;
}

// A rough double-ring ink stamp, single-instance filter id — this view only
// ever has one card mounted at a time (unlike machine-icon.ts's per-machine
// gradients), so a fixed id is safe; still scoped with an ach- prefix so it
// can never collide with the machine icon's own filter/gradient ids (#87's
// bug class, per PLAN.md's traps list).
export function stampSvg(stampKey: string): Html {
  return html`<svg class="ach-stamp" viewBox="0 0 54 54" aria-hidden="true"><g filter="url(#ach-rough-ink)" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="27" cy="27" r="23.4" stroke-width="2.6"/><circle cx="27" cy="27" r="19.8" stroke-width=".9"/>${stampInnerSvg(stampKey)}</g></svg>`;
}

// Deterministic per badge id — NOT Math.random(), which would re-jitter the
// same stamp to a new angle on every re-render (see PLAN.md's traps list:
// "jeder minimal schief" has to mean fixed-per-badge, not fixed-per-paint).
export function askewDeg(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (Math.imul(h, 31) + id.charCodeAt(i)) | 0;
  return (Math.abs(h) % 15) - 7; // -7..7 degrees
}

// unlockedAt is Unix SECONDS (the achievements table), not
// milliseconds — see AchievementService.getState()'s header comment.
// #1962: the date and the time both come from the shared formatDate() helper,
// so this view has no formatter of its own.
export function formatStampedOn(unlockedAtSeconds: number, lang: string): string {
  return t('ach_stamped_on', formatDate(unlockedAtSeconds * 1000, localeFor(lang), 'short', true));
}

function formatFullDate(unlockedAtSeconds: number, lang: string): string {
  return formatDate(unlockedAtSeconds * 1000, localeFor(lang));
}

// A card (category) is full once every one of its badges — including any
// still-secret ones on the "secret" card — is unlocked. Per PLAN.md section
// 5: the diagonal "Full" overprint is per category, not a global collection
// state (that's a separate, out-of-scope "share the whole collection" idea).
export function isCardFull(badges: Achievement[]): boolean {
  return badges.length > 0 && badges.every(b => b.unlocked);
}

// Non-secret badges never carry name/description from the API (see
// AchievementService.getState()) — the frontend owns that copy via the
// ach_<id>_n/_d i18n keys already shipped in public-src/i18n/*.js. Secret
// badges carry neither field from the API until unlocked, so a locked
// secret badge renders nothing here by construction, not by a client-side
// guard that could be forgotten.
export function badgeName(b: Achievement): string | null {
  if (b.secret) return b.unlocked ? (b.name ?? null) : null;
  return t(`ach_${b.id}_n`);
}
export function badgeDesc(b: Achievement): string | null {
  if (b.secret) return b.unlocked ? (b.description ?? null) : null;
  return t(`ach_${b.id}_d`);
}
function badgeMeta(b: Achievement): string {
  if (b.unlocked) return formatStampedOn(b.unlockedAt as number, S.currentLang);
  if (b.secret) return t('ach_secret_locked_hint');
  if (b.progress) return t('ach_progress', b.progress.current, b.progress.target);
  return t('ach_not_yet');
}

export type AchFilter = 'all' | 'got' | 'open';

// The card being looked at, the All / Collected / Open filter and the loaded
// catalogue live in module state for the session only — no API and no
// stored-data change (#1465). The chosen category survives leaving and
// reopening the page; only an unknown one falls back to the first card.
const _state: { badges: Achievement[]; card: string; filter: AchFilter } = { badges: [], card: 'basics', filter: 'all' };

// The stamps closest to being earned: locked, non-secret, with a counter that
// has started. Highest share first, then the fewest left, then catalogue order
// (Array#sort is stable, so equal entries keep the order the API sent).
// Secret badges never carry progress, so they can never be named here.
export function achUpcoming(badges: Achievement[]): Achievement[] {
  type Started = Achievement & { progress: { current: number; target: number } };
  return badges
    .filter((b): b is Started => !b.unlocked && !b.secret && b.progress != null
      && b.progress.target > 0 && b.progress.current > 0 && b.progress.current < b.progress.target)
    .sort((a, b) => {
      const share = b.progress.current / b.progress.target - a.progress.current / a.progress.target;
      if (share !== 0) return share;
      return (a.progress.target - a.progress.current) - (b.progress.target - b.progress.current);
    });
}

// The page's one-line answer, built from the statistics verdict classes the
// Dial-In view uses. The big number is the collected count and its label
// carries the total ("of 64 stamps"); the sentence names the closest stamp
// with its progress instead — the count is never repeated inside it
// (docs/DESIGN.md, "Nothing twice").
export function achVerdictHtml(badges: Achievement[]): Html {
  const got = badges.filter(b => b.unlocked).length;
  const total = badges.length;
  const next = achUpcoming(badges)[0];
  const progress = next?.progress;
  const title = next
    ? t('ach_verdict_next', badgeName(next) ?? '')
    : got === total
      ? t('ach_verdict_all')
      : t('ach_verdict_open', total - got);
  return html`
    <div class="analytics-verdict-head">
      <div class="analytics-verdict-text">
        <h2 class="analytics-verdict-title">${esc(title)}</h2>
        ${progress ? html`<p class="analytics-verdict-sub">${esc(t('ach_progress', progress.current, progress.target))}</p>` : html``}
      </div>
      <div class="analytics-verdict-score">
        <span class="analytics-verdict-score-num serif-display">${esc(got)}</span>
        <span class="analytics-verdict-score-lbl">${esc(t('ach_verdict_of', total))}</span>
      </div>
    </div>`;
}

// One stamp's details for the shared sheet. A locked secret badge shows the
// category name ("Secret") and the standing hint, and nothing else: no name,
// no description, no counter — even when the record it was built from carries
// those fields (badgeName()/badgeDesc() return null for it, and this function
// does not fall back to the raw fields either).
export function achDetail(b: Achievement): { title: string; sub: string; body: Html } {
  const secretLocked = b.secret && !b.unlocked;
  const title = secretLocked ? t('ach_card_secret') : (badgeName(b) || '');
  const sub = secretLocked ? '' : t(CARD_NAME_KEYS[b.card] ?? '');
  const desc = secretLocked ? null : badgeDesc(b);
  const progress = b.progress;
  const bar = !b.unlocked && progress && progress.target > 0;
  const pct = progress && progress.target > 0
    ? Math.round(Math.min(100, Math.max(0, (progress.current * 100) / progress.target)))
    : 0;
  return {
    title,
    sub,
    body: html`${desc ? html`<p class="ach-sheet-desc">${esc(desc)}</p>` : html``}<p class="ach-sheet-meta">${esc(badgeMeta(b))}</p>${bar ? html`<span class="ach-bar"><i style="width:${esc(pct)}%"></i></span>` : html``}`,
  };
}

// Exported for test/achievements-view.test.ts: a locked secret badge must
// emit neither its name nor its description, and that is the one property of
// this view worth nailing down at the HTML level rather than trusting
// badgeName()/badgeDesc() to keep returning null.
export function fieldHtml(b: Achievement): Html {
  const rot = askewDeg(b.id);
  const secretLocked = b.secret && !b.unlocked;
  const label = secretLocked ? t('ach_card_secret') : (badgeName(b) || '');
  const cls = `ach-field${b.unlocked ? ' ach-got' : ''}${secretLocked ? ' ach-secret' : ''}`;
  return html`<button type="button" class="${esc(cls)}"
      style="--ach-rot:${esc(rot)}deg" data-ach-id="${esc(b.id)}" aria-label="${esc(label)}">
    <span class="ach-ring"></span>
    ${secretLocked ? html`<span class="ach-qm">?</span>` : html``}
    ${b.unlocked ? html`<span class="ach-ink">${stampSvg(b.stamp)}</span>` : html``}
  </button>`;
}

function pageHtml(cardBadges: Achievement[], key: string, chosen: string): Html {
  const full = isCardFull(cardBadges);
  const overprint = full
    ? (() => {
        const latest = Math.max(...cardBadges.map(b => b.unlockedAt || 0));
        return html`<div class="ach-overprint">${tHtml('ach_full')}<span class="ach-overprint-date">${esc(formatFullDate(latest, S.currentLang))}</span></div>`;
      })()
    : html``;
  return html`<div class="ach-page${esc(full ? ' ach-full' : '')}" data-ach-page="${esc(key)}"${key === chosen ? html`` : html` hidden`}>
    <div class="ach-fields">${joinHtml(cardBadges.map(fieldHtml))}</div>
    ${overprint}
  </div>`;
}

// The whole page: the settings top app bar, the two chip rows, then the
// verdict and the card. The category chips replace the old arrows/dots/"Card
// n of 8" line — eight categories are pages of one depicted card, which is
// what the chips say. The filter is pure CSS: the layout carries
// data-ach-filter and the stylesheet dims the stamps that do not match, so
// the card stays one object and nothing is hidden or reflowed.
export function achPageHtml(badges: Achievement[], card: string, filter: AchFilter): Html {
  const byCard = new Map<string, Achievement[]>(CARD_KEYS.map(k => [k, []]));
  for (const b of badges) {
    const list = byCard.get(b.card);
    if (list) list.push(b);
  }

  const cardChips = joinHtml(CARD_KEYS.map(key =>
    html`<button type="button" class="lib-shelf-chip" data-ach-card="${esc(key)}" aria-pressed="${esc(key === card ? 'true' : 'false')}">${tHtml(CARD_NAME_KEYS[key] ?? '')}</button>`
  ));
  const filters: [AchFilter, string][] = [['all', 'lib_shelf_all'], ['got', 'ach_filter_got'], ['open', 'ach_filter_open']];
  const showChips = joinHtml(filters.map(([value, key]) =>
    html`<button type="button" class="lib-shelf-chip" data-ach-show="${esc(value)}" aria-pressed="${esc(value === filter ? 'true' : 'false')}">${tHtml(key)}</button>`
  ));

  return html`
    <div class="settings-bar ach-bar-top"><h1 class="settings-bar-title">${tHtml('nav_achievements')}</h1></div>
    <div class="ach-filters">
      <div class="ach-chips" role="group">${cardChips}</div>
      <div class="ach-chips" role="group">${showChips}</div>
    </div>
    <div class="ach-layout" data-ach-filter="${esc(filter)}">
      <section class="analytics-verdict-card ach-verdict">${achVerdictHtml(badges)}</section>
      <div class="ach-cardwrap">
        <svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
          <filter id="ach-rough-ink" x="-25%" y="-25%" width="150%" height="150%">
            <feTurbulence type="fractalNoise" baseFrequency=".78" numOctaves="3" seed="9" result="achn"/>
            <feDisplacementMap in="SourceGraphic" in2="achn" scale="1.7" xChannelSelector="R" yChannelSelector="G"/>
          </filter>
        </defs></svg>
        <div class="ach-card">
          <div class="ach-frame"></div>
          <div class="ach-head">
            <span class="ach-brand">Gaggiuino Local Profiler</span>
            <span class="ach-title serif-display" id="achTitle">${esc(t(CARD_NAME_KEYS[card] ?? ''))}</span>
          </div>
          <div class="ach-grid">${joinHtml(CARD_KEYS.map(key => pageHtml(byCard.get(key) || [], key, card)))}</div>
        </div>
      </div>
    </div>`;
}

export function setAchCard(key: string): void {
  if (!CARD_KEYS.includes(key)) return;
  _state.card = key;
  document.querySelectorAll<HTMLElement>('.ach-page').forEach(el => {
    if (el.dataset.achPage === key) el.removeAttribute('hidden');
    else el.setAttribute('hidden', '');
  });
  document.querySelectorAll<HTMLElement>('[data-ach-card]').forEach(el => {
    el.setAttribute('aria-pressed', String(el.dataset.achCard === key));
  });
  const titleEl = document.getElementById('achTitle');
  if (titleEl) titleEl.textContent = t(CARD_NAME_KEYS[key] ?? '');
}

export function setAchFilter(value: string): void {
  if (value !== 'all' && value !== 'got' && value !== 'open') return;
  _state.filter = value;
  const layout = document.querySelector<HTMLElement>('.ach-layout');
  if (layout) layout.dataset.achFilter = value;
  document.querySelectorAll<HTMLElement>('[data-ach-show]').forEach(el => {
    el.setAttribute('aria-pressed', String(el.dataset.achShow === value));
  });
}

export function openAchievement(id: string): void {
  const badge = _state.badges.find(b => b.id === id);
  if (!badge) return;
  const d = achDetail(badge);
  // Centred dialog on desktop, the usual bottom sheet on phones (#2038).
  openDetailSheet({ title: d.title, body: d.body, dialog: true, ...(d.sub ? { sub: d.sub } : {}) });
}

function _closest(ev: Event, attr: string): HTMLElement | null {
  const target = ev.target as HTMLElement | null;
  return target && typeof target.closest === 'function' ? target.closest<HTMLElement>(`[${attr}]`) : null;
}

export async function loadAchievementsView(): Promise<void> {
  const container = document.getElementById('achievements-view');
  if (!container) return;
  container.innerHTML = html`<div class="loading-state">${tHtml('ach_loading')}</div>`;
  try {
    const r = await getAchievements(S.currentLang);
    const data = await r.json() as { badges?: Achievement[] };
    _state.badges = data.badges || [];
  } catch {
    container.innerHTML = html`<div class="loading-state" style="color:var(--err)">${tHtml('error_load')}</div>`;
    return;
  }
  if (!_state.badges.length) {
    container.innerHTML = html`<div class="loading-state" style="color:var(--err)">${tHtml('error_load')}</div>`;
    return;
  }
  if (!CARD_KEYS.includes(_state.card)) _state.card = 'basics';
  // codeql[js/xss-through-dom] false positive: esc()/html already applied, see #760
  container.innerHTML = achPageHtml(_state.badges, _state.card, _state.filter);

  // One delegated listener per container: the page re-renders itself on every
  // open, so per-element listeners would pile up.
  if (container.dataset.achBound) return;
  container.dataset.achBound = '1';
  container.addEventListener('click', ev => {
    const chip = _closest(ev, 'data-ach-card');
    if (chip) { setAchCard(chip.dataset.achCard as string); return; }
    const show = _closest(ev, 'data-ach-show');
    if (show) { setAchFilter(show.dataset.achShow as string); return; }
    const field = _closest(ev, 'data-ach-id');
    if (field) openAchievement(field.dataset.achId as string);
  });
}
