import { apiFetch } from './api.js';

// Bean/grinder images require the auth token, so <img src="api/...​"> can't be
// used directly — fetch as a blob and hand back an object URL instead. Cached
// per entity for the page lifetime; grinder photos can be re-uploaded, so
// invalidateGrinderImage() clears a stale cache entry after a new upload.
const _cache = new Map(); // 'bean:<id>' | 'grinder:<id>' -> Promise<string|null>

function _load(key, url) {
  if (_cache.has(key)) return _cache.get(key);
  const p = (async () => {
    try {
      const r = await apiFetch(url);
      if (!r.ok) return null;
      return URL.createObjectURL(await r.blob());
    } catch { return null; }
  })();
  _cache.set(key, p);
  return p;
}

export function loadBeanImageBlobUrl(beanId) {
  return _load(`bean:${beanId}`, `api/library/bean/${beanId}/image`);
}

export function loadGrinderImageBlobUrl(grinderId) {
  return _load(`grinder:${grinderId}`, `api/library/grinder/${grinderId}/image`);
}

export function invalidateGrinderImage(grinderId) {
  _cache.delete(`grinder:${grinderId}`);
}
