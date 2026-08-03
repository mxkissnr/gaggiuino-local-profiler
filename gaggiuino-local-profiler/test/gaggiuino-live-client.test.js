// lib/gaggiuino-live-client.js (#597) — the persistent-WS-session live-value
// cache (d_sensor_snap/d_sys_state), as opposed to gaggiuino-ws-client.js's
// short-lived-connection-per-request pattern. Covers: lazy connect on first
// read, cache population from pushed frames, and the 'sensor-snap'/
// 'sys-state' events emitted for future consumers (the observer seam noted
// in that module's header comment).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebSocketServer } from 'ws';
import { createRequire } from 'module';

const req = createRequire(import.meta.url);

describe('gaggiuino-live-client', () => {
    let server, port, liveClient, proto, connections;

    beforeAll(async () => {
        liveClient = req('../lib/gaggiuino-live-client');
        proto = req('../lib/gaggiuino-proto');
        server = new WebSocketServer({ port: 0 });
        port = server.address().port;
        connections = 0;

        server.on('connection', (ws) => {
            connections++;
            ws._push = (action, msgType, payload) => {
                const msg = proto.WebSocketMessageDto.create({ action, data: msgType.toBinary(msgType.create(payload)) });
                ws.send(proto.WebSocketMessageDto.toBinary(msg));
            };
        });
    });

    afterAll(() => server.close());

    const baseUrl = () => `http://127.0.0.1:${port}`;

    it('returns null before any push has arrived, then caches the decoded snapshot', async () => {
        expect(liveClient.getLiveSensorSnapshot(baseUrl())).toBeNull();

        await new Promise(resolve => setTimeout(resolve, 100));
        const [ws] = [...server.clients];
        ws._push('d_sensor_snap', proto.SensorStateSnapshotDto, { temperature: 92.5, pumpFlow: 1.2, weightFlow: 0.8, boilerState: true });

        await new Promise(resolve => setTimeout(resolve, 50));
        const snap = liveClient.getLiveSensorSnapshot(baseUrl());
        expect(snap.temperature).toBeCloseTo(92.5);
        expect(snap.pumpFlow).toBeCloseTo(1.2);
        expect(snap.boilerState).toBe(true);
    });

    it('caches d_sys_state separately from d_sensor_snap', async () => {
        const url = `http://127.0.0.1:${port}`;
        const [ws] = [...server.clients]; // already connected from the previous test
        ws._push('d_sys_state', proto.SystemStateDto, {
            operationMode: 4, thermocoupleFaulted: true, thermocoupleFaultReason: 'Open circuit',
        });
        await new Promise(resolve => setTimeout(resolve, 50));
        const state = liveClient.getLiveSystemState(url);
        expect(state.operationMode).toBe(4);
        expect(state.thermocoupleFaulted).toBe(true);
        expect(state.thermocoupleFaultReason).toBe('Open circuit');
    });

    it('emits a sensor-snap event on the shared events bus (the future-MQTT-publisher seam)', async () => {
        const url = `http://127.0.0.1:${port}`;
        const received = new Promise(resolve => liveClient.events.once('sensor-snap', (b, snap) => resolve({ b, snap })));
        const [ws] = [...server.clients];
        ws._push('d_sensor_snap', proto.SensorStateSnapshotDto, { temperature: 88 });
        const { b, snap } = await received;
        expect(b).toBe(url);
        expect(snap.temperature).toBeCloseTo(88);
    });

    it('reuses the same connection across repeated reads for one baseUrl (WS_MAX_CONNECTIONS budget)', () => {
        const before = connections;
        liveClient.getLiveSensorSnapshot(baseUrl());
        liveClient.getLiveSensorSnapshot(baseUrl());
        liveClient.getLiveSystemState(baseUrl());
        expect(connections).toBe(before); // no new connections opened by repeated cache reads
    });

    // #600: lib/machines/registry.js's session-eviction hook (deleteMachine/
    // updateMachine host change) needs a way to actually tear a stale
    // session down instead of leaving it retrying every RECONNECT_DELAY_MS
    // forever.
    it('disconnect(baseUrl) terminates the socket and forgets the session, without triggering a reconnect', async () => {
        liveClient.getLiveSensorSnapshot(baseUrl());
        await new Promise(resolve => setTimeout(resolve, 100));
        expect(server.clients.size).toBe(1);

        liveClient.disconnect(baseUrl());
        await new Promise(resolve => setTimeout(resolve, 100));
        // The underlying socket is actually gone (not just forgotten by this
        // module) and nothing reopened it on its own within this window.
        expect(server.clients.size).toBe(0);

        // A later read reopens a fresh session/connection, exactly like a
        // cold cache — same as the very first test in this file.
        expect(liveClient.getLiveSensorSnapshot(baseUrl())).toBeNull();
        await new Promise(resolve => setTimeout(resolve, 100));
        expect(server.clients.size).toBe(1);
    });

    it('disconnect(baseUrl) does not schedule its own reconnect even past RECONNECT_DELAY_MS', async () => {
        liveClient.getLiveSensorSnapshot(baseUrl());
        await new Promise(resolve => setTimeout(resolve, 100));

        liveClient.disconnect(baseUrl());
        // RECONNECT_DELAY_MS is 3000 — wait past it for real. If the closed
        // socket's own 'close' handler were still attached, this is exactly
        // when a phantom reconnect would show up as a new server connection.
        await new Promise(resolve => setTimeout(resolve, 3200));
        expect(server.clients.size).toBe(0);
    }, 10000);

    it('disconnectForHost(host) normalizes a bare host (no scheme) to the same baseUrl key connect() uses', async () => {
        liveClient.getLiveSensorSnapshot(baseUrl());
        await new Promise(resolve => setTimeout(resolve, 100));
        expect(server.clients.size).toBe(1);

        liveClient.disconnectForHost(`127.0.0.1:${port}`); // mirrors a machine registry row's raw `host` column
        await new Promise(resolve => setTimeout(resolve, 100));
        expect(server.clients.size).toBe(0);
        expect(liveClient.getLiveSensorSnapshot(baseUrl())).toBeNull(); // session was actually evicted, not left cached
    });
});
