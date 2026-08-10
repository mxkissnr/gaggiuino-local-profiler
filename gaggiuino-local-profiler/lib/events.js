'use strict';
// #735: minimal backend pub/sub feeding routes/sse.js's single multiplexed
// SSE endpoint (GET /api/events). A plain EventEmitter is enough -- no
// external broker needed for a single-process add-on. setMaxListeners(50)
// because every open browser tab registers its own listener per event type
// it cares about (see routes/sse.js), and Node's default cap of 10 would log
// a MaxListenersExceededWarning long before that's an actual problem.
const EventEmitter = require('events');

const bus = new EventEmitter();
bus.setMaxListeners(50);

// PREHEAT_UPDATE/LIVE_SNAPSHOT are defined now, even though this PR's
// backend (lib/sync.js) never emits them yet, so PR 2 (live-mode over the
// same bus/route) doesn't need to rename anything here.
const EVENTS = {
    SYNC_PROGRESS: 'sync-progress',
    SYNC_COMPLETE: 'sync-complete',
    LIVE_SNAPSHOT: 'live-snapshot',
    PREHEAT_UPDATE: 'preheat-update',
};

module.exports = { bus, EVENTS };
