// Persistent WS session (one per machine baseUrl) that decodes and caches
// d_sensor_snap/d_sys_state pushes (#597) — a second connection pattern
// alongside lib/gaggiuino-ws-client.js's short-lived-connection-per-request
// one. Both messages stream unsolicited (sensor_snap continuously, sys_state
// on every change — see websocket.md), so treating either as a request/
// response round trip would mean either opening a fresh WS connection per
// poll (blowing through the firmware's WS_MAX_CONNECTIONS=3 budget under any
// real polling interval) or missing state that changed between polls. One
// long-lived connection per machine, lazily opened on first read and reused
// across every subsequent call, stays within that budget regardless of how
// often callers ask.
//
// Emits 'sensor-snap' / 'sys-state' (baseUrl, payload) on the shared `events`
// bus below whenever a session's cache updates — this is the seam for a
// future consumer (e.g. an MQTT publisher republishing machine state, not
// part of this issue) to piggyback on this same connection's data without
// parsing WS frames itself or reaching into session internals:
// `require('./gaggiuino-live-client').events.on('sensor-snap', (baseUrl, snap) => ...)`.
// No publisher exists yet — this only wires the observer seam.
'use strict';
const WebSocket = require('ws');
const { EventEmitter } = require('events');
const { wsUrlFor } = require('./gaggiuino-ws-client');
const { WebSocketMessageDto, SensorStateSnapshotDto, SystemStateDto } = require('./gaggiuino-proto');
const { log } = require('./helpers');

const RECONNECT_DELAY_MS = 3000;
// A cached value older than this is reported as unavailable (null) rather
// than silently served stale — e.g. after the machine drops off the network
// and the reconnect loop below is still retrying.
const STALE_MS = 15000;

const events = new EventEmitter();
const sessions = new Map(); // baseUrl -> session state

function getSession(baseUrl) {
    let session = sessions.get(baseUrl);
    if (!session) {
        session = {
            ws: null, connecting: false, reconnectTimer: null,
            sensorSnap: null, sensorSnapAt: 0,
            sysState: null, sysStateAt: 0,
        };
        sessions.set(baseUrl, session);
    }
    return session;
}

function connect(baseUrl) {
    const session = getSession(baseUrl);
    if (session.ws || session.connecting) return session;
    session.connecting = true;

    const ws = new WebSocket(wsUrlFor(baseUrl));
    session.ws = ws;

    ws.on('open', () => { session.connecting = false; });

    ws.on('message', (data) => {
        let envelope;
        try { envelope = WebSocketMessageDto.fromBinary(data); } catch { return; } // not a valid envelope frame, ignore
        if (!envelope.data) return;
        if (envelope.action === 'd_sensor_snap') {
            try {
                session.sensorSnap = SensorStateSnapshotDto.fromBinary(envelope.data);
                session.sensorSnapAt = Date.now();
                events.emit('sensor-snap', baseUrl, session.sensorSnap);
            } catch { /* malformed frame, ignore */ }
        } else if (envelope.action === 'd_sys_state') {
            try {
                session.sysState = SystemStateDto.fromBinary(envelope.data);
                session.sysStateAt = Date.now();
                events.emit('sys-state', baseUrl, session.sysState);
            } catch { /* malformed frame, ignore */ }
        }
    });

    const scheduleReconnect = () => {
        session.ws = null;
        session.connecting = false;
        if (session.reconnectTimer) return;
        session.reconnectTimer = setTimeout(() => {
            session.reconnectTimer = null;
            connect(baseUrl);
        }, RECONNECT_DELAY_MS);
    };

    ws.on('close', scheduleReconnect);
    ws.on('error', (e) => {
        log(`Gaggiuino live WS error (${baseUrl}): ${e.message}`, true);
        scheduleReconnect();
    });

    return session;
}

function freshOrNull(value, at) {
    if (value === null || Date.now() - at > STALE_MS) return null;
    return value;
}

// #600: closes and forgets exactly one machine's session — unlike
// disconnectAll() (used by routes/mqtt.js's settings-save flow, which really
// does mean "every session, the broker changed"), removing or re-hosting one
// machine must never touch any other machine's live session. Removes the ws
// listeners before terminating so a 'close' event fired by the teardown
// itself can't run scheduleReconnect()'s closure and silently recreate the
// very session entry this just deleted.
function disconnect(baseUrl) {
    const session = sessions.get(baseUrl);
    if (!session) return;
    if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
    if (session.ws) {
        session.ws.removeAllListeners();
        try { session.ws.terminate(); } catch { /* already closed */ }
    }
    sessions.delete(baseUrl);
}

// Same host -> baseUrl normalisation lib/machines/gaggiuino/adapter.js's
// baseUrlFor() applies (scheme defaulted to http://, then re-serialised via
// URL) minus its async assertMachineHost() SSRF check — that check gates
// whether a *new* connection is allowed to open, it doesn't change the key
// string, and running it here would make eviction of a now-unreachable
// machine's stale session fail exactly when eviction matters most (host
// removed/powered off => DNS may no longer resolve at all).
function normalizeBaseUrl(host) {
    const raw = (host || '').trim();
    if (!raw) return null;
    const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
    try {
        const u = new URL(withScheme);
        return `${u.protocol}//${u.host}`;
    } catch {
        return null;
    }
}

// lib/machines/registry.js's targeted entrypoint: normalizes a raw machine
// host straight to the session key and evicts it, so registry.js never has
// to duplicate connect()'s key format itself.
function disconnectForHost(host) {
    const baseUrl = normalizeBaseUrl(host);
    if (baseUrl) disconnect(baseUrl);
}

// Both getters lazily (re)open the session's connection as a side effect —
// the very first call for a given baseUrl returns null (nothing cached yet)
// until the machine's next push arrives, same as any other cold cache.
function getLiveSensorSnapshot(baseUrl) {
    const session = connect(baseUrl);
    return freshOrNull(session.sensorSnap, session.sensorSnapAt);
}

function getLiveSystemState(baseUrl) {
    const session = connect(baseUrl);
    return freshOrNull(session.sysState, session.sysStateAt);
}

module.exports = { getLiveSensorSnapshot, getLiveSystemState, events, disconnect, disconnectForHost };
