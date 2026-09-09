// #812: the achievements ("stamp card") view. Renders the 54-badge catalogue
// (go/internal/achievements) as a
// printed cardboard card, per PLAN.md section 5 — not an app panel, not a
// level/score UI. Seven categories sit side by side from the very first
// visit (CARD_KEYS below, mirrored from the backend) so an unlockable-only-
// by-chance secret badge never strands anyone on one page.
//
// The card is a depicted object and stays paper-colored in the dark theme
// too — its colors are hardcoded (see the --ach-* custom properties in
// style.css's "Achievements view" section), never the app's --gray-*/--err
// etc. theme tokens.
import { S } from '../state.js';
import { t } from '../i18n.js';
import { apiFetch } from '../api.js';
import { localeFor } from '../constants.js';
import { esc } from '../utils.js';

const CARD_KEYS = ['basics', 'craft', 'beans', 'endurance', 'care', 'house', 'secret'];
const CARD_NAME_KEYS = {
  basics: 'ach_card_basics', craft: 'ach_card_craft', beans: 'ach_card_beans',
  endurance: 'ach_card_endurance', care: 'ach_card_care', house: 'ach_card_house',
  secret: 'ach_card_secret',
};

// Stamp motifs — ported from redesign-2026-08/build-prototype.py's
// STAMP_INNER dict (see PLAN.md section 5), lowercased to match
// registry.js's `stamp` field values. A badge whose `stamp` isn't one of
// these keys (e.g. '90', '1:2', '30d', '5x') renders as plain ink text
// instead — see stampInnerSvg() below. Paths are authored for the 54×54
// viewBox stampSvg() wraps them in; they are not general-purpose nav icons
// (no independent viewBox/currentColor sizing), which is why they live here
// rather than in icons.js alongside the *_ICON_SVG rail-icon exports.
const ACH_STAMP_MOTIFS = {
  gear:   '<circle cx="27" cy="26.6" r="3.4"/><path d="M27 17.6v3M27 32.6v3M18 26.6h3M33 26.6h3M20.6 20.2l2.1 2.1M31.3 30.9l2.1 2.1M33.4 20.2l-2.1 2.1M22.7 30.9l-2.1 2.1"/>',
  scale:  '<path d="M27 17.4v18.4M20 21.4h14"/><path d="M18.4 21.4 15 28a3.4 3.4 0 0 0 6.8 0z"/><path d="M35.6 21.4 39 28a3.4 3.4 0 0 1-6.8 0z"/>',
  bolt:   '<path d="M28.4 16.6 20 30.2h6l-1 9 8.4-13.6h-6z"/>',
  leaf:   '<path d="M35.4 18.6c0 9.4-5 14.4-12.2 14.4a5.6 5.6 0 0 1 0-11.2c5 0 8.6-1.2 12.2-3.2z"/><path d="M20.4 36.4c2-6.4 6-10.4 11.6-13"/>',
  map:    '<path d="M18.6 20.4 24.6 18l6.6 2.6 6-2.4v15.4l-6 2.4-6.6-2.6-6 2.4z"/><path d="M24.6 18v17.4M31.2 20.6V38"/>',
  shield: '<path d="M27 16.6 36 20v6.6c0 5.4-3.8 9.6-9 11-5.2-1.4-9-5.6-9-11V20z"/><path d="m23 26.6 3 3 5-5.6"/>',
  star:   '<path d="m27 17.6 2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z"/>',
  link:   '<path d="m23.4 30.6 7.2-7.2"/><path d="M25.6 20.4 27.8 18a4.9 4.9 0 0 1 7 7l-2.2 2.2"/><path d="m28.4 33.6-2.2 2.2a4.9 4.9 0 0 1-7-7l2.2-2.2"/>',
  drop:   '<path d="M27 16.6s7.4 8 7.4 13.4a7.4 7.4 0 0 1-14.8 0c0-5.4 7.4-13.4 7.4-13.4z"/>',
  book:   '<path d="M19.4 18.2A1.8 1.8 0 0 1 21.2 16.4h14v21.2h-14a1.8 1.8 0 0 1-1.8-1.8z"/><path d="M25.4 16.4v21.2"/>',
  cup:    '<path d="M33.6 21.6h1.8a3.4 3.4 0 0 1 0 6.8h-1.8M18.6 21.6h15v8a4.6 4.6 0 0 1-4.6 4.6h-5.8a4.6 4.6 0 0 1-4.6-4.6z"/><path d="M23.4 15.4v2.6M28.2 15.4v2.6"/>',
  target: '<circle cx="27" cy="26.6" r="8.4"/><circle cx="27" cy="26.6" r="4"/><circle cx="27" cy="26.6" r=".9"/>',
  bean:   '<path d="M19 26.6c0-4.6 3.4-8.4 7.8-8.4s7.8 3.8 7.8 8.4-3.8 8-8.4 8a7.2 7.2 0 0 1-7.2-8z"/><path d="M22 30.4c2.3-1.2 3.4-3.5 3.4-6.9"/>',
  moon:   '<path d="M36 30.4A9.4 9.4 0 0 1 24.4 18.8a9.4 9.4 0 1 0 11.6 11.6z"/>',
  globe:  '<circle cx="27" cy="26.6" r="8.4"/><path d="M18.6 26.6h16.8"/><path d="M27 18.2c2.2 2.3 3.4 5.3 3.4 8.4s-1.2 6.1-3.4 8.4c-2.2-2.3-3.4-5.3-3.4-8.4s1.2-6.1 3.4-8.4z"/>',
  flame:  '<path d="M27 17.4c3 3.6 5.6 6.3 5.6 9.9a5.6 5.6 0 1 1-11.2 0c0-3.6 2.6-6.3 5.6-9.9z"/><path d="M27 33.6a2.7 2.7 0 0 0 2.7-2.7c0-1.7-1.4-2.7-2.7-4.4-1.3 1.7-2.7 2.7-2.7 4.4a2.7 2.7 0 0 0 2.7 2.7z"/>',
  jug:    '<path d="M21.6 18.4h8.6l-1 14.4a2 2 0 0 1-2 1.9h-2.6a2 2 0 0 1-2-1.9z"/><path d="M21.6 18.4 18 20.8l4 1.8"/><path d="M30.2 21.8a3.6 3.6 0 0 1 0 7.4"/>',
  wrench: '<path d="M31.4 20.2a4.5 4.5 0 0 1-6.1 6.1l-6 6 3.2 3.2 6-6a4.5 4.5 0 0 1 6.1-6.1l-2.8 2.8-2.3-2.3z"/>',
  sun:    '<circle cx="27" cy="26.6" r="4.3"/><path d="M27 15.9v2.8M27 34.5v2.8M19.1 18.7l2 2M32.9 32.5l2 2M16.3 26.6h2.8M34.9 26.6h2.8M19.1 34.5l2-2M32.9 20.7l2-2"/>',
  roast:  '<circle cx="27" cy="24.6" r="6.4"/><path d="M23.8 24.6a3.2 3.2 0 0 1 6.4 0"/><path d="M22.6 33.6c1.3 1.5 2.7 2.2 4.4 2.2s3.1-.7 4.4-2.2"/>',
  slider: '<path d="M20 17.4v6.6M20 28.4v8.2M27 17.4v2.4M27 24.4v12.2M34 17.4v11M34 32v.7"/><circle cx="20" cy="26.2" r="2.2"/><circle cx="27" cy="21.9" r="2.2"/><circle cx="34" cy="30.5" r="2.2"/>',
  clock:  '<circle cx="27" cy="26.6" r="8.4"/><path d="M27 20.9v5.7l4 2.3"/>',
};

