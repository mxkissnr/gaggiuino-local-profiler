// /api/machines route tests (#317) — CRUD + SSRF guard on host.
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const Database = require('better-sqlite3');
const dbPath   = require.resolve('../lib/db');
const realDb   = require(dbPath);
const memDb    = new Database(':memory:');
realDb.initSchema(memDb);
require.cache[dbPath].exports = { getDb: () => memDb, initSchema: realDb.initSchema };

// SSRF-guard resolves hostnames via DNS — stub it so 'gaggiuino.local'-style
// test hosts resolve to a public-looking address instead of hitting real DNS.
// Machine hosts use assertMachineHost() (#336), which — unlike the bean-import
// route's assertPublicHost() — allows private/LAN addresses (that's where a
// real Gaggiuino/GaggiMate controller lives) and blocks only loopback/
// link-local/cloud-metadata.
const dns = require('dns');
vi.spyOn(dns.promises, 'lookup').mockImplementation(async (hostname) => {
    if (hostname === 'lan.internal') return [{ address: '192.168.1.5', family: 4 }];
    if (hostname === 'blocked.internal') return [{ address: '169.254.169.254', family: 4 }];
    return [{ address: '203.0.113.10', family: 4 }];
});

// #725/#729: routes/machines.js destructures `syncShots`/`syncMachineShots`
// from lib/sync at its own require time, so both stubs must be in place in
// require.cache *before* routes/machines is first required below --
// swapping them in afterward wouldn't reach the reference machines.js
// already captured.
const syncPath = require.resolve('../lib/sync');
const realSync = require(syncPath);
const syncShotsMock = vi.fn().mockResolvedValue(true);
const syncMachineShotsMock = vi.fn().mockResolvedValue(true);
require.cache[syncPath].exports = { ...realSync, syncShots: syncShotsMock, syncMachineShots: syncMachineShotsMock };

const express = require('express');
const machinesRouter = require('../routes/machines');
const registry = require('../lib/machines/registry');

function makeApp() {
    const app = express();
    app.use(express.json());
    app.use(machinesRouter);
    app.use((err, req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
    return app;
}

let server, baseUrl;

beforeEach(async () => {
    memDb.exec('DELETE FROM machines;');
    syncShotsMock.mockClear();
    syncMachineShotsMock.mockClear();
    server = makeApp().listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => server?.close());

describe('GET /api/machines', () => {
    it('seeds and returns the default machine on first call', async () => {
        const r = await fetch(`${baseUrl}/api/machines`);
        const machines = await r.json();
        expect(machines).toHaveLength(1);
        expect(machines[0].isDefault).toBe(true);
    });
});

describe('POST /api/machines', () => {
    it('creates a new non-default machine', async () => {
        const r = await fetch(`${baseUrl}/api/machines`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Office GaggiMate', type: 'gaggimate', host: 'gaggimate.local' }),
        });
        expect(r.status).toBe(200);
        const machine = await r.json();
        expect(machine.name).toBe('Office GaggiMate');
        expect(machine.type).toBe('gaggimate');
        expect(machine.isDefault).toBe(false);
    });

    it('rejects an invalid type', async () => {
        const r = await fetch(`${baseUrl}/api/machines`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'X', type: 'nespresso', host: 'x.local' }),
        });
        expect(r.status).toBe(400);
    });

    it('allows a host that resolves to a private LAN address (#336 — real machines live there)', async () => {
        const r = await fetch(`${baseUrl}/api/machines`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'X', type: 'gaggiuino', host: 'lan.internal' }),
        });
        expect(r.status).toBe(200);
        const machine = await r.json();
        expect(machine.host).toBe('lan.internal');
    });

    it('rejects a host that resolves to a loopback/link-local/metadata address (SSRF guard)', async () => {
        const r = await fetch(`${baseUrl}/api/machines`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'X', type: 'gaggiuino', host: 'blocked.internal' }),
        });
        expect(r.status).toBe(400);
        const body = await r.json();
        expect(body.error).toMatch(/not allowed/);
    });
});

