import { describe, it, expect, afterEach, vi } from 'vitest';

// api/transport.js (and state/index.js) touch these browser globals at module
// load — stub the minimum so the module graph imports under vitest's node
// environment, the same bridge the sibling api tests use.
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
g.navigator ??= { language: 'en-US' };
g.window ??= globalThis;

const { postRestore } = await import('../public-src/api/system.js');

// A zip restore carries the passphrase in a header, and a header value can
// only hold ISO-8859-1 bytes — so a passphrase with umlauts/€ must travel as
// base64 of its UTF-8 bytes (X-GLP-Passphrase-B64), never raw in
// X-GLP-Passphrase.
describe('postRestore passphrase header (#1602)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends the UTF-8 passphrase base64 in X-GLP-Passphrase-B64 and no X-GLP-Passphrase', async () => {
    const fetchMock = vi.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) }));
    vi.stubGlobal('fetch', fetchMock);

    await postRestore({ zipBytes: new ArrayBuffer(4), passphrase: 'äö€' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('api/restore');
    const headers = init.headers as Record<string, string>;

    expect(headers['X-GLP-Passphrase']).toBeUndefined();

    const b64 = headers['X-GLP-Passphrase-B64'] ?? '';
    expect(b64).not.toBe('');
    const decoded = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    expect(Array.from(decoded)).toEqual(Array.from(new TextEncoder().encode('äö€')));
  });
});
