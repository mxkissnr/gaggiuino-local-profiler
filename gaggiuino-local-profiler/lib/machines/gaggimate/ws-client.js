// JSON WebSocket client for GaggiMate machines (#318). Own implementation
// written from the protocol description in
// https://raw.githubusercontent.com/jniebuhr/gaggimate/master/docs/websocket-api.yaml
// (fetched for reference only, never copied — see the repo's Gaggiuino
// project-boundaries rule, which we hold GaggiMate to as well) — no code or
// assets from the GaggiMate repo are vendored here.
//
// Protocol shape: one WebSocket at ws://<host>/ws, JSON frames with a `tp`
// (type) field. Requests are `req:<name>` (optionally carrying an `rid` for
// correlation), answered by a `res:<name>` frame; the server also pushes
// unsolicited `evt:status` frames with live telemetry (ct/tt/pr/fl/pt/m/p
// /cp/cd) on its own cadence — there is no explicit "get status" request.
'use strict';
const WebSocket = require('ws');

const DEFAULT_TIMEOUT_MS = 8000;

function wsUrlFor(baseUrl) {
    const u = new URL(baseUrl);
    const proto = u.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${u.host}/ws`;
}

// Opens a short-lived connection, sends one `req:<name>` frame (with a
// request id for correlation) and resolves with the payload of the first
// matching `res:<name>` frame that echoes the same `rid` — mirrors
// lib/gaggiuino-ws-client.js's per-call connection pattern, adapted to JSON
// framing. GaggiMate's request volume from GLP is low (profile CRUD, one-off
// commands), so a fresh connection per call is simpler and easier to test
// than maintaining a shared persistent socket for this path.
function request(baseUrl, reqType, payload = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
        if (!reqType.startsWith('req:')) return reject(new Error(`Not a request type: ${reqType}`));
        const resType = `res:${reqType.slice(4)}`;
        const rid = Math.floor(Math.random() * 1e9);

        let settled = false;
        const ws = new WebSocket(wsUrlFor(baseUrl));
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            ws.terminate();
            reject(new Error(`Timed out waiting for "${resType}" from the machine`));
        }, timeoutMs);

        function finish(err, value) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { ws.close(); } catch { /* already closing */ }
            err ? reject(err) : resolve(value);
        }

        ws.on('open', () => {
            ws.send(JSON.stringify({ tp: reqType, rid, ...payload }));
        });

        ws.on('message', (data) => {
            if (settled) return;
            let msg;
            try { msg = JSON.parse(data.toString()); } catch { return; }
            if (msg.tp !== resType) return;
            // GaggiMate firmware echoes `rid` back as a string even though the
            // client sends it as a number (verified live against a real device,
            // #342) — the comparison must be type-tolerant, not a strict `!==`.
            if (msg.rid !== undefined && String(msg.rid) !== String(rid)) return;
            finish(null, msg);
        });

        ws.on('error', (e) => finish(new Error(`WebSocket error: ${e.message}`)));
    });
}

// Connects, waits for the first `evt:status` broadcast (the machine's own
// telemetry push, not a request/response), and resolves with its fields.
function waitForStatus(baseUrl, timeoutMs = DEFAULT_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const ws = new WebSocket(wsUrlFor(baseUrl));
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            ws.terminate();
            reject(new Error('Timed out waiting for evt:status from the machine'));
        }, timeoutMs);

        function finish(err, value) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { ws.close(); } catch { /* already closing */ }
            err ? reject(err) : resolve(value);
        }

        ws.on('message', (data) => {
            if (settled) return;
            let msg;
            try { msg = JSON.parse(data.toString()); } catch { return; }
            if (msg.tp === 'evt:status') finish(null, msg);
        });

        ws.on('error', (e) => finish(new Error(`WebSocket error: ${e.message}`)));
    });
}

// Persistent, auto-reconnecting connection for continuous live-status
// polling (used by the multi-machine live-poll loop, not by one-off adapter
// calls). Exponential backoff capped at 30s; never throws — callers read
// .status / .reachable instead of awaiting a promise per tick.
class GaggiMateLiveClient {
    constructor(baseUrl) {
        this.baseUrl = baseUrl;
        this.status = null;
        this.reachable = false;
        this.closed = false;
        this._ws = null;
        this._backoffMs = 1000;
        this._connect();
    }

    _connect() {
        if (this.closed) return;
        const ws = new WebSocket(wsUrlFor(this.baseUrl));
        this._ws = ws;
        ws.on('open', () => { this.reachable = true; this._backoffMs = 1000; });
        ws.on('message', (data) => {
            let msg;
            try { msg = JSON.parse(data.toString()); } catch { return; }
            if (msg.tp === 'evt:status') this.status = msg;
        });
        ws.on('close', () => { this.reachable = false; this._scheduleReconnect(); });
        ws.on('error', () => { this.reachable = false; try { ws.terminate(); } catch {} });
    }

    _scheduleReconnect() {
        if (this.closed) return;
        setTimeout(() => this._connect(), this._backoffMs);
        this._backoffMs = Math.min(this._backoffMs * 2, 30000);
    }

    close() {
        this.closed = true;
        try { this._ws?.close(); } catch {}
    }
}

module.exports = { wsUrlFor, request, waitForStatus, GaggiMateLiveClient };
