'use strict';
const axios      = require('axios');
const { log }    = require('./helpers');
const { loadOptions, getSyncIntervalMs, debugLog } = require('./data');
const shotService = require('./services/ShotService');
const state      = require('./state');
const { getMachineRuntimeState } = require('./machine-runtime-state');
const registry   = require('./machines/registry');
const { getAdapter, toGlobalShotId, toNativeShotId } = require('./machines');
const { syncNativeMaintenance } = require('./maintenance-sync');

// #549: same single-default-machine assumption as lib/poll.js/lib/preheat.js.
const defaultRuntime = getMachineRuntimeState();

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

async function syncShots(runtime = defaultRuntime) {
    const switchEntity = registry.switchEntityFor();
    // #655: this early return intentionally leaves lastSyncTime/lastSyncError
    // untouched -- lib/poll.js's checkAndApplyMachinePower() now sets
    // state.machineReachable = false as soon as this same switchEntity is
    // seen off, which already drives the status dot to red (its top
    // priority signal, see status.js's updateStatus()) regardless of these
    // two fields. Once the dot is correctly red, an old lastSyncTime next to
    // it ("last synced 3 days ago") is accurate, not misleading -- it really
    // was the last successful sync -- so bumping it to "now" here would
    // make it lie about actually having synced when nothing was fetched.
    if (!runtime.machineOn && switchEntity) return true;
    try {
        const machineUrl = registry.apiUrlFor();
        // #718: null means no host configured anywhere -- nothing to sync,
        // don't request against a placeholder/fallback hostname.
        if (!machineUrl) return true;
        debugLog(`GET ${machineUrl}/latest`); // #714
        const latestResponse  = await axios.get(`${machineUrl}/latest`, { timeout: 10000 });
        // #717: raw response, not just the extracted lastShotId -- lets a
        // genuinely corrupted/absurd value reported by the machine's own
        // firmware be told apart from something produced locally (e.g. a
        // blocklist entry or a second machine's synthetic id ending up on
        // the default machine's rows).
        debugLog(`/latest raw response: ${JSON.stringify(latestResponse.data).slice(0, 500)}`);
        // eslint-disable-next-line require-atomic-updates -- syncShots() has no mutex guarding overlapping calls (pre-existing); a real fix is a synchronization change out of scope for this lint-only pass
        state.machineReachable   = true;
        // eslint-disable-next-line require-atomic-updates -- see above
        state.lastMachineError   = null;
        // eslint-disable-next-line require-atomic-updates -- see above
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
            // eslint-disable-next-line require-atomic-updates -- syncShots() has no mutex guarding overlapping calls (pre-existing); a real fix is a synchronization change out of scope for this lint-only pass
            state.lastSyncTime   = new Date().toISOString();
            // eslint-disable-next-line require-atomic-updates -- see above
            state.lastSyncError  = null;
            // eslint-disable-next-line require-atomic-updates -- see above
            state.syncRetryCount = 0;
            return true;
        }

        for (let i = effectiveMax + 1; i <= latestMachineId; i++) {
            // #716: elapsed time per shot, not just the URL (#714) -- lets a
            // large backfill's per-request latency be checked against shot
            // id afterward, to confirm or rule out the machine's own
            // embedded HTTP server slowing down as shot history grows.
            const shotStartedAt = Date.now();
            let r;
            try {
                r = await axios.get(`${machineUrl}/${i}`, { timeout: 10000 });
                debugLog(`GET ${machineUrl}/${i} -> ${Date.now() - shotStartedAt}ms`);
            } catch (err) {
                // #721: the machine's on-device shot storage rotates/caps
                // independently of the monotonically increasing lastShotId
                // it reports via /latest -- a genuine 404 here means shot i
                // is permanently gone, not a transient failure. Blocklisting
                // it (the same mechanism already used for user-deleted
                // shots, and already factored into effectiveMax above) lets
                // the backfill skip past it instead of restarting at this
                // exact id forever. Any other error (network/timeout/5xx)
                // is NOT skipped -- it's rethrown so the outer catch aborts
                // the whole call and the existing retry/backoff schedule
                // handles it, since a flaky connection is not the same
                // situation as a confirmed-missing shot.
                if (err.response?.status === 404) {
                    log(`Shot ${i} not found on machine (404) -- marking as permanently missing, continuing backfill`, true);
                    const bl = shotService.getBlocklist();
                    if (!bl.includes(i)) shotService.saveBlocklist([...bl, i]);
                    continue;
                }
                // #721: the outer catch's logging redacts the whole URL
                // (including the shot id path segment), making a failing
                // shot id invisible in logs -- log it explicitly here first.
                debugLog(`GET ${machineUrl}/${i} failed after ${Date.now() - shotStartedAt}ms: ${err.message}`);
                throw err;
            }
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

        // eslint-disable-next-line require-atomic-updates -- syncShots() has no mutex guarding overlapping calls (pre-existing); a real fix is a synchronization change out of scope for this lint-only pass
        state.lastSyncTime   = new Date().toISOString();
        // eslint-disable-next-line require-atomic-updates -- see above
        state.lastSyncError  = null;
        // eslint-disable-next-line require-atomic-updates -- see above
        state.syncRetryCount = 0;
        log(`Sync complete: ${maxLocalId + (latestMachineId - effectiveMax)} shots stored`);
        return true;
    } catch (err) {
        state.lastSyncError = err.message.replace(/https?:\/\/\S+/g, '[url]');
        state.lastSyncTime  = new Date().toISOString();
        state.machineReachable = false;
        state.lastMachineError = state.lastSyncError;
        log(`Sync error: ${err.message}`, true);
        // #709: err.message alone (e.g. "Request failed with status code
        // 404") doesn't say which endpoint/shot id 404'd or what the
        // machine actually returned -- debug-gated since it echoes response
        // bodies, which could be large/noisy for normal users.
        if (err.response) {
            const url  = (err.config?.url || '').replace(/https?:\/\/\S+/g, '[url]');
            const body = JSON.stringify(err.response.data).slice(0, 500);
            debugLog(`Sync error detail: ${err.response.status} on ${url} -- body: ${body}`);
        }
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
    const shotStartedAt = Date.now(); // #716
    const shot = await adapter.getShot(machine, nativeId);
    debugLog(`Sync (${machine.name}): fetched shot ${nativeId} from host=${machine.host} -> ${Date.now() - shotStartedAt}ms`);
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
    // #578: native descale/backflush "Service Log" sync, every enabled
    // machine (including the default one) — independent of shot syncing
    // above, so a failure here never affects shot-sync's ok/retry result.
    try { await syncNativeMaintenance(); }
    catch (err) { log(`Native maintenance sync failed: ${err.message}`, true); }
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
    // #641/#648 fixed this pattern everywhere except here -- this call still
    // read options.json's possibly-stale machine_host directly, so a host
    // edited via Settings UI could make backgroundHaCheck() (30s interval)
    // mark a correctly-rehosted machine unreachable.
    const baseUrl   = registry.baseUrlFor();
    if (!baseUrl) return; // #718: no host configured anywhere -- nothing to check
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
