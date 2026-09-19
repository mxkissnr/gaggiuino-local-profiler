// Package A3d: the api.js shim is being retired, and the seam the domain
// clients call through is now api/transport.ts. Importing the binding (rather
// than calling api/transport.ts's apiFetch from inside each client) keeps it
// swappable: a test that spies on transport.js's apiFetch still intercepts
// every domain request, because the re-export the spy patches and the binding
// read here are the same live module binding.
//
// api.js still exists for the call sites not yet swept (views/library.js's
// import-URL calls, views/shots/index.js's GaggiMate profile fetch, main.ts's
// own import) — it re-exports apiFetch from transport.js, so those raw calls
// and the typed clients below still resolve to the same live binding. Delete
// it only once those have moved over too.
import { apiFetch as _apiFetch } from './transport.js';

type FetchFn = (url: string, opts?: RequestInit) => Promise<Response>;

// The typed transport handle the domain clients (`./shots.js`, `./orders.js`)
// call through. Each invocation reads transport.js's apiFetch at call time —
// `_apiFetch` is never snapshotted into a local at import time — so a stub
// installed on transport.js's apiFetch intercepts the domain clients'
// requests too.
export const apiFetch: FetchFn = (url, opts) => _apiFetch(url, opts);

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
