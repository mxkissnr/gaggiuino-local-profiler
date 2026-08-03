// Gaggiuino adapter (#317) — thin wrapper around the existing REST client
// (axios, mirroring lib/sync.js/lib/poll.js) and the existing protobuf
// WebSocket client (lib/gaggiuino-ws-client.js, kept in place rather than
// moved so the existing test/gaggiuino-ws-client.test.js require path stays
// untouched) so this machine type conforms to the adapter interface
// documented in lib/machines/adapter-base.js.
'use strict';
const axios = require('axios');
const gaggiuinoWs = require('../../gaggiuino-ws-client');
const liveTransport = require('../../live-transport');
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
    const baseUrl = await baseUrlFor(machine);
    // Newer firmware (build 7889b7d+) exposes profile detail as plain REST,
    // same JSON shape the WS path already decodes into (phases with string
    // type/curve enums) — try that first since it's cheaper (one HTTP
    // request vs a WS handshake), and fall back to the WebSocket path for
    // older firmware (404) or any other transient failure, which is the
    // known-working baseline for every firmware version.
    try {
        const r = await axios.get(`${baseUrl}/api/profile/${id}`, { timeout: 5000 });
        return r.data;
    } catch {
        return gaggiuinoWs.getProfileById(baseUrl, parseInt(id));
    }
}

async function createProfile(machine, profile) {
    const baseUrl = await baseUrlFor(machine);
    // Newer firmware (build 7889b7d+) exposes POST /api/profile as REST
    // create — live-verified (#580) against a real machine: the endpoint is
    // create-only (an `id` in the body is silently ignored, always minting a
    // fresh id — duplicate names are accepted too, no conflict check), so
    // this is the REST equivalent of createProfile only; updateProfile and
    // deleteProfile below stay WebSocket-only since there is no verified
    // REST path for either. Mirrors getProfile()'s try-REST-first,
    // fall-back-to-WS pattern: cheaper than a WS handshake on firmware that
    // has it, and the WS path is the known-working baseline for a 404 on
    // older firmware or any other transient failure.
    try {
        const r = await axios.post(`${baseUrl}/api/profile`, profile, { timeout: 5000 });
        return { id: r.data.id, name: r.data.name };
    } catch {
        return gaggiuinoWs.createProfile(baseUrl, profile);
    }
}

// WebSocket-only, unchanged by #580: the machine's only REST profile-write
// endpoint (POST /api/profile) is create-only (see createProfile() above) —
// live-verified there is no REST update/delete equivalent, so these keep
// using the known-working WS path rather than guessing at one.
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

// Newer firmware (build 7889b7d+)'s own descale/backflush "Service Log" —
// a separate accounting system from GLP's own maintenance tracking (see
// lib/maintenance-sync.js), never called getMaintenance to avoid confusion
// with LibraryService.getMaintenance(), which is a wholly different thing.
async function getNativeMaintenanceLog(machine) {
    const baseUrl = await baseUrlFor(machine);
    const r = await axios.get(`${baseUrl}/api/maintenance`, { timeout: 5000 });
    return r.data;
}

// ── Settings/control proxy (#597) ───────────────────────────────────────
// GLP-side plumbing for HA-integration parity with the community
// ALERTua/hass-gaggiuino integration — GLP itself has no settings UI yet
// (that's a later round). category omitted -> GET /api/settings (all
// categories); routes/machine-control.js is the caller that validates
// `category` against GAGGIUINO_SETTINGS_CATEGORIES (+ the read-only
// 'versions') before it ever reaches here.
async function getSettings(machine, category) {
    const baseUrl = await baseUrlFor(machine);
    const path = category ? `/api/settings/${category}` : '/api/settings';
    const r = await axios.get(`${baseUrl}${path}`, { timeout: 5000 });
    return r.data;
}

