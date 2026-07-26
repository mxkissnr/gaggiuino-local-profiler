import { describe, it, expect, beforeEach, vi } from 'vitest';

// api.js/state.js's import chain touches localStorage/navigator at module
// load time — stub the minimum browser globals so the module graph can be
// imported under vitest's node environment, same pattern as
// test/bottom-nav-config.test.js. This test tracks every localStorage call
// (rather than backing it with a real store) because the whole point of
// #522 is asserting the token is *never* persisted there.
const localStorageCalls = [];
globalThis.localStorage = {
  getItem: (k) => { localStorageCalls.push(['getItem', k]); return null; },
  setItem: (k, v) => { localStorageCalls.push(['setItem', k, v]); },
  removeItem: (k) => { localStorageCalls.push(['removeItem', k]); },
};
globalThis.navigator ??= { language: 'en-US' };

const { S } = await import('../public-src/state.js');
const { initToken, apiFetch } = await import('../public-src/api.js');

beforeEach(() => {
  localStorageCalls.length = 0;
  S.glpToken = '';
  vi.unstubAllGlobals();
});

describe('GLP API token — client-side storage (#522, CodeQL js/clear-text-storage-of-sensitive-data)', () => {
  it('starts with an in-memory-only, empty token — never read from localStorage', () => {
    expect(S.glpToken).toBe('');
    expect(localStorageCalls.filter(c => c[1] === 'glp_token')).toEqual([]);
  });

  it('initToken() populates S.glpToken from /api/token without ever touching localStorage', async () => {
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ apiToken: 'fresh-token-xyz' }) })
    ));

    await initToken();

    expect(S.glpToken).toBe('fresh-token-xyz');
    expect(localStorageCalls.filter(c => c[1] === 'glp_token')).toEqual([]);
  });

  it('a repeat initToken() call still refetches — no reliance on a cached value', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ apiToken: 'fresh-token-xyz' }) })
    );
    vi.stubGlobal('fetch', fetchMock);

    await initToken();
    await initToken();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(localStorageCalls.filter(c => c[1] === 'glp_token')).toEqual([]);
  });

  it('apiFetch() sends the in-memory token as a header without reading localStorage', async () => {
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
