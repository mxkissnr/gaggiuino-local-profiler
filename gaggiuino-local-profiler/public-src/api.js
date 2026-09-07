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

// apiFetchToBlob runs a request through apiFetch and reads the response body
// as a Blob, reporting download progress along the way. `total` passed to
// onProgress is the Content-Length if present, else the value of the
// `estimateHeader` response header (POST /api/backup's approximate
// X-GLP-Backup-Estimate — the Node backend never sends it), else null for
// "indeterminate". A non-numeric/zero header is treated as null too.
//
// The whole body is buffered in browser memory before the caller builds an
// object-URL download from the returned Blob. That is acceptable for the
// tens-of-MB database/backup files this is used for, not for a
// general-purpose streaming download.
export async function apiFetchToBlob(url, { opts = {}, onProgress, estimateHeader } = {}) {
  const r = await apiFetch(url, opts);
  if (!r.ok) {
    return { ok: false, status: r.status, errorText: await r.text().catch(() => '') };
  }
  // Safari <14.1 / JSDOM: no streaming body reader — fall back to r.blob(),
  // which still works, just without progress events.
  if (!r.body || typeof r.body.getReader !== 'function') {
    return { ok: true, status: r.status, blob: await r.blob() };
  }

  const finitePositive = (v) => (Number.isFinite(v) && v > 0 ? v : null);
  const total = finitePositive(Number(r.headers.get('Content-Length')))
    ?? (estimateHeader ? finitePositive(Number(r.headers.get(estimateHeader))) : null);

  const reader = r.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress?.(received, total);
  }
  const type = r.headers.get('Content-Type') || 'application/octet-stream';
  return { ok: true, status: r.status, blob: new Blob(chunks, { type }) };
}

// apiUpload sends a body via XMLHttpRequest so upload progress
// (xhr.upload.onprogress) is observable — fetch() has no equivalent. It
// mirrors apiFetch's X-GLP-Token injection and forwards any custom headers.
// All mutable state stays inside the executor (require-atomic-updates).
export function apiUpload(url, { method = 'POST', headers = {}, body, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    if (S.glpToken) xhr.setRequestHeader('X-GLP-Token', S.glpToken);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded, e.total);
    };
    xhr.onload = () => resolve({
      ok: xhr.status >= 200 && xhr.status < 300,
      status: xhr.status,
      text: xhr.responseText,
    });
    xhr.onerror = () => reject(new Error('network error'));
    xhr.send(body);
  });
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
