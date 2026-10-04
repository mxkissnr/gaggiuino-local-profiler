// #1375: shared UI choices. localStorage is the synchronous cache every view
// reads at load time; the server (GET/PUT /api/ui-prefs) is the shared source
// of truth, so the same choices follow you to another device. Changed keys are
// PUT in one debounced request and stay queued until a request succeeds.
import { getUiPrefs, saveUiPrefs } from './api/system.js';
import type { UiPrefs } from './api/types.js';

const STORAGE_KEY = 'glp_ui_prefs';
const FLUSH_DELAY_MS = 600;

let _prefs: UiPrefs = {};
try {
  const raw = localStorage.getItem(STORAGE_KEY);
  const parsed = raw ? (JSON.parse(raw) as unknown) : null;
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    _prefs = parsed as UiPrefs;
  }
} catch {
  _prefs = {};
}

const _queue = new Set<string>();
// Bumped on every write to a key, so a failed/deferred flush can tell whether
// the value it sent is still the current one (finding: an in-flight PUT must
// not drop a change made while it was in flight).
const _version = new Map<string, number>();
let _timer: ReturnType<typeof setTimeout> | null = null;
let _flushing = false;
let _flushAgain = false;

/** Reads a memoised choice. Missing keys resolve to `undefined`. */
export function getUiPref<T>(key: string): T | undefined {
  return _prefs[key] as T | undefined;
}

function _persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(_prefs));
  } catch {
    // Private-mode/quota failures just mean the cache doesn't survive a reload.
  }
}

/** Records a choice: cache it synchronously, then queue it for the server. */
export function setUiPref(key: string, value: unknown): void {
  _prefs[key] = value;
  _version.set(key, (_version.get(key) ?? 0) + 1);
  _persist();
  _queue.add(key);
  if (_timer == null) {
    _timer = setTimeout(() => { _timer = null; void _flush(); }, FLUSH_DELAY_MS);
  }
}

async function _flush(): Promise<void> {
  if (_flushing) {
    // A change arrived while a PUT was in flight; re-run once it settles so the
    // newer value is not dropped.
    _flushAgain = true;
    return;
  }
  if (!_queue.size) return;
  _flushing = true;
  try {
    const keys = [..._queue];
    const payload: UiPrefs = {};
    const sentVersions = new Map<string, number>();
    for (const key of keys) {
      payload[key] = _prefs[key];
      sentVersions.set(key, _version.get(key) ?? 0);
    }
    const r = await saveUiPrefs(payload);
    if (!r.ok) return; // keep queued for the next change / next start
    for (const key of keys) {
      // Keep the key queued if its value changed while this PUT was in flight.
      if (_version.get(key) === sentVersions.get(key)) _queue.delete(key);
    }
  } catch {
    // Network failure: keep queued; the next change or the next start re-sends.
  } finally {
    _flushing = false;
    if (_flushAgain && _queue.size && _timer == null) {
      _flushAgain = false;
      _timer = setTimeout(() => { _timer = null; void _flush(); }, FLUSH_DELAY_MS);
    }
  }
}

/**
 * Server wins for every key it has, except keys with a local write still queued
 * (`pending`), which are newer than the server's value. Keys only present
 * locally (and not pending) are pushed up once, which migrates an existing
 * device. Pure so it can be unit-tested.
 */
export function mergeUiPrefs(
  local: UiPrefs,
  server: UiPrefs,
  pending: ReadonlySet<string> = new Set(),
): { merged: UiPrefs; pushUp: string[] } {
  const merged: UiPrefs = { ...local };
  const pushUp: string[] = [];
  for (const [key, value] of Object.entries(server)) {
    if (pending.has(key)) continue;
    merged[key] = value;
  }
  for (const key of Object.keys(local)) {
    if (!(key in server) && !pending.has(key)) pushUp.push(key);
  }
  return { merged, pushUp };
}

/**
 * Fetches the shared choices and merges them over the local cache, pushing
 * local-only keys up once. Resolves to whether anything changed so callers can
 * re-render; a network failure leaves the local cache untouched.
 */
export async function loadUiPrefsFromServer(): Promise<boolean> {
  try {
    const r = await getUiPrefs();
    if (!r.ok) return false;
    const body = (await r.json()) as unknown;
    const server = body && typeof body === 'object' && !Array.isArray(body)
      ? (body as UiPrefs)
      : {};
    const { merged, pushUp } = mergeUiPrefs(_prefs, server, _queue);
    const changed = JSON.stringify(merged) !== JSON.stringify(_prefs);
    _prefs = merged;
    _persist();
    if (pushUp.length) {
      for (const key of pushUp) _queue.add(key);
      await _flush();
    }
    return changed;
  } catch {
    return false;
  }
}
