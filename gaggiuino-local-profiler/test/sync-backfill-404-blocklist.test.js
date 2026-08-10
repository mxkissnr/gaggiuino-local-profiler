// #721: a genuine 404 for one shot id in the backfill loop (the machine's
// own on-device storage rotates/caps independently of the monotonically
// increasing lastShotId it reports via /latest) used to throw out of
// syncShots() entirely. Because effectiveMax (the resume point) only
// advances when a shot is actually stored, every subsequent sync attempt
// restarted at that exact dead id forever -- every id after it was never
// even attempted, even though it was perfectly fetchable. The fix
// blocklists a 404'd id (same mechanism already used for user-deleted
// shots) and continues the backfill past it.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const dbPath         = require.resolve('../lib/db');
const realDb         = require(dbPath);
const constantsPath  = require.resolve('../lib/constants');
const realConstants  = require(constantsPath);
const axiosPath      = require.resolve('axios');
const realAxios      = require(axiosPath);
const registryPath   = require.resolve('../lib/machines/registry');
const dataPath       = require.resolve('../lib/data');
const syncPath       = require.resolve('../lib/sync');
const shotServicePath = require.resolve('../lib/services/ShotService');

function makeShot(id) {
    return {
        id,
        timestamp: 1_700_000_000 + id,
        duration: 250,
        profileName: `Profile ${id}`,
        datapoints: [{ timeInShot: 0, pressure: 9 }],
    };
}

describe('#721 syncShots() backfill survives a single 404 shot id', () => {
    let memDb, tmpFile, axiosGetMock;

    beforeEach(() => {
        memDb = new Database(':memory:');
        realDb.initSchema(memDb);
        require.cache[dbPath].exports = { getDb: () => memDb, initSchema: realDb.initSchema };

        tmpFile = path.join(os.tmpdir(), `glp-test-options-721-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
        fs.writeFileSync(tmpFile, JSON.stringify({ machine_host: 'machine.local' }));
        require.cache[constantsPath].exports = { ...realConstants, OPTIONS_FILE: tmpFile };

        delete require.cache[registryPath];
        delete require.cache[dataPath];
        delete require.cache[syncPath];
        delete require.cache[shotServicePath];

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

    it('skips a 404\'d shot id, blocklists it, and still stores the ids after it', async () => {
        // Shots 1-2 fetch fine, shot 3 404s (permanently gone from the
        // machine's own storage), shots 4-5 fetch fine again.
        axiosGetMock = vi.fn((url) => {
            if (url.endsWith('/latest')) return Promise.resolve({ data: [{ lastShotId: 5 }] });
            const id = Number(url.split('/').pop());
            if (id === 3) {
                const err = new Error('Request failed with status code 404');
                err.response = { status: 404, data: { error: 'Not found' } };
                err.config = { url };
                return Promise.reject(err);
            }
            return Promise.resolve({ data: makeShot(id) });
        });
        require.cache[axiosPath].exports = { get: axiosGetMock };

        const { syncShots } = require('../lib/sync');
        const shotService = require('../lib/services/ShotService');

        const ok = await syncShots({ machineOn: true });

        expect(ok).toBe(true);
        // shot 3 never got fetched successfully -> not stored, but blocklisted
        const stored = shotService.getAll(1).map((s) => s.id).sort((a, b) => a - b);
        expect(stored).toEqual([1, 2, 4, 5]);

        const blocklist = shotService.getBlocklist().map(Number);
        expect(blocklist).toContain(3);
    });

    it('a non-404 error mid-backfill still aborts the whole sync (no skip-ahead)', async () => {
        axiosGetMock = vi.fn((url) => {
            if (url.endsWith('/latest')) return Promise.resolve({ data: [{ lastShotId: 3 }] });
            const id = Number(url.split('/').pop());
            if (id === 2) return Promise.reject(new Error('socket hang up'));
            return Promise.resolve({ data: makeShot(id) });
        });
        require.cache[axiosPath].exports = { get: axiosGetMock };

        const { syncShots } = require('../lib/sync');
        const shotService = require('../lib/services/ShotService');

        const ok = await syncShots({ machineOn: true });

        expect(ok).toBe(false);
        // shot 1 stored before the failure, shot 3 never attempted (loop aborted)
        const stored = shotService.getAll(1).map((s) => s.id).sort((a, b) => a - b);
        expect(stored).toEqual([1]);
        expect(shotService.getBlocklist()).toEqual([]);
    });
});
