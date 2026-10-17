import { describe, it, expect, afterEach } from 'vitest';
import { safeLocalStorage, safeSessionStorage } from '../public-src/storage.js';

// #1615: the safe wrapper must never throw, whether the storage global itself
// is unreadable (blocked storage) or a single call fails (quota), and must
// pass straight through to the real storage when it works.
const g = globalThis as unknown as Record<string, unknown>;

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() { return data.size; },
    key: (i: number) => [...data.keys()][i] ?? null,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, v); },
    removeItem: (k: string) => { data.delete(k); },
    clear: () => { data.clear(); },
  };
}

afterEach(() => {
  delete g.localStorage;
  delete g.sessionStorage;
});

describe('safe storage (#1615)', () => {
  it('passes reads and writes through to working storage', () => {
    g.localStorage = memoryStorage();
    g.sessionStorage = memoryStorage();
    safeLocalStorage.setItem('k', 'v');
    safeSessionStorage.setItem('k', 's');
    expect(safeLocalStorage.getItem('k')).toBe('v');
    expect(safeSessionStorage.getItem('k')).toBe('s');
    safeLocalStorage.removeItem('k');
    expect(safeLocalStorage.getItem('k')).toBeNull();
  });

  it('reads null and drops writes when the storage global throws on access', () => {
    for (const name of ['localStorage', 'sessionStorage']) {
      Object.defineProperty(g, name, {
        get() { throw new DOMException('The operation is insecure.', 'SecurityError'); },
        configurable: true,
      });
    }
    for (const store of [safeLocalStorage, safeSessionStorage]) {
      expect(() => store.setItem('k', 'v')).not.toThrow();
      expect(() => store.removeItem('k')).not.toThrow();
      expect(store.getItem('k')).toBeNull();
    }
  });

  it('swallows a failing individual call (quota exceeded)', () => {
    g.localStorage = { ...memoryStorage(), setItem: () => { throw new DOMException('full', 'QuotaExceededError'); } };
    expect(() => safeLocalStorage.setItem('k', 'v')).not.toThrow();
    expect(safeLocalStorage.getItem('k')).toBeNull();
  });
});
