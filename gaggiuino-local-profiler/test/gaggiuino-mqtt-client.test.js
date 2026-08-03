// lib/gaggiuino-mqtt-client.js (#598) — the MQTT alternative to
// gaggiuino-live-client.js's persistent-WS-session cache. Tested against a
// real in-process MQTT broker (aedes, over a real TCP socket) rather than
// mocked strings, same rigor as test/gaggiuino-live-client.test.js's
// in-process WebSocketServer — a second `mqtt` client acts as the publisher
// (standing in for the Gaggiuino machine itself), so this exercises the
// actual `mqtt` package's connect/subscribe/publish/message round trip, not
// just this module's internal logic.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Aedes } from 'aedes';
import net from 'net';
import mqtt from 'mqtt';
import { createRequire } from 'module';

const req = createRequire(import.meta.url);

function waitFor(check, timeoutMs = 2000, intervalMs = 20) {
    return new Promise((resolve, reject) => {
        const start = Date.now();
        const tick = () => {
            const value = check();
            if (value) return resolve(value);
            if (Date.now() - start > timeoutMs) return reject(new Error('waitFor timed out'));
            setTimeout(tick, intervalMs);
        };
        tick();
    });
}

describe('gaggiuino-mqtt-client', () => {
    let broker, server, port, mqttClient, liveEvents, publisher, clientCount;

    beforeAll(async () => {
        mqttClient = req('../lib/gaggiuino-mqtt-client');
        liveEvents = req('../lib/gaggiuino-live-client').events;

        broker = await Aedes.createBroker();
        server = net.createServer(broker.handle);
        await new Promise(resolve => server.listen(0, resolve));
        port = server.address().port;

        clientCount = 0;
        broker.on('client', () => { clientCount++; });

        publisher = mqtt.connect(`mqtt://127.0.0.1:${port}`);
        await new Promise((resolve, reject) => {
            publisher.on('connect', resolve);
            publisher.on('error', reject);
        });
    });

    afterAll(async () => {
        mqttClient.disconnectAll();
        publisher.end(true);
        await new Promise(resolve => server.close(resolve));
    });

    const conn = () => ({ host: '127.0.0.1', port, prefix: 'test' });

    it('returns null before any push has arrived, then caches the sensors payload mapped to WS field names', async () => {
        expect(mqttClient.getLiveSensorSnapshot(conn())).toBeNull(); // side effect: lazily connects the subscriber

        // Real Gaggiuino firmware retains `<prefix>/sensors` (MQTT.md) —
        // publishing retained here too means this doesn't race the
        // subscriber's still-in-flight SUBSCRIBE (a plain QoS 0, non-
        // retained publish sent before that ack lands would be silently
        // dropped, same as it would against the real broker).
        publisher.publish('test/sensors', JSON.stringify({
            brewActive: true, temperature: 92.5, pumpFlow: 1.2, weightFlow: 0.8,
            boilerOn: true, valveOpen: false, hotWaterActive: false,
        }), { retain: true });

        const snap = await waitFor(() => mqttClient.getLiveSensorSnapshot(conn()));
        expect(snap.brewActive).toBe(true);
        expect(snap.temperature).toBeCloseTo(92.5);
        expect(snap.pumpFlow).toBeCloseTo(1.2);
        // MQTT.md's field names (boilerOn/valveOpen/hotWaterActive) must land
        // on the exact field names lib/gaggiuino-proto.js's SensorStateSnapshotDto
        // decodes WS pushes into (boilerState/valveState/hotWaterSwitchState) —
        // this is the cache-shape contract lib/machine-state.js's
        // deriveMachineState() relies on.
        expect(snap.boilerState).toBe(true);
        expect(snap.valveState).toBe(false);
        expect(snap.hotWaterSwitchState).toBe(false);
    });

    it('caches the system payload separately, mapped to SystemStateDto field names', async () => {
        publisher.publish('test/system', JSON.stringify({
            operationMode: 'STEAM', thermocoupleFaulted: true, thermocoupleFaultReason: 'Open circuit',
            pressureSensorFaulted: false, coreVersion: '1.5.0',
        }), { retain: true });
        const state = await waitFor(() => mqttClient.getLiveSystemState(conn()));
        expect(state.operationMode).toBe('STEAM');
        expect(state.thermocoupleFaulted).toBe(true);
        expect(state.thermocoupleFaultReason).toBe('Open circuit');
        expect(state.coreVersion).toBe('1.5.0');
    });

    it('emits sensor-snap on gaggiuino-live-client.js\'s shared events bus — the transport-agnostic seam', async () => {
        const received = new Promise(resolve => liveEvents.once('sensor-snap', (key, snap) => resolve({ key, snap })));
        publisher.publish('test/sensors', JSON.stringify({ temperature: 88 }));
        const { key, snap } = await received;
        expect(key).toBe(mqttClient.connKeyFor(conn()));
        expect(snap.temperature).toBeCloseTo(88);
    });

    it('reuses the same broker connection across repeated reads for one connection descriptor', async () => {
        await waitFor(() => mqttClient.getLiveSensorSnapshot(conn()));
        const before = clientCount;
        mqttClient.getLiveSensorSnapshot(conn());
        mqttClient.getLiveSensorSnapshot(conn());
        mqttClient.getLiveSystemState(conn());
        expect(clientCount).toBe(before); // no new broker connections opened by repeated cache reads
    });

    it('disconnectAll() closes the session so the next read reconnects fresh', async () => {
        await waitFor(() => mqttClient.getLiveSensorSnapshot(conn()));
        const before = clientCount;
        mqttClient.disconnectAll();
        expect(mqttClient.getLiveSensorSnapshot(conn())).toBeNull(); // fresh session, nothing cached yet
        await waitFor(() => clientCount > before);
    });
});
