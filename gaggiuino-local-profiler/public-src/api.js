import { S } from './state.js';

export async function initToken() {
  // Migration for pre-#522 installs: the token used to be cached in
  // localStorage under this key. Idempotent no-op once the key is gone.
  localStorage.removeItem('glp_token');
  try {
    // /api/token is only served to requests arriving via the HA Supervisor ingress
    // (source 172.30.x.x) or to already-authenticated callers — not to unauthenticated
    // external LAN clients. Ingress traffic is authorized purely by Supervisor IP +
    // X-Ingress-Path (see server.js isIngressRequest()), never by a client-held token,
    // so a fresh token is available on every load — no need to persist it (#522).
    const headers = S.glpToken ? { 'X-GLP-Token': S.glpToken } : {};
    const r = await fetch('api/token', { headers });
    if (r.ok) {
      const s = await r.json();
      // Re-check against the current value (not the pre-fetch snapshot used for
      // `headers` above) before writing — required by require-atomic-updates:
      // S.glpToken could have been changed by a concurrent initToken() call
      // while this fetch was in flight, and this keeps the write correct
      // instead of racing on stale data.
      if (s.apiToken && s.apiToken !== S.glpToken) {
        S.glpToken = s.apiToken;
      }
    }
  } catch { /* ignore */ }
}

export async function apiFetch(url, opts = {}) {
  if (S.glpToken) opts = { ...opts, headers: { ...opts.headers, 'X-GLP-Token': S.glpToken } };
  return fetch(url, opts);
}
