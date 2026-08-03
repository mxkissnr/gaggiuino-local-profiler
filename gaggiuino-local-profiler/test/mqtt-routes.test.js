// routes/mqtt.js (#598) — Supervisor discovery, settings read/save, and the
// one-click "apply to machine" proxy write. Mirrors test/machine-control-
// route.test.js's in-memory-DB + mock-device-HTTP-server pattern for the
// apply-to-machine case (it round-trips through the same #597 settings
// proxy), and spies on lib/mqtt-discovery.js's discoverSupervisorMqtt()
// (network call to the Supervisor, not reachable in a test environment)
// rather than mocking the whole module.
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

const mqttDiscovery = require('../lib/mqtt-discovery');
const discoverySpy  = vi.spyOn(mqttDiscovery, 'discoverSupervisorMqtt').mockResolvedValue(null);

const express = require('express');
const mqttRouter = require('../routes/mqtt');
const registry    = require('../lib/machines/registry');
const mqttSettingsRepo = require('../lib/repositories/MqttSettingsRepository');
const gaggiuinoMqtt = require('../lib/gaggiuino-mqtt-client');

function makeApp() {
    const app = express();
    app.use(express.json());
    app.use(mqttRouter);
    app.use((err, request, response, _next) => response.status(err.status || 500).json({ error: err.message }));
    return app;
}

let server, baseUrl, deviceServer, devicePort, systemSettings;

beforeAll(async () => {
    systemSettings = { mqttEnabled: false, mqttHost: '', mqttPort: 1883, mqttUsername: '', mqttPassword: '', mqttTopicPrefix: 'gaggiuino', wifiEnabled: true };
    const httpServer = http.createServer((request, response) => {
        const send = (status, body) => {
            response.writeHead(status, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify(body));
        };
        if (request.method === 'GET' && request.url === '/api/settings/system') return send(200, systemSettings);
        if (request.method === 'POST' && request.url === '/api/settings/system') {
            let body = '';
            request.on('data', chunk => { body += chunk; });
            request.on('end', () => {
                systemSettings = JSON.parse(body);
                send(200, { success: true });
            });
            return;
        }
        send(404, { error: 'not found' });
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
    memDb.exec('DELETE FROM machines; DELETE FROM kv;');
    registry.ensureDefaultMachine();
    registry.updateMachine(1, { host: `127.0.0.1:${devicePort}` });
    discoverySpy.mockResolvedValue(null);
    gaggiuinoMqtt.disconnectAll();

    server = makeApp().listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

describe('GET /api/mqtt/discovery', () => {
    it('reports unavailable when the Supervisor has no MQTT service registered', async () => {
        const r = await fetch(`${baseUrl}/api/mqtt/discovery`);
        expect(r.status).toBe(200);
        expect(await r.json()).toEqual({ available: false });
    });

    it('surfaces the Supervisor-discovered broker when one is registered', async () => {
        discoverySpy.mockResolvedValue({ host: 'core-mosquitto', port: 1883, username: 'ha-mqtt', password: 'secret' });
        const r = await fetch(`${baseUrl}/api/mqtt/discovery`);
        expect(await r.json()).toEqual({ available: true, host: 'core-mosquitto', port: 1883, username: 'ha-mqtt', password: 'secret' });
    });
});

describe('GET/POST /api/mqtt/settings', () => {
    it('defaults to the websocket transport', async () => {
        const r = await fetch(`${baseUrl}/api/mqtt/settings`);
        expect((await r.json()).transport).toBe('websocket');
    });

    it('saves and echoes back valid settings', async () => {
        const r = await fetch(`${baseUrl}/api/mqtt/settings`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ transport: 'mqtt', host: '192.168.1.50', port: 1883, username: 'u', password: 'p', prefix: 'gaggiuino' }),
        });
        expect(r.status).toBe(200);
        const saved = await r.json();
        expect(saved.transport).toBe('mqtt');
        expect(saved.host).toBe('192.168.1.50');

        const r2 = await fetch(`${baseUrl}/api/mqtt/settings`);
        expect((await r2.json()).host).toBe('192.168.1.50');
    });

    it('rejects an invalid transport value', async () => {
        const r = await fetch(`${baseUrl}/api/mqtt/settings`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ transport: 'carrier-pigeon' }),
        });
        expect(r.status).toBe(400);
    });
});

describe('POST /api/mqtt/apply-to-machine', () => {
    it('errors when no broker is configured yet', async () => {
        const r = await fetch(`${baseUrl}/api/mqtt/apply-to-machine`, { method: 'POST' });
        expect(r.status).toBe(400);
    });

    it('merges the saved broker onto a full GET of the machine\'s system settings before POSTing back', async () => {
        mqttSettingsRepo.saveSettings({ transport: 'mqtt', host: '192.168.1.50', port: 1883, username: 'u', password: 'p', prefix: 'gaggiuino' });
        const r = await fetch(`${baseUrl}/api/mqtt/apply-to-machine`, { method: 'POST' });
        expect(r.status).toBe(200);
        expect(systemSettings.mqttEnabled).toBe(true);
        expect(systemSettings.mqttHost).toBe('192.168.1.50');
        expect(systemSettings.mqttTopicPrefix).toBe('gaggiuino');
        // Fields unrelated to MQTT from the original GET must survive the merge.
        expect(systemSettings.wifiEnabled).toBe(true);
    });
});
