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
const dns = require('dns');
vi.spyOn(dns.promises, 'lookup').mockImplementation(async (hostname) => {
    if (hostname === 'blocked.internal') return [{ address: '192.168.1.5', family: 4 }];
    return [{ address: '203.0.113.10', family: 4 }];
});

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

    it('rejects a host that resolves to a private address (SSRF guard)', async () => {
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
