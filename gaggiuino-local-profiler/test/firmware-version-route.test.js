// GET /api/machine/firmware/version (#620 Phase 1) — same in-memory-DB +
// mock-device-HTTP-server pattern as test/machine-control-route.test.js,
// kept in its own file so lib/machines/gaggiuino/firmware-check.js can be
// swapped out via require.cache (same trick as test/import-route.test.js
// uses for axios) without affecting that file's own axios-hitting-real-
// localhost-device assumptions.
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { createRequire } from 'module';
import http from 'http';

const require = createRequire(import.meta.url);

const Database = require('better-sqlite3');
const dbPath   = require.resolve('../lib/db');
const realDb   = require(dbPath);
const memDb    = new Database(':memory:');
realDb.initSchema(memDb);
require.cache[dbPath].exports = { getDb: () => memDb, initSchema: realDb.initSchema };

vi.spyOn(require('../lib/ssrf-guard'), 'assertMachineHost').mockResolvedValue();

const firmwareCheckPath = require.resolve('../lib/machines/gaggiuino/firmware-check');
const getLatestFirmwareRelease = vi.fn();
require.cache[firmwareCheckPath] = { exports: { getLatestFirmwareRelease, CHANNEL_TAG_PREFIX: { 0: 'main-', 1: 'main-', 2: 'dev-' } } };

const express = require('express');
const machineControlRouter = require('../routes/machine-control');
const registry = require('../lib/machines/registry');

function makeApp() {
    const app = express();
    app.use(express.json());
    app.use(machineControlRouter);
    app.use((err, req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
    return app;
}

let server, baseUrl, deviceServer, devicePort;
let versionsResponse, systemResponse;

beforeAll(async () => {
    const httpServer = http.createServer((request, response) => {
        const send = (status, body) => {
            response.writeHead(status, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify(body));
        };
        if (request.method === 'GET' && request.url === '/api/settings/versions') return send(200, versionsResponse);
        if (request.method === 'GET' && request.url === '/api/settings/system')   return send(200, systemResponse);
        send(404, { error: 'not found' });
    });
    deviceServer = httpServer;
    await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve));
    devicePort = httpServer.address().port;
});

afterAll(() => { deviceServer.close(); server?.close(); });

beforeEach(async () => {
    memDb.exec('DELETE FROM machines;');
    registry.ensureDefaultMachine();
    registry.updateMachine(1, { host: `127.0.0.1:${devicePort}` });

    versionsResponse = { coreVersion: '7889b7d', frontVersion: 'abc1234', staticVersion: 'def5678' };
    systemResponse   = { releaseChannel: 0 };
    getLatestFirmwareRelease.mockReset();

    server = makeApp().listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

describe('GET /api/machine/firmware/version', () => {
    it('reports updateAvailable:true when installed and latest differ', async () => {
        getLatestFirmwareRelease.mockResolvedValue({ hash: 'aaaaaaa', publishedAt: '2026-08-05T00:00:00Z', releaseUrl: 'https://example.com/release' });
        const r = await fetch(`${baseUrl}/api/machine/firmware/version`);
        expect(r.status).toBe(200);
        expect(await r.json()).toEqual({
            installed: '7889b7d', latest: 'aaaaaaa', updateAvailable: true, releaseUrl: 'https://example.com/release',
        });
    });

    it('reports updateAvailable:false when installed matches latest', async () => {
        getLatestFirmwareRelease.mockResolvedValue({ hash: '7889b7d', publishedAt: '2026-08-02T00:00:00Z', releaseUrl: 'https://example.com/release' });
        const r = await fetch(`${baseUrl}/api/machine/firmware/version`);
        expect(await r.json()).toMatchObject({ installed: '7889b7d', latest: '7889b7d', updateAvailable: false });
    });

    it('passes the machine\'s own releaseChannel through to the GitHub lookup', async () => {
        systemResponse = { releaseChannel: 2 };
        getLatestFirmwareRelease.mockResolvedValue({ hash: 'devhash1', publishedAt: '2026-08-05T00:00:00Z', releaseUrl: 'https://example.com/dev' });
        await fetch(`${baseUrl}/api/machine/firmware/version`);
        expect(getLatestFirmwareRelease).toHaveBeenCalledWith(2);
    });

    it('reports updateAvailable:false with latest:null when the GitHub lookup finds nothing (unknown, not "up to date")', async () => {
        getLatestFirmwareRelease.mockResolvedValue(null);
        const r = await fetch(`${baseUrl}/api/machine/firmware/version`);
        expect(await r.json()).toEqual({ installed: '7889b7d', latest: null, updateAvailable: false, releaseUrl: null });
    });

    it('502s when the GitHub lookup itself fails', async () => {
        getLatestFirmwareRelease.mockRejectedValue(new Error('GitHub API rate-limited'));
        const r = await fetch(`${baseUrl}/api/machine/firmware/version`);
        expect(r.status).toBe(502);
    });

    it('501s for a machine type without settingsProxy support (GaggiMate)', async () => {
        const gm = registry.createMachine({ name: 'GaggiMate', type: 'gaggimate', host: '127.0.0.1:1' });
        const r = await fetch(`${baseUrl}/api/machine/firmware/version?machineId=${gm.id}`);
        expect(r.status).toBe(501);
    });
});
