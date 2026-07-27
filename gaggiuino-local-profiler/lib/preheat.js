'use strict';
const fs = require('fs');
const {
    PREHEAT_STATE_FILE, PREHEAT_STATE_TTL,
    TEMP_STABLE_MIN, TEMP_STABLE_VAR,
} = require('./constants');
const { log, writeFileSafe } = require('./helpers');
const { getHaLanguage, sendHaNotify, callHaService } = require('./ha');
const { loadOptions, loadOrdersSettings } = require('./data');
const { notifyT } = require('./notify-i18n');
const state = require('./state');

function savePreheatState() {
    try {
        writeFileSafe(PREHEAT_STATE_FILE, {
            switchOnAt: state.switchOnAt, switchOffAt: state.switchOffAt,
            readyByTargetAt: state.readyByTargetAt, plannedSwitchOnAt: state.plannedSwitchOnAt,
        });
    } catch { /* ignore */ }
}

function loadPreheatState() {
    try {
        if (!fs.existsSync(PREHEAT_STATE_FILE)) return;
        const s   = JSON.parse(fs.readFileSync(PREHEAT_STATE_FILE, 'utf8'));
        const now = Date.now();
        if (s.switchOnAt  && (now - s.switchOnAt)  < PREHEAT_STATE_TTL) state.switchOnAt  = s.switchOnAt;
        if (s.switchOffAt && (now - s.switchOffAt) < PREHEAT_STATE_TTL) state.switchOffAt = s.switchOffAt;
        if (s.readyByTargetAt && s.plannedSwitchOnAt) {
            state.readyByTargetAt   = s.readyByTargetAt;
            state.plannedSwitchOnAt = s.plannedSwitchOnAt;
        }
        if (state.switchOnAt) log(`Preheat state restored: started ${Math.round((now - state.switchOnAt) / 60000)} min ago`);
    } catch { /* ignore */ }
}

function isTempStable() {
    if (state.tempHistory.length < TEMP_STABLE_MIN) return false;
    const window = state.tempHistory.slice(-TEMP_STABLE_MIN);
    return Math.max(...window) - Math.min(...window) <= TEMP_STABLE_VAR;
}

// Ready-by preheat (#541): a future HA-integration service sets a target
// wall-clock "ready by" time; this computes when the switch needs to go on
// (target minus the same preheat_time config _checkPreheatNotify/the
// GET /api/preheat response already use) so the 30s watcher below can flip
// it automatically, no separate scheduling primitive needed.
function setReadyByTarget(targetAt) {
    if (targetAt == null) {
        state.readyByTargetAt   = null;
        state.plannedSwitchOnAt = null;
    } else {
        const opts      = loadOptions();
        const preheatMs = Math.max(1, parseInt(opts.preheat_time) || 20) * 60 * 1000;
        state.readyByTargetAt   = targetAt;
        state.plannedSwitchOnAt = targetAt - preheatMs;
    }
    savePreheatState();
}

// Shared by GET /api/preheat and POST /api/preheat/ready-by so both return
// the identical shape.
function buildPreheatResponse() {
    const opts        = loadOptions();
    const preheatMins = Math.max(1, parseInt(opts.preheat_time) || 20);
    const preheatMs   = preheatMins * 60 * 1000;
    const machineOff  = !state.machineOn && !!opts.switch_entity;
    const readyBy     = { readyByTargetAt: state.readyByTargetAt, plannedSwitchOnAt: state.plannedSwitchOnAt };
    if (machineOff || !state.switchOnAt) {
        return { ready: false, elapsed: 0, remaining: preheatMins * 60, pct: 0,
                 preheatTime: preheatMins, temp: state.currentTemp, targetTemp: state.currentTargetTemp,
                 ...readyBy };
    }
    const elapsedMs = Date.now() - state.switchOnAt;
    const elapsed   = Math.floor(elapsedMs / 1000);
    const remaining = Math.max(0, Math.ceil((preheatMs - elapsedMs) / 1000));
    const pct       = Math.min(1, elapsedMs / preheatMs);
    const ready     = remaining === 0;
    return { ready, elapsed, remaining, pct, preheatTime: preheatMins,
             stabilityReady: ready && !!state.stabilityReady,
             temp: state.currentTemp, targetTemp: state.currentTargetTemp,
             ...readyBy };
}

let _preheatWatchTimer = null;

async function _checkPreheatNotify() {
    if (!state.machineOn || !state.switchOnAt) return;
    if (state.preheatNotifySent) return;
    const opts      = loadOptions();
    const preheatMs = Math.max(1, parseInt(opts.preheat_time) || 20) * 60 * 1000;
    if (Date.now() - state.switchOnAt < preheatMs) return;
    const svc = loadOrdersSettings().baristaNotifyService;
    if (!svc) return;
    const lang = await getHaLanguage();
    sendHaNotify(svc, notifyT(lang, 'preheat_title'), notifyT(lang, 'preheat_body'), 'glp_preheat_ready');
    // eslint-disable-next-line require-atomic-updates -- theoretical only: this function runs on a 30s interval and its own network calls have 3-5s timeouts, so re-entrant overlap before this flag is set is not realistically reachable
    state.preheatNotifySent = true;
    log('Preheat-ready notification sent to barista');
}

// One-shot: fires the switch on once the planned time is reached, then
// clears the target so it never re-fires — same "turn switch on" HA call as
// POST /api/switch/toggle's turn-on path (callHaService, not a duplicated
// axios call). Cleared regardless of whether the HA call succeeds, so a
// persistently unreachable HA instance doesn't get hammered every tick.
async function _checkReadyByPreheat() {
    if (!state.readyByTargetAt || !state.plannedSwitchOnAt) return;
    if (state.machineOn) return;
    if (Date.now() < state.plannedSwitchOnAt) return;
    const entity = loadOptions().switch_entity;
    if (entity) {
        try {
            await callHaService('switch', 'turn_on', { entity_id: entity });
            log(`Ready-by preheat: switch ${entity} -> turn_on`);
        } catch (e) {
            log(`Ready-by preheat switch-on failed: ${e.message}`, true);
        }
    }
    // eslint-disable-next-line require-atomic-updates -- theoretical only, same reasoning as _checkPreheatNotify's state.preheatNotifySent above: 30s interval, callHaService has a 5s timeout, so re-entrant overlap before this clears is not realistically reachable
    state.readyByTargetAt   = null;
    // eslint-disable-next-line require-atomic-updates -- same as above
    state.plannedSwitchOnAt = null;
    savePreheatState();
}

function startPreheatWatcher() {
    if (_preheatWatchTimer) clearInterval(_preheatWatchTimer);
    _preheatWatchTimer = setInterval(() => {
        _checkPreheatNotify();
        _checkReadyByPreheat();
    }, 30000);
}

module.exports = {
    loadPreheatState, savePreheatState, isTempStable, startPreheatWatcher,
    setReadyByTarget, buildPreheatResponse,
};
