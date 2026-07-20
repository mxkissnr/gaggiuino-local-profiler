import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// Same in-memory DB swap as test/db-routes.test.js / test/shots-image.test.js:
// patch the require cache for lib/db.js before any route/repository is required.
const Database = require('better-sqlite3');
const dbPath   = require.resolve('../lib/db');
const realDb   = require(dbPath);
const memDb    = new Database(':memory:');
realDb.initSchema(memDb);
require.cache[dbPath].exports = { getDb: () => memDb, initSchema: realDb.initSchema };

const express     = require('express');
const shotsRouter = require('../routes/shots');
const shotRepo     = require('../lib/repositories/ShotRepository');
const { getDb }    = require('../lib/db');

function makeApp() {
    const app = express();
    app.use(express.json());
    app.use(shotsRouter);
    app.use((err, req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
    return app;
}

let server, baseUrl;

beforeEach(async () => {
    getDb().exec('DELETE FROM shots; DELETE FROM annotations; DELETE FROM trash;');
    server = makeApp().listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => {
    server?.close();
});

describe('ShotRepository.findPreviousByProfile', () => {
    it('returns the most recent earlier shot with the same profile on the same machine', () => {
        shotRepo.upsert({ id: 1, timestamp: 1000, duration: 250, profileName: 'V60-ish', machineId: 1 });
        shotRepo.upsert({ id: 2, timestamp: 2000, duration: 250, profileName: 'V60-ish', machineId: 1 });
        shotRepo.upsert({ id: 3, timestamp: 3000, duration: 250, profileName: 'V60-ish', machineId: 1 });

        const prev = shotRepo.findPreviousByProfile(3, 'V60-ish', 1);
        expect(prev.id).toBe(2);
    });

    it('ignores shots with a different profile name', () => {
        shotRepo.upsert({ id: 1, timestamp: 1000, duration: 250, profileName: 'Ristretto', machineId: 1 });
        shotRepo.upsert({ id: 2, timestamp: 2000, duration: 250, profileName: 'V60-ish', machineId: 1 });

        expect(shotRepo.findPreviousByProfile(2, 'V60-ish', 1)).toBeNull();
    });

    it('ignores shots on a different machine', () => {
        shotRepo.upsert({ id: 1, timestamp: 1000, duration: 250, profileName: 'V60-ish', machineId: 2 });
        shotRepo.upsert({ id: 2, timestamp: 2000, duration: 250, profileName: 'V60-ish', machineId: 1 });

        expect(shotRepo.findPreviousByProfile(2, 'V60-ish', 1)).toBeNull();
    });

    it('excludes trashed shots', () => {
        shotRepo.upsert({ id: 1, timestamp: 1000, duration: 250, profileName: 'V60-ish', machineId: 1 });
        shotRepo.upsert({ id: 2, timestamp: 2000, duration: 250, profileName: 'V60-ish', machineId: 1 });
        shotRepo.moveToTrash(1);

        expect(shotRepo.findPreviousByProfile(2, 'V60-ish', 1)).toBeNull();
    });

    it('returns null when there is no earlier shot', () => {
        shotRepo.upsert({ id: 1, timestamp: 1000, duration: 250, profileName: 'V60-ish', machineId: 1 });
        expect(shotRepo.findPreviousByProfile(1, 'V60-ish', 1)).toBeNull();
    });
});

describe('GET /api/shots/:id previousShotId/previousShot', () => {
    it('is additive: existing fields are untouched and previous fields are null with no earlier shot', async () => {
        shotRepo.upsert({ id: 1, timestamp: 1000, duration: 250, profileName: 'V60-ish', machineId: 1 });
        const r    = await fetch(`${baseUrl}/api/shots/1`);
        const body = await r.json();
        expect(body.id).toBe(1);
        expect(body.previousShotId).toBeNull();
        expect(body.previousShot).toBeNull();
    });

    it('surfaces the previous same-profile shot with its own score', async () => {
        shotRepo.upsert({ id: 1, timestamp: 1000, duration: 250, profileName: 'V60-ish', machineId: 1 });
        shotRepo.upsert({ id: 2, timestamp: 2000, duration: 250, profileName: 'V60-ish', machineId: 1 });
        const r    = await fetch(`${baseUrl}/api/shots/2`);
        const body = await r.json();
        expect(body.previousShotId).toBe(1);
        expect(body.previousShot.id).toBe(1);
        expect(body.previousShot).toHaveProperty('score');
    });
});
