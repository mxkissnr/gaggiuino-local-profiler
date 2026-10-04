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
let _timer: ReturnType<typeof setTimeout> | null = null;

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
  _persist();
  _queue.add(key);
  if (_timer == null) {
    _timer = setTimeout(() => { _timer = null; void _flush(); }, FLUSH_DELAY_MS);
  }
}

async function _flush(): Promise<void> {
  if (!_queue.size) return;
  const keys = [..._queue];
  const payload: UiPrefs = {};
  for (const key of keys) payload[key] = _prefs[key];
  try {
    const r = await saveUiPrefs(payload);
    if (!r.ok) return; // keep queued for the next change / next start
    for (const key of keys) _queue.delete(key);
  } catch {
    // Network failure: keep queued; the next change or the next start re-sends.
  }
}

/**
 * Server wins for every key it has; keys only present locally are pushed up
 * once, which migrates an existing device. Pure so it can be unit-tested.
 */
export function mergeUiPrefs(
  local: UiPrefs,
  server: UiPrefs,
): { merged: UiPrefs; pushUp: string[] } {
  const merged: UiPrefs = { ...local };
  const pushUp: string[] = [];
  for (const [key, value] of Object.entries(server)) merged[key] = value;
  for (const key of Object.keys(local)) {
    if (!(key in server)) pushUp.push(key);
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
    const { merged, pushUp } = mergeUiPrefs(_prefs, server);
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
