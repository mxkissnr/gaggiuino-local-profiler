import { S } from './state.js';

export async function initToken() {
  // Try a cached token first (avoids a round trip on subsequent loads)
  const cached = localStorage.getItem('glp_token');
  if (cached) { S.glpToken = cached; }
  try {
    // /api/token is only served to requests arriving via the HA Supervisor ingress
    // (source 172.30.x.x) or to already-authenticated callers — not to unauthenticated
    // external LAN clients.
    const headers = S.glpToken ? { 'X-GLP-Token': S.glpToken } : {};
    const r = await fetch('api/token', { headers });
    if (r.ok) {
      const s = await r.json();
      if (s.apiToken && s.apiToken !== S.glpToken) {
        S.glpToken = s.apiToken;
        localStorage.setItem('glp_token', S.glpToken);
      }
    }
  } catch (e) {}
}

export async function apiFetch(url, opts = {}) {
  if (S.glpToken) opts = { ...opts, headers: { ...opts.headers, 'X-GLP-Token': S.glpToken } };
  return fetch(url, opts);
}
