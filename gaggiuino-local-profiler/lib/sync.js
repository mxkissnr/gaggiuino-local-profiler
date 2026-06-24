'use strict';
const fs = require('fs');
const axios = require('axios');
const { DATA_FILE } = require('./constants');
const { log, writeFileSafe } = require('./helpers');
const { loadOptions, getMachineUrl, getMachineBaseUrl, getSyncIntervalMs, loadBlocklist } = require('./data');
const state = require('./state');

const SYNC_RETRY_DELAYS = [30_000, 60_000, 120_000];

async function syncAfterBrew() {
    let prevMaxId = 0;
    try {
        const existing = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        prevMaxId = existing.length > 0 ? existing.reduce((m, s) => s.id > m ? s.id : m, 0) : 0;
    } catch (e) {}
    await syncShots();
    try {
        const updated  = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        const newShots = updated.filter(s => s.id > prevMaxId);
        if (newShots.length > 0) log(`New shot saved: #${newShots.map(s => s.id).join(', ')}`);
    } catch (e) {}
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

        let localShots = [];
        if (fs.existsSync(DATA_FILE)) {
            const content = fs.readFileSync(DATA_FILE, 'utf8');
            localShots = content ? JSON.parse(content) : [];
        }

        const blocklist    = loadBlocklist();
        const maxLocalId   = localShots.length > 0 ? localShots.reduce((max, s) => s.id > max ? s.id : max, 0) : 0;
        const maxBlockedId = blocklist.length > 0 ? Math.max(...blocklist) : 0;
        const effectiveMax = Math.max(maxLocalId, maxBlockedId);

        if (effectiveMax >= latestMachineId) {
            log(`Already up to date. Shots: ${localShots.length}`);
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
                const ver = d.softwareVersion || d.firmware || d.buildNumber ||
                            d.buildDate       || d.version  || null;
                if (ver) { state.cachedMachineVersion = String(ver); log(`Gaggiuino firmware (from shot): ${state.cachedMachineVersion}`); }
            }
            if (state.cachedMachineVersion) r.data.glpFirmwareVersion = state.cachedMachineVersion;
            localShots.push(r.data);
        }

        writeFileSafe(DATA_FILE, localShots);
        state.lastSyncTime   = new Date().toISOString();
        state.lastSyncError  = null;
        state.syncRetryCount = 0;
        log(`Sync complete: ${localShots.length} shots stored`);
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
        if (ok) {
            scheduleNextSync(0);
        } else {
            const nextRetry = retryCount + 1;
            scheduleNextSync(nextRetry <= SYNC_RETRY_DELAYS.length ? nextRetry : 0);
        }
    }, delay);
}

async function fetchMachineVersion() {
    if (state.cachedMachineVersion) return;
    const opts      = loadOptions();
    const baseUrl   = getMachineBaseUrl(opts);
    const endpoints = ['/api/system/info', '/api/firmware', '/api/about'];
    for (const path of endpoints) {
        try {
            const res = await axios.get(`${baseUrl}${path}`, { timeout: 3000 });
            const d   = res.data || {};
            const ver = d.version || d.firmware || d.softwareVersion ||
                        d.fw_version || d.buildNumber || d.buildDate || null;
            if (ver) { state.cachedMachineVersion = String(ver); log(`Gaggiuino firmware (${path}): ${state.cachedMachineVersion}`); return; }
        } catch (_) {}
    }
}

module.exports = { syncShots, syncAfterBrew, scheduleNextSync, fetchMachineVersion };
