import { apiFetch } from './api/transport.js';
import { shotImageUrl } from './api/shots.js';

// Bean/grinder/shot images require the auth token, so <img src="api/...">
// can't be used directly — fetch as a blob and hand back an object URL
// instead. Cached per entity for the page lifetime; photos can be
// re-uploaded/removed, so invalidate*Image() clears a stale cache entry.
// 'bean:<id>' | 'grinder:<id>' | 'shot:<id>' -> Promise<string|null>
const _cache = new Map<string, Promise<string | null>>();

function _load(key: string, url: string): Promise<string | null> {
  if (_cache.has(key)) return _cache.get(key)!;
  const p = (async () => {
    try {
      const r = await apiFetch(url);
      if (!r.ok) {
        // #1185: a restore can write an entity's photo a moment after the list
        // first renders, and a transient failure (token not ready, a 404 while
        // the file is still landing) used to cache `null` for the whole page's
        // life — the thumbnail then stayed blank on every later render with no
        // retry. Drop the failed entry so the next render re-fetches.
        _cache.delete(key);
        return null;
      }
      return URL.createObjectURL(await r.blob());
    } catch {
      _cache.delete(key);
      return null;
    }
  })();
  _cache.set(key, p);
  return p;
}

export function loadBeanImageBlobUrl(beanId: unknown): Promise<string | null> {
  return _load(`bean:${beanId as string}`, `api/library/bean/${beanId as string}/image`);
}

export function loadGrinderImageBlobUrl(grinderId: unknown): Promise<string | null> {
  return _load(`grinder:${grinderId as string}`, `api/library/grinder/${grinderId as string}/image`);
}

export function invalidateGrinderImage(grinderId: unknown): void {
  _cache.delete(`grinder:${grinderId as string}`);
}

export function invalidateBeanImage(beanId: unknown): void {
  _cache.delete(`bean:${beanId as string}`);
}

// #635: basket/puck screen photos — same pattern as bean/grinder images.
export function loadBasketImageBlobUrl(basketId: unknown): Promise<string | null> {
  return _load(`basket:${basketId as string}`, `api/library/basket/${basketId as string}/image`);
}

export function invalidateBasketImage(basketId: unknown): void {
  _cache.delete(`basket:${basketId as string}`);
}

export function loadPuckScreenImageBlobUrl(puckScreenId: unknown): Promise<string | null> {
  return _load(`puckscreen:${puckScreenId as string}`, `api/library/puckscreen/${puckScreenId as string}/image`);
}

export function invalidatePuckScreenImage(puckScreenId: unknown): void {
  _cache.delete(`puckscreen:${puckScreenId as string}`);
}

export function loadShotImageBlobUrl(shotId: number): Promise<string | null> {
  return _load(`shot:${shotId}`, shotImageUrl(shotId));
}

export function invalidateShotImage(shotId: number): void {
  _cache.delete(`shot:${shotId}`);
}
