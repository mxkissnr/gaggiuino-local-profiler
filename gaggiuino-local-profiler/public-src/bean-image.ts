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
      // no-cache: a photo a browser stored under the old 24 h lifetime must be revalidated, not served from that still-fresh entry (an unchanged photo just costs a 304).
      const r = await apiFetch(url, { cache: 'no-cache' });
      if (!r.ok) return null;
      return URL.createObjectURL(await r.blob());
    } catch { return null; }
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

// #1351: the server serves a smaller thumbnail with ?thumb=1 (falling back to
// the full image) — used by the coffee-history spiral so a long shot history
// stays cheap to draw.
export function loadShotThumbBlobUrl(shotId: number): Promise<string | null> {
  return _load(`shotthumb:${shotId}`, `${shotImageUrl(shotId)}?thumb=1`);
}

export function invalidateShotImage(shotId: number): void {
  _cache.delete(`shot:${shotId}`);
  // #1351/#1539: the thumbnail is cached under its own key, so a replaced shot
  // photo must drop both entries.
  _cache.delete(`shotthumb:${shotId}`);
}

// #1539: a remote library change (or a whole-database one) can touch any bean,
// grinder, basket or puck-screen photo, with no per-entity id available, so drop
// every library cache entry at once. Shot photos are addressed per id and are
// invalidated separately, so they are deliberately left alone here.
export function invalidateLibraryImages(): void {
  const libraryKeys = ['bean:', 'grinder:', 'basket:', 'puckscreen:'];
  for (const key of [..._cache.keys()]) {
    if (libraryKeys.some((prefix) => key.startsWith(prefix))) _cache.delete(key);
  }
}
