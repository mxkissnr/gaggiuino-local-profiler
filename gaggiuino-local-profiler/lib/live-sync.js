const fs    = require('fs');
const axios = require('axios');
const {
    DATA_FILE, PREHEAT_STATE_FILE, HA_API,
    TEMP_HISTORY_MAX, TEMP_STABLE_MIN, TEMP_STABLE_VAR, PREHEAT_STATE_TTL,
    WARM_TEMP_MIN, WARM_OFF_MAX_MS,
} = require('./constants');
const { log, writeFileSafe } = require('./helpers');
const { loadOptions, getMachineUrl, getMachineBaseUrl, getSyncIntervalMs, loadBlocklist } = require('./data');
const { getSwitchState, HA_TOKEN } = require('./ha');
const state = require('./state');

// ── Preheat persistence ───────────────────────────────────────────────────

function savePreheatState() {
    try {
        writeFileSafe(PREHEAT_STATE_FILE, { switchOnAt: state.switchOnAt, switchOffAt: state.switchOffAt });
    } catch (e) {}
}

function loadPreheatState() {
    try {
        if (!fs.existsSync(PREHEAT_STATE_FILE)) return;
        const s   = JSON.parse(fs.readFileSync(PREHEAT_STATE_FILE, 'utf8'));
        const now = Date.now();
        if (s.switchOnAt  && (now - s.switchOnAt)  < PREHEAT_STATE_TTL) state.switchOnAt  = s.switchOnAt;
        if (s.switchOffAt && (now - s.switchOffAt) < PREHEAT_STATE_TTL) state.switchOffAt = s.switchOffAt;
        if (state.switchOnAt) log(`Preheat state restored: started ${Math.round((now - state.switchOnAt) / 60000)} min ago`);
    } catch (e) {}
}

function isTempStable() {
    if (state.tempHistory.length < TEMP_STABLE_MIN) return false;
    const mean     = state.tempHistory.reduce((a, b) => a + b, 0) / state.tempHistory.length;
    const variance = state.tempHistory.reduce((sum, t) => sum + (t - mean) ** 2, 0) / state.tempHistory.length;
    return variance < TEMP_STABLE_VAR;
}

// ── Live polling ──────────────────────────────────────────────────────────

function startLivePolling() {
    if (state.livePollTimer) return;
    const offMs     = state.switchOffAt ? Date.now() - state.switchOffAt : Infinity;
    const stillWarm = state.currentTemp !== null && state.currentTemp > WARM_TEMP_MIN && offMs < WARM_OFF_MAX_MS;
    if (!state.switchOnAt || !stillWarm) { state.switchOnAt = Date.now(); savePreheatState(); }
    state.tempHistory = [];
    log('Live polling started via /api/system/status');
    state.livePollTimer = setInterval(pollLive, 1000);
}

function stopLivePolling() {
    if (!state.livePollTimer) return;
    clearInterval(state.livePollTimer);
    state.livePollTimer = null;
    state.liveAccum     = null;
    state.switchOffAt   = Date.now();
    state.tempHistory   = [];
    savePreheatState();
    log('Live polling stopped');
}

async function pollLive() {
    if (state.isPollRunning) return;
    state.isPollRunning = true;
    try { await pollViaGaggiuinoStatus(); }
    finally { state.isPollRunning = false; }
}

async function pollViaGaggiuinoStatus() {
    const opts    = loadOptions();
    const baseUrl = getMachineBaseUrl(opts);
    try {
        const statusRes = await axios.get(`${baseUrl}/api/system/status`, { timeout: 3000 });
        const raw       = statusRes.data;
        const status    = Array.isArray(raw) ? raw[0] : raw;

        const isBrewing = !!status.brewSwitchState;
        const presVal   = parseFloat(status.pressure)          || 0;
        const tempVal   = parseFloat(status.temperature)       || 0;
        state.currentTemp = tempVal || state.currentTemp;
        const weightVal = parseFloat(status.weight)            || 0;
        const tTempVal  = parseFloat(status.targetTemperature) || 0;
        state.currentTargetTemp = tTempVal || state.currentTargetTemp;
        const profile   = status.profileName || 'Unknown';

        if (tempVal > 0 && !isBrewing) {
            state.tempHistory.push(tempVal);
            if (state.tempHistory.length > TEMP_HISTORY_MAX) state.tempHistory.shift();
            if (state.switchOnAt && tTempVal > 0 && tempVal >= tTempVal - 2 && isTempStable()) {
                const preheatMs = (Math.max(1, parseInt(opts.preheat_time) || 20)) * 60 * 1000;
                if (Date.now() - state.switchOnAt < preheatMs) {
                    state.switchOnAt = Date.now() - preheatMs;
                    savePreheatState();
                    log('Temperature stable -- preheat marked complete');
                }
            }
        } else if (isBrewing) {
            state.tempHistory = [];
        }

        if (isBrewing && !state.liveAccum) {
            state.liveAccum = {
                startTime:   Date.now(),
                profileName: profile,
                prevWeight:  weightVal,
                datapoints: {
                    timeInShot: [], pressure: [], temperature: [],
                    shotWeight: [], weightFlow: [], pumpFlow: [], targetTemperature: []
                }
            };
            log(`Brew started: profile ${profile}`);
        }

        if (!isBrewing && state.liveAccum) {
            log('Brew finished');
            state.liveAccum = null;
            state.liveSeq++;
            setTimeout(syncAfterBrew, 3000);
        }

        if (isBrewing && state.liveAccum) {
            const elapsed    = Math.round((Date.now() - state.liveAccum.startTime) / 100);
            const weightFlow = Math.max(0, weightVal - state.liveAccum.prevWeight);
            state.liveAccum.prevWeight = weightVal;
            state.liveAccum.datapoints.timeInShot.push(elapsed);
            state.liveAccum.datapoints.pressure.push(Math.round(presVal * 10));
            state.liveAccum.datapoints.temperature.push(Math.round(tempVal * 10));
            state.liveAccum.datapoints.shotWeight.push(Math.round(weightVal * 10));
            state.liveAccum.datapoints.weightFlow.push(Math.round(weightFlow * 10));
            state.liveAccum.datapoints.pumpFlow.push(0);
            state.liveAccum.datapoints.targetTemperature.push(Math.round(tTempVal * 10));
        }
    } catch (err) {
        log(`Live poll error: ${err.message}`, true);
    }
}