describe('PUT/DELETE /api/machines/:id', () => {
    it('updates a machine', async () => {
        const created = registry.createMachine({ name: 'A', type: 'gaggiuino', host: 'a.local' });
        const r = await fetch(`${baseUrl}/api/machines/${created.id}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Renamed' }),
        });
        expect(r.status).toBe(200);
        const updated = await r.json();
        expect(updated.name).toBe('Renamed');
    });

    it('deletes a non-default machine', async () => {
        const created = registry.createMachine({ name: 'A', type: 'gaggiuino', host: 'a.local' });
        const r = await fetch(`${baseUrl}/api/machines/${created.id}`, { method: 'DELETE' });
        expect(r.status).toBe(200);
        expect(registry.getMachine(created.id)).toBeNull();
    });

    it('refuses to delete the default machine via the API', async () => {
        registry.ensureDefaultMachine();
        const r = await fetch(`${baseUrl}/api/machines/1`, { method: 'DELETE' });
        expect(r.status).toBe(400);
    });

    it('404s for an unknown machine id', async () => {
        const r = await fetch(`${baseUrl}/api/machines/999`, { method: 'DELETE' });
        expect(r.status).toBe(404);
    });
});

describe('sync-on-save (#725/#729/#731)', () => {
    it('PUT on the default machine\'s host triggers a catch-up sync', async () => {
        registry.ensureDefaultMachine();
        const r = await fetch(`${baseUrl}/api/machines/1`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ host: 'newly-configured.local' }),
        });
        expect(r.status).toBe(200);
        expect(syncShotsMock).toHaveBeenCalledTimes(1);
        expect(syncMachineShotsMock).not.toHaveBeenCalled();
    });

    // #729: sync-on-save is no longer gated on the host field changing --
    // every successful save of the default machine triggers a catch-up sync.
    it('PUT on the default machine changing an unrelated field (not host) still triggers a sync', async () => {
        registry.ensureDefaultMachine();
        const r = await fetch(`${baseUrl}/api/machines/1`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Renamed only' }),
        });
        expect(r.status).toBe(200);
        expect(syncShotsMock).toHaveBeenCalledTimes(1);
    });

    // #729: a non-default machine's save now goes through syncMachineShots()
    // (its own adapter-driven sync path) instead of being a no-op --
    // syncShots() itself still only ever acts on the default machine.
    it('PUT on a non-default machine\'s host triggers syncMachineShots() for that machine', async () => {
        const created = registry.createMachine({ name: 'Office GaggiMate', type: 'gaggimate', host: 'a.local' });
        const r = await fetch(`${baseUrl}/api/machines/${created.id}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ host: 'b.local' }),
        });
        expect(r.status).toBe(200);
        expect(syncShotsMock).not.toHaveBeenCalled();
        expect(syncMachineShotsMock).toHaveBeenCalledTimes(1);
        expect(syncMachineShotsMock.mock.calls[0][0]).toMatchObject({ id: created.id });
    });

    it('POST /api/machines for a new non-default machine triggers syncMachineShots() for it', async () => {
        const r = await fetch(`${baseUrl}/api/machines`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Office GaggiMate', type: 'gaggimate', host: 'gaggimate.local' }),
        });
        expect(r.status).toBe(200);
        expect(syncShotsMock).not.toHaveBeenCalled();
        expect(syncMachineShotsMock).toHaveBeenCalledTimes(1);
    });

    // #731: the "Test connection" button saves the form first to get a
    // testable machine id (see machines-settings.js's testMachineForm()) --
    // that implicit save must not itself start an import, only an explicit
    // "Speichern" click should. The client marks it with a `?sync=0` query
    // param, checked here on both POST and PUT.
    it('POST /api/machines?sync=0 creates the machine but skips the catch-up sync', async () => {
        const r = await fetch(`${baseUrl}/api/machines?sync=0`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Office GaggiMate', type: 'gaggimate', host: 'gaggimate.local' }),
        });
        expect(r.status).toBe(200);
        const machine = await r.json();
        expect(machine.name).toBe('Office GaggiMate');
        expect(syncShotsMock).not.toHaveBeenCalled();
        expect(syncMachineShotsMock).not.toHaveBeenCalled();
    });

    it('PUT /api/machines/:id?sync=0 on the default machine updates it but skips the catch-up sync', async () => {
        registry.ensureDefaultMachine();
        const r = await fetch(`${baseUrl}/api/machines/1?sync=0`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ host: 'newly-configured.local' }),
        });
        expect(r.status).toBe(200);
        const updated = await r.json();
        expect(updated.host).toBe('newly-configured.local');
        expect(syncShotsMock).not.toHaveBeenCalled();
        expect(syncMachineShotsMock).not.toHaveBeenCalled();
    });
});
