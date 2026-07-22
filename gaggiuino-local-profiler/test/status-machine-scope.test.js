// GET /api/status ?machineId= scoping (#464) — the topbar status dot/
// hostname used to always describe the default machine regardless of which
// machine the switcher had active. An explicit ?machineId for a *non*-
// default machine now scopes machineHostname/lastSync/lastSyncError/
// machineReachable to that machine via a live adapter.getStatus() probe
// (the same plumbing /api/machines/:id/test uses); omitting it, or passing
// the default machine's own id, must stay byte-for-byte identical to the
// pre-#464 default-only response — other pollers depend on that.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const Database = require('better-sqlite3');
const dbPath   = require.resolve('../lib/db');
const realDb   = require(dbPath);
const memDb    = new Database(':memory:');
realDb.initSchema(memDb);
require.cache[dbPath].exports = { getDb: () => memDb, initSchema: realDb.initSchema };

const machinesIndexPath = require.resolve('../lib/machines');
const systemPath        = require.resolve('../routes/system');

const express = require('express');
const state   = require('../lib/state');

const TEST_TOKEN = 'test-token';
function makeApp(systemRouter) {
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

async function startWithAdapter(fakeAdapter) {
    require.cache[machinesIndexPath] = {
        exports: { ...require('../lib/machines'), getAdapter: () => fakeAdapter },
    };
    delete require.cache[systemPath];
    const systemRouter = require('../routes/system');
    server = makeApp(systemRouter).listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
}

beforeEach(() => {
    memDb.exec('DELETE FROM machines;');
    state.lastSyncTime     = '2026-01-01T00:00:00.000Z';
    state.lastSyncError    = null;
    state.machineReachable = true;
});

afterEach(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    delete require.cache[systemPath];
    vi.restoreAllMocks();
});

describe('GET /api/status without machineId (default machine, unaffected by other registered machines)', () => {
    it('reports the default machine\'s own lastSync/lastSyncError, ignoring a registered second machine', async () => {
        const registry = require('../lib/machines/registry');
        registry.ensureDefaultMachine();
        registry.createMachine({ name: 'Kitchen GaggiMate', type: 'gaggimate', host: 'kitchen.local' });

        const fakeAdapter = { getStatus: vi.fn().mockResolvedValue({ reachable: true }) };
        await startWithAdapter(fakeAdapter);

        const r = await fetch(`${baseUrl}/api/status`, { headers: { 'X-GLP-Token': TEST_TOKEN } });
        const body = await r.json();
        expect(body.lastSync).toBe('2026-01-01T00:00:00.000Z');
        expect(body.machineReachable).toBe(true);
        expect(fakeAdapter.getStatus).not.toHaveBeenCalled(); // no live probe unless machineId scopes a non-default machine
    });

    it('an explicit machineId for the default machine itself behaves exactly like omitting it', async () => {
        const registry = require('../lib/machines/registry');
        registry.ensureDefaultMachine();
        const def = registry.getDefaultMachine();

        const fakeAdapter = { getStatus: vi.fn().mockResolvedValue({ reachable: true }) };
        await startWithAdapter(fakeAdapter);

        const r = await fetch(`${baseUrl}/api/status?machineId=${def.id}`, { headers: { 'X-GLP-Token': TEST_TOKEN } });
        const body = await r.json();
        expect(body.lastSync).toBe('2026-01-01T00:00:00.000Z');
        expect(fakeAdapter.getStatus).not.toHaveBeenCalled();
    });
});

describe('GET /api/status ?machineId=<non-default machine> (#464)', () => {
    it('returns that machine\'s hostname and a fresh lastSync when the live probe succeeds', async () => {
        const registry = require('../lib/machines/registry');
        registry.ensureDefaultMachine();
        const machine = registry.createMachine({ name: 'Kitchen GaggiMate', type: 'gaggimate', host: 'kitchen.local:8080' });

        const fakeAdapter = { getStatus: vi.fn().mockResolvedValue({ reachable: true }) };
        await startWithAdapter(fakeAdapter);

        const r = await fetch(`${baseUrl}/api/status?machineId=${machine.id}`, { headers: { 'X-GLP-Token': TEST_TOKEN } });
        const body = await r.json();
        expect(body.machineHostname).toBe('kitchen.local');
        expect(body.machineReachable).toBe(true);
        expect(body.lastSyncError).toBeNull();
        expect(body.lastSync).not.toBe('2026-01-01T00:00:00.000Z'); // scoped to a fresh probe, not the default machine's stale field
        expect(fakeAdapter.getStatus).toHaveBeenCalledWith(expect.objectContaining({ id: machine.id }));
    });

    it('reports machineReachable:false and the adapter\'s error when the probe fails, without touching the default machine\'s own state', async () => {
        const registry = require('../lib/machines/registry');
        registry.ensureDefaultMachine();
        const machine = registry.createMachine({ name: 'Kitchen GaggiMate', type: 'gaggimate', host: 'kitchen.local' });

        const fakeAdapter = { getStatus: vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED')) };
        await startWithAdapter(fakeAdapter);

        const r = await fetch(`${baseUrl}/api/status?machineId=${machine.id}`, { headers: { 'X-GLP-Token': TEST_TOKEN } });
        const body = await r.json();
        expect(body.machineReachable).toBe(false);
        expect(body.lastSyncError).toBe('connect ECONNREFUSED');
        expect(state.lastSyncTime).toBe('2026-01-01T00:00:00.000Z'); // default machine's own global state untouched
        expect(state.machineReachable).toBe(true);
    });

    it('exposes machineReachable unauthenticated but keeps machineHostname/lastSyncError gated (H1 stays intact)', async () => {
        const registry = require('../lib/machines/registry');
        registry.ensureDefaultMachine();
        const machine = registry.createMachine({ name: 'Kitchen GaggiMate', type: 'gaggimate', host: 'kitchen.local' });

        const fakeAdapter = { getStatus: vi.fn().mockResolvedValue({ reachable: true }) };
        await startWithAdapter(fakeAdapter);

        const r = await fetch(`${baseUrl}/api/status?machineId=${machine.id}`);
        const body = await r.json();
        expect(body.machineReachable).toBe(true);
        expect(body.machineHostname).toBeUndefined();
        expect(body.lastSyncError).toBeUndefined();
    });

    it('an unknown machineId falls back to the default machine\'s response, matching resolveMachine()\'s existing fallback convention', async () => {
        const registry = require('../lib/machines/registry');
        registry.ensureDefaultMachine();

        const fakeAdapter = { getStatus: vi.fn().mockResolvedValue({ reachable: true }) };
        await startWithAdapter(fakeAdapter);

        const r = await fetch(`${baseUrl}/api/status?machineId=999999`, { headers: { 'X-GLP-Token': TEST_TOKEN } });
        const body = await r.json();
        expect(body.lastSync).toBe('2026-01-01T00:00:00.000Z');
        expect(fakeAdapter.getStatus).not.toHaveBeenCalled();
    });
});