// ── Sync ──────────────────────────────────────────────────────────────────

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
    if (!state.machineOn && opts.switch_entity) return;
    const machineUrl = getMachineUrl(opts);
    try {
        const latestResponse  = await axios.get(`${machineUrl}/latest`, { timeout: 10000 });
        const latestMachineId = latestResponse.data[0].lastShotId;

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
            state.lastSyncTime  = new Date().toISOString();
            state.lastSyncError = null;
            return;
        }

        for (let i = effectiveMax + 1; i <= latestMachineId; i++) {
            const r = await axios.get(`${machineUrl}/${i}`, { timeout: 10000 });
            if (!r.data || typeof r.data.id === 'undefined' || !r.data.datapoints) {
                log(`Shot ${i} has invalid data -- skipped`, true);
                continue;
            }
            if (state.cachedMachineVersion) r.data.glpFirmwareVersion = state.cachedMachineVersion;
            localShots.push(r.data);
        }

        writeFileSafe(DATA_FILE, localShots);
        state.lastSyncTime  = new Date().toISOString();
        state.lastSyncError = null;
        log(`Sync complete: ${localShots.length} shots stored`);
    } catch (err) {
        state.lastSyncError = err.message.replace(/https?:\/\/\S+/g, '[url]');
        state.lastSyncTime  = new Date().toISOString();
        log(`Sync error: ${err.message}`, true);
    }
}

function scheduleNextSync() {
    const opts = loadOptions();
    setTimeout(async () => { await syncShots(); scheduleNextSync(); }, getSyncIntervalMs(opts));
}

async function fetchMachineVersion() {
    if (state.cachedMachineVersion) return;
    const opts    = loadOptions();
    const baseUrl = getMachineBaseUrl(opts);
    try {
        const res = await axios.get(`${baseUrl}/api/system/info`, { timeout: 3000 });
        const ver = (res.data || {}).version || (res.data || {}).firmware ||
                    (res.data || {}).softwareVersion || (res.data || {}).fw_version || null;
        if (ver) { state.cachedMachineVersion = String(ver); log(`Gaggiuino firmware: ${state.cachedMachineVersion}`); }
    } catch (_) {}
}

async function checkAndApplyMachinePower() {
    const opts   = loadOptions();
    const entity = opts.switch_entity;
    if (!entity || !HA_TOKEN) {
        if (!state.livePollTimer) startLivePolling();
        return;
    }
    const isOn = await getSwitchState(entity);
    if (isOn === null) return;
    if (isOn === state.machineOn) return;
    state.machineOn = isOn;
    if (isOn) {
        log('Machine on -- live polling and sync resumed');
        startLivePolling();
        setTimeout(syncShots, 2000);
    } else {
        log('Machine off -- live polling and sync paused');
        stopLivePolling();
    }
}

async function backgroundHaCheck() {
    if (!HA_TOKEN) return;
    await checkAndApplyMachinePower();
    if (!state.cachedMachineVersion) fetchMachineVersion();
    try {
        const res    = await axios.get(`${HA_API}/states/sensor.gaggiuino_latest_shot_id`,
            { headers: { Authorization: `Bearer ${HA_TOKEN}` }, timeout: 3000 });
        const shotId = parseInt(res.data.state) || 0;
        if (shotId > state.lastKnownShotId && state.lastKnownShotId > 0) {
            log(`New shot ID detected: ${shotId} -- auto-sync`);
            setTimeout(syncShots, 2000);
        }
        state.lastKnownShotId = shotId;
    } catch (e) {}
}

module.exports = {
    loadPreheatState, savePreheatState, isTempStable,
    startLivePolling, stopLivePolling, pollLive,
    syncShots, syncAfterBrew, scheduleNextSync,
    fetchMachineVersion, checkAndApplyMachinePower, backgroundHaCheck,
};
