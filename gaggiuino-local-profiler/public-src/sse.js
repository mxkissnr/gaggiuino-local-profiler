import { S } from './state.js';

// #735: thin wrapper around EventSource for the single multiplexed
// GET /api/events stream (sync-progress/sync-complete now, live-snapshot/
// preheat-update from the PR 2 follow-up). No Ingress precedent exists for
// streaming in this app, so this deliberately does NOT trust SSE blindly --
// see the fallback detection below -- callers keep their existing polling
// code path as a fallback for whenever it doesn't connect cleanly.

// Mirrors lib/events.js's EVENTS on the backend -- kept here (not just as
// string literals at each onEvent() call site) so a future rename only
// needs updating in one frontend spot. The two files can't share a single
// JS module (CommonJS backend vs. bundled ESM frontend), so this is a
// values-must-match-lib/events.js contract, not true DRY.
export const EVENTS = {
  SYNC_PROGRESS: 'sync-progress',
  SYNC_COMPLETE: 'sync-complete',
  LIVE_SNAPSHOT: 'live-snapshot',
  PREHEAT_UPDATE: 'preheat-update',
};

const WATCHDOG_MS = 8000;
const MAX_STRIKES = 3;
// #1016: lib/preheat.js's startPreheatWatcher() unconditionally emits a
// PREHEAT_UPDATE every 30s regardless of machine/live state -- the one named
// event the backend guarantees no matter what. STALE_MS sits comfortably
// above that floor so normal jitter never false-positives, while still
// catching a stream that has gone silent (Ingress/proxy killed it without a
// clean close, token expiry, etc.) well within a session.
const STALE_MS = 40000;

let source = null;
let everConnected = false;
let strikes = 0;
let watchdogTimer = null;
let staleTimer = null;
const listeners = new Map(); // type -> Set<cb>
const attachedTypes = new Set(); // types with a native listener already wired on the current `source`

function clearWatchdog() {
  if (watchdogTimer) { clearTimeout(watchdogTimer); watchdogTimer = null; }
}

function clearStaleTimer() {
  if (staleTimer) { clearTimeout(staleTimer); staleTimer = null; }
}

// Re-armed on every open + every received event (see dispatch() below). If
// it ever fires, no traffic at all has arrived for STALE_MS despite having
// connected once -- the mid-session counterpart to the first-connect
// watchdog above. Unlike triggerFallback(), this does NOT tear down
// `source`: EventSource's own native reconnect may still be working in the
// background and can flip S.sseActive back to true via onopen once it
// recovers, same as any other transient drop.
function armStaleTimer() {
  clearStaleTimer();
  staleTimer = setTimeout(() => { S.sseActive = false; }, STALE_MS);
}

function dispatch(type) {
  return e => {
    let data;
    try { data = JSON.parse(e.data); } catch { return; }
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
function attachType(type) {
  if (!source || attachedTypes.has(type)) return;
  source.addEventListener(type, dispatch(type));
  attachedTypes.add(type);
}

// Marks SSE as not working and hands control back to the caller's polling
// fallback. Only ever reached via a call site that already checked
// `!everConnected` -- a normal auto-reconnect after a mid-session drop must
// NOT re-trigger this, only "never once connected" does.
function triggerFallback(onFallback) {
  S.sseActive = false;
  disconnectEvents();
  onFallback?.();
}

// Opens the stream and wires the fallback-detection watchdog/error-counter.
// `onFallback` fires at most once, only if the connection has NEVER
// successfully opened -- a normal EventSource auto-reconnect after a
// mid-session drop must not flicker the app back into polling mode.
export function connectEvents(onFallback) {
  disconnectEvents();
  everConnected = false;
  strikes = 0;
  clearStaleTimer();

  const url = S.glpToken ? `api/events?token=${encodeURIComponent(S.glpToken)}` : 'api/events';
  source = new EventSource(url);
  for (const type of listeners.keys()) attachType(type);

  watchdogTimer = setTimeout(() => {
    if (!everConnected) triggerFallback(onFallback);
  }, WATCHDOG_MS);

  source.onopen = () => {
    everConnected = true;
    strikes = 0;
    S.sseActive = true;
    clearWatchdog();
    armStaleTimer();
  };

  source.onerror = () => {
    if (everConnected) return; // normal auto-reconnect after a drop -- not a fallback trigger
    strikes++;
    if (strikes >= MAX_STRIKES) triggerFallback(onFallback);
  };
}

export function disconnectEvents() {
  clearWatchdog();
  clearStaleTimer();
  if (source) { source.close(); source = null; }
  attachedTypes.clear();
}

export function onEvent(type, cb) {
  if (!listeners.has(type)) listeners.set(type, new Set());
  listeners.get(type).add(cb);
  attachType(type);
}

export function offEvent(type, cb) {
  listeners.get(type)?.delete(cb);
}
