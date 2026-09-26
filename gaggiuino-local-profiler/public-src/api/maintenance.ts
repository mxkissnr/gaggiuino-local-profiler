import { apiFetch } from './fetch.js';

// Typed client for the `maintenance` domain (go/internal/maintenance — every
// route that package registers: /api/maintenance plus /api/maintenance/log*).
// Package A3d of the TS migration (#1110).
//
// Every helper returns the raw Response. The call sites key their rendering
// off `.ok`/status and parse the JSON themselves (see views/maintenance.js),
// so handing the Response back unchanged is what preserves their existing
// error handling — the same convention api/shots.ts's listShots established.
//
// The concrete `machineId` is resolved by the caller: views/maintenance.js's
// _writeMachineId() owns the local view scope and the 'all' → first-machine
// fallback, so these helpers only build the URL.

function _json(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

/** GET /api/maintenance?machineId=... — task status for one machine, or the whole fleet with `machineId=all`. */
export function getMaintenance(machineId: string | number): Promise<Response> {
  return apiFetch(`api/maintenance?machineId=${machineId}`);
}

/** POST /api/maintenance/{task}/done?machineId=... — mark one task as done. */
export function markMaintenanceDone(task: string, machineId: string | number): Promise<Response> {
  return apiFetch(`api/maintenance/${task}/done?machineId=${machineId}`, { method: 'POST' });
}

/**
 * POST /api/maintenance/{task}/threshold?machineId=... — write a task's
 * threshold. `body` is the caller's shots/days field set (a partial write is
 * deliberate: the backend overwrites only the keys present).
 */
export function saveMaintenanceThreshold(
  task: string,
  machineId: string | number,
  body: unknown,
): Promise<Response> {
  return apiFetch(`api/maintenance/${task}/threshold?machineId=${machineId}`, _json(body));
}

/** POST /api/maintenance/custom?machineId=... — create a user-defined maintenance task. */
export function addCustomMaintenanceTask(
  machineId: string | number,
  body: { label: string; threshold_shots: number | null; threshold_days: number | null },
): Promise<Response> {
  return apiFetch(`api/maintenance/custom?machineId=${machineId}`, _json(body));
}

/** DELETE /api/maintenance/custom/{task}?machineId=... — remove a user-defined maintenance task. */
export function deleteCustomMaintenanceTask(task: string, machineId: string | number): Promise<Response> {
  return apiFetch(`api/maintenance/custom/${task}?machineId=${machineId}`, { method: 'DELETE' });
}

/** GET /api/maintenance/log?machineId=... — the maintenance log rows. */
export function getMaintenanceLog(machineId: string | number): Promise<Response> {
  return apiFetch(`api/maintenance/log?machineId=${machineId}`);
}

/** POST /api/maintenance/log?machineId=... — add a manual log entry. */
export function addMaintenanceLogEntry(
  machineId: string | number,
  entry: { task: string; date: string; notes: string },
): Promise<Response> {
  return apiFetch(`api/maintenance/log?machineId=${machineId}`, _json(entry));
}

/** DELETE /api/maintenance/log/{id} — remove one log entry. */
export function deleteMaintenanceLogEntry(id: number | string): Promise<Response> {
  return apiFetch(`api/maintenance/log/${id}`, { method: 'DELETE' });
}
