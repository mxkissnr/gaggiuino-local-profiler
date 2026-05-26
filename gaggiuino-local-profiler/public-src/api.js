import { S } from './state.js';

export async function initToken() {
  try {
    const r = await fetch('api/status');
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
