// GaggiMate JSON-WebSocket client tests (#318) — mirrors
// test/gaggiuino-ws-client.test.js's approach: a mock WebSocketServer
// speaking the same JSON tp/req:*/res:*/evt:* protocol GLP's own client
// implements, since no real GaggiMate hardware is available to test against.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { createRequire } from 'module';
import http from 'http';

const req = createRequire(import.meta.url);

// The adapter now re-validates machine.host on every request via
// assertMachineHost() (defense-in-depth against SSRF, since the default
// machine's host is seeded from add-on options and bypasses
// routes/machines.js's save-time check entirely). That guard rejects
// loopback addresses by design — real Gaggiuino/GaggiMate hardware never
// lives at 127.0.0.1 — but these tests stand up their mock device server on
// 127.0.0.1, so the guard is stubbed out here to isolate the adapter/wire
// behaviour under test from that unrelated host-validation concern.
vi.spyOn(req('../lib/ssrf-guard'), 'assertMachineHost').mockResolvedValue();

describe('gaggimate/ws-client', () => {
    let server, port, wsClient, profiles;

    beforeAll(async () => {
        wsClient = req('../lib/machines/gaggimate/ws-client');
        profiles = req('../lib/machines/gaggimate/profiles');
        server = new WebSocketServer({ port: 0 });
        port = server.address().port;

        server.on('connection', (ws) => {
            ws.on('message', (data) => {
                let msg;
                try { msg = JSON.parse(data.toString()); } catch { return; }

                if (msg.tp === 'req:profiles:list') {
                    ws.send(JSON.stringify({ tp: 'res:profiles:list', rid: msg.rid, profiles: [{ id: '1', name: 'Default' }] }));
                } else if (msg.tp === 'req:profiles:load') {
                    if (msg.id === 'never-responds') return;
                    ws.send(JSON.stringify({ tp: 'res:profiles:load', rid: msg.rid, profile: { id: msg.id, name: 'Mock Profile', steps: [] } }));
                } else if (msg.tp === 'req:profiles:save') {
                    const saved = { ...msg.profile, id: msg.profile.id || 'new-id' };
                    ws.send(JSON.stringify({ tp: 'res:profiles:save', rid: msg.rid, profile: saved }));
                } else if (msg.tp === 'req:profiles:delete') {
                    ws.send(JSON.stringify({ tp: 'res:profiles:delete', rid: msg.rid, ok: true }));
                } else if (msg.tp === 'req:profiles:select') {
                    ws.send(JSON.stringify({ tp: 'res:profiles:select', rid: msg.rid, ok: true }));
                } else if (msg.tp === 'req:rid-as-string-echo') {
                    // Real GaggiMate firmware echoes rid back as a string even
                    // though the client sends it as a number (#342) — simulate
                    // that quirk here so a regression is caught in CI.
                    ws.send(JSON.stringify({ tp: 'res:rid-as-string-echo', rid: String(msg.rid), ok: true }));
                }
            });
            // Push an unsolicited status event shortly after connect, like a real device would.
            setTimeout(() => {
                ws.send(JSON.stringify({ tp: 'evt:status', ct: 92.5, tt: 93, pr: 8.9, fl: 2.1, pt: 9, m: 1, p: 'Default', cp: true, cd: false }));
            }, 20);
        });
    });

    afterAll(() => server.close());

    const baseUrl = () => `http://127.0.0.1:${port}`;

    it('waitForStatus resolves with the first evt:status broadcast', async () => {
        const status = await wsClient.waitForStatus(baseUrl());
        expect(status.tp).toBe('evt:status');
        expect(status.ct).toBeCloseTo(92.5);
        expect(status.m).toBe(1);
    });

    it('request() correlates req:* with res:* by rid', async () => {
        const res = await wsClient.request(baseUrl(), 'req:profiles:list');
        expect(res.profiles).toEqual([{ id: '1', name: 'Default' }]);
    });

    it('request() correlates rid even when the machine echoes it back as a string (#342)', async () => {
        const res = await wsClient.request(baseUrl(), 'req:rid-as-string-echo');
        expect(res.ok).toBe(true);
    });

    it('request() times out cleanly when the machine never responds', async () => {
        await expect(wsClient.request(baseUrl(), 'req:profiles:load', { id: 'never-responds' }, 300))
            .rejects.toThrow(/Timed out/);
    });

    it('profiles.listProfiles/loadProfile/saveProfile/deleteProfile/selectProfile round-trip', async () => {
        const list = await profiles.listProfiles(baseUrl());
        expect(list).toEqual([{ id: '1', name: 'Default' }]);

        const loaded = await profiles.loadProfile(baseUrl(), '1');
        expect(loaded.name).toBe('Mock Profile');

        const saved = await profiles.saveProfile(baseUrl(), { name: 'New Profile' });
        expect(saved.id).toBe('new-id');

        const del = await profiles.deleteProfile(baseUrl(), '1');
        expect(del.ok).toBe(true);

        const sel = await profiles.selectProfile(baseUrl(), '1');
        expect(sel.ok).toBe(true);
    });
});

