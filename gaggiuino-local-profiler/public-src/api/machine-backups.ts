import { apiFetch, jsonBody, pathSeg } from './fetch.js';
import type {
  MachineBackup, MachineBackupCreateInput, MachineBackupDeleteResult, MachineBackupDetail, MachineBackupDocument,
  MachineBackupErrorCode, MachineBackupRestoreInput, MachineBackupRestoreResult, MachineBackupSecrets, MachineBackupSettings,
  MachineBackupUploadInput, MachineBusyReason,
} from './types.js';

// Typed client for the machine settings backups domain (go/internal/machinebackups:
// every /api/machine/backups* route, #1878). Unlike machines.ts every helper resolves to a
// MachineBackupResult: it never throws and never hands out a raw Response, so the settings
// sheet (U1-U3) switches on `code`. A body that is not GLP's documented error (a proxy's
// error page, a plain {error} answer, a network failure) gives `code: null`, which means
// "show the generic error". Server error texts are not passed on (the UI translates by
// code); only `machineError` is, as untrusted text to render escaped.
//
// URLs stay relative (HA ingress) and every interpolated id goes through pathSeg. The
// module holds no state: every call names its machine (machineId) or its backup (id).

/** A failed call. status 0: GLP was not reached (network error). code null: no documented
 *  code in the answer (plain {error}, proxy page, rate limit, network). reason only with
 *  machine_busy, machineError only with restore_rejected (untrusted, max 200 chars, render escaped). */
export interface MachineBackupFailure {
  readonly ok: false;
  readonly status: number;
  readonly code: MachineBackupErrorCode | null;
  readonly reason: MachineBusyReason | null;
  readonly machineError: string | null;
}

export type MachineBackupResult<T> = { readonly ok: true; readonly value: T } | MachineBackupFailure;

export interface MachineBackupDownload {
  readonly blob: Blob;
  /** The server's file name when it has exactly the documented form, else 'gaggiuino-backup.json'. */
  readonly filename: string;
  /** 'missing' only when the server says so; anything else counts as 'merged' (warn: plain-text Wi-Fi password). */
  readonly secrets: MachineBackupSecrets;
}

// The Record type makes a code added to or removed from openapi.yaml a typecheck error here.
const ERROR_CODES: Record<MachineBackupErrorCode, true> = {
  unsupported_machine: true,
  unsupported_firmware: true,
  machine_unreachable: true,
  invalid_backup: true,
  machine_busy: true,
  operation_running: true,
  pre_update_backup_failed: true,
  pre_restore_backup_failed: true,
  pending_profile_changes: true,
  restore_rejected: true,
  no_confirmation: true,
};

const BUSY_REASONS: Record<MachineBusyReason, true> = {
  brew: true,
  steam: true,
  descale: true,
  firmware_update: true,
};

const MACHINE_ERROR_MAX = 200;

const DOWNLOAD_NAME = /^attachment; filename="(gaggiuino-backup-m\d{1,19}-\d{4}-\d{2}-\d{2}_\d{4}\.json)"$/;
const DEFAULT_DOWNLOAD_NAME = 'gaggiuino-backup.json';

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function ownString(o: Record<string, unknown>, key: string): string | null {
  if (!Object.hasOwn(o, key)) return null;
  const v = o[key];
  return typeof v === 'string' ? v : null;
}

// Own-key allowlists only: 'toString', 'constructor' and '__proto__' never count as a code.
function isErrorCode(v: string | null): v is MachineBackupErrorCode {
  return v !== null && Object.hasOwn(ERROR_CODES, v);
}

function isBusyReason(v: string | null): v is MachineBusyReason {
  return v !== null && Object.hasOwn(BUSY_REASONS, v);
}

function failure(status: number, body: unknown): MachineBackupFailure {
  const fields: Record<string, unknown> = isObject(body) ? body : {};
  const rawCode = ownString(fields, 'code');
  const code = isErrorCode(rawCode) ? rawCode : null;
  const rawReason = code === 'machine_busy' ? ownString(fields, 'reason') : null;
  const rawMachineError = code === 'restore_rejected' ? ownString(fields, 'machineError') : null;
  return {
    ok: false,
    status,
    code,
    reason: isBusyReason(rawReason) ? rawReason : null,
    machineError: rawMachineError === null ? null : Array.from(rawMachineError).slice(0, MACHINE_ERROR_MAX).join(''),
  };
}

async function readJson(r: Response): Promise<unknown> {
  try {
    return (await r.json()) as unknown;
  } catch {
    return undefined;
  }
}

async function request<T>(url: string, init: RequestInit | undefined, shape: 'list' | 'object'): Promise<MachineBackupResult<T>> {
  let r: Response;
  try {
    r = await apiFetch(url, init);
  } catch {
    return failure(0, undefined);
  }
  const body = await readJson(r);
  if (!r.ok) return failure(r.status, body);
  const shaped = shape === 'list' ? Array.isArray(body) : isObject(body);
  return shaped ? { ok: true, value: body as T } : failure(r.status, undefined);
}

