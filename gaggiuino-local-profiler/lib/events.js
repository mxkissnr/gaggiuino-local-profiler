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

// SYNC_PROGRESS/SYNC_COMPLETE: emitted by lib/sync.js's backfill loop (#735).
// LIVE_SNAPSHOT/PREHEAT_UPDATE: emitted by lib/poll.js/lib/preheat.js (#736).
const EVENTS = {
    SYNC_PROGRESS: 'sync-progress',
    SYNC_COMPLETE: 'sync-complete',
    LIVE_SNAPSHOT: 'live-snapshot',
    PREHEAT_UPDATE: 'preheat-update',
};

module.exports = { bus, EVENTS };
