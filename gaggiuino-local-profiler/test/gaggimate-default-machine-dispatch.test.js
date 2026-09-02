// #954: for a GaggiMate default machine the live-poll loop and the shot
// sync must dispatch to the GaggiMate WS/history paths, never the
// Gaggiuino-only HTTP endpoints (/api/system/status, /api/shots/latest) —
// polling those made a real GaggiMate v1.8.1 unresponsive. Done properly
// here (dispatch once by adapter type), without PR #947's regressions:
// the sync guard sits after the machine-off + in-flight guards, and a
// reachable GaggiMate sets state.machineReachable.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const Database = require('better-sqlite3');

const dbPath        = require.resolve('../lib/db');
const realDb        = require(dbPath);
const axiosPath     = require.resolve('axios');
const realAxios     = require(axiosPath);
const wsClientPath  = require.resolve('../lib/machines/gaggimate/ws-client');
const realWsClient  = require(wsClientPath);
const gmAdapterPath = require.resolve('../lib/machines/gaggimate/adapter');
const realGmAdapter = require(gmAdapterPath);
const registryPath  = require.resolve('../lib/machines/registry');
const dataPath      = require.resolve('../lib/data');
const pollPath      = require.resolve('../lib/poll');
const syncPath      = require.resolve('../lib/sync');
const state         = require('../lib/state');
const { bus, EVENTS } = require('../lib/events');

// A stand-in for GaggiMateLiveClient — no real WebSocket; the test drives
// `.status` / `.reachable` directly.
class FakeLiveClient {
    constructor(baseUrl) { FakeLiveClient.instances.push(this); this.baseUrl = baseUrl; this.status = null; this.reachable = false; this.closed = false; }
    close() { this.closed = true; }
}
FakeLiveClient.instances = [];

function seedMachine(memDb, type, host) {
    memDb.prepare(
        `INSERT INTO machines (id, name, type, host, switch_entity, is_default, enabled, created_at)
         VALUES (1, ?, ?, ?, null, 1, 1, ?)`,
    ).run(type === 'gaggimate' ? 'GaggiMate' : 'Gaggiuino', type, host, Date.now());
}

