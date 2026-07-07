const express = require('express');
const axios   = require('axios');
const fs      = require('fs');
const path    = require('path');
const yaml    = require('js-yaml');
const router  = express.Router();

let _openApiSpec = null;
function getOpenApiSpec() {
    if (!_openApiSpec) {
        try {
            const raw = fs.readFileSync(path.join(__dirname, '..', 'openapi.yaml'), 'utf8');
            _openApiSpec = yaml.load(raw);
        } catch (_) {
            return {};
        }
    }
    return _openApiSpec;
}

const { GLP_VERSION, HA_API, HA_TOKEN, PROFILES_CACHE_FILE } = require('../lib/constants');
const shotRepo = require('../lib/repositories/ShotRepository');
const { loadOptions, getMachineUrl, getMachineBaseUrl, isOrdersEnabled, loadMenu } = require('../lib/data');
const { getSwitchState, callHaService } = require('../lib/ha');
const { log, rateLimit, isSupervisorIp } = require('../lib/helpers');
const state = require('../lib/state');
const demoService = require('../lib/services/DemoService');

// ── Profile cache helpers ─────────────────────────────────────────────────

function loadProfilesCache() {
    try {
        if (fs.existsSync(PROFILES_CACHE_FILE))
            return JSON.parse(fs.readFileSync(PROFILES_CACHE_FILE, 'utf8'));
    } catch (_) {}
    return [];
}

function saveProfilesCache(profiles) {
    try { fs.writeFileSync(PROFILES_CACHE_FILE, JSON.stringify(profiles)); } catch (_) {}
}

// Pre-load cache into state on startup so the profile select is immediately available
(function initProfilesCache() {
    const cached = loadProfilesCache();
    if (cached.length) {
        state.machineProfiles = cached;
        log(`Profiles cache loaded: ${cached.length} profiles`);
    }
})();

// ── Token endpoint ────────────────────────────────────────────────────────
// Returns the GLP API token to callers that are one of:
//  a) already authenticated (valid X-GLP-Token — covered by middleware),
//  b) coming from the HA Supervisor-internal network (loopback or
//     172.30.0.0/16 — see isSupervisorIp in lib/helpers.js; this is the same
//     boundary server.js uses for the ingress bypass, and does NOT include
//     ordinary LAN/Docker-bridge addresses — ANY device that can reach this
//     port used to be able to pull the token unauthenticated (issue #276)),
//     or
//  c) presenting a valid HA Supervisor token (Authorization: Bearer <token>)
//     verified by calling http://supervisor/info — only processes inside HA OS
//     have a Supervisor token, making this safe against external callers.
// Callers outside these categories (e.g. the Order Card in direct-URL mode,
// or any browser hitting the app's LAN IP directly) must copy the token
// manually from Settings → API Token in the web UI.
async function isValidSupervisorToken(token) {
    if (!token) return false;
    try {
        const r = await fetch('http://supervisor/info', {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(4000),
        });
        return r.ok;
    } catch (_) {
        return false;
    }
}

router.get('/api/token', async (req, res) => {
    const ip = (req.socket?.remoteAddress || req.ip || '').replace(/^::ffff:/, '');
    if (!rateLimit(`token:${ip}`, 10)) return res.status(429).json({ error: 'Rate limit exceeded' });
    const fromSupervisor = isSupervisorIp(ip);
    const hasValidToken  = req.glpAuthenticated;

    if (fromSupervisor || hasValidToken) {
        return res.json({ apiToken: state.apiToken || null });
    }

    // Fallback: verify via HA Supervisor API.
    // Only HA-internal processes (core, add-ons) hold a valid Supervisor token.
    const authHeader = req.headers['authorization'] || '';
    const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (bearerToken && await isValidSupervisorToken(bearerToken)) {
        return res.json({ apiToken: state.apiToken || null });
    }

    log(`Token request denied — ip=${ip}`);
    res.status(401).json({ error: 'Unauthorized' });
});

// ── Status ────────────────────────────────────────────────────────────────

router.get('/api/status', (req, res) => {
    const opts          = loadOptions();
    const machineUrl    = getMachineUrl(opts);
    let shotCount = 0, machineHostname = '';
    try { shotCount = shotRepo.count(); } catch (e) {}
    try { machineHostname = new URL(machineUrl).hostname; } catch (e) {}
    // Sensitive fields only exposed to authenticated callers (H1)
    const sensitive = req.glpAuthenticated ? {
        machineUrl, machineHostname,
        lastSyncError:    state.lastSyncError,
        lastMachineError: state.lastMachineError,
        switchEntity:     opts.switch_entity || null,
        isDemo:           demoService.isDemoActive(),
    } : {};
    res.json({
        shotCount,
        lastSync:           state.lastSyncTime,
        syncRetryCount:     state.syncRetryCount,
        machineVersion:     state.cachedMachineVersion,
        syncInterval:       opts.sync_interval || 5,
        haConnected:        !!HA_TOKEN,
        glpVersion:         GLP_VERSION,
        ordersFeature:      isOrdersEnabled(),
        machineReachable:   state.machineReachable,
        lastMachineSuccess: state.lastMachineSuccess,
        ...sensitive,
    });
});

// ── Demo mode (#274) ─────────────────────────────────────────────────────

router.post('/api/demo/seed', (req, res) => {
    try {
        if (!demoService.isEmpty()) return res.status(409).json({ error: 'Database is not empty' });
        demoService.seedDemoData();
        log('Demo data seeded');
        res.json({ ok: true, isDemo: true });
    } catch (e) {
        log(`Demo seed error: ${e.message}`, true);
        res.status(500).json({ error: e.message });
    }
});

