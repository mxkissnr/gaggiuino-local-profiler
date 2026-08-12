import { S } from './state.js';

export async function initToken() {
  // Migration for pre-#522 installs: the token used to be cached in
  // localStorage under this key. Idempotent no-op once the key is gone.
  localStorage.removeItem('glp_token');
  try {
    // /api/token answers any caller that can reach the port by default (#533),
    // so a fresh token is normally available on every load — no need to
    // persist it (#522). #803: if the add-on's expose_api_port option is
    // turned off, this fetch 403s for a session that didn't arrive via HA
    // Ingress, and S.glpToken simply stays empty for the rest of this
    // session — see server.js's isIngressRequest() and routes/system.js's
    // GET /api/token.
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

// #807: "this session can't talk to the API because expose_api_port is off".
// Both inputs are already client-side: S.apiPortExposed mirrors the add-on
// option via the deliberately-public /api/status (components/status.js), and
// an empty S.glpToken means initToken()'s /api/token fetch was refused for
// this (non-Ingress) session. Callers pass the failed response's status so a
// plain 401/403 from any other cause still surfaces as itself; omitting it
// asks the plain "is this session in that state" question, which is what the
// app-wide banner needs.
export function isApiPortBlocked(status) {
  if (status != null && status !== 401 && status !== 403) return false;
  return S.apiPortExposed === false && !S.glpToken;
}
