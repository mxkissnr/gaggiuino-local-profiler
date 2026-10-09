import { CLIENT_ID } from './api/transport.js';

// #1539 slice 3: the client half of live sync. The server pushes one
// `data-changed` SSE event per successful write (kind, revision, epoch, and
// optionally the entity id and the writing client's id). This module turns
// those into debounced, single-flight refetches of the affected part of local
// state, so a page opened on another device catches up without a reload.
//
// Design notes:
//  - No listeners are registered at module load; initLiveSync() does that, so a
//    module that merely imports this one (tests, the demo bundle) stays inert.
//  - Revisions are only comparable within one server epoch. A different epoch
//    means the server restarted and reset its counters, so every known
//    revision is dropped and every registered kind is refetched once.
//  - Nothing runs while the tab is hidden (the work is flushed on visibility)
//    or while an input has focus (retried on focusout), so a background refresh
//    never clobbers what the user is reading or typing.

// The kinds this client can register a handler for. The server tracks more
// (shot, shots, settings, profiles); an unregistered kind's revision is still
// recorded, but no handler runs for it.
export type DataKind = 'library' | 'orders' | 'maintenance' | 'ui-prefs' | 'library-image';

const REGISTERED_KINDS: readonly DataKind[] = ['library', 'orders', 'maintenance', 'ui-prefs', 'library-image'];
const ALL_KIND = 'all';
const DEBOUNCE_MS = 300;
// A run that threw backs off before retrying; a run a canRun() guard deferred
// polls on this interval until it is allowed through.
const RETRY_MS = 5000;
const CANRUN_RETRY_MS = 2000;

export interface DataChangedPayload {
  kind: string;
  rev?: number;
  epoch?: string;
  id?: string;
  src?: string;
  /** Present on a kind:"all" event: every kind's revision after the bump. */
  revs?: Record<string, number>;
}

export interface LiveSyncHandler {
  /** Refetch the kind. `ids` is null for "everything", else the dirtied ids. */
  run(ids: string[] | null): Promise<void> | void;
  /** Optional predicate: when it returns false the run is deferred. */
  canRun?(): boolean;
}

export type LiveSyncHandlers = Partial<Record<DataKind, LiveSyncHandler>>;

let _handlers: LiveSyncHandlers = {};
// Per kind: the ids dirtied since the last run, or null for "everything".
const _dirty = new Map<DataKind, Set<string> | null>();
// Last revision seen per kind, including kinds with no handler.
const _lastSeen = new Map<string, number>();
const _timers = new Map<DataKind, ReturnType<typeof setTimeout>>();
const _running = new Set<DataKind>();
// The server epoch `_lastSeen` belongs to; null until the first epoch is seen.
let _epoch: string | null = null;
// False until the first /api/status revision snapshot has been recorded: that
// first snapshot is the baseline, later increases are what trigger refetches.
let _statusSynced = false;
let _listenersBound = false;

function _isRegistered(kind: string): kind is DataKind {
  return (REGISTERED_KINDS as readonly string[]).includes(kind);
}

function _activeKinds(): DataKind[] {
  return REGISTERED_KINDS.filter((k) => _handlers[k] !== undefined);
}

function _isHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

function _focusBlocked(): boolean {
  if (typeof document === 'undefined') return false;
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName ? el.tagName.toLowerCase() : '';
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  return el.isContentEditable === true;
}

function _schedule(kind: DataKind, delay = DEBOUNCE_MS): void {
  const existing = _timers.get(kind);
  if (existing !== undefined) clearTimeout(existing);
  _timers.set(kind, setTimeout(() => {
    _timers.delete(kind);
    void _drain(kind);
  }, delay));
}

// Records a revision with the never-lower rule: a stale (lower) value from an
// out-of-order event must not undo a higher watermark.
function _recordSeen(kind: string, rev: number): void {
  const seen = _lastSeen.get(kind);
  if (seen !== undefined && rev <= seen) return;
  _lastSeen.set(kind, rev);
}

// Puts back the ids a failed run had consumed, merged with anything dirtied
// while it ran (null means "everything" and wins).
function _mergeDirty(kind: DataKind, ids: string[] | null): void {
  const current = _dirty.get(kind);
  if (current === null || ids === null) { _dirty.set(kind, null); return; }
  if (current === undefined) { _dirty.set(kind, new Set(ids)); return; }
  for (const id of ids) current.add(id);
}

function _markDirty(kind: DataKind, id: string | null): void {
  const current = _dirty.get(kind);
  if (current === null || id == null) _dirty.set(kind, null);
  else if (current === undefined) _dirty.set(kind, new Set([id]));
  else current.add(id);
  _schedule(kind);
}

// Switching epoch forgets every recorded revision and marks each registered
// kind dirty: the server restarted, so its counters begin again from zero and
// the client must refetch rather than trust its stale high-water marks.
function _syncEpoch(epoch: string): void {
  if (_epoch === epoch) return;
  const changed = _epoch !== null;
  _epoch = epoch;
  if (!changed) return;
  _lastSeen.clear();
  for (const kind of _activeKinds()) _markDirty(kind, null);
}

