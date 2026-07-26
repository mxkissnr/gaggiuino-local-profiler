import { describe, it, expect, beforeEach, vi } from 'vitest';

// api.js/state.js's import chain touches localStorage/navigator at module
// load time — stub the minimum browser globals so the module graph can be
// imported under vitest's node environment, same pattern as
// test/bottom-nav-config.test.js. Backed by a real Map store (not an
// always-null stub) so the migration-cleanup test below can pre-seed a
// legacy token and assert it actually gets removed.
const _store = new Map();
const localStorageCalls = [];
globalThis.localStorage = {
  getItem: (k) => { localStorageCalls.push(['getItem', k]); return _store.has(k) ? _store.get(k) : null; },
  setItem: (k, v) => { localStorageCalls.push(['setItem', k, v]); _store.set(k, String(v)); },
  removeItem: (k) => { localStorageCalls.push(['removeItem', k]); _store.delete(k); },
};
globalThis.navigator ??= { language: 'en-US' };

const { S } = await import('../public-src/state.js');
const { initToken, apiFetch } = await import('../public-src/api.js');

// Snapshot the calls made while the modules above were *imported* (i.e.
// state.js's module-level `glpToken: ...` initializer) before beforeEach
// clears the log. This is intentionally never reset, so it stays a live
// check on state.js's own module-load-time behavior rather than a
// tautology — see the first test below.
const importTimeCalls = [...localStorageCalls];

beforeEach(() => {
  localStorageCalls.length = 0;
  _store.clear();
  S.glpToken = '';
  vi.unstubAllGlobals();
});

describe('GLP API token — client-side storage (#522, CodeQL js/clear-text-storage-of-sensitive-data)', () => {
  it('state.js never reads glp_token from localStorage at module-load time', () => {
    expect(importTimeCalls.filter(c => c[1] === 'glp_token')).toEqual([]);
  });

  it('starts with an in-memory-only, empty token', () => {
    expect(S.glpToken).toBe('');
  });

  it('initToken() populates S.glpToken from /api/token and never reads/writes it in localStorage', async () => {
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ apiToken: 'fresh-token-xyz' }) })
    ));

    await initToken();

    expect(S.glpToken).toBe('fresh-token-xyz');
    expect(localStorageCalls.filter(c => c[1] === 'glp_token' && c[0] !== 'removeItem')).toEqual([]);
  });

  it('a repeat initToken() call still refetches — no reliance on a cached value', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ apiToken: 'fresh-token-xyz' }) })
    );
    vi.stubGlobal('fetch', fetchMock);

    await initToken();
    await initToken();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(localStorageCalls.filter(c => c[1] === 'glp_token' && c[0] !== 'removeItem')).toEqual([]);
  });

  it('initToken() removes a pre-existing legacy token from localStorage (migration for pre-#522 installs)', async () => {
    _store.set('glp_token', 'stale-plaintext-token-from-before-522');
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false })));

    await initToken();

    expect(_store.has('glp_token')).toBe(false);
    expect(localStorageCalls).toContainEqual(['removeItem', 'glp_token']);
  });

  it('apiFetch() sends the in-memory token as a header without touching localStorage', async () => {
    S.glpToken = 'in-memory-token';
    const fetchMock = vi.fn(() => Promise.resolve({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await apiFetch('/api/shots');

    expect(fetchMock).toHaveBeenCalledWith('/api/shots', {
      headers: { 'X-GLP-Token': 'in-memory-token' },
    });
    expect(localStorageCalls.filter(c => c[1] === 'glp_token')).toEqual([]);
  });
});
