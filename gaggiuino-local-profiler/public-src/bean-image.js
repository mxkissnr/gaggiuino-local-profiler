import { apiFetch } from './api.js';

// Bean images require the auth token, so <img src="api/...​"> can't be used
// directly — fetch as a blob and hand back an object URL instead. Cached per
// bean id for the page lifetime (a bean's image never changes after import).
const _cache = new Map(); // beanId -> Promise<string|null>

export function loadBeanImageBlobUrl(beanId) {
  if (_cache.has(beanId)) return _cache.get(beanId);
  const p = (async () => {
    try {
      const r = await apiFetch(`api/library/bean/${beanId}/image`);
      if (!r.ok) return null;
      return URL.createObjectURL(await r.blob());
    } catch { return null; }
  })();
  _cache.set(beanId, p);
  return p;
}