// Single-flight per kind: concurrent drains collapse into one run, and if the
// kind is dirtied again while that run is in flight exactly one rerun follows.
// The dirty mark is cleared only for a run that succeeds; a run that throws has
// its ids merged back and is retried once after a backoff, so a transient
// failure can never drop the refresh.
async function _drain(kind: DataKind): Promise<void> {
  if (!_dirty.has(kind)) return;
  if (_running.has(kind)) return;
  const handler = _handlers[kind];
  if (!handler) { _dirty.delete(kind); return; }
  if (_isHidden() || _focusBlocked()) return;
  if (handler.canRun && !handler.canRun()) { _schedule(kind, CANRUN_RETRY_MS); return; }
  const current = _dirty.get(kind);
  const ids = current === null || current === undefined ? null : [...current];
  _dirty.delete(kind);
  _running.add(kind);
  let failed = false;
  try {
    await handler.run(ids);
  } catch {
    failed = true;
  } finally {
    _running.delete(kind);
    // "Dirtied meanwhile -> rerun" only after a success; a failure backs off.
    if (!failed && _dirty.has(kind)) void _drain(kind);
  }
  if (failed) {
    _mergeDirty(kind, ids);
    _schedule(kind, RETRY_MS);
  }
}

function _onVisibilityChange(): void {
  if (_isHidden()) return;
  retryDeferred();
}

function _onFocusOut(): void {
  // On focusout the browser has not moved activeElement to the next target yet,
  // so decide after a macrotask rather than immediately re-running.
  setTimeout(() => { retryDeferred(); }, 0);
}

/**
 * Registers the per-kind refetch handlers and (once) the visibility/focus
 * listeners. Safe to call again with new handlers; listeners are never added
 * at module load.
 */
export function initLiveSync(handlers: LiveSyncHandlers): void {
  _handlers = handlers;
  if (_listenersBound) return;
  _listenersBound = true;
  if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
  document.addEventListener('visibilitychange', _onVisibilityChange);
  document.addEventListener('focusout', _onFocusOut);
}

/**
 * Re-attempts every deferred kind. Exported so a caller that knows a guard has
 * lifted (and the internal visibility/focusout retries) can flush.
 */
export function retryDeferred(): void {
  for (const kind of [..._dirty.keys()]) {
    if (_running.has(kind)) continue;
    void _drain(kind);
  }
}

/**
 * Handles one `data-changed` SSE payload: records revisions, dedupes stale and
 * self-produced events, and marks the affected registered kinds dirty.
 */
export function handleDataChanged(data: unknown): void {
  if (!data || typeof data !== 'object') return;
  const p = data as DataChangedPayload;
  const kind = typeof p.kind === 'string' ? p.kind : '';
  if (!kind) return;

  if (typeof p.epoch === 'string' && p.epoch) _syncEpoch(p.epoch);

  const rev = typeof p.rev === 'number' ? p.rev : null;
  const own = p.src === CLIENT_ID;

  if (kind === ALL_KIND) {
    // The all event carries every kind's post-bump revision (step 4); record
    // them, and refetch every registered kind unless this is our own echo.
    if (p.revs && typeof p.revs === 'object') {
      for (const [k, r] of Object.entries(p.revs)) {
        if (typeof r === 'number') _recordSeen(k, r);
      }
    }
    if (!own) for (const k of _activeKinds()) _markDirty(k, null);
    return;
  }

  if (own) {
    // Our own write: remember its revision so the echo cannot re-trigger us. A
    // gap (rev > seen + 1) means a remote change landed before the echo, so
    // catch up rather than hiding it behind the higher watermark.
    if (rev !== null) {
      const seen = _lastSeen.get(kind);
      if (seen !== undefined && rev > seen + 1 && _isRegistered(kind)) _markDirty(kind, null);
      _recordSeen(kind, rev);
    }
    return;
  }

  if (rev !== null) {
    const seen = _lastSeen.get(kind);
    if (seen !== undefined && rev <= seen) return;
    _recordSeen(kind, rev);
  }
  if (!_isRegistered(kind)) return;
  _markDirty(kind, typeof p.id === 'string' ? p.id : null);
}

/**
 * Records the server's epoch and per-kind revisions from /api/status. The first
 * snapshot is only a baseline; on later polls a higher revision (same epoch)
 * marks that kind dirty, catching anything a missed SSE event left behind.
 */
export function noteServerRevs(epoch?: string | null, revs?: Record<string, number> | null): void {
  const first = !_statusSynced;
  if (typeof epoch === 'string' && epoch) _syncEpoch(epoch);
  if (revs && typeof revs === 'object') {
    for (const [kind, rev] of Object.entries(revs)) {
      if (typeof rev !== 'number') continue;
      const seen = _lastSeen.get(kind);
      if (seen !== undefined && rev <= seen) continue;
      _recordSeen(kind, rev);
      if (!first && _isRegistered(kind)) _markDirty(kind, null);
    }
  }
  _statusSynced = true;
}
