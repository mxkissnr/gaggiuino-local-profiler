import { apiFetch } from './fetch.js';
import type { MqttSettings } from './types.js';

// Typed client for the `mqtt` domain (go/internal/mqtt — its four routes:
// GET /api/mqtt/discovery, GET/POST /api/mqtt/settings,
// POST /api/mqtt/apply-to-machine). Package A3d of the TS migration (#1110).
//
// URL building and the JSON-headers boilerplate live here. Helpers whose
// result the caller inspects (`ok`/status and the server's error body) return
// the raw Response unchanged, matching api/maintenance.ts.

function _json(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

/** GET /api/mqtt/settings — the redacted settings view (`hasPassword`, never the stored password). */
export function getMqttSettings(): Promise<Response> {
  return apiFetch('api/mqtt/settings');
}

/** GET /api/mqtt/discovery — Supervisor auto-discovery fallback for the broker fields. */
export function getMqttDiscovery(): Promise<Response> {
  return apiFetch('api/mqtt/discovery');
}

/** POST /api/mqtt/settings — save the connection; the caller reads the JSON error body on a non-ok. */
export function saveMqttSettings(payload: MqttSettings): Promise<Response> {
  return apiFetch('api/mqtt/settings', _json(payload));
}

/** POST /api/mqtt/apply-to-machine — push the saved connection to the machine (#598). */
export function applyMqttToMachine(): Promise<Response> {
  return apiFetch('api/mqtt/apply-to-machine', { method: 'POST' });
}
