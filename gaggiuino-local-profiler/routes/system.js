const express = require('express');
const axios   = require('axios');
const fs      = require('fs');
const path    = require('path');
const yaml    = require('js-yaml');
const router  = express.Router();

let _openApiSpec = null;
function getOpenApiSpec() {
    if (!_openApiSpec) {
        const raw = fs.readFileSync(path.join(__dirname, '..', 'openapi.yaml'), 'utf8');
        _openApiSpec = yaml.load(raw);
    }
    return _openApiSpec;
}

const { GLP_VERSION, DATA_FILE, HA_API, HA_TOKEN } = require('../lib/constants');
const { loadOptions, getMachineUrl, getMachineBaseUrl, isOrdersEnabled } = require('../lib/data');
const { getSwitchState, callHaService, getHaState } = require('../lib/ha');
const { log } = require('../lib/helpers');
const state = require('../lib/state');

// ── Status ────────────────────────────────────────────────────────────────

router.get('/api/status', (req, res) => {
    const opts          = loadOptions();
    const machineUrl    = getMachineUrl(opts);
    let shotCount = 0, machineHostname = '';
    try {
        const fs = require('fs');
        if (require('fs').existsSync(DATA_FILE))
            shotCount = JSON.parse(require('fs').readFileSync(DATA_FILE, 'utf8')).length;
    } catch (e) {}
    try { machineHostname = new URL(machineUrl).hostname; } catch (e) {}
    res.json({
        shotCount,
        lastSync:       state.lastSyncTime,
        lastSyncError:  state.lastSyncError,
        machineUrl,
        machineHostname,
        machineVersion: state.cachedMachineVersion,
        syncInterval:   opts.sync_interval || 5,
        haConnected:    !!HA_TOKEN,
        switchEntity:   opts.switch_entity || null,
        glpVersion:     GLP_VERSION,
        apiToken:       state.apiToken || null,
        ordersFeature:  isOrdersEnabled(),
    });
});

// ── Manual sync ───────────────────────────────────────────────────────────

router.post('/api/sync', (req, res) => {
    const now = Date.now();
    if (now - state.lastManualSync < 30000)
        return res.status(429).json({ error: 'Bitte 30 Sekunden zwischen manuellen Syncs warten.' });
    state.lastManualSync = now;
    res.json({ ok: true });
    require('../lib/live-sync').syncShots();
});

// ── Machine switch ────────────────────────────────────────────────────────

router.get('/api/switch', async (req, res) => {
    const opts   = loadOptions();
    const entity = opts.switch_entity;
    if (!entity) return res.json({ configured: false });
    const st = await getSwitchState(entity);
    res.json({ configured: true, entity, state: st });
});

router.post('/api/switch/toggle', async (req, res) => {
    const opts   = loadOptions();
    const entity = opts.switch_entity;
    if (!HA_TOKEN || !entity)
        return res.status(400).json({ error: 'switch_entity nicht konfiguriert' });
    try {
        const current = await getSwitchState(entity);
        const action  = current ? 'turn_off' : 'turn_on';
        await callHaService('switch', action, { entity_id: entity });
        res.json({ ok: true, state: !current });
        log(`Switch ${entity} -> ${action}`);
    } catch (e) {
        log(`Switch toggle error: ${e.message}`, true);
        res.status(500).json({ error: e.message });
    }
});

// ── Machine profiles ──────────────────────────────────────────────────────

router.get('/api/machine/profiles', async (req, res) => {
    if (!HA_TOKEN) return res.json({ available: false });
    try {
        const data = await getHaState('select.gaggiuino_profile');
        res.json({ available: true, current: data.state, options: data.attributes.options || [] });
    } catch (e) {
        if (e.response?.status === 404) return res.json({ available: false });
        res.status(500).json({ error: e.message });
    }
});

router.post('/api/machine/profile/set', async (req, res) => {
    const { option } = req.body || {};
    if (!option) return res.status(400).json({ error: 'option required' });
    if (!HA_TOKEN) return res.status(503).json({ error: 'HA token unavailable' });
    try {
        await callHaService('select', 'select_option', { entity_id: 'select.gaggiuino_profile', option });
        res.json({ ok: true });
        log(`Profile switched to: ${option}`);
    } catch (e) {
        log(`Profile set error: ${e.message}`, true);
        res.status(500).json({ error: e.message });
    }
});

// ── Preheat ───────────────────────────────────────────────────────────────

router.get('/api/preheat', (req, res) => {
    const opts        = loadOptions();
    const preheatMins = Math.max(1, parseInt(opts.preheat_time) || 20);
    const preheatMs   = preheatMins * 60 * 1000;
    const machineOff  = !state.machineOn && !!opts.switch_entity;
    if (machineOff || !state.switchOnAt) {
        return res.json({ ready: false, elapsed: 0, remaining: preheatMins * 60, pct: 0,
                          preheatTime: preheatMins, temp: state.currentTemp, targetTemp: state.currentTargetTemp });
    }
    const elapsedMs = Date.now() - state.switchOnAt;
    const elapsed   = Math.floor(elapsedMs / 1000);
    const remaining = Math.max(0, Math.ceil((preheatMs - elapsedMs) / 1000));
    const pct       = Math.min(1, elapsedMs / preheatMs);
    res.json({ ready: remaining === 0, elapsed, remaining, pct, preheatTime: preheatMins,
               temp: state.currentTemp, targetTemp: state.currentTargetTemp });
});

// ── Live data ─────────────────────────────────────────────────────────────

router.get('/api/live/data', (req, res) => {
    res.json({
        isLive:      !!state.liveAccum,
        profileName: state.liveAccum?.profileName || '',
        datapoints:  state.liveAccum ? state.liveAccum.datapoints : null,
        seq:         state.liveSeq,
    });
});

// ── OpenAPI spec ──────────────────────────────────────────────────────────

router.get('/api/openapi.json', (req, res) => {
    try { res.json(getOpenApiSpec()); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Debug ─────────────────────────────────────────────────────────────────

router.get('/api/debug/machine', async (req, res) => {
    const opts    = loadOptions();
    const baseUrl = getMachineBaseUrl(opts);
    try {
        const r = await axios.get(`${baseUrl}/api/system/status`, { timeout: 5000 });
        res.json({ ok: true, baseUrl, data: r.data });
    } catch (e) {
        res.json({ ok: false, baseUrl, error: e.message });
    }
});

module.exports = router;
