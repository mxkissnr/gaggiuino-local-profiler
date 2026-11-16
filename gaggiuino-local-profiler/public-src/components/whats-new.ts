// "What's New" Settings card (#610) — always-visible in-app changelog,
// reading the hand-maintained shared/whats-new.ts. Static local data, no
// fetch — safe to render immediately at startup rather than waiting on
// initToken() like
// the token-gated cards do.
// #1956: the entry markup is shared with the What's New popup (boot/popups.ts).
import { getWhatsNewEntries } from '../shared/whats-new.js';
import type { WhatsNewEntry } from '../shared/whats-new.js';
import { esc as escapeHtml, html, joinHtml } from '../utils.js';
import type { Html } from '../utils.js';

export function whatsNewEntriesHtml(entries: readonly WhatsNewEntry[]): Html {
  return joinHtml(entries.map(entry => html`
    <div class="whats-new-entry">
      <h4 class="whats-new-version">v${escapeHtml(entry.version)} — ${escapeHtml(entry.date)}</h4>
      <ul class="whats-new-highlights">
        ${joinHtml(entry.highlights.map(h => html`<li>${escapeHtml(h)}</li>`))}
      </ul>
    </div>
  `));
}

export function renderWhatsNewCard(): void {
  const list = document.getElementById('whatsNewList');
  if (!list) return;
  list.innerHTML = whatsNewEntriesHtml(getWhatsNewEntries());
}
