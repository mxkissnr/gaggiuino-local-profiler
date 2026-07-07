import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// Same in-memory DB swap as db-routes.test.js/backup.test.js: patch the
// require cache for lib/db.js before any route/repository is required, so
// every consumer shares the memory DB.
const Database  = require('better-sqlite3');
const dbPath    = require.resolve('../lib/db');
const realDb    = require(dbPath);
const memDb     = new Database(':memory:');
realDb.initSchema(memDb);
require.cache[dbPath].exports = { getDb: () => memDb, initSchema: realDb.initSchema };

const express      = require('express');
const systemRouter = require('../routes/system');
const shotRepo      = require('../lib/repositories/ShotRepository');
const libraryRepo   = require('../lib/repositories/LibraryRepository');
const demoService   = require('../lib/services/DemoService');
const state         = require('../lib/state');
const { getDb }     = require('../lib/db');

// Minimal stand-in for server.js's auth middleware: a request is
// "authenticated" when it sends the sentinel X-GLP-Token below.
const TEST_TOKEN = 'test-token';
function makeApp() {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.glpAuthenticated = req.headers['x-glp-token'] === TEST_TOKEN;
        next();
    });
    app.use(systemRouter);
    app.use((err, req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
    return app;
}

let server, baseUrl;

beforeEach(async () => {
    getDb().exec('DELETE FROM shots; DELETE FROM annotations; DELETE FROM trash; DELETE FROM library; DELETE FROM kv;');
    state.machineReachable   = null;
    state.lastMachineError   = null;
    state.lastMachineSuccess = null;
    server = makeApp().listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => server?.close());

describe('demo seed/unseed round-trip', () => {
    it('seeds shots, beans and a recipe, then removes exactly those rows on end', async () => {
        expect(demoService.isEmpty()).toBe(true);

        const seedRes = await fetch(`${baseUrl}/api/demo/seed`, { method: 'POST' });
        expect(seedRes.status).toBe(200);
        expect((await seedRes.json())).toMatchObject({ ok: true, isDemo: true });

        expect(shotRepo.count()).toBeGreaterThan(0);
        const lib = libraryRepo.getLibrary();
        expect(lib.beans.length).toBeGreaterThan(0);
        expect(lib.recipes.length).toBeGreaterThan(0);
        expect(demoService.isDemoActive()).toBe(true);

        const endRes = await fetch(`${baseUrl}/api/demo/end`, { method: 'POST' });
        expect(endRes.status).toBe(200);
        expect((await endRes.json())).toMatchObject({ ok: true, isDemo: false });

        expect(shotRepo.count()).toBe(0);
        const libAfter = libraryRepo.getLibrary();
        expect(libAfter.beans).toEqual([]);
        expect(libAfter.recipes).toEqual([]);
        expect(demoService.isDemoActive()).toBe(false);
    });

    it('refuses to seed when the database already has shots', async () => {
        shotRepo.upsert({ id: 1, timestamp: 1000, duration: 250 });

        const r = await fetch(`${baseUrl}/api/demo/seed`, { method: 'POST' });
        expect(r.status).toBe(409);
        expect(demoService.isDemoActive()).toBe(false);
    });

    it('refuses to seed when the library already has beans', async () => {
        libraryRepo.saveLibrary({ beans: [{ id: 1, name: 'Existing' }], grinders: [], recipes: [] });

        const r = await fetch(`${baseUrl}/api/demo/seed`, { method: 'POST' });
        expect(r.status).toBe(409);
    });

    it('"end demo" only deletes the seeded rows, not shots added afterwards', async () => {
        await fetch(`${baseUrl}/api/demo/seed`, { method: 'POST' });
        const seededCount = shotRepo.count();

        // A real shot arrives after demo seeding (e.g. machine comes online)
        shotRepo.upsert({ id: 999999, timestamp: 5000, duration: 300 });
        expect(shotRepo.count()).toBe(seededCount + 1);

        await fetch(`${baseUrl}/api/demo/end`, { method: 'POST' });
        expect(shotRepo.count()).toBe(1);
        expect(shotRepo.findById(999999)).toBeTruthy();
    });
});

describe('GET /api/status — machine reachability + auth gating', () => {
    it('exposes machineReachable and lastMachineSuccess unauthenticated', async () => {
        state.machineReachable   = false;
        state.lastMachineError   = 'connect ECONNREFUSED [url]';
        state.lastMachineSuccess = null;

        const r = await fetch(`${baseUrl}/api/status`);
        expect(r.status).toBe(200);
        const body = await r.json();
        expect(body.machineReachable).toBe(false);
        expect('lastMachineSuccess' in body).toBe(true);
        expect(body.lastMachineError).toBeUndefined();
        expect(body.machineHostname).toBeUndefined();
        expect(body.isDemo).toBeUndefined();
    });

    it('exposes lastMachineError, machineHostname and isDemo only when authenticated', async () => {
        state.machineReachable = false;
        state.lastMachineError = 'connect ECONNREFUSED [url]';

        const r = await fetch(`${baseUrl}/api/status`, { headers: { 'X-GLP-Token': TEST_TOKEN } });
        expect(r.status).toBe(200);
        const body = await r.json();
        expect(body.machineReachable).toBe(false);
        expect(body.lastMachineError).toBe('connect ECONNREFUSED [url]');
        expect('machineHostname' in body).toBe(true);
        expect(typeof body.isDemo).toBe('boolean');
    });
});
