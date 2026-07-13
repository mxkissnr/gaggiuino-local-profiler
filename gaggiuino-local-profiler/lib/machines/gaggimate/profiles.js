// GaggiMate profile CRUD over its JSON WebSocket (#318) —
// req:profiles:list/load/save/delete/select. Profiles stay in GaggiMate's
// own JSON shape; converting into GLP's editor format is a stretch goal for
// a later release (v1 exposes GaggiMate profiles read-only — see
// capabilities() in adapter.js), so these functions are thin pass-throughs.
'use strict';
const { request } = require('./ws-client');

async function listProfiles(baseUrl) {
    const res = await request(baseUrl, 'req:profiles:list');
    return Array.isArray(res.profiles) ? res.profiles : [];
}

async function loadProfile(baseUrl, id) {
    const res = await request(baseUrl, 'req:profiles:load', { id });
    return res.profile ?? res;
}

async function saveProfile(baseUrl, profile) {
    const res = await request(baseUrl, 'req:profiles:save', { profile });
    return res.profile ?? res;
}

async function deleteProfile(baseUrl, id) {
    return request(baseUrl, 'req:profiles:delete', { id });
}

async function selectProfile(baseUrl, id) {
    return request(baseUrl, 'req:profiles:select', { id });
}

module.exports = { listProfiles, loadProfile, saveProfile, deleteProfile, selectProfile };