describe('gaggimate/adapter', () => {
    let server, port, adapter;

    beforeAll(async () => {
        adapter = req('../lib/machines/gaggimate/adapter');
        server = new WebSocketServer({ port: 0 });
        port = server.address().port;
        server.on('connection', (ws) => {
            setTimeout(() => {
                ws.send(JSON.stringify({ tp: 'evt:status', ct: 91, tt: 94, pr: 3.2, fl: 0, m: 0, p: 'Idle' }));
            }, 10);
        });
    });

    afterAll(() => server.close());

    it('getStatus maps evt:status fields into the adapter interface shape', async () => {
        const machine = { host: `127.0.0.1:${port}`, type: 'gaggimate' };
        const status = await adapter.getStatus(machine);
        expect(status.reachable).toBe(true);
        expect(status.temperature).toBeCloseTo(91);
        expect(status.targetTemperature).toBeCloseTo(94);
        expect(status.brewing).toBe(false); // m: 0, not the "brewing" mode
        expect(status.profileName).toBe('Idle');
    });

    it('capabilities() reports GaggiMate limitations (no brew start, read-only profiles)', () => {
        const caps = adapter.capabilities();
        expect(caps.brewStart).toBe(false);
        expect(caps.profileEdit).toBe(false);
        expect(caps.history).toBe(true);
    });
});

// getShot() history URL padding (#343) — real GaggiMate firmware 404s on
// unpadded .slog filenames (e.g. /api/history/2.slog) and only serves
// /api/history/000002.slog (id zero-padded to 6 digits), live-verified
// against a real device. A mock HTTP server that only answers the padded
// path (404s everything else, including the unpadded form) catches a
// regression to the unpadded form here instead of only live, on hardware.
describe('gaggimate/adapter — getShot() history URL', () => {
    let httpServer, port, adapter;

    function buildMinimalSlogV4() {
        const history = req('../lib/machines/gaggimate/history');
        const headerSize = history.HEADER_SIZE_V4;
        const buf = Buffer.alloc(headerSize);
        buf.write('SHOT', 0, 'ascii');
        buf.writeUInt8(4, 4);            // version
        buf.writeUInt8(0, 5);            // deviceSampleSize
        buf.writeUInt16LE(headerSize, 6);
        buf.writeUInt16LE(100, 8);       // sampleIntervalMs
        buf.writeUInt32LE(0, 12);        // fieldsMask (no fields, no samples)
        buf.writeUInt32LE(0, 16);        // sampleCount
        buf.writeUInt32LE(1000, 20);     // durationMs
        buf.writeUInt32LE(1700000000, 24); // timestamp
        return buf;
    }

    beforeAll(async () => {
        adapter = req('../lib/machines/gaggimate/adapter');
        const slogBuf = buildMinimalSlogV4();
        httpServer = http.createServer((request, response) => {
            if (request.url === '/api/history/000002.slog') {
                response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
                response.end(slogBuf);
            } else {
                response.writeHead(404);
                response.end('not found');
            }
        });
        await new Promise((resolve) => httpServer.listen(0, resolve));
        port = httpServer.address().port;
    });

    afterAll(() => new Promise((resolve) => httpServer.close(resolve)));

    it('requests the 6-digit zero-padded .slog path, not the plain numeric id', async () => {
        const machine = { host: `127.0.0.1:${port}`, type: 'gaggimate' };
        const shot = await adapter.getShot(machine, 2);
        expect(shot.id).toBe(2);
        expect(shot.machineType).toBe('gaggimate');
    });

    it('rejects if the server only serves the unpadded form (regression guard)', async () => {
        const machine = { host: `127.0.0.1:${port}`, type: 'gaggimate' };
        await expect(adapter.getShot(machine, 999)).rejects.toThrow();
    });
});
