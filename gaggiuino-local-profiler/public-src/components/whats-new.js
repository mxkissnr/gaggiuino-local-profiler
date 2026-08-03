// "What's New" Settings card (#610) — always-visible in-app changelog,
// reading the hand-maintained lib/whats-new.js (shared with the backend
// via the same CommonJS-in-Vite pattern as lib/machines/theme-presets.js,
// see vite.config.js's commonjsOptions). Static local data, no fetch — safe
// to render immediately at startup rather than waiting on initToken() like
// the token-gated cards do.
import { getWhatsNewEntries } from '../../lib/whats-new.js';

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function renderWhatsNewCard() {
  const list = document.getElementById('whatsNewList');
  if (!list) return;
  list.innerHTML = getWhatsNewEntries().map(entry => `
    <div class="whats-new-entry">
      <h4 class="whats-new-version">v${escapeHtml(entry.version)} — ${escapeHtml(entry.date)}</h4>
      <ul class="whats-new-highlights">
        ${entry.highlights.map(h => `<li>${escapeHtml(h)}</li>`).join('')}
      </ul>
    </div>
  `).join('');
}
