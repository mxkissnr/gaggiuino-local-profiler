// #736: lib/poll.js's LIVE_SNAPSHOT and lib/poll.js/lib/preheat.js's
// PREHEAT_UPDATE emissions over lib/events.js's bus -- the backend half of
// the Live view/preheat-widget SSE push feature. Same in-memory-DB +
// mocked-axios pattern as test/poll-reachability-recovery-sync.test.js
// (which already covers pollViaGaggiuinoStatus()'s other #725 side effects
// structurally); this file only adds coverage for the new event emissions
// on top of that.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const Database = require('better-sqlite3');

const dbPath       = require.resolve('../lib/db');
const realDb       = require(dbPath);
const axiosPath    = require.resolve('axios');
const realAxios    = require(axiosPath);
const registryPath = require.resolve('../lib/machines/registry');
const dataPath     = require.resolve('../lib/data');
const pollPath     = require.resolve('../lib/poll');
const preheatPath  = require.resolve('../lib/preheat');
const eventsPath   = require.resolve('../lib/events');
const syncPath     = require.resolve('../lib/sync');
const realSync     = require(syncPath);
const state        = require('../lib/state');

describe('LIVE_SNAPSHOT/PREHEAT_UPDATE SSE emissions (#736)', () => {
    let memDb, axiosGetMock;

    beforeEach(() => {
        memDb = new Database(':memory:');
        realDb.initSchema(memDb);
        require.cache[dbPath].exports = { getDb: () => memDb, initSchema: realDb.initSchema };

        axiosGetMock = vi.fn().mockResolvedValue({ data: {} });
        require.cache[axiosPath].exports = { get: axiosGetMock };

        require.cache[syncPath].exports = { ...realSync, syncShots: vi.fn().mockResolvedValue(true) };

        // #736: eventsPath (and everything that holds a `bus` reference to
        // it -- pollPath/preheatPath) must be dropped together so every
        // fresh require() below shares one and the same bus instance,
        // instead of some modules holding a stale one from a previous test.
        delete require.cache[eventsPath];
        delete require.cache[registryPath];
        delete require.cache[dataPath];
        delete require.cache[pollPath];
        delete require.cache[preheatPath];

        const registry = require('../lib/machines/registry');
        registry.ensureDefaultMachine();
        registry.updateMachine(1, { host: 'gaggiuino.local' });

        state.liveAccum        = null;
        state.liveSeq          = 0;
        state.machineReachable = null;
        state.lastMachineError = null;
        // Healthy steady state so pollViaGaggiuinoStatus()'s unrelated #725
        // reachability-recovery catch-up sync path never fires here.
        state.lastSyncTime  = new Date().toISOString();
        state.lastSyncError = null;
    });

    afterEach(() => {
        memDb.close();
        require.cache[dbPath].exports = realDb;
        require.cache[axiosPath].exports = realAxios;
        require.cache[syncPath].exports = realSync;
        vi.useRealTimers();
    });

    it('pollViaGaggiuinoStatus() emits LIVE_SNAPSHOT on a successful poll, matching GET /api/live/data\'s shape', async () => {
        const { pollViaGaggiuinoStatus, buildLiveDataResponse } = require('../lib/poll');
        const { MachineRuntimeState } = require('../lib/machine-runtime-state');
        const { bus, EVENTS } = require('../lib/events');
        const runtime = new MachineRuntimeState();

        const events = [];
        bus.on(EVENTS.LIVE_SNAPSHOT, p => events.push(p));

        await pollViaGaggiuinoStatus(runtime);

        expect(events).toHaveLength(1);
        expect(events[0]).toEqual(buildLiveDataResponse());
        expect(events[0]).toEqual({ isLive: false, profileName: '', datapoints: null, seq: 0, machineReachable: true });
    });

    it('pollViaGaggiuinoStatus() emits LIVE_SNAPSHOT with machineReachable:false on a failed poll', async () => {
        axiosGetMock.mockRejectedValueOnce(new Error('network unreachable'));
        const { pollViaGaggiuinoStatus } = require('../lib/poll');
        const { MachineRuntimeState } = require('../lib/machine-runtime-state');
        const { bus, EVENTS } = require('../lib/events');
        const runtime = new MachineRuntimeState();

        const events = [];
        bus.on(EVENTS.LIVE_SNAPSHOT, p => events.push(p));

        await pollViaGaggiuinoStatus(runtime);

        expect(events).toHaveLength(1);
        expect(events[0].machineReachable).toBe(false);
    });

    it('startLivePolling()/stopLivePolling() each emit an immediate PREHEAT_UPDATE', () => {
        const { startLivePolling, stopLivePolling } = require('../lib/poll');
        const { MachineRuntimeState } = require('../lib/machine-runtime-state');
        const { bus, EVENTS } = require('../lib/events');
        const runtime = new MachineRuntimeState();

        const events = [];
        bus.on(EVENTS.PREHEAT_UPDATE, p => events.push(p));

        startLivePolling(runtime);
        expect(events).toHaveLength(1);

        stopLivePolling(runtime);
        expect(events).toHaveLength(2);
    });

    // #736 review: an SSE-connected Live tab client had nothing telling it
    // the machine went offline once fetchLiveData()'s own 1s fallback poll
    // was gated behind S.sseActive -- pollViaGaggiuinoStatus()'s 1s loop
    // (the only other LIVE_SNAPSHOT emitter) is exactly what stopLivePolling()
    // stops, reintroducing #655's bug class for the SSE path specifically.
    it('stopLivePolling() also emits a LIVE_SNAPSHOT reflecting machineReachable:false (#655 for the SSE path)', () => {
        const { startLivePolling, stopLivePolling } = require('../lib/poll');
        const { MachineRuntimeState } = require('../lib/machine-runtime-state');
        const { bus, EVENTS } = require('../lib/events');
        const runtime = new MachineRuntimeState();

        state.machineReachable = true; // was fine before the switch flipped off
        startLivePolling(runtime); // startLivePolling() itself only emits PREHEAT_UPDATE, no LIVE_SNAPSHOT

        const events = [];
        bus.on(EVENTS.LIVE_SNAPSHOT, p => events.push(p));

        stopLivePolling(runtime);

        expect(events).toHaveLength(1);
        expect(events[0].machineReachable).toBe(false);
    });

    it('stopLivePolling() flips machineReachable and emits LIVE_SNAPSHOT even when no live-poll timer was ever running', () => {
        const { stopLivePolling } = require('../lib/poll');
        const { MachineRuntimeState } = require('../lib/machine-runtime-state');
        const { bus, EVENTS } = require('../lib/events');
        const runtime = new MachineRuntimeState(); // never went through startLivePolling()

        state.machineReachable = true;

        const events = [];
        bus.on(EVENTS.LIVE_SNAPSHOT, p => events.push(p));

        stopLivePolling(runtime);

        expect(state.machineReachable).toBe(false);
        expect(events).toHaveLength(1);
        expect(events[0].machineReachable).toBe(false);
    });

    it('setReadyByTarget() emits PREHEAT_UPDATE with the new target reflected', () => {
        const { setReadyByTarget } = require('../lib/preheat');
        const { MachineRuntimeState } = require('../lib/machine-runtime-state');
        const { bus, EVENTS } = require('../lib/events');
        const runtime = new MachineRuntimeState();

        const events = [];
        bus.on(EVENTS.PREHEAT_UPDATE, p => events.push(p));

        const targetAt = Date.now() + 5 * 60 * 1000;
        setReadyByTarget(targetAt, runtime);

        expect(events).toHaveLength(1);
        expect(events[0].readyByTargetAt).toBe(targetAt);
    });

    it('startPreheatWatcher()\'s 30s tick emits a periodic PREHEAT_UPDATE even with nothing else to report', async () => {
        vi.useFakeTimers();
        const { startPreheatWatcher } = require('../lib/preheat');
        const { MachineRuntimeState } = require('../lib/machine-runtime-state');
        const { bus, EVENTS } = require('../lib/events');
        const runtime = new MachineRuntimeState();

        const events = [];
        bus.on(EVENTS.PREHEAT_UPDATE, p => events.push(p));

        startPreheatWatcher(runtime);
        await vi.advanceTimersByTimeAsync(30000);

        expect(events.length).toBeGreaterThanOrEqual(1);
    });
});
