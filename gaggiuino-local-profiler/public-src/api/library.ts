import { apiFetch } from './fetch.js';
import type {
  Basket, Bean, CoffeeLibrary, Grinder, Milk, PuckScreen, Recipe,
} from './types.js';

// Typed client for the `library` domain (go/internal/library — every route
// that package registers under /api/library*). Package A3c of the TS
// migration (#1110); the remaining domains stay on the api.js shim until
// their own runs.
//
// URL building and the JSON-headers boilerplate live here so the views never
// assemble an endpoint string or repeat the fetch options. Helpers whose
// result the caller inspects (`ok`/`status`/`statusText`/`json` for an error
// body) return the raw Response unchanged; the rest parse their body into the
// domain type and keep the error semantics of the call they replaced — a null
// on a non-ok response, matching api/shots.ts.

function _json(method: string, body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

async function _jsonOrNull<T>(r: Response): Promise<T | null> {
  return r.ok ? ((await r.json()) as T) : null;
}

// ── Whole library ────────────────────────────────────────────────────────

/**
 * GET /api/library — the full snapshot (beans, grinders, baskets, puck
 * screens, recipes, milks). Null on a non-ok response so the caller can keep
 * whatever it already has in S.coffeeLibrary.
 */
export async function getLibrary(): Promise<CoffeeLibrary | null> {
  return _jsonOrNull<CoffeeLibrary>(await apiFetch('api/library'));
}

// ── Beans ────────────────────────────────────────────────────────────────

/**
 * POST/PUT /api/library/bean[/{id}] — create (`id` null) or update a bean.
 * `payload` is the form's field set (see the Bean schema); returns the saved
 * bean, or null on a non-ok response.
 */
export async function saveBean(id: number | null, payload: unknown): Promise<Bean | null> {
  const url = id != null ? `api/library/bean/${id}` : 'api/library/bean';
  return _jsonOrNull<Bean>(await apiFetch(url, _json(id != null ? 'PUT' : 'POST', payload)));
}

/** POST /api/library/bean/{id}/new-bag — append a bag to the bean. */
export async function addBeanBag(id: number, payload: unknown): Promise<Bean | null> {
  return _jsonOrNull<Bean>(await apiFetch(`api/library/bean/${id}/new-bag`, _json('POST', payload)));
}

/** DELETE /api/library/bean/{beanId}/bag/{bagId} — drop one bag; returns the updated bean. */
export async function deleteBeanBag(beanId: number, bagId: number): Promise<Bean | null> {
  return _jsonOrNull<Bean>(await apiFetch(`api/library/bean/${beanId}/bag/${bagId}`, { method: 'DELETE' }));
}

/** PUT /api/library/bean/{beanId}/bag/{bagId} — edit a bag's mutable fields (full-replace; sortOrder optional/partial). */
export async function updateBeanBag(beanId: number, bagId: number, payload: unknown): Promise<Bean | null> {
  return _jsonOrNull<Bean>(await apiFetch(`api/library/bean/${beanId}/bag/${bagId}`, _json('PUT', payload)));
}

/** POST /api/library/bean/{id}/reorder-bags — bulk-reassign queue order for upcoming bags. */
export async function reorderBeanBags(id: number, bagIds: number[]): Promise<Bean | null> {
  return _jsonOrNull<Bean>(await apiFetch(`api/library/bean/${id}/reorder-bags`, _json('POST', { bagIds })));
}

/** POST /api/library/bean/{id}/freeze-portions — split part of the active bag into dated frozen portions. */
export async function freezeBeanPortions(id: number, payload: unknown): Promise<Bean | null> {
  return _jsonOrNull<Bean>(await apiFetch(`api/library/bean/${id}/freeze-portions`, _json('POST', payload)));
}

/** POST /api/library/bean/{beanId}/thaw-portion — thaw one portion of a frozen batch. */
export async function thawBeanPortion(beanId: number, payload: unknown): Promise<Bean | null> {
  return _jsonOrNull<Bean>(await apiFetch(`api/library/bean/${beanId}/thaw-portion`, _json('POST', payload)));
}

/** POST /api/library/bean/{beanId}/adjust-frozen-portion — correct a frozen-portion entry after the fact. */
export async function adjustFrozenPortion(beanId: number, payload: unknown): Promise<Bean | null> {
  return _jsonOrNull<Bean>(await apiFetch(`api/library/bean/${beanId}/adjust-frozen-portion`, _json('POST', payload)));
}

/** POST /api/library/bean/{id}/known-grind — remember a (grinder, grindSetting) pair. */
export async function saveBeanKnownGrind(
  id: number,
  payload: { grinder?: string; grindSetting?: string },
): Promise<Bean | null> {
  return _jsonOrNull<Bean>(await apiFetch(`api/library/bean/${id}/known-grind`, _json('POST', payload)));
}

/** POST /api/library/bean/{id}/toggle-active — manual override for the order card's bean picker (#578). */
export async function toggleBeanActive(id: number): Promise<Bean | null> {
  return _jsonOrNull<Bean>(await apiFetch(`api/library/bean/${id}/toggle-active`, { method: 'POST' }));
}

/** POST /api/library/bean/{id}/delete — permanently delete a bean. */
export function deleteBeanPermanently(id: number): Promise<Response> {
  return apiFetch(`api/library/bean/${id}/delete`, { method: 'POST' });
}

/** POST /api/library/bean/{id}/image — upload a (cropped) bean photo; raw Response so the caller can read the JSON error/statusText. */
export function uploadBeanImage(id: number, blob: Blob): Promise<Response> {
  return apiFetch(`api/library/bean/${id}/image`, { method: 'POST', headers: { 'Content-Type': blob.type }, body: blob });
}

// ── Grinders ─────────────────────────────────────────────────────────────

/** POST/PUT /api/library/grinder[/{id}] — create (`id` null) or update a grinder. */
export async function saveGrinder(id: number | null, payload: unknown): Promise<Grinder | null> {
  const url = id != null ? `api/library/grinder/${id}` : 'api/library/grinder';
  return _jsonOrNull<Grinder>(await apiFetch(url, _json(id != null ? 'PUT' : 'POST', payload)));
}

/** POST /api/library/grinder/{id}/reset-burrs — start a fresh burr-wear counting window. */
export async function resetGrinderBurrs(id: number): Promise<Grinder | null> {
  return _jsonOrNull<Grinder>(await apiFetch(`api/library/grinder/${id}/reset-burrs`, { method: 'POST' }));
}

/** POST /api/library/grinder/{id}/image — upload a (cropped) grinder photo; raw Response. */
export function uploadGrinderImage(id: number, blob: Blob): Promise<Response> {
  return apiFetch(`api/library/grinder/${id}/image`, { method: 'POST', headers: { 'Content-Type': blob.type }, body: blob });
}

/** POST /api/library/grinder/{id}/delete — permanently delete a grinder. */
export function deleteGrinderPermanently(id: number): Promise<Response> {
  return apiFetch(`api/library/grinder/${id}/delete`, { method: 'POST' });
}

// ── Recipes ──────────────────────────────────────────────────────────────

/** POST/PUT /api/library/recipe[/{id}] — create (`id` null) or update a recipe. */
export async function saveRecipe(id: number | null, payload: unknown): Promise<Recipe | null> {
  const url = id != null ? `api/library/recipe/${id}` : 'api/library/recipe';
  return _jsonOrNull<Recipe>(await apiFetch(url, _json(id != null ? 'PUT' : 'POST', payload)));
}

/** POST /api/library/recipe/{id}/delete — permanently delete a recipe. */
export function deleteRecipePermanently(id: number): Promise<Response> {
  return apiFetch(`api/library/recipe/${id}/delete`, { method: 'POST' });
}

// ── Milk ─────────────────────────────────────────────────────────────────

/** GET /api/library/milks — just the milk list (the annotation panel's pill source). */
export async function listMilks(): Promise<Milk[] | null> {
  return _jsonOrNull<Milk[]>(await apiFetch('api/library/milks'));
}

/** POST /api/library/milk — create a milk. */
export async function createMilk(payload: unknown): Promise<Milk | null> {
  return _jsonOrNull<Milk>(await apiFetch('api/library/milk', _json('POST', payload)));
}

/** POST /api/library/milk/{id}/restock — add `ml` to the milk's stock. */
export async function restockMilk(id: number, ml: number): Promise<Milk | null> {
  return _jsonOrNull<Milk>(await apiFetch(`api/library/milk/${id}/restock`, _json('POST', { ml })));
}

/** POST /api/library/milk/{id}/deduct — subtract the drink's `ml` from the milk's stock. */
export async function deductMilk(id: number, ml: number): Promise<Milk | null> {
  return _jsonOrNull<Milk>(await apiFetch(`api/library/milk/${id}/deduct`, _json('POST', { ml })));
}

/** DELETE /api/library/milk/{id} — permanently delete a milk. */
export function deleteMilkById(id: number): Promise<Response> {
  return apiFetch(`api/library/milk/${id}`, { method: 'DELETE' });
}

// ── Baskets (#635) ───────────────────────────────────────────────────────

/** POST/PUT /api/library/basket[/{id}] — create (`id` null) or update a basket. */
export async function saveBasket(id: number | null, payload: unknown): Promise<Basket | null> {
  const url = id != null ? `api/library/basket/${id}` : 'api/library/basket';
  return _jsonOrNull<Basket>(await apiFetch(url, _json(id != null ? 'PUT' : 'POST', payload)));
}

/** POST /api/library/basket/{id}/image — upload a (cropped) basket photo; raw Response. */
export function uploadBasketImage(id: number, blob: Blob): Promise<Response> {
  return apiFetch(`api/library/basket/${id}/image`, { method: 'POST', headers: { 'Content-Type': blob.type }, body: blob });
}

/** DELETE /api/library/basket/{id} — permanently delete a basket. */
export function deleteBasketById(id: number): Promise<Response> {
  return apiFetch(`api/library/basket/${id}`, { method: 'DELETE' });
}

// ── Puck screens (#635) ──────────────────────────────────────────────────

/** POST/PUT /api/library/puckscreen[/{id}] — create (`id` null) or update a puck screen. */
export async function savePuckScreen(id: number | null, payload: unknown): Promise<PuckScreen | null> {
  const url = id != null ? `api/library/puckscreen/${id}` : 'api/library/puckscreen';
  return _jsonOrNull<PuckScreen>(await apiFetch(url, _json(id != null ? 'PUT' : 'POST', payload)));
}

/** POST /api/library/puckscreen/{id}/image — upload a (cropped) puck-screen photo; raw Response. */
export function uploadPuckScreenImage(id: number, blob: Blob): Promise<Response> {
  return apiFetch(`api/library/puckscreen/${id}/image`, { method: 'POST', headers: { 'Content-Type': blob.type }, body: blob });
}

/** DELETE /api/library/puckscreen/{id} — permanently delete a puck screen. */
export function deletePuckScreenById(id: number): Promise<Response> {
  return apiFetch(`api/library/puckscreen/${id}`, { method: 'DELETE' });
}

// ── Barcode scan ─────────────────────────────────────────────────────────

/**
 * GET /api/library/scan/{barcode} — the Open Food Facts proxy lookup. Returns
 * the raw Response: the caller distinguishes "not found" (404) from any other
 * failure and reads the `{ name, roaster, notes }` body itself.
 */
export function scanBarcode(barcode: string): Promise<Response> {
  return apiFetch(`api/library/scan/${encodeURIComponent(barcode)}`);
}
