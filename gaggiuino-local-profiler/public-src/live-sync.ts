import { CLIENT_ID, lastWriteAt } from './api/transport.js';

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
//    revision is dropped and every resync kind (photos excepted) is refetched.
//  - Nothing runs while the tab is hidden (the work is flushed on visibility)
//    or while an input has focus (retried on focusout), so a background refresh
//    never clobbers what the user is reading or typing.

// The kinds this client can register a handler for. The server tracks more
// (settings, profiles); an unregistered kind's revision is still recorded, but
// no handler runs for it.
export type DataKind =
  | 'library'
  | 'orders'
  | 'maintenance'
  | 'ui-prefs'
  | 'library-image'
  | 'shot'
  | 'shots';

const REGISTERED_KINDS: readonly DataKind[] = [
  'library', 'orders', 'maintenance', 'ui-prefs', 'library-image', 'shot', 'shots',
];
const ALL_KIND = 'all';
const DEBOUNCE_MS = 300;
// A run a canRun() guard deferred polls on this interval until it is allowed
// through.
const CANRUN_RETRY_MS = 2000;
// A status revision this page's own write produced is not a reason to refetch
// for this long after that write's request: the write's SSE echo records the
// revision, so within the window the poll only waits for that echo.
const OWN_WRITE_GRACE_MS = 5000;

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

// "all" is not a data kind the server tracks; it is the sync key for a
// whole-database change, whose handler reloads the page.
export type LiveSyncHandlers = Partial<Record<DataKind | typeof ALL_KIND, LiveSyncHandler>>;
type SyncKind = DataKind | typeof ALL_KIND;

let _handlers: LiveSyncHandlers = {};
// Per kind: the ids dirtied since the last run, or null for "everything".
const _dirty = new Map<SyncKind, Set<string> | null>();
// Last revision seen per kind, including kinds with no handler.
const _lastSeen = new Map<string, number>();
const _timers = new Map<SyncKind, ReturnType<typeof setTimeout>>();
const _running = new Set<SyncKind>();
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

// Kinds a full resync refetches when the stream reconnects or the epoch turns
// over. library-image is deliberately excluded: a reconnect or an online event
// must not evict and re-download every library photo. Photo writes still reach
// us as their own library-image events (and through the status revision
// check), so nothing is missed. `shot` is excluded too: a resync marks `shots`
// (its whole state) dirty, whose handler already reloads the whole list, so
// refetching each individual shot on top would be redundant.
function _activeResyncKinds(): DataKind[] {
  return _activeKinds().filter((k) => k !== 'library-image' && k !== 'shot');
}

function _isHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

// Only text entry holds off a background refetch: a refetch (or a reload) can
// discard in-progress text, but it cannot corrupt a checkbox, radio, range,
// button, color, file input or <select> -- those re-render from their stored
// value, so focusing one must not block a resync. An <input> with no type (or
// an unknown one) is a text field.
const TEXT_INPUT_TYPES = new Set([
  'text', 'search', 'number', 'email', 'url', 'tel', 'password',
  'date', 'time', 'datetime-local', '',
]);

function _focusBlocked(): boolean {
  if (typeof document === 'undefined') return false;
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName ? el.tagName.toLowerCase() : '';
  if (tag === 'textarea') return true;
  if (tag === 'input') {
    const type = ((el as HTMLInputElement).type || '').toLowerCase();
    return TEXT_INPUT_TYPES.has(type);
  }
  return el.isContentEditable === true;
}

// The surfaces that must hold back a reload. Bottom sheets mark <body> with
// .lib-sheet-open (see bean-form-sheet.ts / detail-sheet.ts). The modal
// overlays are .guided-maint-overlay (profile/dial-in editors, guided
// maintenance, flavor wheel, brew confirm), while the backup and scan dialogs
// are #backupModal/#scanModal shown through their .open class. The
// guided-maint overlays hide/show by inline display (the default markup is
// display:none), so a bare selector cannot tell an open one from the hidden
// default -- each candidate is checked for visibility. A native <dialog>
// carries its own [open] attribute.
const OVERLAY_SELECTOR = '.guided-maint-overlay, #backupModal.open, #scanModal.open';

function _elementShown(el: Element): boolean {
  const style = (el as HTMLElement).style;
  return !style || style.display !== 'none';
}

function _overlayOpen(): boolean {
  if (typeof document === 'undefined') return false;
  const body = document.body;
  if (body && body.classList && body.classList.contains('lib-sheet-open')) return true;
  if (typeof document.querySelector !== 'function') return false;
  if (document.querySelector('dialog[open]') !== null) return true;
  if (typeof document.querySelectorAll !== 'function') return false;
  for (const el of document.querySelectorAll(OVERLAY_SELECTOR)) {
    if (_elementShown(el)) return true;
  }
  return false;
}

/**
 * True while an automatic whole-page reload would discard user work: a
 * text-entry field has focus or a bottom sheet, modal or dialog is open.
 * Exported so the `all` (whole-database reload) handler can carry it into its
 * canRun. The scheduler already applies the focus and hidden-tab guards to
 * every kind.
 */
export function reloadBlocked(): boolean {
  return _focusBlocked() || _overlayOpen();
}

