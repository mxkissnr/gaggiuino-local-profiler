// The seam every domain client (`./shots.ts`, `./orders.ts`, etc.) calls
// through, rather than importing api/transport.ts's apiFetch directly: a
// test that spies/mocks transport.ts's apiFetch still intercepts every
// domain request, because the binding read here is the same live module
// binding as the one the spy patches.
import { apiFetch as _apiFetch } from './transport.js';

type FetchFn = (url: string, opts?: RequestInit) => Promise<Response>;

// The typed transport handle the domain clients (`./shots.ts`, `./orders.ts`)
// call through. Each invocation reads transport.ts's apiFetch at call time —
// `_apiFetch` is never snapshotted into a local at import time — so a stub
// installed on transport.ts's apiFetch intercepts the domain clients'
// requests too.
export const apiFetch: FetchFn = (url, opts) =>
  opts === undefined ? _apiFetch(url) : _apiFetch(url, opts);

// apiFetchJson is the read-side companion to apiFetch: it runs a request
// through the facade above, parses the JSON body as T, and rejects on a
// non-ok status. Callers already treat a rejection as "no data" (every one
// has a `.catch`/try fallback: the orders view, kiosk, notify settings, MCP
// settings), so throwing here keeps a 4xx/5xx error body `{error: "..."}` from
// being handed back typed as the success shape (e.g. `Order[]`) and crashing
// later (`.map` on an object). The rejection message is the body's `error`
// string when the body is JSON carrying one, else `HTTP <status>`. `T` is the
// caller's view of the documented response body — schema.gen.ts documents only
// a subset of what most endpoints actually return, so the domain modules pass
// their own.
export async function apiFetchJson<T>(url: string, opts: RequestInit = {}): Promise<T> {
  const r = await apiFetch(url, opts);
  if (!r.ok) {
    let message = `HTTP ${r.status}`;
    try {
      const body = await r.json() as { error?: unknown } | null;
      if (body && typeof body.error === 'string') message = body.error;
    } catch { /* non-JSON body — keep the HTTP <status> message */ }
    throw new Error(message);
  }
  return (await r.json()) as T;
}

// The request options for a JSON body, POST unless another method is given
// (#1615: this used to be copied into five domain modules).
export function jsonBody(body: unknown, method = 'POST'): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

// Every id that goes into an API path or query goes through this.
export const pathSeg = (v: string | number): string => encodeURIComponent(String(v));

// The parsed body of an ok response as T, or null for a non-ok one: the
// "null on a non-ok response" convention the domain clients share.
export async function jsonOrNull<T>(r: Response): Promise<T | null> {
  return r.ok ? ((await r.json()) as T) : null;
}
