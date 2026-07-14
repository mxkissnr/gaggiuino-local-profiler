'use strict';
const axios      = require('axios');
const { log }    = require('./helpers');
const { loadOptions, getMachineUrl, getMachineBaseUrl, getSyncIntervalMs } = require('./data');
const shotService = require('./services/ShotService');
const state      = require('./state');
const registry   = require('./machines/registry');
const { getAdapter, toGlobalShotId, toNativeShotId } = require('./machines');

const SYNC_RETRY_DELAYS = [30_000, 60_000, 120_000];

// #341: scoped to machine 1 (the default/legacy machine) explicitly. Once a
// second machine has synced shots of its own, shotService.getAll() with no
// argument returns every machine's shots mixed together (by design, for the
// all-machines shots list view) — those other machines' synthetic ids
// (10,000,000+, see lib/machines/index.js) are far larger than any real
// Gaggiuino native id, so an unscoped max-id reduce would make the default
// machine's sync think it's already "caught up" and silently stop pulling
// its own new shots. Must stay scoped to avoid that regression.
async function syncAfterBrew() {
    const prevMaxId = shotService.getAll(1).reduce((m, s) => s.id > m ? s.id : m, 0);
    await syncShots();
    const newShots = shotService.getAll(1).filter(s => s.id > prevMaxId);
    if (newShots.length) log(`New shot saved: #${newShots.map(s => s.id).join(', ')}`);
}

async function syncShots() {
    const opts = loadOptions();
    if (!state.machineOn && opts.switch_entity) return true;
    const machineUrl = getMachineUrl(opts);
    try {
        const latestResponse  = await axios.get(`${machineUrl}/latest`, { timeout: 10000 });
        state.machineReachable   = true;
        state.lastMachineError   = null;
        state.lastMachineSuccess = Date.now();
        const latestMachineId = latestResponse.data?.[0]?.lastShotId;
        if (latestMachineId == null) {
            log('Sync: machine /latest returned no lastShotId — skipped', true);
            return false;
        }

        const blocklist    = shotService.getBlocklist();
        const maxLocalId   = shotService.getAll(1).reduce((m, s) => s.id > m ? s.id : m, 0);
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
        state.machineReachable = false;
        state.lastMachineError = state.lastSyncError;
        log(`Sync error: ${err.message}`, true);
        return false;
    }
}

// #341: syncs one non-default registered machine (adapter-driven, not the
// legacy opts.machine_host path syncShots() uses for machine #1) up from
// its own last-synced native shot id to its current latest. Shots are
// persisted under a synthetic global id (lib/machines/index.js's
// toGlobalShotId) so they can never collide with the default machine's
// native ids or another additional machine's shots in the shared `shots`
// table.
async function syncMachineShot(machine, nativeId, adapter) {
    const shot = await adapter.getShot(machine, nativeId);
    if (!shot || !shot.datapoints) {
        log(`Sync (${machine.name}): shot ${nativeId} has invalid data -- skipped`, true);
        return;
    }
    shot.id = toGlobalShotId(machine.id, nativeId);
    shot.machineId = machine.id;
    shotService.upsertShot(shot);
}

async function syncMachineShots(machine) {
    const adapter = getAdapter(machine);
    try {
        const latestNativeId = await adapter.getLatestShotId(machine);
        if (latestNativeId == null) return true;

        const lastGlobalId = shotService.getLatestId(machine.id);
        const lastNativeId = lastGlobalId != null ? toNativeShotId(machine.id, lastGlobalId) : 0;

        if (lastNativeId >= latestNativeId) return true;

        for (let i = lastNativeId + 1; i <= latestNativeId; i++) {
            await syncMachineShot(machine, i, adapter);
        }
        log(`Sync (${machine.name}): up to shot ${latestNativeId}`);
        return true;
    } catch (err) {
        log(`Sync error (${machine.name}): ${err.message}`, true);
        return false;
    }
}

// Additive on top of syncShots() (#341): loops over every OTHER enabled
// registered machine (the default machine keeps using its own proven
// syncShots() path above, untouched) and ingests their shots via the
// adapter/registry pattern routes/system.js's resolveMachine()/getAdapter()
// already established. One machine's failure doesn't stop the others.
async function syncOtherMachines() {
    const machines = registry.listMachines().filter(m => m.enabled && !m.isDefault);
    let allOk = true;
    for (const machine of machines) {
        const ok = await syncMachineShots(machine);
        if (!ok) allOk = false;
    }
    return allOk;
}

// Entry point used by the scheduler/manual-sync route: syncs the default
// machine exactly as before, then all other registered machines. The
// default machine's retry-count/backoff behavior is driven solely by its
// own result, unaffected by other machines' outcomes.
async function syncAllMachines() {
    const ok = await syncShots();
    try { await syncOtherMachines(); }
    catch (err) { log(`Multi-machine sync failed: ${err.message}`, true); }
    return ok;
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
        const ok = await syncAllMachines();
        scheduleNextSync(ok ? 0 : Math.min(retryCount + 1, SYNC_RETRY_DELAYS.length));
    }, delay);
}

async function fetchMachineVersion() {
    if (state.cachedMachineVersion) return;
    const baseUrl   = getMachineBaseUrl(loadOptions());
    const endpoints = ['/api/system/info', '/api/firmware', '/api/about'];
    let lastErr = null, anySuccess = false;
    for (const path of endpoints) {
        try {
            const res = await axios.get(`${baseUrl}${path}`, { timeout: 3000 });
            anySuccess = true;
            state.machineReachable   = true;
            state.lastMachineError   = null;
            state.lastMachineSuccess = Date.now();
            const d   = res.data || {};
            const ver = d.version || d.firmware || d.softwareVersion || d.fw_version || d.buildNumber || d.buildDate || null;
            if (ver) { state.cachedMachineVersion = String(ver); log(`Gaggiuino firmware (${path}): ${state.cachedMachineVersion}`); return; }
        } catch (e) { lastErr = e; }
    }
    if (lastErr && !anySuccess) {
        state.machineReachable = false;
        state.lastMachineError = lastErr.message.replace(/https?:\/\/\S+/g, '[url]');
    }
}

module.exports = {
    syncShots, syncAfterBrew, scheduleNextSync, fetchMachineVersion,
    syncOtherMachines, syncMachineShots, syncAllMachines,
};