function downloadName(header: string | null): string {
  if (header === null) return DEFAULT_DOWNLOAD_NAME;
  return DOWNLOAD_NAME.exec(header)?.[1] ?? DEFAULT_DOWNLOAD_NAME;
}

/** GET /api/machine/backups[?machineId=N], newest first. Null = every machine, deleted ones
 *  included (for "backups of deleted machines"). */
export function listMachineBackups(machineId: number | null): Promise<MachineBackupResult<MachineBackup[]>> {
  const url = machineId === null ? 'api/machine/backups' : `api/machine/backups?machineId=${pathSeg(machineId)}`;
  return request(url, undefined, 'list');
}

/** POST /api/machine/backups: Back up now (201 entry). */
export function backUpMachineNow(machineId: number, note?: string): Promise<MachineBackupResult<MachineBackup>> {
  const body: MachineBackupCreateInput = note === undefined ? { machineId } : { machineId, note };
  return request('api/machine/backups', jsonBody(body), 'object');
}

/** DELETE /api/machine/backups/{id}: any kind, also a deleted machine's backup. */
export function deleteMachineBackup(id: number): Promise<MachineBackupResult<MachineBackupDeleteResult>> {
  return request(`api/machine/backups/${pathSeg(id)}`, { method: 'DELETE' }, 'object');
}

/** GET /api/machine/backups/{id}: entry + secret-free document, for the compare view. */
export function getMachineBackup(id: number): Promise<MachineBackupResult<MachineBackupDetail>> {
  return request(`api/machine/backups/${pathSeg(id)}`, undefined, 'object');
}

/** GET /api/machine/backups/{id}/download: the native file as a Blob. Check `secrets` and warn
 *  before saving; the caller turns the Blob into a download (shareOrDownloadBlob). */
export async function downloadMachineBackup(id: number): Promise<MachineBackupResult<MachineBackupDownload>> {
  let r: Response;
  try {
    r = await apiFetch(`api/machine/backups/${pathSeg(id)}/download`);
  } catch {
    return failure(0, undefined);
  }
  if (!r.ok) return failure(r.status, await readJson(r));
  let blob: Blob;
  try {
    blob = await r.blob();
  } catch {
    return failure(0, undefined);
  }
  // An unknown or absent X-GLP-Secrets counts as 'merged': fail safe, the user gets the warning.
  return {
    ok: true,
    value: {
      blob,
      filename: downloadName(r.headers.get('Content-Disposition')),
      secrets: r.headers.get('X-GLP-Secrets') === 'missing' ? 'missing' : 'merged',
    },
  };
}

/** POST /api/machine/backups/upload: store a parsed backup file for this machine (201 entry). */
export function uploadMachineBackup(
  machineId: number, document: MachineBackupDocument, note?: string,
): Promise<MachineBackupResult<MachineBackup>> {
  const body: MachineBackupUploadInput = note === undefined
    ? { machineId, document }
    : { machineId, document, note };
  return request('api/machine/backups/upload', jsonBody(body), 'object');
}

/** GET /api/machine/backups/settings?machineId=N: this machine's schedule and retention. */
export function getMachineBackupSettings(machineId: number): Promise<MachineBackupResult<MachineBackupSettings>> {
  return request(`api/machine/backups/settings?machineId=${pathSeg(machineId)}`, undefined, 'object');
}

/** PUT /api/machine/backups/settings: replace one machine's schedule and retention (machineId inside). */
export function saveMachineBackupSettings(settings: MachineBackupSettings): Promise<MachineBackupResult<MachineBackupSettings>> {
  return request('api/machine/backups/settings', jsonBody(settings, 'PUT'), 'object');
}

/**
 * POST /api/machine/backups/{id}/restore. `machineId` is the target: the backup's own machine,
 * or, only for a backup whose machine was deleted, a registered Gaggiuino machine the user
 * chose. A backup of an existing machine onto another answers 404 (`code: null`). Before
 * posting, GLP stores the machine's current state as a manual backup (note
 * `Before restoring backup <id>`), so reload the list afterwards. On `ok` the machine applies
 * the backup and restarts: poll getFirmwareVersion (machines.ts) as PLAN-1878 "Restore" says.
 *
 * Nothing was sent for machine_busy (+ reason), pending_profile_changes, operation_running,
 * pre_restore_backup_failed, invalid_backup, machine_unreachable, unsupported_machine and
 * unsupported_firmware; restore_rejected means the machine refused, nothing changed
 * (machineError). no_confirmation, status 0 and code null with status >= 500 leave the
 * outcome unknown (the machine may already be restarting): never say nothing was restored then.
 */
export function restoreMachineBackup(id: number, machineId: number): Promise<MachineBackupResult<MachineBackupRestoreResult>> {
  const body: MachineBackupRestoreInput = { machineId };
  return request(`api/machine/backups/${pathSeg(id)}/restore`, jsonBody(body), 'object');
}
