// #735: lib/sync.js's SYNC_PROGRESS/SYNC_COMPLETE emissions over lib/events.js's
// bus -- the backend half of the SSE push feature. Same in-memory-DB +
// mocked-axios pattern as test/sync-backfill-404-blocklist.test.js and
// test/multi-machine-sync.test.js; this file only adds coverage for the new
// event emissions on top of what those already verify structurally
// (progress/blocklist behavior, per-machine Map isolation).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const dbPath          = require.resolve('../lib/db');
const realDb          = require(dbPath);
const constantsPath   = require.resolve('../lib/constants');
const realConstants   = require(constantsPath);
const axiosPath       = require.resolve('axios');
const realAxios       = require(axiosPath);
const registryPath    = require.resolve('../lib/machines/registry');
const dataPath        = require.resolve('../lib/data');
const syncPath        = require.resolve('../lib/sync');
const shotServicePath = require.resolve('../lib/services/ShotService');
const eventsPath      = require.resolve('../lib/events');
const machinesIndexPath = require.resolve('../lib/machines');

function makeShot(id) {
    return {
        id,
        timestamp: 1_700_000_000 + id,
        duration: 250,
        profileName: `Profile ${id}`,
        datapoints: [{ timeInShot: 0, pressure: 9 }],
    };
}

