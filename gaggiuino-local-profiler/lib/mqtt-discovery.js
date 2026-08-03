// #598: Supervisor MQTT service auto-discovery — same
// HA_TOKEN/SUPERVISOR_API-bearer-auth pattern lib/ha.js already uses against
// the Core API, pointed at the Supervisor's own /services/mqtt endpoint
// instead (see lib/constants.js's SUPERVISOR_API comment for why that's a
// different root than HA_API). Requires `services: [mqtt:want]` in
// config.yaml, which is what makes the Supervisor populate this endpoint
// with the broker Home Assistant's own MQTT integration is configured
// against (e.g. the Mosquitto broker add-on) — installs with no MQTT
// service registered at all get a 4xx here, treated the same as "not
// available" rather than an error, since manual entry is always a valid
// fallback (see public-src/components/mqtt-settings.js).
'use strict';
const axios = require('axios');
const { SUPERVISOR_API, HA_TOKEN } = require('./constants');
const { log } = require('./helpers');

async function discoverSupervisorMqtt() {
    if (!HA_TOKEN) return null;
    try {
        const r = await axios.get(`${SUPERVISOR_API}/services/mqtt`,
            { headers: { Authorization: `Bearer ${HA_TOKEN}` }, timeout: 3000 });
        const d = r.data?.data;
        if (!d || !d.host) return null;
        return {
            host:     d.host,
            port:     d.port || 1883,
            username: d.username || '',
            password: d.password || '',
        };
    } catch (e) {
        log(`Supervisor MQTT discovery unavailable: ${e.message}`);
        return null;
    }
}

module.exports = { discoverSupervisorMqtt };
