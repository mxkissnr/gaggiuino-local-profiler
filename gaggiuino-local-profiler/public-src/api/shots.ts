import { apiFetch } from './fetch.js';
import type { HydratedShot, ShotAnnotation, ShotDefaults } from './types.js';

// Typed client for the `shots` domain (go/internal/shots — every route that
// package registers: /shots.json plus /api/shots*). Package A3b of the TS
// migration (#1110); the remaining domains stay on the api.js shim until
// their own runs.
//
// URL building lives here so the views never assemble an endpoint string or
// repeat the JSON-headers boilerplate. Helpers whose result the caller
// inspects (`ok`/`status`/`text`/`blob`) return the raw Response unchanged;
// the rest parse their body into the domain type and keep the error semantics
// of the call they replaced — see api/fetch.ts.

/** Query parameters for GET /api/shots — the keyset-paginated metadata list. */
export interface ListShotsParams {
  /** Page size. */
  limit: number;
  /** Opaque cursor from the previous page's `nextCursor`. */
  cursor?: string | null;
  /** List trashed shots instead of live ones. */
  trash?: boolean;
}

/**
 * GET /api/shots — one page of shot METADATA (no `datapoints`), newest-first.
 * Body: `{ shots: HydratedShot[]; nextCursor: string | null; hasMore: boolean }`.
 *
 * Returns the raw Response because the caller keys the pre-#957 Node-backend
 * fallback off a 404 and reports the failing status through the page state.
 */
export function listShots({ limit, cursor, trash = false }: ListShotsParams): Promise<Response> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor) params.set('cursor', cursor);
  if (trash) params.set('trash', '1');
  return apiFetch(`api/shots?${params}`);
}

/**
 * GET /shots.json — the full dump (timestamp-ASC, `datapoints` inline) the
 * frozen Node backend still serves. Body: `HydratedShot[]`. Only reached when
 * {@link listShots} answers 404.
 */
export function listShotsDump({ trash = false }: { trash?: boolean } = {}): Promise<Response> {
  return apiFetch(trash ? 'shots.json?trash=1' : 'shots.json');
}

/**
 * GET /api/shots/{id} — the full hydrated shot including `datapoints` and the
 * previous same-profile shot. Resolves to null when the shot isn't there (or
 * the request is otherwise rejected with a status), so the curve cache can
 * treat it as transient and retry later.
 */
export async function getShot(id: number): Promise<HydratedShot | null> {
  const r = await apiFetch(`api/shots/${id}`);
  return r.ok ? ((await r.json()) as HydratedShot) : null;
}

/**
 * URL of the stored shot photo (GET /api/shots/{id}/image). The route is
 * token-gated, so callers fetch it as a blob rather than using it as an
 * `<img src>`.
 */
export function shotImageUrl(id: number): string {
  return `api/shots/${id}/image`;
}

/** POST /api/shots/{id}/annotate — upsert the shot's annotation. */
export function annotateShot(id: number, annotation: ShotAnnotation): Promise<Response> {
  return apiFetch(`api/shots/${id}/annotate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(annotation),
  });
}

/**
 * GET /api/shots/defaults — the per-install annotation defaults (#654).
 * Resolves to null on a non-ok response so the caller keeps the defaults it
 * already has cached.
 */
export async function getShotDefaults(): Promise<ShotDefaults | null> {
  const r = await apiFetch('api/shots/defaults');
  return r.ok ? ((await r.json()) as ShotDefaults) : null;
}

/**
 * POST /api/shots/defaults — save the defaults and return what was stored;
 * null when the save failed, so the caller keeps its previous state.
 */
export async function saveShotDefaults(defaults: ShotDefaults): Promise<ShotDefaults | null> {
  const r = await apiFetch('api/shots/defaults', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(defaults),
  });
  return r.ok ? ((await r.json()) as ShotDefaults) : null;
}

/** POST /api/shots/{id}/trash — soft-delete. */
export function sendShotToTrash(id: number): Promise<Response> {
  return apiFetch(`api/shots/${id}/trash`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
}

/** POST /api/shots/{id}/restore — undo {@link sendShotToTrash}. */
export function restoreShotFromTrash(id: number): Promise<Response> {
  return apiFetch(`api/shots/${id}/restore`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
}

/** POST /api/shots/{id}/delete — permanently delete an already-trashed shot. */
export function deleteShotPermanently(id: number): Promise<Response> {
  return apiFetch(`api/shots/${id}/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Options for {@link getShotCard} — the share-card renderer's query parameters. */
export interface ShotCardOptions {
  /** Card aspect/layout preset. */
  format: string;
  /** Palette accent, matching the viewer's current Farbschema. */
  accent: string;
  /** "dark" | "light". */
  theme: string;
}

/**
 * GET /api/shots/{id}/card — the rendered PNG. Returns the raw Response: the
 * caller streams the body as a Blob and reads the JSON error on a non-ok.
 */
export function getShotCard(id: number, { format, accent, theme }: ShotCardOptions): Promise<Response> {
  const params = new URLSearchParams({ format, accent, theme });
  return apiFetch(`api/shots/${id}/card?${params}`);
}

/** POST /api/shots/{id}/image — upload a (cropped) shot photo. */
export function postShotImage(id: number, blob: Blob): Promise<Response> {
  return apiFetch(shotImageUrl(id), {
    method: 'POST',
    headers: { 'Content-Type': blob.type },
    body: blob,
  });
}

/** DELETE /api/shots/{id}/image — remove the shot's photo. */
export function deleteShotImage(id: number): Promise<Response> {
  return apiFetch(shotImageUrl(id), { method: 'DELETE' });
}
