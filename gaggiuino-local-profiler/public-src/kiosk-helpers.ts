import { t } from './i18n.js';
import type { Order, QueueEta } from './api/types.js';

// Pure helpers for the kiosk page, kept out of kiosk.ts so tests can import
// them without pulling in that module's bootstrap (which touches the DOM).
// Ported from the old /ui/kiosk's static/kiosk.js.

// The queue row's ETA label: an accepted order counts down from its own
// acceptedAt + eta; a still-pending one falls back to the rolling queue
// estimate; with neither there is no label. `now` is passed in (not read from
// Date.now()) so the local-vs-overdue boundary is testable.
export function etaText(order: Order, eta: QueueEta | null, now: number): string {
  if (order.status === 'accepted' && order.acceptedAt != null && order.eta != null) {
    const remaining = Math.ceil((order.acceptedAt + order.eta * 60000 - now) / 60000);
    return remaining > 0 ? t('kiosk_eta_minutes', remaining) : t('kiosk_almost_ready');
  }
  const position = eta?.positions[order.id];
  return position ? t('kiosk_eta_minutes', position.suggestedEta) : '';
}

// ?eink=1 puts the page in its e-ink stylesheet (see kiosk.css's html.eink).
export function isEinkMode(search: string): boolean {
  return new URLSearchParams(search).get('eink') === '1';
}
