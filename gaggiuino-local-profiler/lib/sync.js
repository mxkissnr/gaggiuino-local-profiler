'use strict';
const axios      = require('axios');
const { log }    = require('./helpers');
const { loadOptions, getMachineUrl, getMachineBaseUrl, getSyncIntervalMs } = require('./data');
const shotService = require('./services/ShotService');
const state      = require('./state');

const SYNC_RETRY_DELAYS = [30_000, 60_000, 120_000];

async function syncAfterBrew() {
    const prevMaxId = shotService.getAll().reduce((m, s) => s.id > m ? s.id : m, 0);
    await syncShots();
    const newShots = shotService.getAll().filter(s => s.id > prevMaxId);
    if (newShots.length) log(`New shot saved: #${newShots.map(s => s.id).join(', ')}`);
}

async function syncShots() {
    const opts = loadOptions();
    if (!state.machineOn && opts.switch_entity) return true;
    const machineUrl = getMachineUrl(opts);
    try {
        const latestResponse  = await axios.get(`${machineUrl}/latest`, { timeout: 10000 });
        const latestMachineId = latestResponse.data?.[0]?.lastShotId;
        if (latestMachineId == null) {
            log('Sync: machine /latest returned no lastShotId — skipped', true);
            return false;
        }

        const blocklist    = shotService.getBlocklist();
        const maxLocalId   = shotService.getAll().reduce((m, s) => s.id > m ? s.id : m, 0);
        const maxBlockedId = blocklist.length ? Math.max(...blocklist.map(Number)) : 0;
        const effectiveMax = Math.max(maxLocalId, maxBlockedId);

        if (effectiveMax >= latestMachineId) {
            log(`Already up to date. Shots: ${maxLocalId}`);
            state.lastSyncTime   = new Date().toISOString();
            state.lastSyncError  = null;
            state.syncRetryCount = 0;
            return true;
        }

        for (let i = effectiveMax + 1; i <= latestMachineId; i++) {
            const r = await axios.get(`${machineUrl}/${i}`, { timeout: 10000 });
            if (!r.data || typeof r.data.id === 'undefined' || !r.data.datapoints) {
                log(`Shot ${i} has invalid data -- skipped`, true);
                continue;
            }
            if (!state.cachedMachineVersion) {
                const d   = r.data;
                const ver = d.softwareVersion || d.firmware || d.buildNumber || d.buildDate || d.version || null;
                if (ver) { state.cachedMachineVersion = String(ver); log(`Gaggiuino firmware (from shot): ${state.cachedMachineVersion}`); }
            }
            if (state.cachedMachineVersion) r.data.glpFirmwareVersion = state.cachedMachineVersion;
            shotService.upsertShot(r.data);
        }

        state.lastSyncTime   = new Date().toISOString();
        state.lastSyncError  = null;
        state.syncRetryCount = 0;
        log(`Sync complete: ${maxLocalId + (latestMachineId - effectiveMax)} shots stored`);
        return true;
    } catch (err) {
        state.lastSyncError = err.message.replace(/https?:\/\/\S+/g, '[url]');
        state.lastSyncTime  = new Date().toISOString();
        log(`Sync error: ${err.message}`, true);
        return false;
    }
}

function scheduleNextSync(retryCount = 0) {
    const opts = loadOptions();
    state.syncRetryCount = retryCount;
    let delay;
    if (retryCount > 0 && retryCount <= SYNC_RETRY_DELAYS.length) {
        delay = SYNC_RETRY_DELAYS[retryCount - 1];
        log(`Sync retry ${retryCount}/${SYNC_RETRY_DELAYS.length} in ${delay / 1000}s`);
    } else {
        delay = getSyncIntervalMs(opts);
        if (retryCount > SYNC_RETRY_DELAYS.length)
            log(`Sync retries exhausted -- resuming regular ${opts.sync_interval || 5} min schedule`);
    }
    setTimeout(async () => {
        const ok = await syncShots();
        scheduleNextSync(ok ? 0 : Math.min(retryCount + 1, SYNC_RETRY_DELAYS.length));
    }, delay);
}

async function fetchMachineVersion() {
    if (state.cachedMachineVersion) return;
    const baseUrl   = getMachineBaseUrl(loadOptions());
    const endpoints = ['/api/system/info', '/api/firmware', '/api/about'];
    for (const path of endpoints) {
        try {
            const res = await axios.get(`${baseUrl}${path}`, { timeout: 3000 });
            const d   = res.data || {};
            const ver = d.version || d.firmware || d.softwareVersion || d.fw_version || d.buildNumber || d.buildDate || null;
            if (ver) { state.cachedMachineVersion = String(ver); log(`Gaggiuino firmware (${path}): ${state.cachedMachineVersion}`); return; }
        } catch (_) {}
    }
}

module.exports = { syncShots, syncAfterBrew, scheduleNextSync, fetchMachineVersion };
