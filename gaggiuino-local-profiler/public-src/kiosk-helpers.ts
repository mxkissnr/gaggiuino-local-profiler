import { t } from './i18n.js';
import { S } from './state/index.js';
import type { SafeStorage } from './storage.js';
import type { Order, QueueEta } from './api/types.js';

// Pure helpers for the kiosk page, kept out of kiosk.ts so tests can import
// them without pulling in that module's bootstrap (which touches the DOM).
// Ported from the former server-rendered /ui/kiosk page's script.

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

// ── Orders-only kiosk key (#1731) ────────────────────────────────────────

/** Where the tablet keeps its orders-only key between loads. */
export const KIOSK_KEY_STORAGE = 'glp_kiosk_key';

// The key carried by a kiosk link's fragment (`kiosk.html#key=<key>`), or null
// when the hash has none. A blank value counts as none.
export function kioskKeyFromHash(hash: string): string | null {
  const key = new URLSearchParams(hash.replace(/^#/, '')).get('key')?.trim() ?? '';
  return key === '' ? null : key;
}

// Takes the key out of a kiosk link. A fragment key is stored and then stripped
// from the address bar (replaceState, so it never enters history) — it must not
// stay visible on a tablet that sits in the open. Returns the kiosk key now in
// effect: the fragment's, else the stored one from an earlier visit.
export function adoptKioskKey({ hash, href, storage, replaceUrl }: {
  hash: string;
  href: string;
  storage: Pick<SafeStorage, 'getItem' | 'setItem'>;
  replaceUrl: (url: string) => void;
}): string | null {
  const fromHash = kioskKeyFromHash(hash);
  if (fromHash === null) return storage.getItem(KIOSK_KEY_STORAGE) || null;
  storage.setItem(KIOSK_KEY_STORAGE, fromHash);
  const url = new URL(href);
  url.hash = '';
  replaceUrl(url.toString());
  return fromHash;
}

// Authenticates the kiosk: a stored key is the credential, so /api/token is not
// asked at all (it would hand back the full API token, which the tablet must
// not hold). Without a key the page keeps its pre-#1731 behaviour. Returns
// whether a kiosk key is in use, which the 401 hint keys off.
export async function startKioskAuth(key: string | null, initToken: () => Promise<void>): Promise<boolean> {
  if (key === null) {
    await initToken();
    return false;
  }
  S.glpToken = key;
  return true;
}
