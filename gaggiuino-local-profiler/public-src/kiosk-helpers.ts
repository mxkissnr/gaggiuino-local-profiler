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

// Variant chips are single choice: the server stores one variant per order (a
// `variant` string, max 50 chars), so tapping an unselected chip selects it on
// its own and tapping the selected chip clears the selection. The array shape
// keeps at most one entry, leaving the kiosk's store and renderer unchanged.
export function toggleVariantSelection(selected: readonly string[], variant: string): string[] {
  return selected.includes(variant) ? [] : [variant];
}

// The order body's variant field: the single chosen variant, or nothing when
// the guest picked none. The kiosk used to send `variants: [...]`, but the
// server only reads this `variant` string, so every order arrived variant-less.
export function variantOrderField(selected: readonly string[]): { variant?: string } {
  const chosen = selected[0];
  return chosen === undefined ? {} : { variant: chosen };
}
