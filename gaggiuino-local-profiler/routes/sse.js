// #735: GET /api/events -- single SSE endpoint multiplexing every push event
// type over one connection (sync-progress/sync-complete now, live-snapshot/
// preheat-update added by the PR 2 follow-up). Existing REST endpoints
// (/api/status, /api/live/data, /api/preheat) are untouched -- other GLP
// repos may consume them directly, and the frontend falls back to polling
// them whenever this stream doesn't work (see public-src/sse.js).
'use strict';
const express = require('express');
const router  = express.Router();

const state = require('../lib/state');
const { bus, EVENTS } = require('../lib/events');

const PING_INTERVAL_MS = 20_000;

router.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // #738: HA Supervisor's Ingress panel is served through an nginx reverse
    // proxy, which buffers proxied responses by default -- without this
    // header, nginx held the whole stream until it had accumulated enough
    // bytes (or the connection closed) before flushing to the browser, so
    // events arrived in the same "block jump" pattern as the old 30s poll
    // despite the backend emitting one per shot. Live-tested over Ingress;
    // not reproducible in a local/direct-port dev session, which has no
    // such proxy in front of it.
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    function send(type, data) {
        res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    }

    // Prime a newly-connected client with whatever backfill is already in
    // progress -- without this, a tab opened mid-import would show no
    // progress bar at all until the next shot bumps it.
    for (const [machineId, p] of state.syncProgress) {
        send(EVENTS.SYNC_PROGRESS, { machineId, current: p.current, total: p.total });
    }

    const onProgress = payload => send(EVENTS.SYNC_PROGRESS, payload);
    const onComplete  = payload => send(EVENTS.SYNC_COMPLETE, payload);
    bus.on(EVENTS.SYNC_PROGRESS, onProgress);
    bus.on(EVENTS.SYNC_COMPLETE, onComplete);

    // Keepalive comment line (not a real event) against silent proxy/idle
    // timeouts -- HA Ingress and any LAN reverse proxy in between.
    const pingTimer = setInterval(() => res.write(':ping\n\n'), PING_INTERVAL_MS);

    req.on('close', () => {
        clearInterval(pingTimer);
        bus.off(EVENTS.SYNC_PROGRESS, onProgress);
        bus.off(EVENTS.SYNC_COMPLETE, onComplete);
    });
});

module.exports = router;
