import { describe, it, expect, beforeEach, vi } from 'vitest';

// api.js -> state.js touches localStorage/navigator at module-load time —
// stub the minimum browser globals so the module graph imports under
// vitest's node environment (same pattern as api-token-client-storage.test.js).
const _store = new Map();
globalThis.localStorage = {
  getItem: (k) => (_store.has(k) ? _store.get(k) : null),
  setItem: (k, v) => _store.set(k, String(v)),
  removeItem: (k) => _store.delete(k),
};
globalThis.navigator ??= { language: 'en-US' };

const { S } = await import('../public-src/state.js');
const { apiFetchToBlob, apiUpload } = await import('../public-src/api.js');

function fakeHeaders(entries) {
  const m = new Map(entries);
  return { get: (k) => (m.has(k) ? m.get(k) : null) };
}

function readerYielding(chunks) {
  let i = 0;
  return {
    getReader: () => ({
      read: () => (i < chunks.length
        ? Promise.resolve({ done: false, value: chunks[i++] })
        : Promise.resolve({ done: true, value: undefined })),
    }),
  };
}

beforeEach(() => {
  _store.clear();
  S.glpToken = '';
  vi.unstubAllGlobals();
});

describe('apiFetchToBlob', () => {
  it('reports progress from Content-Length and returns a Blob of the concatenated chunks', async () => {
    const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])];
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: true, status: 200,
      headers: fakeHeaders([['Content-Length', '5'], ['Content-Type', 'application/zip']]),
      body: readerYielding(chunks),
    })));

    const seen = [];
    const res = await apiFetchToBlob('api/backup', { onProgress: (r, t) => seen.push([r, t]) });

    expect(res.ok).toBe(true);
    expect(res.blob).toBeInstanceOf(Blob);
    expect(res.blob.size).toBe(5);
    expect(res.blob.type).toBe('application/zip');
    expect(seen).toEqual([[3, 5], [5, 5]]);
  });

  it('falls back to the estimateHeader value when Content-Length is absent', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: true, status: 200,
      headers: fakeHeaders([['X-GLP-Backup-Estimate', '10'], ['Content-Type', 'application/zip']]),
      body: readerYielding([new Uint8Array([1, 2])]),
    })));

    const seen = [];
    await apiFetchToBlob('api/backup', {
      estimateHeader: 'X-GLP-Backup-Estimate',
      onProgress: (r, t) => seen.push([r, t]),
    });

    expect(seen).toEqual([[2, 10]]);
  });

  it('passes total = null to onProgress when neither header is present (indeterminate)', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: true, status: 200,
      headers: fakeHeaders([['Content-Type', 'application/zip']]),
      body: readerYielding([new Uint8Array([9])]),
    })));

    const seen = [];
    await apiFetchToBlob('api/backup', {
      estimateHeader: 'X-GLP-Backup-Estimate',
      onProgress: (r, t) => seen.push([r, t]),
    });

    expect(seen).toEqual([[1, null]]);
  });

  it('returns { ok:false, status, errorText } without throwing on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: false, status: 500,
      headers: fakeHeaders([]),
      text: () => Promise.resolve('{"error":"boom"}'),
    })));

    const res = await apiFetchToBlob('api/backup', {});
    expect(res).toEqual({ ok: false, status: 500, errorText: '{"error":"boom"}' });
  });

  it('falls back to r.blob() when the response body has no getReader (JSDOM/Safari)', async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'application/octet-stream' });
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: true, status: 200,
      headers: fakeHeaders([]),
      body: null,
      blob: () => Promise.resolve(blob),
    })));

    const res = await apiFetchToBlob('api/debug/export-db', {});
    expect(res).toEqual({ ok: true, status: 200, blob });
  });
});

describe('apiUpload', () => {
  let lastXHR;

  class FakeXHR {
    constructor() {
      lastXHR = this;
      this.upload = {};
      this.headers = {};
    }
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader(k, v) { this.headers[k] = v; }
    send(body) {
      this.body = body;
      this.upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 10 });
      this.upload.onprogress?.({ lengthComputable: true, loaded: 10, total: 10 });
      this.status = 200;
      this.responseText = '{"ok":true}';
      this.onload();
    }
  }

  beforeEach(() => {
    lastXHR = undefined;
    vi.stubGlobal('XMLHttpRequest', FakeXHR);
  });

  it('injects X-GLP-Token from S.glpToken and forwards custom headers', async () => {
    S.glpToken = 'tok-123';
    await apiUpload('api/debug/import-db', {
      headers: { 'Content-Type': 'application/octet-stream' },
      body: 'BYTES',
    });
    expect(lastXHR.method).toBe('POST');
    expect(lastXHR.url).toBe('api/debug/import-db');
    expect(lastXHR.headers).toEqual({
      'X-GLP-Token': 'tok-123',
      'Content-Type': 'application/octet-stream',
    });
    expect(lastXHR.body).toBe('BYTES');
  });

  it('omits X-GLP-Token when there is no token', async () => {
    await apiUpload('api/x', { body: 'x' });
    expect(lastXHR.headers).toEqual({});
  });

  it('drives onProgress from lengthComputable upload events', async () => {
    const seen = [];
    await apiUpload('api/x', { body: 'x', onProgress: (s, t) => seen.push([s, t]) });
    expect(seen).toEqual([[5, 10], [10, 10]]);
  });

  it('resolves { ok, status, text } from xhr.status / responseText', async () => {
    const res = await apiUpload('api/x', { body: 'x' });
    expect(res).toEqual({ ok: true, status: 200, text: '{"ok":true}' });
  });

  it('rejects on a network error', async () => {
    class ErrXHR extends FakeXHR {
      send() { this.onerror(); }
    }
    vi.stubGlobal('XMLHttpRequest', ErrXHR);
    await expect(apiUpload('api/x', { body: 'x' })).rejects.toThrow('network error');
  });
});
