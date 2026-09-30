// "What's New" Settings card (#610) — always-visible in-app changelog,
// reading the hand-maintained lib/whats-new.js (shared with the backend
// via the same CommonJS-in-Vite pattern as lib/machines/theme-presets.js,
// see vite.config.js's commonjsOptions). Static local data, no fetch — safe
// to render immediately at startup rather than waiting on initToken() like
// the token-gated cards do.
import { getWhatsNewEntries } from '../shared/whats-new.js';
import { esc as escapeHtml, html, joinHtml } from '../utils.js';

export function renderWhatsNewCard(): void {
  const list = document.getElementById('whatsNewList');
  if (!list) return;
  list.innerHTML = joinHtml(getWhatsNewEntries().map(entry => html`
    <div class="whats-new-entry">
      <h4 class="whats-new-version">v${escapeHtml(entry.version)} — ${escapeHtml(entry.date)}</h4>
      <ul class="whats-new-highlights">
        ${joinHtml(entry.highlights.map(h => html`<li>${escapeHtml(h)}</li>`))}
      </ul>
    </div>
  `));
}
