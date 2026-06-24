'use strict';
const fs = require('fs');
const {
    PREHEAT_STATE_FILE, PREHEAT_STATE_TTL,
    TEMP_STABLE_MIN, TEMP_STABLE_VAR,
} = require('./constants');
const { log, writeFileSafe } = require('./helpers');
const { getHaLanguage, sendHaNotify } = require('./ha');
const { loadOptions, loadOrdersSettings } = require('./data');
const { notifyT } = require('./notify-i18n');
const state = require('./state');

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
    const window = state.tempHistory.slice(-TEMP_STABLE_MIN);
    return Math.max(...window) - Math.min(...window) <= TEMP_STABLE_VAR;
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
    state.preheatNotifySent = true;
    log('Preheat-ready notification sent to barista');
}

function startPreheatWatcher() {
    if (_preheatWatchTimer) clearInterval(_preheatWatchTimer);
    _preheatWatchTimer = setInterval(_checkPreheatNotify, 30000);
}

module.exports = { loadPreheatState, savePreheatState, isTempStable, startPreheatWatcher };
