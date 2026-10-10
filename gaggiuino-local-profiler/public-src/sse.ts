import { S } from './state/index.js';

// #735: thin wrapper around EventSource for the single multiplexed
// GET /api/events stream (live-snapshot/preheat-update). No Ingress
// precedent exists for
// streaming in this app, so this deliberately does NOT trust SSE blindly --
// see the fallback detection below -- callers keep their existing polling
// code path as a fallback for whenever it doesn't connect cleanly.

// Event names for the backend's /api/events stream -- kept here (not just as
// string literals at each onEvent() call site) so a future rename only
// needs updating in one spot. The backend and frontend can't share a single
// module, so this is a values-must-match-the-backend contract, not true DRY.
export const EVENTS = {
  LIVE_SNAPSHOT: 'live-snapshot',
  PREHEAT_UPDATE: 'preheat-update',
  // #1539: the server publishes one of these after every successful write, with
  // the changed data kind and revision — see live-sync.ts.
  DATA_CHANGED: 'data-changed',
};

const WATCHDOG_MS = 8000;
const MAX_STRIKES = 3;
// #1016: the backend unconditionally emits a
// PREHEAT_UPDATE every 30s regardless of machine/live state -- the one named
// event the backend guarantees no matter what. STALE_MS sits comfortably
// above that floor so normal jitter never false-positives, while still
// catching a stream that has gone silent (Ingress/proxy killed it without a
// clean close, token expiry, etc.) well within a session.
const STALE_MS = 40000;
// #1539: once a stream has connected, EventSource stops retrying on its own as
// soon as it reaches CLOSED (e.g. a 502 while Home Assistant restarts). Drive
// our own reconnect with backoff so a live session recovers without a reload.
const RECONNECT_BASE_MS = 5000;
const RECONNECT_MAX_MS = 60000;

let source: EventSource | null = null;
let everConnected = false;
let strikes = 0;
let watchdogTimer: ReturnType<typeof setTimeout> | null = null;
let staleTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = RECONNECT_BASE_MS;
const listeners = new Map<string, Set<(data: unknown) => void>>(); // type -> Set<cb>
const attachedTypes = new Set<string>(); // types with a native listener already wired on the current `source`

function clearWatchdog(): void {
  if (watchdogTimer) { clearTimeout(watchdogTimer); watchdogTimer = null; }
}

function clearStaleTimer(): void {
  if (staleTimer) { clearTimeout(staleTimer); staleTimer = null; }
}

function clearReconnect(): void {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
}

// Re-armed on every open + every received event (see dispatch() below). If
// it ever fires, no traffic at all has arrived for STALE_MS despite having
// connected once -- the mid-session counterpart to the first-connect
// watchdog above. Unlike triggerFallback(), this does NOT tear down
// `source`: EventSource's own native reconnect may still be working in the
// background and can flip S.sseActive back to true via onopen once it
// recovers, same as any other transient drop.
function armStaleTimer(): void {
  clearStaleTimer();
  staleTimer = setTimeout(() => { S.sseActive = false; }, STALE_MS);
}

function dispatch(type: string): (e: MessageEvent) => void {
  return e => {
    let data: unknown;
    try { data = JSON.parse(e.data as string); } catch { return; }
    // A real message is itself the strongest possible "still working" signal
    // -- resets the stale window and (covering the rare case of traffic
    // resuming on the same never-actually-closed connection, so onopen never
    // re-fires) restores S.sseActive directly rather than waiting on onopen.
    S.sseActive = true;
    armStaleTimer();
    for (const cb of listeners.get(type) || []) cb(data);
  };
}

// One native EventSource listener per event type, fanning out to every
// registered callback for that type -- avoids re-wrapping/leaking a fresh
// closure per onEvent() call, and keeps offEvent() a plain Set.delete().
function attachType(type: string): void {
  if (!source || attachedTypes.has(type)) return;
  source.addEventListener(type, dispatch(type));
  attachedTypes.add(type);
}

// Marks SSE as not working and hands control back to the caller's polling
// fallback. Only ever reached via a call site that already checked
// `!everConnected` -- a normal auto-reconnect after a mid-session drop must
// NOT re-trigger this, only "never once connected" does.
function triggerFallback(onFallback?: () => void): void {
  S.sseActive = false;
  disconnectEvents();
  onFallback?.();
}

// Opens a fresh EventSource and wires its handlers. `isReconnect` leaves
// everConnected set, so a successful reopen announces itself through
// onReconnect instead of being mistaken for a first connect (which would arm
// the fallback watchdog and reset the error counter).
function _open(onFallback: (() => void) | undefined, onReconnect: (() => void) | undefined, isReconnect: boolean): void {
  const url = S.glpToken ? `api/events?token=${encodeURIComponent(S.glpToken)}` : 'api/events';
  source = new EventSource(url);
  for (const type of listeners.keys()) attachType(type);

  if (!isReconnect) {
    watchdogTimer = setTimeout(() => {
      if (!everConnected) triggerFallback(onFallback);
    }, WATCHDOG_MS);
  }

  source.onopen = () => {
    // A second open (within one connection, or after our own reopen) follows a
    // drop; tell the caller so it can resync what it missed.
    const reconnected = everConnected;
    everConnected = true;
    strikes = 0;
    reconnectDelay = RECONNECT_BASE_MS;
    S.sseActive = true;
    clearWatchdog();
    armStaleTimer();
    if (reconnected) onReconnect?.();
  };

  source.onerror = () => {
    if (!everConnected) {
      strikes++;
      if (strikes >= MAX_STRIKES) triggerFallback(onFallback);
      return;
    }
    // A stream that reached CLOSED after having connected is one EventSource
    // has given up on; it will not retry itself, so schedule our own reconnect
    // with backoff. A CONNECTING/OPEN stream is mid auto-reconnect -- leave it.
    if (source && source.readyState === EventSource.CLOSED) scheduleReconnect(onFallback, onReconnect);
  };
}

// One reconnect timer at a time. Each fire reopens over the same callbacks
// (isReconnect=true) and doubles the next delay, capped at RECONNECT_MAX_MS; a
// successful open resets it. disconnectEvents() cancels a pending timer.
function scheduleReconnect(onFallback: (() => void) | undefined, onReconnect: (() => void) | undefined): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (source) { source.close(); source = null; }
    attachedTypes.clear();
    _open(onFallback, onReconnect, true);
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
}

// Opens the stream and wires the fallback-detection watchdog/error-counter.
// `onFallback` fires at most once, only if the connection has NEVER
// successfully opened -- a normal EventSource auto-reconnect (or our own
// reconnect below) after a mid-session drop must not flicker the app back into
// polling mode.
export function connectEvents(onFallback?: () => void, onReconnect?: () => void): void {
  disconnectEvents();
  everConnected = false;
  strikes = 0;
  reconnectDelay = RECONNECT_BASE_MS;
  _open(onFallback, onReconnect, false);
}

export function disconnectEvents(): void {
  clearWatchdog();
  clearStaleTimer();
  clearReconnect();
  if (source) { source.close(); source = null; }
  attachedTypes.clear();
}

export function onEvent(type: string, cb: (data: unknown) => void): void {
  if (!listeners.has(type)) listeners.set(type, new Set());
  listeners.get(type)!.add(cb);
  attachType(type);
}

export function offEvent(type: string, cb: (data: unknown) => void): void {
  listeners.get(type)?.delete(cb);
}
