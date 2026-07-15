// Gaggiuino adapter (#317) — thin wrapper around the existing REST client
// (axios, mirroring lib/sync.js/lib/poll.js) and the existing protobuf
// WebSocket client (lib/gaggiuino-ws-client.js, kept in place rather than
// moved so the existing test/gaggiuino-ws-client.test.js require path stays
// untouched) so this machine type conforms to the adapter interface
// documented in lib/machines/adapter-base.js.
'use strict';
const axios = require('axios');
const gaggiuinoWs = require('../../gaggiuino-ws-client');
const { ALLOWED_URL_SCHEMES } = require('../../constants');
const { assertMachineHost } = require('../../ssrf-guard');

// Re-validates the host on every request, not just at machine-save time
// (routes/machines.js): the default machine seeded by
// lib/machines/registry.js's ensureDefaultMachine() reads machine_host
// straight from add-on options and bypasses that route's assertMachineHost()
// check entirely, and rows saved before v2.1.1 introduced the check were
// never validated at all. Cheap defense-in-depth since every adapter call is
// already async.
async function baseUrlFor(machine) {
    const raw = (machine.host || '').trim();
    const normalised = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
    const u = new URL(normalised);
    if (!ALLOWED_URL_SCHEMES.includes(u.protocol)) throw new Error(`Invalid URL scheme: ${u.protocol}`);
    await assertMachineHost(u.hostname);
    return `${u.protocol}//${u.host}`;
}

async function getStatus(machine) {
    const baseUrl = await baseUrlFor(machine);
    const r = await axios.get(`${baseUrl}/api/system/status`, { timeout: 3000 });
    const status = Array.isArray(r.data) ? r.data[0] : r.data;
    return {
        reachable:          true,
        temperature:        parseFloat(status.temperature)       || 0,
        targetTemperature:  parseFloat(status.targetTemperature) || 0,
        pressure:           parseFloat(status.pressure)          || 0,
        weight:             parseFloat(status.weight)            || 0,
        brewing:            !!status.brewSwitchState,
        steamOn:            !!status.steamSwitchState,
        profileId:          parseInt(status.profileId) || null,
        profileName:        status.profileName || null,
        raw:                status,
    };
}

async function getLatestShotId(machine) {
    const baseUrl = await baseUrlFor(machine);
    const r = await axios.get(`${baseUrl}/api/shots/latest`, { timeout: 10000 });
    return r.data?.[0]?.lastShotId ?? null;
}

async function getShot(machine, nativeId) {
    const baseUrl = await baseUrlFor(machine);
    const r = await axios.get(`${baseUrl}/api/shots/${nativeId}`, { timeout: 10000 });
    return r.data;
}

async function listProfiles(machine) {
    const baseUrl = await baseUrlFor(machine);
    const r = await axios.get(`${baseUrl}/api/profiles/all`, { timeout: 5000 });
    return Array.isArray(r.data) ? r.data : [];
}

async function getProfile(machine, id) {
    return gaggiuinoWs.getProfileById(await baseUrlFor(machine), parseInt(id));
}

async function createProfile(machine, profile) {
    return gaggiuinoWs.createProfile(await baseUrlFor(machine), profile);
}

async function updateProfile(machine, profile) {
    return gaggiuinoWs.updateProfile(await baseUrlFor(machine), profile);
}

async function deleteProfile(machine, id) {
    return gaggiuinoWs.deleteProfile(await baseUrlFor(machine), parseInt(id));
}

async function selectProfile(machine, id) {
    const baseUrl = await baseUrlFor(machine);
    await axios.post(`${baseUrl}/api/profile-select/${id}`, {}, { timeout: 5000 });
    return { ok: true };
}

function capabilities() {
    return { profileEdit: true, brewStart: false, preheat: true, volumetric: true, history: true };
}

module.exports = {
    baseUrlFor, getStatus, getLatestShotId, getShot, listProfiles, getProfile,
    createProfile, updateProfile, deleteProfile, selectProfile, capabilities,
};