function _schedule(kind: SyncKind, delay = DEBOUNCE_MS): void {
  const existing = _timers.get(kind);
  if (existing !== undefined) clearTimeout(existing);
  _timers.set(kind, setTimeout(() => {
    _timers.delete(kind);
    void _drain(kind);
  }, delay));
}

// Records a revision with the never-lower rule: a stale (lower) value from an
// out-of-order event must not undo a higher watermark. Returns whether the
// watermark advanced past what was already recorded.
function _recordSeen(kind: string, rev: number): boolean {
  const seen = _lastSeen.get(kind);
  if (seen !== undefined && rev <= seen) return false;
  _lastSeen.set(kind, rev);
  return true;
}

function _markDirty(kind: SyncKind, id: string | null): void {
  const current = _dirty.get(kind);
  if (current === null || id == null) _dirty.set(kind, null);
  else if (current === undefined) _dirty.set(kind, new Set([id]));
  else current.add(id);
  _schedule(kind);
}

// Switching epoch forgets every recorded revision and marks each resync kind
// dirty: the server restarted, so its counters begin again from zero and the
// client must refetch rather than trust its stale high-water marks. Photos are
// excluded (see _activeResyncKinds).
function _syncEpoch(epoch: string): void {
  if (_epoch === epoch) return;
  const changed = _epoch !== null;
  _epoch = epoch;
  if (!changed) return;
  _lastSeen.clear();
  for (const kind of _activeResyncKinds()) _markDirty(kind, null);
}

// Single-flight per kind: concurrent drains collapse into one run, and if the
// kind is dirtied again while that run is in flight exactly one rerun follows.
// The loaders swallow their own errors, so a failed refetch is not retried here
// -- recovery comes from resyncAll() (an online event or SSE reconnect).
async function _drain(kind: SyncKind): Promise<void> {
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
  try {
    await handler.run(ids);
  } catch {
    // A throwing handler must not wedge the kind as permanently running; the
    // loaders do not throw, so this is only a scheduler safety net.
  } finally {
    _running.delete(kind);
    if (_dirty.has(kind)) void _drain(kind);
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
 * Marks every resync kind dirty with null (its whole state), so the next drain
 * refetches it. Called after the browser comes back online or the SSE stream
 * reconnects: a refetch that failed or was missed while offline is recovered
 * here rather than by a per-run retry. Photos are left alone -- re-downloading
 * the whole library image cache on every reconnect is wasteful, and photo
 * writes are still caught by their own events and the status revision check.
 * Back-to-back calls are already coalesced by each kind's debounce, so no
 * throttle is applied here: a resync that follows an earlier round whose
 * refetches failed (the online event often fires before the network works) must
 * still run rather than be swallowed.
 */
export function resyncAll(): void {
  for (const kind of _activeResyncKinds()) _markDirty(kind, null);
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
    // them. A remote whole-database change reloads the page through the all
    // handler, deferred by the same focus/hidden guards as any other run; our
    // own echo only records the revisions.
    if (p.revs && typeof p.revs === 'object') {
      for (const [k, r] of Object.entries(p.revs)) {
        if (typeof r === 'number') _recordSeen(k, r);
      }
    }
    if (!own) _markDirty(ALL_KIND, null);
    return;
  }

  if (own) {
    // Our own write: remember its revision so the echo cannot re-trigger us. A
    // gap (rev > seen + 1) means a remote change landed before the echo, so
    // catch up rather than hiding it behind the higher watermark. With no
    // baseline yet we cannot tell, so refetch once.
    if (rev !== null) {
      const seen = _lastSeen.get(kind);
      if (_isRegistered(kind) && (seen === undefined || rev > seen + 1)) _markDirty(kind, null);
      _recordSeen(kind, rev);
    }
    return;
  }

  if (rev !== null && !_recordSeen(kind, rev)) return;
  if (!_isRegistered(kind)) return;
  _markDirty(kind, typeof p.id === 'string' ? p.id : null);
}

/**
 * Records the server's epoch and per-kind revisions from /api/status. The first
 * snapshot is only a baseline; on later polls a higher revision (same epoch)
 * marks that kind dirty, catching anything a missed SSE event left behind.
 * A bump within OWN_WRITE_GRACE_MS of this page's own mutating request is
 * skipped entirely -- neither recorded nor marked dirty -- so a remote change
 * that raised the revision further still arrives through its own SSE event
 * (the watermark stays behind it). The own echo, or the first poll after the
 * window, then records the revision.
 */
export function noteServerRevs(epoch?: string | null, revs?: Record<string, number> | null): void {
  const first = !_statusSynced;
  if (typeof epoch === 'string' && epoch) _syncEpoch(epoch);
  const at = lastWriteAt();
  const ownRecently = at !== null && Date.now() - at < OWN_WRITE_GRACE_MS;
  if (revs && typeof revs === 'object') {
    for (const [kind, rev] of Object.entries(revs)) {
      if (typeof rev !== 'number') continue;
      // Within the grace window a later poll's bump is assumed to be this
      // page's own write: record nothing and mark nothing. If it was actually
      // a remote change, its own event -- or the first poll after the window
      // -- still sees the untouched watermark and refetches.
      if (!first && ownRecently) continue;
      if (!_recordSeen(kind, rev)) continue;
      if (!first && _isRegistered(kind)) _markDirty(kind, null);
    }
  }
  _statusSynced = true;
}
