import { apiFetch, apiFetchJson } from './transport.js';
import type {
  MenuItem, MilkStock, NotifyMapping, NotifyMappingView, NotifyService, Order, OrderStats,
  OrdersSettings, OrdersSettingsUpdate, QueueEta,
} from './types.js';

// Typed client for the `orders` domain (go/internal/orders — every /api/orders*
// route, plus the deliberately-ungated GET /api/menu that package also owns).
// Package A3b of the TS migration (#1110).
//
// Same contract as api/shots.ts: URL building and the JSON-headers boilerplate
// live here. Read helpers parse and reject on a non-ok status (callers keep
// their `.catch(() => fallback)`); mutation helpers return the raw Response
// where the caller inspects `ok`/`status`.

// ── Settings ─────────────────────────────────────────────────────────────

/** GET /api/orders/settings. */
export function getOrdersSettings(): Promise<OrdersSettings> {
  return apiFetchJson<OrdersSettings>('api/orders/settings');
}

/**
 * POST /api/orders/settings — the backend overwrites the stored blob, so
 * callers round-trip the keys they want to keep and `enabled` is required.
 */
export function postOrdersSettings(settings: OrdersSettingsUpdate): Promise<Response> {
  return apiFetch('api/orders/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
}

// ── Orders / queue / stats ───────────────────────────────────────────────

/** GET /api/orders — active (pending + accepted) orders, newest-first. */
export function listOrders(): Promise<Order[]> {
  return apiFetchJson<Order[]>('api/orders');
}

/** GET /api/orders/queue-eta. */
export function getQueueEta(): Promise<QueueEta> {
  return apiFetchJson<QueueEta>('api/orders/queue-eta');
}

/** GET /api/orders/milk-stock — per-milk stock left after active-order demand. */
export function getMilkStock(): Promise<MilkStock[]> {
  return apiFetchJson<MilkStock[]>('api/orders/milk-stock');
}

/** GET /api/orders/stats — completed-order rollups. */
export function getOrdersStats(): Promise<OrderStats> {
  return apiFetchJson<OrderStats>('api/orders/stats');
}

/** POST /api/orders/{id}/accept. */
export function postOrderAccept(id: string, eta: number): Promise<Response> {
  return apiFetch(`api/orders/${id}/accept`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ eta }),
  });
}

/** POST /api/orders/{id}/decline. */
export function postOrderDecline(id: string, reason: string): Promise<Response> {
  return apiFetch(`api/orders/${id}/decline`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason }),
  });
}

/** POST /api/orders/{id}/complete. */
export function postOrderComplete(id: string): Promise<Response> {
  return apiFetch(`api/orders/${id}/complete`, { method: 'POST' });
}

/** DELETE /api/orders/{id}. */
export function deleteOrderById(id: string): Promise<Response> {
  return apiFetch(`api/orders/${id}`, { method: 'DELETE' });
}

/** DELETE /api/orders/history — clears every done/declined order. */
export function deleteOrderHistory(): Promise<Response> {
  return apiFetch('api/orders/history', { method: 'DELETE' });
}

// ── Menu ─────────────────────────────────────────────────────────────────

/** GET /api/orders/menu (the gated twin of GET /api/menu). */
export function getOrdersMenu(): Promise<MenuItem[]> {
  return apiFetchJson<MenuItem[]>('api/orders/menu');
}

/** POST /api/orders/menu — add a drink to the menu. */
export function postOrdersMenu({ name, emoji }: { name: string; emoji: string }): Promise<Response> {
  return apiFetch('api/orders/menu', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, emoji }),
  });
}

/** PUT /api/orders/menu/{id} — patch one menu item (trending/milkMl/variants/useBeans/useMilks). */
export function putMenuItem(id: string, patch: Partial<MenuItem>): Promise<Response> {
  return apiFetch(`api/orders/menu/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

/** DELETE /api/orders/menu/{id}. */
export function deleteMenuItem(id: string): Promise<Response> {
  return apiFetch(`api/orders/menu/${id}`, { method: 'DELETE' });
}

// ── Notifications ────────────────────────────────────────────────────────

/** GET /api/orders/notify-services — the HA notify.* services (empty when HA is off). */
export function getNotifyServices(): Promise<NotifyService[]> {
  return apiFetchJson<NotifyService[]>('api/orders/notify-services');
}

/** GET /api/orders/notify-mapping — saved haUserId→service map plus known customer names. */
export function getNotifyMapping(): Promise<NotifyMappingView> {
  return apiFetchJson<NotifyMappingView>('api/orders/notify-mapping');
}

/** POST /api/orders/notify-mapping — replace the haUserId→service map. */
export function postNotifyMapping(mapping: NotifyMapping): Promise<Response> {
  return apiFetch('api/orders/notify-mapping', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(mapping),
  });
}
