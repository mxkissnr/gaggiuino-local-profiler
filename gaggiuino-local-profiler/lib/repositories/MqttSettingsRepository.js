// #598: persisted Settings-page state for the WebSocket/MQTT live-data
// transport toggle — same kv-table pattern as ImportSettingsRepository.
// `transport` gates lib/live-transport.js's dispatch; host/port/username/
// password/prefix are the broker connection details, either pre-filled from
// Supervisor auto-discovery (lib/mqtt-discovery.js) or entered manually when
// no MQTT service is registered.
'use strict';
const { getDb } = require('../db');

const DEFAULTS = {
    transport: 'websocket', // 'websocket' | 'mqtt'
    host: '', port: 1883, username: '', password: '', prefix: 'gaggiuino',
};

class MqttSettingsRepository {
    getSettings() {
        const db  = getDb();
        const row = db.prepare("SELECT value FROM kv WHERE key = 'mqtt_settings'").get();
        if (!row) return { ...DEFAULTS };
        try {
            const saved = JSON.parse(row.value);
            return { ...DEFAULTS, ...saved };
        } catch { return { ...DEFAULTS }; }
    }

    saveSettings(settings) {
        const merged = { ...this.getSettings(), ...settings };
        getDb().prepare("INSERT OR REPLACE INTO kv (key, value) VALUES ('mqtt_settings', ?)").run(JSON.stringify(merged));
        return merged;
    }
}

module.exports = new MqttSettingsRepository();