function stampInnerSvg(stampKey) {
  const motif = ACH_STAMP_MOTIFS[stampKey];
  if (motif) return motif;
  // Text stamps ('90', '1:2', '30d', …) need no artwork — '5x' is the one
  // exception that's spelled out differently than it's stored, matching
  // the prototype's __STAMP_X5__.
  const txt = stampKey === '5x' ? '5×' : String(stampKey);
  const size = txt.length <= 2 ? 13 : (txt.length === 3 ? 11 : 9.4);
  return `<text x="27" y="27" text-anchor="middle" dominant-baseline="central" font-size="${size}" font-weight="700" fill="currentColor" stroke="none" style="font-family:Figtree,sans-serif;letter-spacing:-.02em">${esc(txt)}</text>`;
}

// A rough double-ring ink stamp, single-instance filter id — this view only
// ever has one card mounted at a time (unlike machine-icon.js's per-machine
// gradients), so a fixed id is safe; still scoped with an ach- prefix so it
// can never collide with the machine icon's own filter/gradient ids (#87's
// bug class, per PLAN.md's traps list).
export function stampSvg(stampKey) {
  return '<svg class="ach-stamp" viewBox="0 0 54 54" aria-hidden="true">' +
    '<g filter="url(#ach-rough-ink)" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<circle cx="27" cy="27" r="23.4" stroke-width="2.6"/><circle cx="27" cy="27" r="19.8" stroke-width=".9"/>' +
    stampInnerSvg(stampKey) + '</g></svg>';
}

