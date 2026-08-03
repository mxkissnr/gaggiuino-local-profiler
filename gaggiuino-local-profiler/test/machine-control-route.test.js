// routes/machine-control.js (#597) — the settings/control/firmware/live
// proxy routes, mirroring test/machines-api.test.js's in-memory-DB + express
// app pattern. The mock device server combines HTTP (settings/firmware REST)
// and WS (opmode/tare/service-test/save commands, live sensor push) on one
// listener, same as test/gaggiuino-adapter.test.js.
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { WebSocketServer } from 'ws';
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

const express = require('express');
const machineControlRouter = require('../routes/machine-control');
const registry = require('../lib/machines/registry');
const proto = require('../lib/gaggiuino-proto');

function makeApp() {
    const app = express();
    app.use(express.json());
    app.use(machineControlRouter);
    app.use((err, req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
    return app;
}

let server, baseUrl, deviceServer, devicePort, gaggimateMachine;

beforeAll(async () => {
    const httpServer = http.createServer((request, response) => {
        const send = (status, body) => {
            response.writeHead(status, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify(body));
        };
        if (request.method === 'GET' && request.url === '/api/settings/boiler') return send(200, { steamSetPoint: 145 });
        if (request.method === 'POST' && request.url === '/api/settings/boiler') return send(200, { success: true });
        if (request.method === 'GET' && request.url === '/api/firmware/progress') return send(200, { progress: 0, status: 'IDLE', type: 'C_FW' });
        if (request.method === 'POST' && request.url === '/api/firmware/update-all') return send(200, { message: 'Update started', success: true });
        send(404, { error: 'not found' });
    });
    const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
    wss.on('connection', (ws) => {
        ws.on('message', (data) => {
            const envelope = proto.WebSocketMessageDto.fromBinary(data);
            const ack = (action, result, errorMessage) => {
                const resp = proto.WebSocketResponseDto.create({ action, result, errorMessage: errorMessage || '' });
                const msg = proto.WebSocketMessageDto.create({ action: 'd_resp', data: proto.WebSocketResponseDto.toBinary(resp) });
                ws.send(proto.WebSocketMessageDto.toBinary(msg));
            };
            if (envelope.action === proto.ND.SetOperationMode) ack(proto.ND.SetOperationMode, proto.WebSocketResponseResultDto.SUCCESS);
            else if (envelope.action === proto.ND.SetTarePending) ack(proto.ND.SetTarePending, proto.WebSocketResponseResultDto.SUCCESS);
            else if (envelope.action === proto.ND.ServiceTest) ack(proto.ND.ServiceTest, proto.WebSocketResponseResultDto.SUCCESS);
            else if (envelope.action === proto.ND.SaveSettings) ack(proto.ND.SaveSettings, proto.WebSocketResponseResultDto.SUCCESS);
            else if (envelope.action === proto.ND.PersistActiveProfile) ack(proto.ND.PersistActiveProfile, proto.WebSocketResponseResultDto.SUCCESS);
        });
        // Push one sensor snapshot right away so GET /api/machine/live has something cached.
        const snap = proto.SensorStateSnapshotDto.create({ temperature: 91, pumpFlow: 1.1 });
        ws.send(proto.WebSocketMessageDto.toBinary(proto.WebSocketMessageDto.create({ action: 'd_sensor_snap', data: proto.SensorStateSnapshotDto.toBinary(snap) })));
    });
    deviceServer = httpServer;
    await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve));
    devicePort = httpServer.address().port;
});

afterAll(() => {
    deviceServer.close();
    server?.close();
});

