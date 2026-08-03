// #598: MQTT live-data transport settings — Supervisor auto-discovery,
// save/read the Settings-page toggle + connection details, and an optional
// one-click "apply to machine" that points the Gaggiuino's own MQTT client
// (system.mqtt* settings, proxied by #597's routes/machine-control.js) at
// the same broker, so the user never has to copy host/port/user/pass
// between two places by hand.
'use strict';
const express = require('express');
const router  = express.Router();

const { getAdapter } = require('../lib/machines');
const registry = require('../lib/machines/registry');
const { log } = require('../lib/helpers');
const { discoverSupervisorMqtt } = require('../lib/mqtt-discovery');
const mqttSettingsRepo = require('../lib/repositories/MqttSettingsRepository');
const gaggiuinoMqtt = require('../lib/gaggiuino-mqtt-client');
const { mqttSettingsSchema } = require('../lib/validation/schemas');

router.get('/api/mqtt/discovery', async (req, res) => {
    const broker = await discoverSupervisorMqtt();
    res.json(broker ? { available: true, ...broker } : { available: false });
});

router.get('/api/mqtt/settings', (req, res) => {
    res.json(mqttSettingsRepo.getSettings());
});

router.post('/api/mqtt/settings', (req, res) => {
    const parsed = mqttSettingsSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid MQTT settings', details: parsed.error.issues });
    const saved = mqttSettingsRepo.saveSettings(parsed.data);
    // Drop any already-open session(s) so a changed host/port/prefix/
    // credentials takes effect on the very next read instead of a stale
    // connection lingering against the old broker (mirrors the machine's
    // own MQTT client behaviour per MQTT.md: "editing any of the fields...
    // causes Gaggiuino to disconnect and reconnect automatically").
    gaggiuinoMqtt.disconnectAll();
    log('MQTT live-data transport settings updated');
    res.json(saved);
});

router.post('/api/mqtt/apply-to-machine', async (req, res) => {
    registry.ensureDefaultMachine();
    const machine = registry.getDefaultMachine();
    const adapter = getAdapter(machine);
    if (!adapter.capabilities().settingsProxy) {
        return res.status(501).json({ error: 'not supported', reason: `${machine.type} machines do not support the settings/control proxy` });
    }
    const mqttSettings = mqttSettingsRepo.getSettings();
    if (!mqttSettings.host) return res.status(400).json({ error: 'no MQTT broker configured yet' });
    try {
        // POST /api/settings/system expects the full settings object back
        // (rest-api.md: "All fields from GET response should be included in
        // the request body"), so this must merge onto a fresh GET rather
        // than send a partial mqtt*-only payload.
        const current = await adapter.getSettings(machine, 'system');
        const merged = {
            ...current,
            mqttEnabled:     true,
            mqttHost:        mqttSettings.host,
            mqttPort:        mqttSettings.port,
            mqttUsername:    mqttSettings.username,
            mqttPassword:    mqttSettings.password,
            mqttTopicPrefix: mqttSettings.prefix,
        };
        const result = await adapter.updateSettings(machine, 'system', merged);
        log(`Applied broker connection to machine #${machine.id} "${machine.name}"'s own MQTT client settings`);
        res.json(result);
    } catch (e) {
        log(`Applying MQTT settings to machine failed: ${e.message}`, true);
        res.status(502).json({ error: e.message });
    }
});

module.exports = router;