router.post('/api/demo/end', (req, res) => {
    try {
        demoService.endDemo();
        log('Demo data removed');
        res.json({ ok: true, isDemo: false });
    } catch (e) {
        log(`Demo end error: ${e.message}`, true);
        res.status(500).json({ error: e.message });
    }
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
    const opts    = loadOptions();
    const baseUrl = getMachineBaseUrl(opts);
    const currentId   = state.machineStatus?.profileId   ?? null;
    const currentName = state.machineStatus?.profileName ?? null;

    const respond = (profiles, stale = false) => {
        const options = profiles.map(p => p.name);
        res.json({
            available:  profiles.length > 0,
            stale,
            current:    currentName,
            currentId,
            options,
            optionsRaw: profiles.map(p => ({ id: p.id, name: p.name })),
        });
    };

    if (!baseUrl) {
        // No machine URL configured — serve from cache if available
        return respond(state.machineProfiles, true);
    }
    try {
        const r    = await axios.get(`${baseUrl}/api/profiles/all`, { timeout: 5000 });
        const raw  = Array.isArray(r.data) ? r.data : [];
        if (raw.length) {
            state.machineProfiles = raw;
            saveProfilesCache(raw);
        }
        respond(state.machineProfiles, raw.length === 0);
    } catch (e) {
        // Machine unreachable — fall back to last-known cache
        log(`Profiles fetch failed, using cache (${state.machineProfiles.length} entries): ${e.message}`, true);
        respond(state.machineProfiles, true);
    }
});

router.post('/api/machine/profile/set', async (req, res) => {
    const { option, id: reqId } = req.body || {};
    if (!option && reqId == null) return res.status(400).json({ error: 'option or id required' });
    const opts    = loadOptions();
    const baseUrl = getMachineBaseUrl(opts);
    if (!baseUrl) return res.status(503).json({ error: 'machine URL not configured' });
    try {
        let profileId = reqId != null ? parseInt(reqId) : null;
        if (profileId == null) {
            // look up by name in cached profile list (refresh if empty)
            let profiles = state.machineProfiles;
            if (!profiles.length) {
                const r = await axios.get(`${baseUrl}/api/profiles/all`, { timeout: 5000 });
                profiles = Array.isArray(r.data) ? r.data : [];
                state.machineProfiles = profiles;
            }
            const match = profiles.find(p => p.name === option);
            if (!match) return res.status(404).json({ error: `Profile not found: ${option}` });
            profileId = match.id;
        }
        await axios.post(`${baseUrl}/api/profile-select/${profileId}`, {}, { timeout: 5000 });
        log(`Profile switched to: ${option || profileId}`);
        res.json({ ok: true, profileId });
    } catch (e) {
        log(`Profile set error: ${e.message}`, true);
        res.status(500).json({ error: e.message });
    }
});

// ── Machine live status (for integration / Lovelace card) ──────────────────

router.get('/api/machine/status', (req, res) => {
    if (!state.machineStatus) return res.json({ available: false });
    const staleSec = (Date.now() - state.machineStatus.updatedAt) / 1000;
    res.json({ available: true, stale: staleSec > 10, ...state.machineStatus });
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
    const ready     = remaining === 0;
    res.json({ ready, elapsed, remaining, pct, preheatTime: preheatMins,
               stabilityReady: ready && !!state.stabilityReady,
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

// ── Public menu (drink types for annotations; always available) ───────────

router.get('/api/menu', (req, res) => res.json(loadMenu()));

// ── OpenAPI spec ──────────────────────────────────────────────────────────

router.get('/api/openapi.json', (req, res) => {
    try { res.json(getOpenApiSpec()); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Version / update check ────────────────────────────────────────────────

let _versionCache = null;
let _versionCacheAt = 0;
const VERSION_CACHE_MS = 60 * 60 * 1000;

router.get('/api/version', async (req, res) => {
    const now = Date.now();
    if (!_versionCache || now - _versionCacheAt > VERSION_CACHE_MS) {
        try {
            const r = await fetch(
                'https://api.github.com/repos/mxkissnr/gaggiuino-local-profiler/releases/latest',
                { headers: { 'User-Agent': 'GLP-Server' }, signal: AbortSignal.timeout(8000) }
            );
            if (r.ok) {
                const data = await r.json();
                _versionCache = data.tag_name?.replace(/^v/, '') || null;
                _versionCacheAt = now;
            }
        } catch (_) {}
    }
    const latest = _versionCache;
    const updateAvailable = !!(latest && latest !== GLP_VERSION);
    res.json({
        current:          GLP_VERSION,
        latest:           latest || null,
        update_available: updateAvailable,
        release_url:      'https://github.com/mxkissnr/gaggiuino-local-profiler/releases/latest',
    });
});

router.post('/api/update', async (req, res) => {
    if (!HA_TOKEN) return res.status(503).json({ error: 'Not running inside Home Assistant' });
    try {
        const r = await fetch('http://supervisor/addons/self/update', {
            method:  'POST',
            headers: { Authorization: `Bearer ${HA_TOKEN}` },
            signal:  AbortSignal.timeout(10000),
        });
        if (!r.ok) return res.status(r.status).json({ error: await r.text() });
        log('Add-on update triggered via Supervisor API');
        res.json({ ok: true });
    } catch (e) {
        log(`Update trigger error: ${e.message}`, true);
        res.status(500).json({ error: e.message });
    }
});

// ── Debug ─────────────────────────────────────────────────────────────────

// H2: only available outside production to avoid leaking internal network topology
if (process.env.NODE_ENV !== 'production') {
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
}

module.exports = router;