describe('#954 GaggiMate default machine dispatch', () => {
    let memDb, axiosGetMock, getLatestShotIdMock;

    beforeEach(() => {
        memDb = new Database(':memory:');
        realDb.initSchema(memDb);
        require.cache[dbPath].exports = { getDb: () => memDb, initSchema: realDb.initSchema };

        axiosGetMock = vi.fn().mockRejectedValue(new Error('network disabled in test'));
        require.cache[axiosPath].exports = { get: axiosGetMock, default: { get: axiosGetMock } };

        FakeLiveClient.instances = [];
        require.cache[wsClientPath].exports = { ...realWsClient, GaggiMateLiveClient: FakeLiveClient };

        getLatestShotIdMock = vi.fn().mockResolvedValue(null);
        require.cache[gmAdapterPath].exports = { ...realGmAdapter, getLatestShotId: getLatestShotIdMock };

        delete require.cache[registryPath];
        delete require.cache[dataPath];
        delete require.cache[pollPath];
        delete require.cache[syncPath];
        delete require.cache[require.resolve('../lib/machines')];

        state.machineReachable = null;
        state.lastSyncTime = null;
        state.lastSyncError = null;
        state.defaultSyncInFlight = false;
        state.isPollRunning = false;
        state.liveAccum = null;
    });

    afterEach(() => {
        try { require('../lib/poll').stopLivePolling(); } catch { /* not loaded */ }
        memDb.close();
        require.cache[dbPath].exports = realDb;
        require.cache[axiosPath].exports = realAxios;
        require.cache[wsClientPath].exports = realWsClient;
        require.cache[gmAdapterPath].exports = realGmAdapter;
        vi.restoreAllMocks();
    });

    it('startLivePolling opens ONE GaggiMate WS client and never the HTTP poll', async () => {
        seedMachine(memDb, 'gaggimate', 'gaggimate.local');
        const { startLivePolling, stopLivePolling } = require('../lib/poll');
        const { MachineRuntimeState } = require('../lib/machine-runtime-state');
        const runtime = new MachineRuntimeState();

        startLivePolling(runtime);
        await new Promise(r => setTimeout(r, 1200)); // past one tick
        stopLivePolling(runtime);

        expect(FakeLiveClient.instances).toHaveLength(1);
        expect(FakeLiveClient.instances[0].closed).toBe(true);
        const statusCalls = axiosGetMock.mock.calls.filter(([u]) => String(u).includes('system/status'));
        expect(statusCalls).toHaveLength(0);
    });

    it('pollGaggiMate with a cached evt:status sets machineReachable + emits live-snapshot', () => {
        seedMachine(memDb, 'gaggimate', 'gaggimate.local');
        const { startLivePolling, pollGaggiMate } = require('../lib/poll');
        const { MachineRuntimeState } = require('../lib/machine-runtime-state');
        const runtime = new MachineRuntimeState();

        startLivePolling(runtime);
        const client = FakeLiveClient.instances[0];
        client.reachable = true;
        client.status = { tp: 'evt:status', ct: 92.5, tt: 93, pr: 0, m: 0, p: 'Espresso' };

        const snapshots = [];
        const off = (d) => snapshots.push(d);
        bus.on(EVENTS.LIVE_SNAPSHOT, off);
        pollGaggiMate(runtime);
        bus.off(EVENTS.LIVE_SNAPSHOT, off);

        expect(state.machineReachable).toBe(true);
        expect(runtime.machineStatus).toBeTruthy();
        expect(runtime.machineStatus.temperature).toBe(92.5);
        expect(snapshots.length).toBeGreaterThan(0);
        expect(axiosGetMock).not.toHaveBeenCalled();
    });

    it('syncShots for a GaggiMate default delegates to the history adapter, not /latest', async () => {
        seedMachine(memDb, 'gaggimate', 'gaggimate.local');
        const { syncShots } = require('../lib/sync');

        const ok = await syncShots({ machineOn: true });

        expect(ok).toBe(true);
        expect(getLatestShotIdMock).toHaveBeenCalled();
        const latestCalls = axiosGetMock.mock.calls.filter(([u]) => String(u).includes('/latest'));
        expect(latestCalls).toHaveLength(0);
        // Successful probe -> reachability recorded (#954 point 2).
        expect(state.machineReachable).toBe(true);
    });

    it('powered-off GaggiMate default: syncShots is a no-op, no history probe (regression #1)', async () => {
        seedMachine(memDb, 'gaggimate', 'gaggimate.local');
        // A switch entity present + machineOn false = the machine-off guard.
        require('../lib/machines/registry').updateMachine(1, { switchEntity: 'switch.machine' });
        delete require.cache[syncPath];
        const { syncShots } = require('../lib/sync');

        const ok = await syncShots({ machineOn: false });

        expect(ok).toBe(true);
        expect(getLatestShotIdMock).not.toHaveBeenCalled();
        expect(axiosGetMock).not.toHaveBeenCalled();
    });

    it('in-flight guard still applies before the GaggiMate branch', async () => {
        seedMachine(memDb, 'gaggimate', 'gaggimate.local');
        const { syncShots } = require('../lib/sync');
        state.defaultSyncInFlight = true;

        const ok = await syncShots({ machineOn: true });

        expect(ok).toBe(true);
        expect(getLatestShotIdMock).not.toHaveBeenCalled();
    });

    it('Gaggiuino default machine is unchanged — HTTP poll still starts (no regression)', async () => {
        seedMachine(memDb, 'gaggiuino', 'gaggiuino.local');
        const { startLivePolling, stopLivePolling } = require('../lib/poll');
        const { MachineRuntimeState } = require('../lib/machine-runtime-state');
        const runtime = new MachineRuntimeState();

        startLivePolling(runtime);
        await new Promise(r => setTimeout(r, 1200));
        stopLivePolling(runtime);

        expect(FakeLiveClient.instances).toHaveLength(0);
        const statusCalls = axiosGetMock.mock.calls.filter(([u]) => String(u).includes('system/status'));
        expect(statusCalls.length).toBeGreaterThan(0);
    });
});
