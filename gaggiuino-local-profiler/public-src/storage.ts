// Web Storage that survives a browser blocking it (#1615). With cookies/site
// data blocked, Safari private mode or a sandboxed iframe, merely reading the
// `localStorage` global throws a SecurityError, and getItem/setItem can throw
// too (QuotaExceededError). Reads then fall back to null and writes are
// dropped, so the app still starts and runs, just without remembering choices
// across reloads.
//
// Same getItem/setItem/removeItem shape as Storage, so call sites (and
// theme.ts's injectable `storage` option) swap over without changing anything
// else. The underlying storage is resolved on every call, never cached at
// import, so a test stubbing the global still takes effect.
export type SafeStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function _safe(resolve: () => Storage): SafeStorage {
  return {
    getItem(key) {
      try { return resolve().getItem(key); } catch { return null; }
    },
    setItem(key, value) {
      try { resolve().setItem(key, value); } catch { /* blocked or full */ }
    },
    removeItem(key) {
      try { resolve().removeItem(key); } catch { /* blocked */ }
    },
  };
}

export const safeLocalStorage: SafeStorage = _safe(() => localStorage);
export const safeSessionStorage: SafeStorage = _safe(() => sessionStorage);
