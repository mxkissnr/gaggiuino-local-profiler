import { apiFetch } from './api/transport.js';
import { shotImageUrl } from './api/shots.js';

// Bean/grinder/shot images require the auth token, so <img src="api/...">
// can't be used directly — fetch as a blob and hand back an object URL
// instead. Cached per entity for the page lifetime; photos can be
// re-uploaded/removed, so invalidate*Image() clears a stale cache entry.
const _cache = new Map(); // 'bean:<id>' | 'grinder:<id>' | 'shot:<id>' -> Promise<string|null>

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

export function invalidateBeanImage(beanId) {
  _cache.delete(`bean:${beanId}`);
}

// #635: basket/puck screen photos — same pattern as bean/grinder images.
export function loadBasketImageBlobUrl(basketId) {
  return _load(`basket:${basketId}`, `api/library/basket/${basketId}/image`);
}

export function invalidateBasketImage(basketId) {
  _cache.delete(`basket:${basketId}`);
}

export function loadPuckScreenImageBlobUrl(puckScreenId) {
  return _load(`puckscreen:${puckScreenId}`, `api/library/puckscreen/${puckScreenId}/image`);
}

export function invalidatePuckScreenImage(puckScreenId) {
  _cache.delete(`puckscreen:${puckScreenId}`);
}

export function loadShotImageBlobUrl(shotId) {
  return _load(`shot:${shotId}`, shotImageUrl(shotId));
}

export function invalidateShotImage(shotId) {
  _cache.delete(`shot:${shotId}`);
}
