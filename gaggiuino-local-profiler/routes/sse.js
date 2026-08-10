// #735/#736: GET /api/events -- single SSE endpoint multiplexing every push
// event type over one connection (sync-progress/sync-complete from #735,
// live-snapshot/preheat-update added by #736). Existing REST endpoints
// (/api/status, /api/live/data, /api/preheat) are untouched -- other GLP
// repos may consume them directly, and the frontend falls back to polling
// them whenever this stream doesn't work (see public-src/sse.js).
'use strict';
const express = require('express');
const router  = express.Router();

const state = require('../lib/state');
const { bus, EVENTS } = require('../lib/events');
const { buildPreheatResponse } = require('../lib/preheat');

const PING_INTERVAL_MS = 20_000;

router.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // #738: harmless to keep even though #740 ruled out nginx-style proxy
    // buffering (any reverse proxy in front of HA Ingress) as the cause --
    // Supervisor's own ingress.py already sets this on its side too, so
    // this is redundant defense-in-depth, not the actual fix.
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    // #740: disable Nagle's algorithm on the response socket. Our events are
    // tiny (a few dozen bytes each, one res.write() per shot) -- without
    // this, small writes can sit coalescing before actually leaving the
    // socket, worsened by the extra Core->Supervisor->add-on hop count HA
    // Ingress adds. A well-known, easy-to-miss gotcha for Node SSE endpoints.
    res.socket?.setNoDelay?.(true);
    // #740: over HA Ingress (both external and local direct-to-Core access,
    // identical -- so not an external reverse proxy issue), the connection
    // never actually opened client-side within our own watchdog window even
    // though the direct add-on port streams correctly and our response
    // carries no Content-Length (ruling out both documented Ingress-side
    // buffering triggers we could find in Supervisor's/Core's own source).
    // This initial padding comment (ignored by EventSource -- any line
    // starting with ':' is a no-op per spec) forces a flush past whichever
    // intermediate layer is buffering, regardless of which exact hop it is.
    res.write(`:${' '.repeat(2048)}\n\n`);

    function send(type, data) {
        res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    }

    // Prime a newly-connected client with whatever backfill is already in
    // progress -- without this, a tab opened mid-import would show no
    // progress bar at all until the next shot bumps it.
    for (const [machineId, p] of state.syncProgress) {
        send(EVENTS.SYNC_PROGRESS, { machineId, current: p.current, total: p.total });
    }

    // #736: also prime with the current preheat snapshot -- without this the
    // Ready badge would wait up to 30s for the watcher's first tick. No
    // equivalent priming for LIVE_SNAPSHOT: its 1s cadence is fast enough
    // that a new client just waits for the next regular tick.
    send(EVENTS.PREHEAT_UPDATE, buildPreheatResponse());

    const onProgress = payload => send(EVENTS.SYNC_PROGRESS, payload);
    const onComplete  = payload => send(EVENTS.SYNC_COMPLETE, payload);
    const onLiveSnapshot  = payload => send(EVENTS.LIVE_SNAPSHOT, payload);
    const onPreheatUpdate = payload => send(EVENTS.PREHEAT_UPDATE, payload);
    bus.on(EVENTS.SYNC_PROGRESS, onProgress);
    bus.on(EVENTS.SYNC_COMPLETE, onComplete);
    bus.on(EVENTS.LIVE_SNAPSHOT, onLiveSnapshot);
    bus.on(EVENTS.PREHEAT_UPDATE, onPreheatUpdate);

    // Keepalive comment line (not a real event) against silent proxy/idle
    // timeouts -- HA Ingress and any LAN reverse proxy in between.
    const pingTimer = setInterval(() => res.write(':ping\n\n'), PING_INTERVAL_MS);

    req.on('close', () => {
        clearInterval(pingTimer);
        bus.off(EVENTS.SYNC_PROGRESS, onProgress);
        bus.off(EVENTS.SYNC_COMPLETE, onComplete);
        bus.off(EVENTS.LIVE_SNAPSHOT, onLiveSnapshot);
        bus.off(EVENTS.PREHEAT_UPDATE, onPreheatUpdate);
    });
});

module.exports = router;
