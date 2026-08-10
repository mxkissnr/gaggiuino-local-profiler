// #725: pollViaGaggiuinoStatus() polls /api/system/status every 1s and
// knows state.machineReachable in real time, but nothing hooked that back
// into triggering a sync -- the only existing catch-up mechanism
// (syncSoonAfterPowerOn()) requires a configured HA switch entity, which
// most installs don't have. These tests prove the false->true reachability
// recovery net added in lib/poll.js actually fires syncShots() only when it
// should: on a genuine recovery transition with an outstanding failure or
// no prior successful sync, and not otherwise.
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
const syncPath     = require.resolve('../lib/sync');
const realSync     = require(syncPath);
const state        = require('../lib/state');

describe('pollViaGaggiuinoStatus() reachability-recovery catch-up sync (#725)', () => {
    let memDb, axiosGetMock, syncShotsMock;

    beforeEach(() => {
        memDb = new Database(':memory:');
        realDb.initSchema(memDb);
        require.cache[dbPath].exports = { getDb: () => memDb, initSchema: realDb.initSchema };

        axiosGetMock = vi.fn().mockResolvedValue({ data: {} });
        require.cache[axiosPath].exports = { get: axiosGetMock };

        syncShotsMock = vi.fn().mockResolvedValue(true);
        require.cache[syncPath].exports = { ...realSync, syncShots: syncShotsMock };

        delete require.cache[registryPath];
        delete require.cache[dataPath];
        delete require.cache[pollPath];

        const registry = require('../lib/machines/registry');
        registry.ensureDefaultMachine();
        registry.updateMachine(1, { host: 'gaggiuino.local' });

        state.lastSyncTime  = null;
        state.lastSyncError = null;
        state.machineReachable = null;
    });

    afterEach(() => {
        memDb.close();
        require.cache[dbPath].exports = realDb;
        require.cache[axiosPath].exports = realAxios;
        require.cache[syncPath].exports = realSync;
        state.lastSyncTime  = null;
        state.lastSyncError = null;
        state.machineReachable = null;
    });

    async function poll() {
        const { pollViaGaggiuinoStatus } = require('../lib/poll');
        const { MachineRuntimeState } = require('../lib/machine-runtime-state');
        await pollViaGaggiuinoStatus(new MachineRuntimeState());
    }

    async function pollFailure() {
        axiosGetMock.mockRejectedValueOnce(new Error('network unreachable'));
        await poll();
    }

    it('triggers a catch-up sync on a false->true recovery when the last sync errored', async () => {
        state.lastSyncError = 'HTTP 500';
        await pollFailure(); // was unreachable
        expect(syncShotsMock).not.toHaveBeenCalled();

        await poll(); // recovers
        expect(syncShotsMock).toHaveBeenCalledTimes(1);
    });

    it('triggers a catch-up sync on a false->true recovery when nothing has ever synced (lastSyncTime falsy)', async () => {
        state.lastSyncError = null;
        state.lastSyncTime  = null;
        await pollFailure();
        await poll();
        expect(syncShotsMock).toHaveBeenCalledTimes(1);
    });

    it('does not trigger a sync when already reachable and healthy (no transition)', async () => {
        state.lastSyncError = null;
        state.lastSyncTime  = new Date().toISOString();

        await poll(); // first successful poll, _wasReachable starts null -- not a false->true transition
        await poll(); // still reachable, no transition either
        expect(syncShotsMock).not.toHaveBeenCalled();
    });

    it('does not trigger a sync on recovery when lastSyncTime is already set and lastSyncError is null (healthy steady state)', async () => {
        state.lastSyncError = null;
        state.lastSyncTime  = new Date().toISOString();
        await pollFailure(); // was unreachable, but sync state is healthy

        await poll(); // recovers
        expect(syncShotsMock).not.toHaveBeenCalled();
    });

    it('does not fire repeatedly while remaining reachable after a recovery', async () => {
        state.lastSyncError = 'HTTP 500';
        await pollFailure();
        await poll(); // recovery #1
        expect(syncShotsMock).toHaveBeenCalledTimes(1);

        // lastSyncError still set (mocked syncShots doesn't clear real state),
        // but no further false->true transition happened.
        await poll();
        await poll();
        expect(syncShotsMock).toHaveBeenCalledTimes(1);
    });

    it('does not let a rejected catch-up sync throw out of the poll', async () => {
        syncShotsMock.mockRejectedValueOnce(new Error('sync boom'));
        state.lastSyncError = 'HTTP 500';
        await pollFailure();

        await expect(poll()).resolves.toBeUndefined();
        expect(syncShotsMock).toHaveBeenCalledTimes(1);
    });
});