beforeEach(async () => {
    memDb.exec('DELETE FROM machines;');
    registry.ensureDefaultMachine();
    registry.updateMachine(1, { host: `127.0.0.1:${devicePort}` });
    gaggimateMachine = registry.createMachine({ name: 'GaggiMate', type: 'gaggimate', host: '127.0.0.1:1' });

    server = makeApp().listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

describe('GET /api/machine/settings', () => {
    it('proxies a category read from the default machine', async () => {
        const r = await fetch(`${baseUrl}/api/machine/settings?category=boiler`);
        expect(r.status).toBe(200);
        expect(await r.json()).toEqual({ steamSetPoint: 145 });
    });

    it('rejects an unknown category', async () => {
        const r = await fetch(`${baseUrl}/api/machine/settings?category=nope`);
        expect(r.status).toBe(400);
    });

    it('501s for a machine type without settingsProxy support', async () => {
        const r = await fetch(`${baseUrl}/api/machine/settings?category=boiler&machineId=${gaggimateMachine.id}`);
        expect(r.status).toBe(501);
    });
});

describe('POST /api/machine/settings/:category', () => {
    it('proxies a settings write', async () => {
        const r = await fetch(`${baseUrl}/api/machine/settings/boiler`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ settings: { steamSetPoint: 150 } }),
        });
        expect(r.status).toBe(200);
        expect((await r.json()).success).toBe(true);
    });

    it('rejects an unknown/read-only category', async () => {
        const r = await fetch(`${baseUrl}/api/machine/settings/versions`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
        });
        expect(r.status).toBe(400);
    });
});

describe('POST /api/machine/settings/save', () => {
    it('does not get swallowed by the /:category route (static route ordering)', async () => {
        const r = await fetch(`${baseUrl}/api/machine/settings/save`, { method: 'POST' });
        expect(r.status).toBe(200);
        expect(await r.json()).toEqual({ ok: true });
    });
});

describe('POST /api/machine/opmode', () => {
    it('sets a valid operation mode', async () => {
        const r = await fetch(`${baseUrl}/api/machine/opmode`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'STEAM' }),
        });
        expect(r.status).toBe(200);
    });

    it('rejects BREW_MANUAL (live-verified no-op while idle)', async () => {
        const r = await fetch(`${baseUrl}/api/machine/opmode`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'BREW_MANUAL' }),
        });
        expect(r.status).toBe(400);
    });
});

describe('POST /api/machine/tare', () => {
    it('requests a tare', async () => {
        const r = await fetch(`${baseUrl}/api/machine/tare`, { method: 'POST' });
        expect(r.status).toBe(200);
    });
});

describe('POST /api/machine/service-test', () => {
    it('triggers a valid peripheral test', async () => {
        const r = await fetch(`${baseUrl}/api/machine/service-test`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ peripheral: 'LED' }),
        });
        expect(r.status).toBe(200);
    });

    it('rejects an invalid peripheral', async () => {
        const r = await fetch(`${baseUrl}/api/machine/service-test`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ peripheral: 'PORTAFILTER' }),
        });
        expect(r.status).toBe(400);
    });
});

describe('POST /api/machine/profile/save', () => {
    it('persists the active profile', async () => {
        const r = await fetch(`${baseUrl}/api/machine/profile/save`, { method: 'POST' });
        expect(r.status).toBe(200);
    });
});

describe('firmware routes', () => {
    it('GET progress proxies the machine', async () => {
        const r = await fetch(`${baseUrl}/api/machine/firmware/progress`);
        expect(r.status).toBe(200);
        expect(await r.json()).toEqual({ progress: 0, status: 'IDLE', type: 'C_FW' });
    });

    it('POST update triggers an OTA update', async () => {
        const r = await fetch(`${baseUrl}/api/machine/firmware/update`, { method: 'POST' });
        expect(r.status).toBe(200);
        expect(await r.json()).toEqual({ message: 'Update started', success: true });
    });
});

describe('GET /api/machine/live', () => {
    it('returns the cached live sensor snapshot once the WS session has one', async () => {
        // Poll briefly: the live-client session's push arrives asynchronously
        // after connect, and a fresh baseUrl/session may not have it yet.
        let body;
        for (let i = 0; i < 20; i++) {
            const r = await fetch(`${baseUrl}/api/machine/live`);
            body = await r.json();
            if (body.sensorSnap) break;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        expect(body.sensorSnap).not.toBeNull();
        expect(body.sensorSnap.temperature).toBeCloseTo(91);
    });
});