// Deterministic per badge id — NOT Math.random(), which would re-jitter the
// same stamp to a new angle on every re-render (see PLAN.md's traps list:
// "jeder minimal schief" has to mean fixed-per-badge, not fixed-per-paint).
export function askewDeg(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (Math.imul(h, 31) + id.charCodeAt(i)) | 0;
  return (Math.abs(h) % 15) - 7; // -7..7 degrees
}

// unlockedAt is Unix SECONDS (lib/db.js's achievements table), not
// milliseconds — see AchievementService.getState()'s header comment.
export function formatStampedOn(unlockedAtSeconds, lang) {
  const d = new Date(unlockedAtSeconds * 1000);
  const locale = localeFor(lang);
  const dateStr = d.toLocaleDateString(locale, { day: '2-digit', month: '2-digit', year: 'numeric' });
  const timeStr = d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  return t('ach_stamped_on', dateStr, timeStr);
}

function formatFullDate(unlockedAtSeconds, lang) {
  return new Date(unlockedAtSeconds * 1000)
    .toLocaleDateString(localeFor(lang), { day: '2-digit', month: '2-digit', year: 'numeric' });
}

// A card (category) is full once every one of its badges — including any
// still-secret ones on the "secret" card — is unlocked. Per PLAN.md section
// 5: the diagonal "Full" overprint is per category, not a global collection
// state (that's a separate, out-of-scope "share the whole collection" idea).
export function isCardFull(badges) {
  return badges.length > 0 && badges.every(b => b.unlocked);
}

// Non-secret badges never carry name/description from the API (see
// AchievementService.getState()) — the frontend owns that copy via the
// ach_<id>_n/_d i18n keys already shipped in public-src/i18n/*.js. Secret
// badges carry neither field from the API until unlocked, so a locked
// secret badge renders nothing here by construction, not by a client-side
// guard that could be forgotten.
function badgeName(b) {
  if (b.secret) return b.unlocked ? b.name : null;
  return t(`ach_${b.id}_n`);
}
function badgeDesc(b) {
  if (b.secret) return b.unlocked ? b.description : null;
  return t(`ach_${b.id}_d`);
}
function badgeMeta(b) {
  if (b.unlocked) return formatStampedOn(b.unlockedAt, S.currentLang);
  if (b.secret) return t('ach_secret_locked_hint');
  if (b.progress) return t('ach_progress', b.progress.current, b.progress.target);
  return t('ach_not_yet');
}

const _state = { badges: [], page: 0 };

// Exported for test/achievements-view.test.js: a locked secret badge must
// emit neither its name nor its description, and that is the one property of
// this view worth nailing down at the HTML level rather than trusting
// badgeName()/badgeDesc() to keep returning null.
export function fieldHtml(b) {
  const rot = askewDeg(b.id);
  const secretLocked = b.secret && !b.unlocked;
  const label = secretLocked ? t('ach_card_secret') : (badgeName(b) || '');
  return `<button type="button" class="ach-field${b.unlocked ? ' ach-got' : ''}${secretLocked ? ' ach-secret' : ''}"
      style="--ach-rot:${rot}deg" data-ach-id="${esc(b.id)}" aria-label="${esc(label)}">
    <span class="ach-ring"></span>
    ${secretLocked ? '<span class="ach-qm">?</span>' : ''}
    ${b.unlocked ? `<span class="ach-ink">${stampSvg(b.stamp)}</span>` : ''}
  </button>`;
}

function pageHtml(cardBadges, idx) {
  const full = isCardFull(cardBadges);
  const overprint = full
    ? (() => {
        const latest = Math.max(...cardBadges.map(b => b.unlockedAt || 0));
        return `<div class="ach-overprint">${esc(t('ach_full'))}<span class="ach-overprint-date">${esc(formatFullDate(latest, S.currentLang))}</span></div>`;
      })()
    : '';
  return `<div class="ach-page${full ? ' ach-full' : ''}" data-ach-page="${idx}"${idx === 0 ? '' : ' hidden'}>
    <div class="ach-fields">${cardBadges.map(fieldHtml).join('')}</div>
    ${overprint}
  </div>`;
}

function updateFineline() {
  const key = CARD_KEYS[_state.page];
  const titleEl = document.getElementById('achTitle');
  if (titleEl) titleEl.textContent = t(CARD_NAME_KEYS[key]);
  const fineEl = document.getElementById('achFine');
  if (fineEl) fineEl.textContent = t('ach_card_of', _state.page + 1, CARD_KEYS.length);
}

