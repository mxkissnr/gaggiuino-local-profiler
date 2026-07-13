// GaggiMate adapter (#318) — conforms to the interface documented in
// lib/machines/adapter-base.js. Experimental in v2.0.0: no real device was
// available to test against, so this is built strictly from the protocol
// description (see ws-client.js/history.js headers) with defensive
// fallbacks. Live status and shot-history sync are supported; profile
// editing is exposed read-only (capabilities().profileEdit === false) even
// though the underlying req:profiles:save/delete calls exist, since a
// GLP-side editor for GaggiMate's own profile JSON shape is a stretch goal
// for a later release (plan decision #7). GaggiMate has no brew start/stop
// command at all, on any client.
'use strict';
const axios = require('axios');
const wsClient = require('./ws-client');
const profiles = require('./profiles');
const history = require('./history');
const { ALLOWED_URL_SCHEMES } = require('../../constants');

function baseUrlFor(machine) {
    const raw = (machine.host || '').trim();
    const normalised = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
    const u = new URL(normalised);
    if (!ALLOWED_URL_SCHEMES.includes(u.protocol)) throw new Error(`Invalid URL scheme: ${u.protocol}`);
    return `${u.protocol}//${u.host}`;
}

// evt:status's `m` (mode) field's exact enum isn't documented anywhere
// public — best-effort until verified against real hardware: mode 1 is
// treated as "brewing", everything else as not brewing. Consumers should
// treat `brewing` as advisory, not authoritative, for GaggiMate machines.
const BREWING_MODE = 1;

async function getStatus(machine) {
    const baseUrl = baseUrlFor(machine);
    const evt = await wsClient.waitForStatus(baseUrl, 5000);
    return {
        reachable:         true,
        temperature:       evt.ct ?? 0,
        targetTemperature: evt.tt ?? 0,
        pressure:          evt.pr ?? 0,
        weight:            null, // evt:status carries no weight field
        brewing:           evt.m === BREWING_MODE,
        steamOn:           null,
        profileId:         null,
        profileName:       evt.p ?? null,
        raw:               evt,
    };
}

async function getLatestShotId(machine) {
    const baseUrl = baseUrlFor(machine);
    const r = await axios.get(`${baseUrl}/api/history/index.bin`, { responseType: 'arraybuffer', timeout: 10000 });
    const idx = history.parseIndexBin(Buffer.from(r.data));
    if (!idx.entries.length) return null;
    return idx.entries.reduce((max, e) => (e.id > max ? e.id : max), 0);
}

async function getShot(machine, nativeId) {
    const baseUrl = baseUrlFor(machine);
    const r = await axios.get(`${baseUrl}/api/history/${nativeId}.slog`, { responseType: 'arraybuffer', timeout: 10000 });
    const slog = history.parseSlog(Buffer.from(r.data));
    return history.toGlpShot(slog, nativeId);
}

async function listProfiles(machine) {
    return profiles.listProfiles(baseUrlFor(machine));
}

async function getProfile(machine, id) {
    return profiles.loadProfile(baseUrlFor(machine), id);
}

async function createProfile(machine, profile) {
    return profiles.saveProfile(baseUrlFor(machine), profile);
}

async function updateProfile(machine, profile) {
    return profiles.saveProfile(baseUrlFor(machine), profile);
}

async function deleteProfile(machine, id) {
    return profiles.deleteProfile(baseUrlFor(machine), id);
}

async function selectProfile(machine, id) {
    return profiles.selectProfile(baseUrlFor(machine), id);
}

function capabilities() {
    return {
        profileEdit: false, // protocol supports it (req:profiles:save/delete); UI-gated off in v1, see header comment
        brewStart:   false, // GaggiMate has no start/stop API at all
        preheat:     null,  // not modeled yet — unknown until verified against hardware
        volumetric:  null,  // determined per-shot from slog systemInfo.volumetricCapable, not a static capability
        history:     true,
    };
}

module.exports = {
    baseUrlFor, getStatus, getLatestShotId, getShot, listProfiles, getProfile,
    createProfile, updateProfile, deleteProfile, selectProfile, capabilities,
};
