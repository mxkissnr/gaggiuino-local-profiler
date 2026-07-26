import { S } from './state.js';

export async function initToken() {
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
