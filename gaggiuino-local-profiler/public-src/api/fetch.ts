// @ts-expect-error TS7016: api.js is untyped JS (the shim is deleted once the
// A3 sweep finishes) — imported on purpose, see below.
import { apiFetch as _apiFetch } from '../api.js';

type FetchFn = (url: string, opts?: RequestInit) => Promise<Response>;

// The typed transport handle the domain clients (`./shots.js`, `./orders.js`)
// call through. Each invocation reads api.js's re-exported apiFetch at call
// time — `_apiFetch` is never snapshotted into a local at import time — so a
// stub installed on api.js's apiFetch (the seam the test suite swaps out, and
// the one every remaining raw call site still uses) intercepts the domain
// clients' requests too. That indirection is the reason the clients must not
// import api/transport.ts directly.
export const apiFetch: FetchFn = (url, opts) => (_apiFetch as FetchFn)(url, opts);

// apiFetchJson is the read-side companion to apiFetch: it runs a request
// through the facade above and parses the JSON body as T. Deliberately
// status-agnostic — it mirrors the `.then(r => r.json())` it replaced, so a
// network or parse failure still rejects (letting callers keep their
// `.catch(() => fallback)`) and an error *body* is handed back as-is; the one
// pair that needs to gate on `ok` (api/shots.ts's shot-defaults helpers)
// checks it itself. `T` is the caller's view of the documented response body —
// schema.gen.ts documents only a subset of what most endpoints actually
// return, so the domain modules pass their own.
export async function apiFetchJson<T>(url: string, opts: RequestInit = {}): Promise<T> {
  const r = await apiFetch(url, opts);
  return (await r.json()) as T;
}
