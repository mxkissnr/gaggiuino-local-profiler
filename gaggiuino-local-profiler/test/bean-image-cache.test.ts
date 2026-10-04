// #1357 (client side): a browser that stored a library/shot photo under the
// old `Cache-Control: max-age=86400` kept answering `fetch()` from that
// still-fresh entry, so a replaced photo survived a hard reload. The photo
// loader must ask for `cache: 'no-cache'` (revalidate; an unchanged photo is
// just a 304) while still sending the X-GLP-Token header.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// state/index.js reads localStorage/navigator at module-eval time; stub the
// minimum browser globals the import chain needs, same convention as
// test/api-token-client-storage.test.ts.
const g = globalThis as unknown as Record<string, unknown>;
const _store = new Map<string, string>();
g.localStorage = {
  getItem: (k: string) => _store.get(k) ?? null,
  setItem: (k: string, v: unknown) => { _store.set(k, String(v)); },
  removeItem: (k: string) => { _store.delete(k); },
};
g.navigator ??= { language: 'en-US' };

const { S } = await import('../public-src/state/index.js');
const { loadBeanImageBlobUrl, loadShotImageBlobUrl } = await import('../public-src/bean-image.js');

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, blob: () => Promise.resolve(new Blob(['photo'])) });
  vi.stubGlobal('fetch', fetchMock);
  g.URL = { createObjectURL: vi.fn(() => 'blob:fake') };
  S.glpToken = '';
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('bean-image photo fetches revalidate (#1357)', () => {
  it("requests a bean photo with cache: 'no-cache'", async () => {
    await expect(loadBeanImageBlobUrl(1)).resolves.toBe('blob:fake');
    expect(fetchMock).toHaveBeenCalledWith('api/library/bean/1/image', { cache: 'no-cache' });
  });

  it("requests a shot photo with cache: 'no-cache'", async () => {
    await loadShotImageBlobUrl(2);
    expect(fetchMock).toHaveBeenCalledWith('api/shots/2/image', { cache: 'no-cache' });
  });

  it('still injects the X-GLP-Token header alongside the cache option', async () => {
    S.glpToken = 'tok-abc';
    await loadBeanImageBlobUrl(3);
    expect(fetchMock).toHaveBeenCalledWith('api/library/bean/3/image', {
      cache: 'no-cache',
      headers: { 'X-GLP-Token': 'tok-abc' },
    });
  });
});
