// #1731: the guest kiosk's orders-only key. A kiosk link carries the key in
// its fragment; the page stores it, strips it from the address bar and uses it
// as the session credential instead of asking /api/token for the full token.
import { describe, it, expect, vi, beforeEach } from 'vitest';

// kiosk-helpers -> i18n -> state/index.ts reads localStorage at module load;
// vitest's node environment has none, so stub a Map-backed Storage first (same
// pattern as test/kiosk.test.ts and test/api-token-client-storage.test.ts).
const g = globalThis as unknown as Record<string, unknown>;
const store = new Map<string, string>();
g.localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k) ?? null : null),
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => { store.clear(); },
  key: () => null,
  length: 0,
};
g.window ??= globalThis;
g.document ??= { documentElement: {}, getElementById: () => undefined };

const { KIOSK_KEY_STORAGE, adoptKioskKey, kioskKeyFromHash, startKioskAuth } =
  await import('../public-src/kiosk-helpers.js');
const { S } = await import('../public-src/state/index.js');

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => (data.has(k) ? data.get(k) ?? null : null),
    setItem: (k: string, v: string) => { data.set(k, v); },
  };
}

beforeEach(() => {
  store.clear();
  S.glpToken = '';
});

describe('kiosk link fragment', () => {
  it('reads the key out of #key=...', () => {
    expect(kioskKeyFromHash('#key=abc123')).toBe('abc123');
    expect(kioskKeyFromHash('#other=1&key=abc123')).toBe('abc123');
  });

  it('is null without a key, and for an empty one', () => {
    expect(kioskKeyFromHash('')).toBeNull();
    expect(kioskKeyFromHash('#eink')).toBeNull();
    expect(kioskKeyFromHash('#key=')).toBeNull();
    expect(kioskKeyFromHash('#key=%20')).toBeNull();
  });
});

describe('adoptKioskKey', () => {
  it('stores the fragment key and strips the hash from the URL', () => {
    const storage = memoryStorage();
    const replaceUrl = vi.fn();
    const key = adoptKioskKey({
      hash: '#key=abc123',
      href: 'http://glp.local:8099/kiosk.html#key=abc123',
      storage,
      replaceUrl,
    });
    expect(key).toBe('abc123');
    expect(storage.getItem(KIOSK_KEY_STORAGE)).toBe('abc123');
    expect(replaceUrl).toHaveBeenCalledWith('http://glp.local:8099/kiosk.html');
  });

  it('reuses the stored key when the link carries none, leaving the URL alone', () => {
    const storage = memoryStorage();
    storage.setItem(KIOSK_KEY_STORAGE, 'stored-key');
    const replaceUrl = vi.fn();
    const key = adoptKioskKey({ hash: '', href: 'http://glp.local:8099/kiosk.html', storage, replaceUrl });
    expect(key).toBe('stored-key');
    expect(replaceUrl).not.toHaveBeenCalled();
  });

  it('returns null for a first visit without a link', () => {
    const replaceUrl = vi.fn();
    expect(adoptKioskKey({ hash: '', href: 'http://glp.local:8099/kiosk.html', storage: memoryStorage(), replaceUrl }))
      .toBeNull();
    expect(replaceUrl).not.toHaveBeenCalled();
  });
});

describe('startKioskAuth', () => {
  it('uses a stored kiosk key and never calls initToken', async () => {
    const initToken = vi.fn(() => Promise.resolve());
    const usedKioskKey = await startKioskAuth('kiosk-key-1', initToken);
    expect(usedKioskKey).toBe(true);
    expect(S.glpToken).toBe('kiosk-key-1');
    expect(initToken).not.toHaveBeenCalled();
  });

  it('falls back to initToken without a kiosk key, so existing kiosks keep working', async () => {
    const initToken = vi.fn(() => {
      S.glpToken = 'full-api-token';
      return Promise.resolve();
    });
    const usedKioskKey = await startKioskAuth(null, initToken);
    expect(usedKioskKey).toBe(false);
    expect(initToken).toHaveBeenCalledTimes(1);
    expect(S.glpToken).toBe('full-api-token');
  });
});
