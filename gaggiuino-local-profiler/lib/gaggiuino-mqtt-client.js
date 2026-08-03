// #598: MQTT alternative to lib/gaggiuino-live-client.js's persistent-WS-
// session cache — the drop-in that module's header comment predicted
// ("a future consumer, e.g. an MQTT publisher... to piggyback on this same
// connection's data"). Subscribes to the machine's own MQTT-published
// topics (see gaggiuino/gaggiuino.github.io's docs/rest-api/MQTT.md) instead
// of opening a WebSocket, and translates the `<prefix>/sensors`/
// `<prefix>/system` JSON payloads into the exact same field names
// lib/gaggiuino-proto.js's SensorStateSnapshotDto/SystemStateDto decode WS
// pushes into (see toSensorSnap()/toSysState() below) — every existing
// reader of getLiveSensorSnapshot()/getLiveSystemState() (lib/machine-
// state.js's deriveMachineState(), routes/machine-control.js's
// GET /api/machine/live) stays unaware of which transport populated the
// cache. lib/live-transport.js is the seam that decides which of this
// module or gaggiuino-live-client.js a given read goes to.
//
// Unlike the WS client (keyed by machine baseUrl, one session per machine),
// MQTT connection details are a single global broker (lib/repositories/
// MqttSettingsRepository.js) — sessions are keyed by the connection
// descriptor itself (host:port:prefix) purely so tests can spin up isolated
// brokers on ephemeral ports without colliding, not because multiple
// concurrent broker connections are a real use case.
'use strict';
const mqtt = require('mqtt');
const { log } = require('./helpers');
// Reuses gaggiuino-live-client.js's own EventEmitter instance (not a second
// bus) so a listener that only cares about "the live cache changed" —
// regardless of which transport is active — can subscribe once, exactly the
// seam that module's header comment described.
const { events } = require('./gaggiuino-live-client');

const STALE_MS = 15000; // same policy as gaggiuino-live-client.js: a cached value older than this reads as unavailable (null), not stale-but-served

const sessions = new Map(); // connKey -> session state

function connKeyFor(conn) {
    return `${conn.host}:${conn.port || 1883}:${conn.prefix || 'gaggiuino'}`;
}

function getSession(conn) {
    const key = connKeyFor(conn);
    let session = sessions.get(key);
    if (!session) {
        session = {
            client: null, connecting: false,
            sensorSnap: null, sensorSnapAt: 0,
            sysState: null, sysStateAt: 0,
            available: null,
            // #611: one-time-per-connect log flags — set once the first
            // sensors/system message arrives after a (re)connect, so a
            // broker publishing continuously doesn't spam the log on every
            // message, only confirms once that data is actually flowing.
            loggedFirstSensorSnap: false, loggedFirstSysState: false,
        };
        sessions.set(key, session);
    }
    return session;
}

// MQTT.md's `<prefix>/sensors` payload -> the same field names
// SensorStateSnapshotDto decodes WS d_sensor_snap pushes into. Field names
// genuinely differ between the two (e.g. `boilerOn` vs `boilerState`) even
// though they describe the same relay/valve state — this is the mapping
// lib/machine-state.js's deriveMachineState() relies on being identical
// regardless of transport. Only the subset deriveMachineState() actually
// reads is mapped (pumpFlow, weightFlow, waterTemperature, boilerState,
// valveState, steamValveState, valveBState, steamBoilerRelayState) plus the
// other sensors-topic fields with a direct 1:1 name (temperature, pressure,
// weight, waterLevel) — the WS-only pin*Level diagnostics have no MQTT
// equivalent (see MQTT.md's field notes) and are simply absent here, same as
// they'd be absent from a stale/empty WS cache.
function toSensorSnap(p) {
    return {
        brewActive:            !!p.brewActive,
        steamActive:           !!p.steamActive,
        hotWaterSwitchState:   !!p.hotWaterActive,
        temperature:           p.temperature ?? 0,
        waterTemperature:      p.waterTemperature ?? 0,
        pressure:              p.pressure ?? 0,
        pumpFlow:              p.pumpFlow ?? 0,
        weightFlow:            p.weightFlow ?? 0,
        weight:                p.weight ?? 0,
        waterLevel:            p.waterLevel ?? 0,
        boilerState:           !!p.boilerOn,
        valveState:            !!p.valveOpen,
        steamValveState:       !!p.steamValveOn,
        valveBState:           !!p.valveBOpen,
        steamBoilerRelayState: !!p.steamBoilerRelayOn,
    };
}