// REST settings writes auto-persist to flash in one call (see rest-api.md's
// "Persistence" note) — unlike the WS c_upd_settings/c_save_settings split
// below, there is no separate "apply then save" step on this path.
async function updateSettings(machine, category, payload) {
    const baseUrl = await baseUrlFor(machine);
    const r = await axios.post(`${baseUrl}/api/settings/${category}`, payload, { timeout: 5000 });
    return r.data;
}

// c_save_settings over WS — persists whatever's currently applied in RAM
// (e.g. via the machine's own touchscreen/web UI) to flash. Exposed for
// integration parity per #597's scope; GLP's own settings writes go through
// updateSettings() above, which doesn't need this extra step.
async function saveSettings(machine) {
    return gaggiuinoWs.saveSettings(await baseUrlFor(machine));
}

// mode: OperationModeDto enum name/value (see lib/gaggiuino-proto.js) —
// BREW_AUTO/FLUSH/DESCALE/STEAM/FLUSH_AUTO/HOT_WATER/HOME. BREW_MANUAL is
// intentionally not usable through this proxy: live-verified against a real
// machine (#597 research) that entering it while idle is a silent no-op (no
// d_resp, mode unchanged) — a shot can't be remote-started this way, so
// routes/machine-control.js rejects that mode before it reaches here rather
// than let a caller send a command that looks like it worked but didn't.
async function setOperationMode(machine, mode) {
    return gaggiuinoWs.setOperationMode(await baseUrlFor(machine), mode);
}

async function tare(machine) {
    return gaggiuinoWs.tare(await baseUrlFor(machine));
}

// peripheral: ServiceTestPeripheralDto enum name/value — PUMP/VALVE/VALVE_B/LED.
async function serviceTest(machine, peripheral) {
    return gaggiuinoWs.serviceTest(await baseUrlFor(machine), peripheral);
}

// c_save_act_prof over WS — persists the currently active profile + its ID
// to flash (distinct from updateProfile()/createProfile() above, which
// write a *saved* profile slot, not the active-profile pointer).
async function saveActiveProfile(machine) {
    return gaggiuinoWs.saveActiveProfile(await baseUrlFor(machine));
}

async function getFirmwareProgress(machine) {
    const baseUrl = await baseUrlFor(machine);
    const r = await axios.get(`${baseUrl}/api/firmware/progress`, { timeout: 5000 });
    return r.data;
}

async function triggerFirmwareUpdate(machine) {
    const baseUrl = await baseUrlFor(machine);
    const r = await axios.post(`${baseUrl}/api/firmware/update-all`, {}, { timeout: 5000 });
    return r.data;
}

// Synchronous cache reads (no I/O here — see lib/live-transport.js) that
// lazily open/reuse this machine's persistent live-value session, WS or
// MQTT depending on the Settings-page transport toggle (#598 — MQTT only
// ever applies to the default machine, see live-transport.js's header
// comment). Returns null until the first push arrives (or if the cached
// value has gone stale) — callers should treat that the same as "not yet
// known", not an error.
async function getLiveSensorSnapshot(machine) {
    return liveTransport.getLiveSensorSnapshot(await baseUrlFor(machine), machine.isDefault);
}

async function getLiveSystemState(machine) {
    return liveTransport.getLiveSystemState(await baseUrlFor(machine), machine.isDefault);
}

function capabilities() {
    return {
        profileEdit: true, brewStart: false, preheat: true, volumetric: true, history: true,
        nativeMaintenanceLog: true, settingsProxy: true,
    };
}

module.exports = {
    baseUrlFor, getStatus, getLatestShotId, getShot, listProfiles, getProfile,
    createProfile, updateProfile, deleteProfile, selectProfile, capabilities,
    getNativeMaintenanceLog,
    getSettings, updateSettings, saveSettings, setOperationMode, tare, serviceTest,
    saveActiveProfile, getFirmwareProgress, triggerFirmwareUpdate,
    getLiveSensorSnapshot, getLiveSystemState,
};