function showPage(i) {
  const total = CARD_KEYS.length;
  _state.page = (i + total) % total;
  document.querySelectorAll('.ach-page').forEach((el, n) => {
    if (n === _state.page) el.removeAttribute('hidden'); else el.setAttribute('hidden', '');
  });
  document.querySelectorAll('.ach-pdot').forEach((el, n) => el.classList.toggle('ach-on', n === _state.page));
  updateFineline();
}

function showDetail(id) {
  const badge = _state.badges.find(b => b.id === id);
  if (!badge) return;
  document.querySelectorAll('.ach-field').forEach(el => el.removeAttribute('aria-current'));
  document.querySelector(`.ach-field[data-ach-id="${id}"]`)?.setAttribute('aria-current', 'true');

  const secretLocked = badge.secret && !badge.unlocked;
  const detail = document.getElementById('achDetail');
  const hint = document.getElementById('achDetailHint');
  const body = document.getElementById('achDetailBody');
  if (!detail || !hint || !body) return;
  detail.removeAttribute('data-empty');
  hint.style.display = 'none';
  body.style.display = '';
  document.getElementById('achDetailName').textContent = secretLocked ? t('ach_card_secret') : (badgeName(badge) || '');
  document.getElementById('achDetailDesc').textContent = secretLocked ? '' : (badgeDesc(badge) || '');
  document.getElementById('achDetailMeta').textContent = badgeMeta(badge);
}

function wireCardEvents() {
  document.getElementById('achPrev')?.addEventListener('click', () => showPage(_state.page - 1));
  document.getElementById('achNext')?.addEventListener('click', () => showPage(_state.page + 1));
  document.querySelectorAll('.ach-pdot').forEach(d => d.addEventListener('click', () => showPage(+d.dataset.achGo)));
  document.querySelectorAll('.ach-field').forEach(f => f.addEventListener('click', () => showDetail(f.dataset.achId)));
}

function renderCard() {
  const container = document.getElementById('achievements-view');
  if (!container) return;

  const byCard = new Map(CARD_KEYS.map(k => [k, []]));
  for (const b of _state.badges) { if (byCard.has(b.card)) byCard.get(b.card).push(b); }
  if (_state.page >= CARD_KEYS.length) _state.page = 0;

  const pagesHtml = CARD_KEYS.map((key, i) => pageHtml(byCard.get(key) || [], i)).join('');
  const dotsHtml = CARD_KEYS.map((key, i) =>
    `<button type="button" class="ach-pdot${i === _state.page ? ' ach-on' : ''}" data-ach-go="${i}" aria-label="${esc(t('ach_card_of', i + 1, CARD_KEYS.length))}"></button>`
  ).join('');

  container.innerHTML = `
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
          <span class="ach-title serif-display" id="achTitle"></span>
        </div>
        <div class="ach-grid">${pagesHtml}</div>
        <div class="ach-foot">
          <button type="button" class="ach-pg" id="achPrev" aria-label="${esc(t('ach_prev'))}">&lsaquo;</button>
          <span class="ach-dots">${dotsHtml}</span>
          <button type="button" class="ach-pg" id="achNext" aria-label="${esc(t('ach_next'))}">&rsaquo;</button>
        </div>
        <div class="ach-fineline"><span id="achFine"></span></div>
      </div>
    </div>
    <div class="ach-detail" id="achDetail" data-empty="1">
      <div class="ach-detail-hint" id="achDetailHint">${esc(t('ach_tap_hint'))}</div>
      <div class="ach-detail-body" id="achDetailBody" style="display:none">
        <div class="ach-detail-n" id="achDetailName"></div>
        <div class="ach-detail-d" id="achDetailDesc"></div>
        <div class="ach-detail-m" id="achDetailMeta"></div>
      </div>
    </div>
  `;

  updateFineline();
  wireCardEvents();
}

export async function loadAchievementsView() {
  const container = document.getElementById('achievements-view');
  if (!container) return;
  container.innerHTML = `<div class="loading-state">${t('ach_loading')}</div>`;
  try {
    const r = await apiFetch(`api/achievements?lang=${S.currentLang}`);
    const data = await r.json();
    _state.badges = data.badges || [];
    _state.page = 0;
    renderCard();
  } catch {
    container.innerHTML = `<div class="loading-state" style="color:var(--err)">${t('error_load')}</div>`;
  }
}