// MQTT.md's `<prefix>/system` payload -> SystemStateDto's field names.
// operationMode arrives as the enum's string name (e.g. "BREW_AUTO") over
// MQTT, vs. a numeric wire value decoded from WS protobuf — left as the
// string here since deriveMachineState() never reads operationMode off
// sysState (only thermocoupleFaulted/Reason, pressureSensorFaulted/Reason
// are consumed there); a caller that does need it can compare either
// representation against lib/gaggiuino-proto.js's OperationModeDto, which
// maps both directions.
function toSysState(p) {
    return {
        startupInitFinished:       !!p.startupInitFinished,
        tofReady:                  !!p.tofReady,
        scalesPresent:             !!p.scalesPresent,
        operationMode:             p.operationMode,
        timeAlive:                 p.timeAliveSec ?? 0,
        coreVersion:               p.coreVersion || '',
        tarePending:               !!p.tarePending,
        thermocoupleFaulted:       !!p.thermocoupleFaulted,
        pressureSensorFaulted:     !!p.pressureSensorFaulted,
        thermocoupleFaultReason:   p.thermocoupleFaultReason || '',
        pressureSensorFaultReason: p.pressureSensorFaultReason || '',
    };
}

function parseJson(payload) {
    try { return JSON.parse(payload.toString()); } catch { return null; }
}

function connect(conn) {
    const session = getSession(conn);
    if (session.client || session.connecting || !conn.host) return session;
    session.connecting = true;

    const prefix = conn.prefix || 'gaggiuino';
    const client = mqtt.connect(`mqtt://${conn.host}:${conn.port || 1883}`, {
        username: conn.username || undefined,
        password: conn.password || undefined,
        reconnectPeriod: 3000,
        connectTimeout: 10000,
    });
    session.client = client;

    client.on('connect', () => {
        session.connecting = false;
        session.loggedFirstSensorSnap = false;
        session.loggedFirstSysState = false;
        log(`Gaggiuino MQTT connected (${conn.host}:${conn.port || 1883}, prefix "${prefix}")`);
        // Sensors/system feed the shared live-state cache (the #597/#598
        // seam); status tracks broker-reported availability. shot/profile/
        // active/maintenance/notification are subscribed per #598's scope
        // (MQTT.md's full topic list) but not wired into a new feature this
        // round — receiving and discarding them here is deliberate, not an
        // oversight: wiring shot-sample accumulation, maintenance auto-sync
        // or HA notifications through a second transport is real additional
        // scope beyond substituting the live-state cache, left for a
        // follow-up rather than half-built alongside it.
        client.subscribe([
            `${prefix}/sensors`, `${prefix}/system`, `${prefix}/status`,
            `${prefix}/shot`, `${prefix}/profile/active`, `${prefix}/maintenance`, `${prefix}/notification`,
        ], { qos: 0 }, (err) => {
            if (err) log(`Gaggiuino MQTT subscribe error: ${err.message}`, true);
        });
    });

    client.on('message', (topic, payload) => {
        if (topic === `${prefix}/status`) {
            session.available = payload.toString() === 'online';
            return;
        }
        const data = parseJson(payload);
        if (!data) return;
        if (topic === `${prefix}/sensors`) {
            session.sensorSnap = toSensorSnap(data);
            session.sensorSnapAt = Date.now();
            if (!session.loggedFirstSensorSnap) {
                session.loggedFirstSensorSnap = true;
                log(`Gaggiuino MQTT: first "${topic}" message received — live sensor data flowing`);
            }
            events.emit('sensor-snap', connKeyFor(conn), session.sensorSnap);
        } else if (topic === `${prefix}/system`) {
            session.sysState = toSysState(data);
            session.sysStateAt = Date.now();
            if (!session.loggedFirstSysState) {
                session.loggedFirstSysState = true;
                log(`Gaggiuino MQTT: first "${topic}" message received — live system data flowing`);
            }
            events.emit('sys-state', connKeyFor(conn), session.sysState);
        }
        // shot/profile/active/maintenance/notification: received, not yet consumed — see the subscribe() comment above.
    });

    client.on('error', (e) => { log(`Gaggiuino MQTT error (${conn.host}:${conn.port || 1883}): ${e.message}`, true); });
    client.on('close', () => { session.connecting = false; session.available = false; });

    return session;
}

function freshOrNull(value, at) {
    if (value === null || Date.now() - at > STALE_MS) return null;
    return value;
}

// Both getters lazily (re)open the session's connection as a side effect —
// same contract as gaggiuino-live-client.js's getters. `conn` is
// { host, port, username, password, prefix }, normally read straight from
// MqttSettingsRepository by lib/live-transport.js.
function getLiveSensorSnapshot(conn) {
    const session = connect(conn);
    return freshOrNull(session.sensorSnap, session.sensorSnapAt);
}

function getLiveSystemState(conn) {
    const session = connect(conn);
    return freshOrNull(session.sysState, session.sysStateAt);
}

// Closes and forgets every open session — called after a settings save
// (routes/mqtt.js) so a changed host/port/prefix/credentials takes effect on
// the next read instead of a stale session lingering connected to the old
// broker in the background indefinitely.
function disconnectAll() {
    for (const session of sessions.values()) {
        try { session.client?.end(true); } catch { /* already closing */ }
    }
    sessions.clear();
}

module.exports = { getLiveSensorSnapshot, getLiveSystemState, disconnectAll, connKeyFor, events };
