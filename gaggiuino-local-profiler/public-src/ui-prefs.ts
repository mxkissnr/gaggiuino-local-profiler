// #1375: shared UI choices. localStorage is the synchronous cache every view
// reads at load time; the server (GET/PUT /api/ui-prefs) is the shared source
// of truth, so the same choices follow you to another device. Changed keys are
// PUT in one debounced request and stay queued until a request succeeds.
// #1403: the queued key set is itself persisted, so a change made offline or
// just before the tab closes is retried after a reload and flushed on leave.
import { getUiPrefs, saveUiPrefs } from './api/system.js';
import type { UiPrefs } from './api/types.js';

const STORAGE_KEY = 'glp_ui_prefs';
const PENDING_STORAGE_KEY = 'glp_ui_prefs_pending';
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
try {
  const rawPending = localStorage.getItem(PENDING_STORAGE_KEY);
  const parsedPending = rawPending ? (JSON.parse(rawPending) as unknown) : null;
  if (Array.isArray(parsedPending)) {
    for (const key of parsedPending) {
      if (typeof key === 'string') _queue.add(key);
    }
  }
} catch {
  // A corrupt pending set just means nothing is retried after this reload.
}

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

/** Persists the queued key set so pending changes survive a reload. */
function _persistPending(): void {
  try {
    localStorage.setItem(PENDING_STORAGE_KEY, JSON.stringify([..._queue]));
  } catch {
    // Same best-effort contract as _persist.
  }
}

/** Builds the PUT payload for the currently queued keys. */
function _queuedPayload(): UiPrefs {
  const payload: UiPrefs = {};
  for (const key of _queue) payload[key] = _prefs[key];
  return payload;
}

/** Records a choice: cache it synchronously, then queue it for the server. */
export function setUiPref(key: string, value: unknown): void {
  _prefs[key] = value;
  _version.set(key, (_version.get(key) ?? 0) + 1);
  _persist();
  _queue.add(key);
  _persistPending();
  if (_timer == null) {
    _timer = setTimeout(() => { _timer = null; void _flush(); }, FLUSH_DELAY_MS);
  }
}

/** Extracts the key names a 400 response's `issues` point at. */
function _issueKeys(issues: unknown): Set<string> {
  const keys = new Set<string>();
  if (!Array.isArray(issues)) return keys;
  for (const issue of issues) {
    const match = /"([^"]+)"/.exec(String(issue));
    if (match && match[1] != null) keys.add(match[1]);
  }
  return keys;
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
    if (!r.ok) {
      // A 400 names the keys it rejected; drop those so one bad value cannot
      // block every later sync. The local value is deliberately kept.
      if (r.status === 400) {
        let dropped = false;
        try {
          const body = (await r.json()) as unknown;
          const issues = body && typeof body === 'object'
            ? (body as { issues?: unknown }).issues
            : undefined;
          for (const key of _issueKeys(issues)) {
            if (_queue.delete(key)) dropped = true;
          }
        } catch {
          // Unreadable error body: keep everything queued and retry later.
        }
        if (dropped) _persistPending();
      }
      return; // keep queued for the next change / next start
    }
    for (const key of keys) {
      // Keep the key queued if its value changed while this PUT was in flight.
      if (_version.get(key) === sentVersions.get(key)) _queue.delete(key);
    }
    _persistPending();
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
 * Sends every queued key to the server right away, using `keepalive` so the
 * browser is allowed to finish the request while the page unloads. Called on
 * `pagehide` and when the tab becomes hidden. A successful response clears the
 * sent keys from the pending set; a failed one leaves them for the next start.
 */
export async function flushUiPrefsOnLeave(): Promise<void> {
  if (!_queue.size) return;
  const keys = [..._queue];
  const payload = _queuedPayload();
  const sentVersions = new Map<string, number>();
  for (const key of keys) sentVersions.set(key, _version.get(key) ?? 0);
  try {
    const r = await saveUiPrefs(payload, { keepalive: true });
    if (!r.ok) return;
    let dropped = false;
    for (const key of keys) {
      if (_version.get(key) === sentVersions.get(key)) {
        if (_queue.delete(key)) dropped = true;
      }
    }
    if (dropped) _persistPending();
  } catch {
    // The page may be gone before the fetch settles; the pending set survives.
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => { void flushUiPrefsOnLeave(); });
}
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flushUiPrefsOnLeave();
  });
}

/**
 * Server wins for every key it already holds, except keys with a local write
 * still queued (`pending`), which are newer than the server's value. When the
 * server is empty the local cache is migrated up once; once the server has any
 * preferences it is authoritative, and local-only keys that are not pending are
 * dropped rather than pushed, so two apps sharing one origin cannot leak their
 * local-only keys into each other. Pure so it can be unit-tested.
 */
export function mergeUiPrefs(
  local: UiPrefs,
  server: UiPrefs,
  pending: ReadonlySet<string> = new Set<string>(),
): { merged: UiPrefs; pushUp: string[] } {
  const merged: UiPrefs = {};
  for (const [key, value] of Object.entries(server)) {
    merged[key] = pending.has(key) ? local[key] : value;
  }
  for (const key of pending) {
    if (key in local) merged[key] = local[key];
  }
  const pushUp: string[] = [];
  if (Object.keys(server).length === 0) {
    for (const key of Object.keys(local)) {
      merged[key] = local[key];
      if (!pending.has(key)) pushUp.push(key);
    }
  }
  return { merged, pushUp };
}

/**
 * Fetches the shared choices and merges them over the local cache. Local-only
 * keys are pushed up only on the first sync (an empty server); otherwise the
 * server is authoritative and the local cache is trimmed to match. Resolves to
 * whether anything changed so callers can re-render; a network failure leaves
 * the local cache untouched.
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
      _persistPending();
    }
    // A non-empty queue means a migration or changes persisted from a previous
    // session are still unsent; retry them now that the server answered.
    if (_queue.size) await _flush();
    return changed;
  } catch {
    return false;
  }
}