describe('lib/sync.js SSE event emissions (#735)', () => {
    let memDb, tmpFile;

    beforeEach(() => {
        memDb = new Database(':memory:');
        realDb.initSchema(memDb);
        require.cache[dbPath].exports = { getDb: () => memDb, initSchema: realDb.initSchema };

        tmpFile = path.join(os.tmpdir(), `glp-test-options-735-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
        fs.writeFileSync(tmpFile, JSON.stringify({ machine_host: 'machine.local' }));
        require.cache[constantsPath].exports = { ...realConstants, OPTIONS_FILE: tmpFile };

        delete require.cache[registryPath];
        delete require.cache[dataPath];
        delete require.cache[syncPath];
        delete require.cache[shotServicePath];
        delete require.cache[eventsPath];
        delete require.cache[machinesIndexPath];

        const registry = require('../lib/machines/registry');
        registry.ensureDefaultMachine();
    });

    afterEach(() => {
        memDb.close();
        require.cache[dbPath].exports = realDb;
        require.cache[constantsPath].exports = realConstants;
        require.cache[axiosPath].exports = realAxios;
        fs.rmSync(tmpFile, { force: true });
    });

    it('syncShots() emits SYNC_PROGRESS per shot and a SYNC_COMPLETE with success:true on a clean tracked backfill', async () => {
        // 10 shots -- above the `total > 5` tracking threshold.
        const axiosGetMock = vi.fn((url) => {
            if (url.endsWith('/latest')) return Promise.resolve({ data: [{ lastShotId: 10 }] });
            const id = Number(url.split('/').pop());
            return Promise.resolve({ data: makeShot(id) });
        });
        require.cache[axiosPath].exports = { get: axiosGetMock };

        const { syncShots } = require('../lib/sync');
        const { bus, EVENTS } = require('../lib/events');
        const registry = require('../lib/machines/registry');
        const defaultId = registry.getDefaultMachine().id;

        const progressEvents = [];
        const completeEvents = [];
        bus.on(EVENTS.SYNC_PROGRESS, p => progressEvents.push(p));
        bus.on(EVENTS.SYNC_COMPLETE, p => completeEvents.push(p));

        const ok = await syncShots({ machineOn: true });

        expect(ok).toBe(true);
        expect(progressEvents).toHaveLength(10);
        expect(progressEvents[0]).toEqual({ machineId: defaultId, current: 1, total: 10 });
        expect(progressEvents[9]).toEqual({ machineId: defaultId, current: 10, total: 10 });
        expect(completeEvents).toEqual([{ machineId: defaultId, total: 10, success: true }]);
    });

    it('syncShots() emits SYNC_COMPLETE with success:false when a non-404 error aborts mid-backfill', async () => {
        // 10 shots so the backfill is tracked; shot 5 fails with a non-404
        // error, which (per #721) aborts the whole loop instead of skipping.
        const axiosGetMock = vi.fn((url) => {
            if (url.endsWith('/latest')) return Promise.resolve({ data: [{ lastShotId: 10 }] });
            const id = Number(url.split('/').pop());
            if (id === 5) return Promise.reject(new Error('socket hang up'));
            return Promise.resolve({ data: makeShot(id) });
        });
        require.cache[axiosPath].exports = { get: axiosGetMock };

        const { syncShots } = require('../lib/sync');
        const { bus, EVENTS } = require('../lib/events');
        const registry = require('../lib/machines/registry');
        const defaultId = registry.getDefaultMachine().id;

        const completeEvents = [];
        bus.on(EVENTS.SYNC_COMPLETE, p => completeEvents.push(p));

        const ok = await syncShots({ machineOn: true });

        expect(ok).toBe(false);
        expect(completeEvents).toEqual([{ machineId: defaultId, total: 10, success: false }]);
    });

    it('syncShots() does not emit SYNC_COMPLETE for a small (untracked) backfill', async () => {
        // Only 3 shots -- below the `total > 5` threshold, no progress bar
        // ever shown, so no completion broadcast should fire either.
        const axiosGetMock = vi.fn((url) => {
            if (url.endsWith('/latest')) return Promise.resolve({ data: [{ lastShotId: 3 }] });
            const id = Number(url.split('/').pop());
            return Promise.resolve({ data: makeShot(id) });
        });
        require.cache[axiosPath].exports = { get: axiosGetMock };

        const { syncShots } = require('../lib/sync');
        const { bus, EVENTS } = require('../lib/events');

        const progressEvents = [];
        const completeEvents = [];
        bus.on(EVENTS.SYNC_PROGRESS, p => progressEvents.push(p));
        bus.on(EVENTS.SYNC_COMPLETE, p => completeEvents.push(p));

        const ok = await syncShots({ machineOn: true });

        expect(ok).toBe(true);
        expect(progressEvents).toEqual([]);
        expect(completeEvents).toEqual([]);
    });

    it('syncMachineShots() emits SYNC_PROGRESS per shot and SYNC_COMPLETE success:true for a non-default machine', async () => {
        const registry = require('../lib/machines/registry');
        const machine = registry.createMachine({ name: 'Kitchen GaggiMate', type: 'gaggimate', host: '10.1.70.199:8180' });

        const fakeAdapter = {
            getLatestShotId: vi.fn().mockResolvedValue(8),
            getShot: vi.fn().mockImplementation(async (m, nativeId) => ({
                id: nativeId, timestamp: 1000 * nativeId, duration: 25000, datapoints: { timeInShot: [0] },
            })),
        };
        require.cache[machinesIndexPath] = {
            exports: { ...require('../lib/machines'), getAdapter: () => fakeAdapter },
        };
        delete require.cache[syncPath];
        const sync = require('../lib/sync');
        const { bus, EVENTS } = require('../lib/events');

        const progressEvents = [];
        const completeEvents = [];
        bus.on(EVENTS.SYNC_PROGRESS, p => progressEvents.push(p));
        bus.on(EVENTS.SYNC_COMPLETE, p => completeEvents.push(p));

        const ok = await sync.syncMachineShots(machine);

        expect(ok).toBe(true);
        expect(progressEvents).toHaveLength(8);
        expect(progressEvents[7]).toEqual({ machineId: machine.id, current: 8, total: 8 });
        expect(completeEvents).toEqual([{ machineId: machine.id, total: 8, success: true }]);
    });

    it('syncMachineShots() emits SYNC_COMPLETE success:false when the adapter throws mid-backfill', async () => {
        const registry = require('../lib/machines/registry');
        const machine = registry.createMachine({ name: 'Kitchen GaggiMate', type: 'gaggimate', host: '10.1.70.199:8180' });

        const fakeAdapter = {
            getLatestShotId: vi.fn().mockResolvedValue(8),
            getShot: vi.fn().mockImplementation(async (m, nativeId) => {
                if (nativeId === 4) throw new Error('ECONNRESET');
                return { id: nativeId, timestamp: 1000 * nativeId, duration: 25000, datapoints: { timeInShot: [0] } };
            }),
        };
        require.cache[machinesIndexPath] = {
            exports: { ...require('../lib/machines'), getAdapter: () => fakeAdapter },
        };
        delete require.cache[syncPath];
        const sync = require('../lib/sync');
        const { bus, EVENTS } = require('../lib/events');

        const completeEvents = [];
        bus.on(EVENTS.SYNC_COMPLETE, p => completeEvents.push(p));

        const ok = await sync.syncMachineShots(machine);

        expect(ok).toBe(false);
        expect(completeEvents).toEqual([{ machineId: machine.id, total: 8, success: false }]);
    });

    // #730/#731 regression guard, re-verified structurally under the new
    // event-driven model: two machines backfilling concurrently must each
    // get their own independent SYNC_COMPLETE, driven by the loopOk flag
    // local to each call -- not by any shared/global state that one
    // machine's finally block could clobber for the other (the original bug
    // class this Map-based design replaced).
    it('two machines backfilling concurrently each emit their own independent SYNC_COMPLETE', async () => {
        const registry = require('../lib/machines/registry');
        const machineA = registry.createMachine({ name: 'A', type: 'gaggimate', host: 'a.local' });
        const machineB = registry.createMachine({ name: 'B', type: 'gaggimate', host: 'b.local' });

        let releaseA;
        const gate = new Promise(resolve => { releaseA = resolve; });
        const fakeAdapter = {
            getLatestShotId: vi.fn().mockImplementation(async m => (m.id === machineA.id ? 10 : 8)),
            getShot: vi.fn().mockImplementation(async (m, nativeId) => {
                if (m.id === machineA.id && nativeId === 5) await gate;
                return { id: nativeId, timestamp: 1000 * nativeId, duration: 25000, datapoints: { timeInShot: [0] } };
            }),
        };
        require.cache[machinesIndexPath] = {
            exports: { ...require('../lib/machines'), getAdapter: () => fakeAdapter },
        };
        delete require.cache[syncPath];
        const sync  = require('../lib/sync');
        const state = require('../lib/state');
        const { bus, EVENTS } = require('../lib/events');
        state.syncProgress.clear();

        const completeEvents = [];
        bus.on(EVENTS.SYNC_COMPLETE, p => completeEvents.push(p));

        const syncAPromise = sync.syncMachineShots(machineA);
        await new Promise(resolve => setTimeout(resolve, 0)); // let A block on `gate`

        const okB = await sync.syncMachineShots(machineB);
        expect(okB).toBe(true);
        // B's completion fired already, independent of A still running.
        expect(completeEvents).toEqual([{ machineId: machineB.id, total: 8, success: true }]);

        releaseA();
        const okA = await syncAPromise;
        expect(okA).toBe(true);
        expect(completeEvents).toEqual([
            { machineId: machineB.id, total: 8, success: true },
            { machineId: machineA.id, total: 10, success: true },
        ]);
    });
});
