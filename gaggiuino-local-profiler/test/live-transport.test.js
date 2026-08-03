// lib/live-transport.js (#598) — the WS-vs-MQTT dispatch seam. Unit-tested
// against spied-on WS/MQTT client modules and settings repo (same
// vi.spyOn-on-a-required-CJS-module pattern as test/gaggiuino-adapter.test.js) —
// the two underlying modules each have their own real-broker/real-server
// integration coverage already (test/gaggiuino-live-client.test.js,
// test/gaggiuino-mqtt-client.test.js), so this file is only about the
// dispatch decision itself: which transport a given read goes to, and the
// default-machine-only MQTT eligibility gate.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';

const req = createRequire(import.meta.url);

describe('live-transport', () => {
    let liveTransport, gaggiuinoLive, gaggiuinoMqtt, mqttSettingsRepo;

    beforeEach(() => {
        vi.restoreAllMocks();
        liveTransport    = req('../lib/live-transport');
        gaggiuinoLive     = req('../lib/gaggiuino-live-client');
        gaggiuinoMqtt     = req('../lib/gaggiuino-mqtt-client');
        mqttSettingsRepo  = req('../lib/repositories/MqttSettingsRepository');

        vi.spyOn(gaggiuinoLive, 'getLiveSensorSnapshot').mockReturnValue({ source: 'ws-sensor' });
        vi.spyOn(gaggiuinoLive, 'getLiveSystemState').mockReturnValue({ source: 'ws-sys' });
        vi.spyOn(gaggiuinoMqtt, 'getLiveSensorSnapshot').mockReturnValue({ source: 'mqtt-sensor' });
        vi.spyOn(gaggiuinoMqtt, 'getLiveSystemState').mockReturnValue({ source: 'mqtt-sys' });
    });

    it('defaults to WS when the transport setting is "websocket"', () => {
        vi.spyOn(mqttSettingsRepo, 'getSettings').mockReturnValue({ transport: 'websocket', host: '' });
        expect(liveTransport.getLiveSensorSnapshot('http://machine')).toEqual({ source: 'ws-sensor' });
        expect(gaggiuinoLive.getLiveSensorSnapshot).toHaveBeenCalledWith('http://machine');
        expect(gaggiuinoMqtt.getLiveSensorSnapshot).not.toHaveBeenCalled();
    });

    it('routes to MQTT for the default machine when transport is "mqtt" and a host is configured', () => {
        const settings = { transport: 'mqtt', host: '192.168.1.50', port: 1883, prefix: 'gaggiuino' };
        vi.spyOn(mqttSettingsRepo, 'getSettings').mockReturnValue(settings);
        expect(liveTransport.getLiveSystemState('http://machine', true)).toEqual({ source: 'mqtt-sys' });
        expect(gaggiuinoMqtt.getLiveSystemState).toHaveBeenCalledWith(settings);
        expect(gaggiuinoLive.getLiveSystemState).not.toHaveBeenCalled();
    });

    it('stays on WS for a non-default machine even when transport is "mqtt"', () => {
        vi.spyOn(mqttSettingsRepo, 'getSettings').mockReturnValue({ transport: 'mqtt', host: '192.168.1.50' });
        expect(liveTransport.getLiveSensorSnapshot('http://second-machine', false)).toEqual({ source: 'ws-sensor' });
        expect(gaggiuinoLive.getLiveSensorSnapshot).toHaveBeenCalledWith('http://second-machine');
        expect(gaggiuinoMqtt.getLiveSensorSnapshot).not.toHaveBeenCalled();
    });

    it('falls back to WS when transport is "mqtt" but no host is configured yet', () => {
        vi.spyOn(mqttSettingsRepo, 'getSettings').mockReturnValue({ transport: 'mqtt', host: '' });
        expect(liveTransport.getLiveSensorSnapshot('http://machine')).toEqual({ source: 'ws-sensor' });
    });
});
