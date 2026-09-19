import { apiFetch } from './fetch.js';
import { apiFetchToBlob, apiUpload } from './transport.js';
import type { ApiFetchToBlobResult, ApiUploadResult } from './transport.js';

// Catch-all typed client for the `system` domain (go/internal/system — the
// routes that package registers outside dedicated feature packages) plus the
// remaining small domains: status, switch/preheat/live-data, version, menu,
// achievements, import, demo, backup and the Dev Tools debug endpoints.
// Package A3d of the TS migration (#1110), the final sweep before api.js is
// retired.
//
// Two shapes, chosen per call site exactly as in A3b/A3c:
//   - a helper returns the raw Response when the caller inspects `ok`/status
//     or reads the server's error body;
//   - a helper resolves to a typed domain value (or null) when the caller
//     only consumes the parsed body.
// The progress-aware transfers go through api/transport.ts's
// apiFetchToBlob/apiUpload, which is why the URL/header building for them
// lives here rather than in the components.

function _json(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

// ── Status / power / sync ────────────────────────────────────────────────

/**
 * GET /api/status[/?machineId=...] — the app-wide status poll. An explicit
 * `machineId` scopes the status dot/hostname fields to that machine;
 * 'all'/null/undefined fall back to the unscoped (default-machine) call.
 */
export function getStatus(machineId?: string | number | null): Promise<Response> {
  const qs = (machineId != null && machineId !== 'all')
    ? `?machineId=${encodeURIComponent(String(machineId))}`
    : '';
  return apiFetch(`api/status${qs}`);
}

/** GET /api/switch — the machine's power-switch state (`{ configured, state }`). */
export function getSwitch(): Promise<Response> {
  return apiFetch('api/switch');
}

/** POST /api/switch/toggle — flip the machine power switch. */
export function toggleSwitch(): Promise<Response> {
  return apiFetch('api/switch/toggle', { method: 'POST' });
}

/** POST /api/sync — force a shot sync; a 429 carries the throttle error body. */
export function triggerSync(): Promise<Response> {
  return apiFetch('api/sync', { method: 'POST' });
}

// ── Live data (#325) ─────────────────────────────────────────────────────

/** GET /api/preheat — the preheat widget's data. */
export function getPreheat(): Promise<Response> {
  return apiFetch('api/preheat');
}

/** GET /api/live/data — one poll of the live shot state. */
export function getLiveData(): Promise<Response> {
  return apiFetch('api/live/data');
}

// ── Version / menu / achievements ────────────────────────────────────────

/** GET /api/version — the add-on's update-check payload. */
export function getVersion(): Promise<Response> {
  return apiFetch('api/version');
}

/** GET /api/menu — the drink-menu entries the annotation panel's pills read. */
export function getMenu(): Promise<Response> {
  return apiFetch('api/menu');
}

/** GET /api/achievements?lang=... — the badge catalogue, localized. */
export function getAchievements(lang: string): Promise<Response> {
  return apiFetch(`api/achievements?lang=${encodeURIComponent(lang)}`);
}

// ── Import-from-URL provider settings (go/internal/import) ───────────────

/** GET /api/import/url?url=... — parse a shop URL; a 400 means "unsupported URL". */
export function importFromUrl(url: string): Promise<Response> {
  return apiFetch(`api/import/url?url=${encodeURIComponent(url)}`);
}

/** GET /api/import/settings — enabled providers and custom Shopify domains. */
export function getImportSettings(): Promise<Response> {
  return apiFetch('api/import/settings');
}

/** POST /api/import/settings — save provider toggles / custom domains (a partial body is deliberate). */
export function saveImportSettings(payload: unknown): Promise<Response> {
  return apiFetch('api/import/settings', _json(payload));
}

// ── Demo mode (#274) ─────────────────────────────────────────────────────

/** POST /api/demo/seed — seed the demo dataset. */
export function seedDemoData(): Promise<Response> {
  return apiFetch('api/demo/seed', { method: 'POST' });
}

/** POST /api/demo/end — tear the demo dataset back down. */
export function endDemoData(): Promise<Response> {
  return apiFetch('api/demo/end', { method: 'POST' });
}

// ── Backup / restore (go/internal/backup) ────────────────────────────────

export interface BackupRequestOptions {
  sections?: unknown;
  passphrase?: string;
  onProgress?: (received: number, total: number | null) => void;
}

/**
 * POST /api/backup — build and download the zip bundle. Buffered through
 * apiFetchToBlob, so the caller gets the progress events and the whole Blob
 * at once. X-GLP-Backup-Estimate is the Go backend's approximate size (the
 * frozen Node backend omits it, leaving the bar indeterminate).
 */
export function requestBackup({ sections, passphrase, onProgress }: BackupRequestOptions): Promise<ApiFetchToBlobResult> {
  return apiFetchToBlob('api/backup', {
    opts: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sections, passphrase }),
    },
    estimateHeader: 'X-GLP-Backup-Estimate',
    onProgress,
  });
}

/**
 * The restore result shape: a real Response for the JSON/dry-run paths, or
 * the `{ ok, status, json() }` facade apiUpload is adapted into for the
 * progress-reporting zip upload — the shape backup-modal.js already expects.
 */
export type RestoreResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};

export interface RestoreRequestOptions {
  /** Full restore bundle (non-zip path). */
  bundle?: Record<string, unknown>;
  zipBytes?: ArrayBuffer | null;
  sections?: unknown;
  passphrase?: string;
  dryRun?: boolean;
  onProgress?: (loaded: number, total: number) => void;
}

/**
 * POST /api/restore — preview (dryRun) or apply a restore. A zip upload with
 * a progress callback goes through apiUpload (XHR) and is adapted to the
 * Response-like facade; everything else uses apiFetch. Header building for
 * the zip path (sections/passphrase/dry-run) is centralized here.
 */
export function postRestore({
  bundle, zipBytes, sections, passphrase, dryRun, onProgress,
}: RestoreRequestOptions): Promise<RestoreResponse> {
  if (zipBytes) {
    const headers: Record<string, string> = { 'Content-Type': 'application/zip' };
    if (sections !== undefined) headers['X-GLP-Sections'] = JSON.stringify(sections);
    if (passphrase !== undefined) headers['X-GLP-Passphrase'] = passphrase;
    if (dryRun) headers['X-GLP-Dry-Run'] = 'true';
    if (onProgress) {
      return apiUpload('api/restore', { method: 'POST', headers, body: zipBytes, onProgress })
        .then(res => ({
          ok: res.ok,
          status: res.status,
          json: () => Promise.resolve(JSON.parse(res.text || '{}') as unknown),
        }));
    }
    return apiFetch('api/restore', { method: 'POST', headers, body: zipBytes });
  }
  return apiFetch('api/restore', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...bundle, dryRun, sections, passphrase }),
  });
}

// ── Dev Tools database transfer (#960, #755) ─────────────────────────────

/** GET /api/debug/export-db — stream the SQLite file down with progress. */
export function exportDevDb(
  onProgress: (received: number, total: number | null) => void,
): Promise<ApiFetchToBlobResult> {
  return apiFetchToBlob('api/debug/export-db', { onProgress });
}

/** POST /api/debug/import-db — upload a replacement SQLite file with progress. */
export function importDevDb(
  bytes: ArrayBuffer,
  onProgress: (loaded: number, total: number) => void,
): Promise<ApiUploadResult> {
  return apiUpload('api/debug/import-db', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: bytes,
    onProgress,
  });
}
