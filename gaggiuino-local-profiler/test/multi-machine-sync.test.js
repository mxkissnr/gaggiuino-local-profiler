// Multi-machine shot sync (#341). syncShots() (default machine, machine #1)
// stays untouched by this feature except for a required scoping fix (see
// below); syncMachineShots()/syncOtherMachines()/syncAllMachines() are new,
// additive, and drive every other registered+enabled machine through the
// adapter/registry pattern instead of the legacy opts.machine_host path.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const Database = require('better-sqlite3');
const dbPath    = require.resolve('../lib/db');
const realDb    = require(dbPath);
const registryPath = require.resolve('../lib/machines/registry');
const machinesIndexPath = require.resolve('../lib/machines');
const syncPath  = require.resolve('../lib/sync');
const shotServicePath = require.resolve('../lib/services/ShotService');

describe('lib/sync multi-machine', () => {
    let memDb;

    beforeEach(() => {
        memDb = new Database(':memory:');
        realDb.initSchema(memDb);
        require.cache[dbPath].exports = { getDb: () => memDb, initSchema: realDb.initSchema };
        delete require.cache[registryPath];
        delete require.cache[shotServicePath];
        delete require.cache[require.resolve('../lib/repositories/ShotRepository')];
        delete require.cache[syncPath];

        const registry = require('../lib/machines/registry');
        registry.ensureDefaultMachine();
    });

    afterEach(() => { memDb.close(); vi.restoreAllMocks(); });

    it('#341 regression guard: default machine\'s max-id lookup ignores other machines\' shots', () => {
        const shotService = require('../lib/services/ShotService');
        // Default machine (id 1) has native shot #5. A second machine's
        // synthetic shot id (20,000,010) is far larger and must NOT be
        // picked up by the default machine's own max-id computation --
        // that would make syncShots() think it's already caught up and
        // silently stop pulling its own new shots (see lib/sync.js comment).
        shotService.upsertShot({ id: 5, timestamp: 1000, duration: 25000, datapoints: {}, machineId: 1 });
        shotService.upsertShot({ id: 20_000_010, timestamp: 2000, duration: 25000, datapoints: {}, machineId: 2 });

        const maxDefault = shotService.getAll(1).reduce((m, s) => s.id > m ? s.id : m, 0);
        expect(maxDefault).toBe(5);

        const maxUnscoped = shotService.getAll().reduce((m, s) => s.id > m ? s.id : m, 0);
        expect(maxUnscoped).toBe(20_000_010); // confirms the bug would exist without scoping
    });

    it('syncMachineShots ingests new shots for a non-default machine via its adapter, using synthetic ids', async () => {
        const registry = require('../lib/machines/registry');
        const machine = registry.createMachine({ name: 'Kitchen GaggiMate', type: 'gaggimate', host: '10.1.70.199:8180' });

        const fakeAdapter = {
            getLatestShotId: vi.fn().mockResolvedValue(2),
            getShot: vi.fn().mockImplementation(async (m, nativeId) => ({
                id: nativeId, // adapter returns its own native id; syncMachineShots must remap it
                timestamp: 1000 * nativeId,
                duration: 25000,
                datapoints: { timeInShot: [0, 10] },
            })),
        };
        require.cache[machinesIndexPath] = {
            exports: { ...require('../lib/machines'), getAdapter: () => fakeAdapter },
        };
        delete require.cache[syncPath];
        const sync = require('../lib/sync');

        const ok = await sync.syncMachineShots(machine);
        expect(ok).toBe(true);
        expect(fakeAdapter.getShot).toHaveBeenCalledTimes(2);

        const shotService = require('../lib/services/ShotService');
        const { toGlobalShotId } = require('../lib/machines');
        const shot1 = shotService.getById(toGlobalShotId(machine.id, 1));
        const shot2 = shotService.getById(toGlobalShotId(machine.id, 2));
        expect(shot1).toBeTruthy();
        expect(shot2).toBeTruthy();
        expect(shot1.machineId).toBe(machine.id);
        expect(shot2.machineId).toBe(machine.id);
    });

    it('syncMachineShots resumes from the last-synced native id instead of re-fetching everything', async () => {
        const registry = require('../lib/machines/registry');
        const machine = registry.createMachine({ name: 'Kitchen GaggiMate', type: 'gaggimate', host: '10.1.70.199:8180' });

        const { toGlobalShotId } = require('../lib/machines');
        const shotService = require('../lib/services/ShotService');
        shotService.upsertShot({ id: toGlobalShotId(machine.id, 1), timestamp: 1000, duration: 25000, datapoints: {}, machineId: machine.id });

        const fakeAdapter = {
            getLatestShotId: vi.fn().mockResolvedValue(3),
            getShot: vi.fn().mockImplementation(async (m, nativeId) => ({
                id: nativeId, timestamp: 1000 * nativeId, duration: 25000, datapoints: { timeInShot: [0] },
            })),
        };
        require.cache[machinesIndexPath] = {
            exports: { ...require('../lib/machines'), getAdapter: () => fakeAdapter },
        };
        delete require.cache[syncPath];
        const sync = require('../lib/sync');

        await sync.syncMachineShots(machine);
        expect(fakeAdapter.getShot).toHaveBeenCalledTimes(2); // only native ids 2 and 3, not 1 again
        expect(fakeAdapter.getShot).toHaveBeenCalledWith(machine, 2);
        expect(fakeAdapter.getShot).toHaveBeenCalledWith(machine, 3);
    });

    it('syncMachineShots is a no-op (returns true) when the machine has no shots yet', async () => {
        const registry = require('../lib/machines/registry');
        const machine = registry.createMachine({ name: 'Kitchen GaggiMate', type: 'gaggimate', host: '10.1.70.199:8180' });

        const fakeAdapter = { getLatestShotId: vi.fn().mockResolvedValue(null), getShot: vi.fn() };
        require.cache[machinesIndexPath] = {
            exports: { ...require('../lib/machines'), getAdapter: () => fakeAdapter },
        };
        delete require.cache[syncPath];
        const sync = require('../lib/sync');

        const ok = await sync.syncMachineShots(machine);
        expect(ok).toBe(true);
        expect(fakeAdapter.getShot).not.toHaveBeenCalled();
    });

    it('syncMachineShots returns false and logs on adapter error, without throwing', async () => {
        const registry = require('../lib/machines/registry');
        const machine = registry.createMachine({ name: 'Kitchen GaggiMate', type: 'gaggimate', host: '10.1.70.199:8180' });

        const fakeAdapter = { getLatestShotId: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')), getShot: vi.fn() };
        require.cache[machinesIndexPath] = {
            exports: { ...require('../lib/machines'), getAdapter: () => fakeAdapter },
        };
        delete require.cache[syncPath];
        const sync = require('../lib/sync');

        const ok = await sync.syncMachineShots(machine);
        expect(ok).toBe(false);
    });

    it('syncOtherMachines skips the default machine and disabled machines', async () => {
        const registry = require('../lib/machines/registry');
        const enabled  = registry.createMachine({ name: 'Enabled GaggiMate', type: 'gaggimate', host: '10.1.70.199:8180' });
        const disabled = registry.createMachine({ name: 'Disabled GaggiMate', type: 'gaggimate', host: '10.1.70.200:8180', enabled: false });

        const fakeAdapter = { getLatestShotId: vi.fn().mockResolvedValue(null), getShot: vi.fn() };
        require.cache[machinesIndexPath] = {
            exports: { ...require('../lib/machines'), getAdapter: vi.fn(() => fakeAdapter) },
        };
        delete require.cache[syncPath];
        const sync = require('../lib/sync');
        const { getAdapter } = require('../lib/machines');

        const ok = await sync.syncOtherMachines();
        expect(ok).toBe(true);
        // called once for the enabled non-default machine, never for the default or the disabled one
        expect(getAdapter).toHaveBeenCalledTimes(1);
        expect(getAdapter).toHaveBeenCalledWith(expect.objectContaining({ id: enabled.id }));
    });
});
