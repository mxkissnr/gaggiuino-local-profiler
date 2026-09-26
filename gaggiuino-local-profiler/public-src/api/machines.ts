import { apiFetch } from './fetch.js';
import type {
  FirmwareProgress, FirmwareVersion, Machine, MachineProfile, MachineProfileList,
  MachineSaveInput, MachineSystemSettings,
} from './types.js';

// Typed client for the `machines` domain (go/internal/machines — every route
// that package registers: /api/machines* plus /api/machine/*). Package A3c of
// the TS migration (#1110).
//
// Note the deliberate split: `api/switch`, `api/preheat` and `api/live/data`
// are NOT here even though they sound machine-related — actual route
// registration puts them in go/internal/system (system/switch.go,
// system/preheat.go, system/poll.go), so they stay for A3d's system client.
//
// URL building and the `?machineId=` query-param handling live here so the
// views/components never assemble an endpoint string. Helpers whose result the
// caller inspects (ok/status/json for an error body) return the raw Response
// unchanged; the rest parse their body into the domain type and resolve to
// null on a non-ok response, matching api/shots.ts.

function _json(method: string, body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

async function _jsonOrNull<T>(r: Response): Promise<T | null> {
  return r.ok ? ((await r.json()) as T) : null;
}

// ── Machine registry ─────────────────────────────────────────────────────

/** GET /api/machines — every registered machine. Null on a non-ok response. */
export async function listMachines(): Promise<Machine[] | null> {
  return _jsonOrNull<Machine[]>(await apiFetch('api/machines'));
}

/**
 * POST/PUT /api/machines[/{id}] — create (`id` null) or update a machine.
 * `triggerSync` false appends `?sync=0`, which the backend reads as "don't
 * start a shot import after this save" (#731), used by the test-connection
 * flow's implicit save. Returns the raw Response: the caller reads the saved
 * id and the server's error body off it.
 */
export function saveMachine(
  id: string | number | null,
  payload: MachineSaveInput,
  { triggerSync = true }: { triggerSync?: boolean } = {},
): Promise<Response> {
  const base = id ? `api/machines/${id}` : 'api/machines';
  const url = triggerSync ? base : `${base}?sync=0`;
  return apiFetch(url, _json(id ? 'PUT' : 'POST', payload));
}

/** POST /api/machines/{id}/test — connection test; the caller reads `{ reachable }` off the raw Response. */
export function testMachine(id: string | number): Promise<Response> {
  return apiFetch(`api/machines/${id}/test`, { method: 'POST' });
}

/** POST /api/machines/{id}/default — reassign the default machine (#753). */
export function setDefaultMachine(id: string | number): Promise<Response> {
  return apiFetch(`api/machines/${id}/default`, { method: 'POST' });
}

/** DELETE /api/machines/{id} — remove a machine; the caller reads the error body on a non-ok. */
export function deleteMachine(id: string | number): Promise<Response> {
  return apiFetch(`api/machines/${id}`, { method: 'DELETE' });
}

// ── Settings control proxy ───────────────────────────────────────────────

/**
 * GET /api/machine/settings?machineId=...&category=... — one settings
 * category off the machine. Null on a non-ok response.
 */
export async function getMachineSettings(
  machineId: string | number,
  category: string,
): Promise<MachineSystemSettings | null> {
  return _jsonOrNull<MachineSystemSettings>(
    await apiFetch(`api/machine/settings?machineId=${machineId}&category=${category}`),
  );
}

/**
 * POST /api/machine/settings/{category} — write one settings category back.
 * The caller builds the full body (including `machineId`) itself and only
 * awaits the result, so the raw Response is enough.
 */
export function saveMachineSettings(category: string, payload: unknown): Promise<Response> {
  return apiFetch(`api/machine/settings/${category}`, _json('POST', payload));
}

// ── Firmware OTA (#1044) ─────────────────────────────────────────────────

/** GET /api/machine/firmware/version?machineId=... — installed/latest version info. Null on a non-ok. */
export async function getFirmwareVersion(machineId: string | number): Promise<FirmwareVersion | null> {
  return _jsonOrNull<FirmwareVersion>(await apiFetch(`api/machine/firmware/version?machineId=${machineId}`));
}

/** POST /api/machine/firmware/update — trigger the machine's OTA update. Raw Response (the caller reads the error body on a non-ok). */
export function triggerFirmwareUpdate(machineId: string | number): Promise<Response> {
  return apiFetch('api/machine/firmware/update', _json('POST', { machineId: Number(machineId) }));
}

/** GET /api/machine/firmware/progress?machineId=... — poll update progress. Null on a non-ok or an unparseable body (treated as a transient failure by the poller). */
export async function getFirmwareProgress(machineId: string | number): Promise<FirmwareProgress | null> {
  const r = await apiFetch(`api/machine/firmware/progress?machineId=${machineId}`);
  if (!r.ok) return null;
  return (await r.json().catch(() => null)) as FirmwareProgress | null;
}

// ── Machine profiles (#307) ──────────────────────────────────────────────

/**
 * GET /api/machine/profiles?machineId=... — the profile list. `optionsRaw` is
 * the raw machine options array and `stale` marks a cached/offline answer.
 */
export async function listMachineProfiles(machineId: string | number): Promise<MachineProfileList | null> {
  return _jsonOrNull<MachineProfileList>(await apiFetch(`api/machine/profiles?machineId=${machineId}`));
}

/**
 * GET /api/machine/profile/{id} — one full profile. `machineId` is optional:
 * the profile-dialin wizard fetches without it, while the editors scope to the
 * active machine. Null on a non-ok response.
 */
export async function getMachineProfile(
  id: string | number,
  machineId?: string | number,
): Promise<MachineProfile | null> {
  const url = machineId === undefined
    ? `api/machine/profile/${id}`
    : `api/machine/profile/${id}?machineId=${machineId}`;
  return _jsonOrNull<MachineProfile>(await apiFetch(url));
}

/**
 * Low-level GET /api/machine/profiles — the raw Response, for the GaggiMate
 * phase-name lookup in views/shots/index.js. That caller retries on a
 * transient 5xx (GaggiMate serves one WS request at a time) and inspects
 * `.ok` itself, so it can't go through {@link listMachineProfiles}'s
 * parse-to-null wrapper. Passing `signal` lets the caller time the attempt
 * out.
 */
export function fetchMachineProfilesResponse(
  machineId: string | number,
  signal?: AbortSignal,
): Promise<Response> {
  return apiFetch(`api/machine/profiles?machineId=${machineId}`, signal ? { signal } : undefined);
}

/** Low-level GET /api/machine/profile/{id} counterpart to {@link fetchMachineProfilesResponse}. */
export function fetchMachineProfileResponse(
  id: string | number,
  machineId: string | number,
  signal?: AbortSignal,
): Promise<Response> {
  return apiFetch(`api/machine/profile/${id}?machineId=${machineId}`, signal ? { signal } : undefined);
}

/**
 * POST/PUT /api/machine/profile[/{id}] — create (`id` null) or update a
 * profile and push it to the machine. The caller reads the server's error body
 * on a non-ok, so this returns the raw Response.
 */
export function saveMachineProfile(id: string | number | null, body: unknown): Promise<Response> {
  const url = id != null ? `api/machine/profile/${id}` : 'api/machine/profile';
  return apiFetch(url, _json(id != null ? 'PUT' : 'POST', body));
}

/** DELETE /api/machine/profile/{id}?machineId=... — delete a profile; raw Response so the caller distinguishes the failure. */
export function deleteMachineProfile(id: string | number, machineId: string | number): Promise<Response> {
  return apiFetch(`api/machine/profile/${id}?machineId=${machineId}`, { method: 'DELETE' });
}
