// GaggiMate JSON-WebSocket client tests (#318) — mirrors
// test/gaggiuino-ws-client.test.js's approach: a mock WebSocketServer
// speaking the same JSON tp/req:*/res:*/evt:* protocol GLP's own client
// implements, since no real GaggiMate hardware is available to test against.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebSocketServer } from 'ws';
import { createRequire } from 'module';

const req = createRequire(import.meta.url);

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
