const express = require('express');
const axios   = require('axios');
const fs      = require('fs');
const path    = require('path');
const { load: yamlLoad } = require('js-yaml');
const router  = express.Router();

let _openApiSpec = null;
function getOpenApiSpec() {
    if (!_openApiSpec) {
        try {
            const raw = fs.readFileSync(path.join(__dirname, '..', 'openapi.yaml'), 'utf8');
            _openApiSpec = yamlLoad(raw);
        } catch {
            return {};
        }
    }
    return _openApiSpec;
}

const { GLP_VERSION, HA_TOKEN, PROFILES_CACHE_FILE } = require('../lib/constants');
const shotRepo = require('../lib/repositories/ShotRepository');
const { loadOptions, isOrdersEnabled, loadMenu } = require('../lib/data');
const { getSwitchState, callHaService } = require('../lib/ha');
const { setReadyByTarget, buildPreheatResponse } = require('../lib/preheat');
const { log, rateLimit } = require('../lib/helpers');
const state = require('../lib/state');
const { getMachineRuntimeState } = require('../lib/machine-runtime-state');
const demoService = require('../lib/services/DemoService');

// #549: the default machine's live/preheat status is still tracked by the
// hard single-machine polling loop in lib/poll.js — same shared instance.
const defaultRuntime = getMachineRuntimeState();
const { profileSchema } = require('../lib/validation/schemas');
const registry = require('../lib/machines/registry');
const { hasUnconfirmedLegacyMachineOptions } = require('../lib/machines/options-adoption');
const { getAdapter } = require('../lib/machines');

// ── Profile cache helpers ─────────────────────────────────────────────────

function loadProfilesCache() {
    try {
        if (fs.existsSync(PROFILES_CACHE_FILE))
            return JSON.parse(fs.readFileSync(PROFILES_CACHE_FILE, 'utf8'));
    } catch { /* ignore */ }
    return [];
}

function saveProfilesCache(profiles) {
    try { fs.writeFileSync(PROFILES_CACHE_FILE, JSON.stringify(profiles)); } catch { /* ignore */ }
}

// Multi-machine (#340): the default machine (id 1) keeps using the existing
// on-disk cache (defaultRuntime.machineProfiles / PROFILES_CACHE_FILE)
// unchanged, for byte-identical behavior on single-machine installs.
// Additional machines get a simple in-memory cache — non-default machines
// never had a cache before, so this is purely additive.
const nonDefaultProfilesCache = {}; // machineId -> profiles array

function getProfilesCacheFor(machine) {
    return machine.isDefault ? defaultRuntime.machineProfiles : (nonDefaultProfilesCache[machine.id] || []);
}

function setProfilesCacheFor(machine, profiles) {
    if (machine.isDefault) {
        defaultRuntime.machineProfiles = profiles;
        saveProfilesCache(profiles);
    } else {
        nonDefaultProfilesCache[machine.id] = profiles;
    }
}

// #679: resolveMachine() now lives in lib/machines/registry.js (was
// duplicated verbatim here and in routes/machine-control.js) -- see that
// file for the resolution convention.
const { resolveMachine } = registry;

// Pre-load cache into state on startup so the profile select is immediately available
(function initProfilesCache() {
    const cached = loadProfilesCache();
    if (cached.length) {
        defaultRuntime.machineProfiles = cached;
        log(`Profiles cache loaded: ${cached.length} profiles`);
    }
})();

// ── Token endpoint ────────────────────────────────────────────────────────

// Serves the API token to any caller that can reach this port, rate-limited.
//
// This deliberately reverses the #276 restriction to HA-internal callers (#533).
// Direct-port access (http://<host>:8099) is how the installable PWA runs, and
// it has no other way to obtain a token: the UI has no token input, and a token
// is no longer cached client-side since #524. Under #276 the PWA only kept
// working because it still held a token cached before that change — once #524
// removed that cached copy, direct-port access broke entirely (v2.19.1).
//
// The trade-off, accepted knowingly for a home LAN: anything that can reach this
// port can obtain the token and therefore call every endpoint, so token auth is
// no longer a boundary within the LAN. Reaching the port at all is the boundary.
// Do NOT "fix" this back to an IP check without providing another way for
// direct-port clients to get a token — that is precisely what broke v2.19.1.
router.get('/api/token', async (req, res) => {
    const ip = (req.socket?.remoteAddress || req.ip || '').replace(/^::ffff:/, '');
    if (!rateLimit(`token:${ip}`, 10)) return res.status(429).json({ error: 'Rate limit exceeded' });
    res.json({ apiToken: state.apiToken || null });
});

// ── Status ────────────────────────────────────────────────────────────────

// Resolves a machineHostname the same way the default-machine path below
// always has (strip protocol, keep hostname only) — used for the scoped
// branch too so both paths report hostname in the same shape.
function hostnameOf(rawHost) {
    try {
        return new URL(/^https?:\/\//i.test(rawHost) ? rawHost : `http://${rawHost}`).hostname;
    } catch {
        return rawHost;
    }
}

router.get('/api/status', async (req, res) => {
    const opts          = loadOptions();
    // Registry-first (#638-class): this used to read options.json's
    // machine_host directly and never picked up a Settings-UI host edit for
    // this display field, even though the switch/preheat endpoints below
    // already went through the registry. Same facade, same fix.
    const machineUrl    = registry.apiUrlFor();
    let shotCount = 0, machineHostname = '';
    try { shotCount = shotRepo.count(); } catch { /* ignore */ }
    try { machineHostname = new URL(machineUrl).hostname; } catch { /* ignore */ }

    let lastSync          = state.lastSyncTime;
    let lastSyncError     = state.lastSyncError;
    let machineReachable  = state.machineReachable;

    // #464: an explicit ?machineId for a non-default machine scopes
    // machineHostname/lastSync/lastSyncError/machineReachable to THAT
    // machine via a live reachability probe (same adapter.getStatus() call
    // /api/machines/:id/test uses), instead of always describing the
    // default machine. No machineId (or one that resolves back to the
    // default machine) keeps the exact behavior above, byte-for-byte —
    // this endpoint is polled unparameterized by other callers.
    const rawMachineId = req.query.machineId;
    if (rawMachineId != null && rawMachineId !== '') {
        const requested = resolveMachine(rawMachineId);
        if (!requested.isDefault) {
            machineHostname = hostnameOf(requested.host);
            try {
                const adapter = getAdapter(requested);
                await adapter.getStatus(requested);
                machineReachable = true;
                lastSync = new Date().toISOString();
                lastSyncError = null;
            } catch (e) {
                machineReachable = false;
                lastSyncError = e.message;
            }
        }
    }

    // Sensitive fields only exposed to authenticated callers (H1)
    const sensitive = req.glpAuthenticated ? {
        machineUrl, machineHostname,
        lastSyncError,
        lastMachineError: state.lastMachineError,
        switchEntity:     registry.switchEntityFor(),
        isDemo:           demoService.isDemoActive(),
    } : {};
    // Multi-machine (#317): flat legacy fields above always describe the
    // default machine unless scoped by ?machineId above, for backward
    // compatibility. `machines` is additive — old clients that don't read
    // it are unaffected.
    let machines = [];
    try {
        registry.ensureDefaultMachine();
        machines = registry.listMachines().map(m => ({
            id: m.id, name: m.name, type: m.type, isDefault: m.isDefault, enabled: m.enabled,
            reachable: m.isDefault ? state.machineReachable : null,
            on:        m.isDefault ? defaultRuntime.machineOn : null,
        }));
    } catch { /* ignore */ }
    res.json({
        shotCount,
        lastSync,
        syncRetryCount:     state.syncRetryCount,
        machineVersion:     state.cachedMachineVersion,
        syncInterval:       opts.sync_interval || 5,
        haConnected:        !!HA_TOKEN,
        glpVersion:         GLP_VERSION,
        // Unset (omitted) on every real install -- only the dev-channel image
        // (.github/workflows/build-dev.yaml) bakes this in via a Docker
        // build-arg, so the frontend's dev-build badge only ever appears on
        // GLP DEV. See the Dockerfile's ARG GLP_DEV_BUILD comment.
        ...(process.env.GLP_DEV_BUILD ? { devBuild: process.env.GLP_DEV_BUILD } : {}),
        ordersFeature:      isOrdersEnabled(),
        machineReachable,
        lastMachineSuccess: state.lastMachineSuccess,
        // #681: default machine's on/off state + the timestamp it last
        // switched on, already tracked for preheat elapsed-time math
        // (lib/preheat.js) -- reused here so the frontend can show "on for
        // Xh Ym" instead of adding a second timestamp to track.
        machineOn:          defaultRuntime.machineOn,
        machineOnSince:     defaultRuntime.switchOnAt,
        // #662: true only while the default machine still has an
        // unconfirmed legacy add-on option (machine_host/switch_entity,
        // deprecated from config.yaml's schema) -- see
        // options-adoption.js's hasUnconfirmedLegacyMachineOptions().
        legacyMachineOptionsPending: hasUnconfirmedLegacyMachineOptions(),
        machines,
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
    require('../lib/live-sync').syncAllMachines();
});

// ── Machine switch ────────────────────────────────────────────────────────

router.get('/api/switch', async (req, res) => {
    const entity = registry.switchEntityFor();
    if (!entity) return res.json({ configured: false });
    const st = await getSwitchState(entity);
    res.json({ configured: true, entity, state: st });
});

router.post('/api/switch/toggle', async (req, res) => {
    const entity = registry.switchEntityFor();
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
    const machine = resolveMachine(req.query.machineId);
    const adapter = getAdapter(machine);

    let currentId = null, currentName = null;
    if (machine.isDefault) {
        // Default machine's live status is already tracked by the legacy
        // polling loop (lib/poll.js) — reuse it rather than an extra round trip.
        currentId   = defaultRuntime.machineStatus?.profileId   ?? null;
        currentName = defaultRuntime.machineStatus?.profileName ?? null;
    } else {
        try {
            const status = await adapter.getStatus(machine);
            currentId   = status.profileId   ?? null;
            currentName = status.profileName ?? null;
        } catch { /* machine unreachable — profile list can still come from cache */ }
    }

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

    try {
        const raw = await adapter.listProfiles(machine);
        if (raw.length) setProfilesCacheFor(machine, raw);
        respond(getProfilesCacheFor(machine), raw.length === 0);
    } catch (e) {
        // Machine unreachable/not configured — fall back to last-known cache
        const cached = getProfilesCacheFor(machine);
        log(`Profiles fetch failed for machine #${machine.id} "${machine.name}", using cache (${cached.length} entries): ${e.message}`, true);
        respond(cached, true);
    }
});

router.post('/api/machine/profile/set', async (req, res) => {
    const { option, id: reqId, machineId } = req.body || {};
    if (!option && reqId == null) return res.status(400).json({ error: 'option or id required' });
    const machine = resolveMachine(machineId);
    const adapter = getAdapter(machine);
    try {
        let profileId = reqId != null ? parseInt(reqId) : null;
        if (profileId == null) {
            // look up by name in cached profile list (refresh if empty)
            let profiles = getProfilesCacheFor(machine);
            if (!profiles.length) {
                profiles = await adapter.listProfiles(machine);
                setProfilesCacheFor(machine, profiles);
            }
            const match = profiles.find(p => p.name === option);
            if (!match) return res.status(404).json({ error: `Profile not found: ${option}` });
            profileId = match.id;
        }
        await adapter.selectProfile(machine, profileId);
        log(`Profile switched to: ${option || profileId} (machine #${machine.id} "${machine.name}")`);
        res.json({ ok: true, profileId });
    } catch (e) {
        log(`Profile set error: ${e.message}`, true);
        res.status(500).json({ error: e.message });
    }
});

// Profile shape: { name, phases:[{name,type,target:{start,end,curve,time,volume},
// restriction,stopConditions:{...},skip,waterTemperature}], globalStopConditions,
// waterTemperature, recipe:{coffeeIn,coffeeOut,ratio}, id (update only) } —
// type/curve accept either the machine's enum strings ("PRESSURE","LINEAR", ...)
// or their numeric wire values. Writes (create/update/delete) are gated by
// the adapter's capabilities().profileEdit — e.g. GaggiMate exposes profiles
// read-only for now (see lib/machines/gaggimate/adapter.js header comment).
function requireProfileEditSupport(adapter, machine, res) {
    if (adapter.capabilities().profileEdit) return true;
    res.status(501).json({
        error: 'not supported',
        reason: `${machine.type} machines do not support remote profile editing yet`,
    });
    return false;
}

router.get('/api/machine/profile/:id', async (req, res) => {
    const machine = resolveMachine(req.query.machineId);
    const adapter = getAdapter(machine);
    try {
        const profile = await adapter.getProfile(machine, parseInt(req.params.id));
        res.json(profile);
    } catch (e) {
        log(`Machine profile detail fetch failed: ${e.message}`, true);
        res.status(502).json({ error: e.message });
    }
});

router.post('/api/machine/profile', async (req, res) => {
    const parsed = profileSchema.safeParse(req.body || {});
    if (!parsed.success)
        return res.status(400).json({ error: 'invalid profile', details: parsed.error.issues });
    const profile = parsed.data;
    const machine = resolveMachine(req.body?.machineId);
    const adapter = getAdapter(machine);
    if (!requireProfileEditSupport(adapter, machine, res)) return;
    try {
        const created = await adapter.createProfile(machine, profile);
        log(`Created machine profile "${created.name}" (id ${created.id}) on machine #${machine.id}`);
        res.json(created);
    } catch (e) {
        log(`Machine profile create failed: ${e.message}`, true);
        res.status(502).json({ error: e.message });
    }
});

router.put('/api/machine/profile/:id', async (req, res) => {
    const parsed = profileSchema.safeParse({ ...(req.body || {}), id: parseInt(req.params.id) });
    if (!parsed.success)
        return res.status(400).json({ error: 'invalid profile', details: parsed.error.issues });
    const profile = parsed.data;
    const machine = resolveMachine(req.body?.machineId);
    const adapter = getAdapter(machine);
    if (!requireProfileEditSupport(adapter, machine, res)) return;
    try {
        const updated = await adapter.updateProfile(machine, profile);
        log(`Updated machine profile "${updated.name}" (id ${updated.id}) on machine #${machine.id}`);
        res.json(updated);
    } catch (e) {
        log(`Machine profile update failed: ${e.message}`, true);
        res.status(502).json({ error: e.message });
    }
});

router.delete('/api/machine/profile/:id', async (req, res) => {
    const machine = resolveMachine(req.body?.machineId ?? req.query.machineId);
    const adapter = getAdapter(machine);
    if (!requireProfileEditSupport(adapter, machine, res)) return;
    try {
        const remaining = await adapter.deleteProfile(machine, parseInt(req.params.id));
        log(`Deleted machine profile id ${req.params.id} on machine #${machine.id}`);
        res.json({ ok: true, remaining });
    } catch (e) {
        log(`Machine profile delete failed: ${e.message}`, true);
        res.status(502).json({ error: e.message });
    }
});

// ── Machine live status (for integration / Lovelace card) ──────────────────

router.get('/api/machine/status', (req, res) => {
    if (!defaultRuntime.machineStatus) return res.json({ available: false });
    const staleSec = (Date.now() - defaultRuntime.machineStatus.updatedAt) / 1000;
    res.json({ available: true, stale: staleSec > 10, ...defaultRuntime.machineStatus });
});

// ── Preheat ───────────────────────────────────────────────────────────────

router.get('/api/preheat', (req, res) => {
    res.json(buildPreheatResponse());
});

// #541: lets a future HA-integration service set a target "ready by" wall-
// clock time — the app computes when the switch needs to go on and does so
// automatically via the existing 30s preheat watcher (lib/preheat.js's
// _checkReadyByPreheat), no separate scheduling primitive. targetAt: null
// cancels a pending target.
router.post('/api/preheat/ready-by', (req, res) => {
    const { targetAt } = req.body || {};
    if (targetAt !== null && (typeof targetAt !== 'number' || !Number.isFinite(targetAt)))
        return res.status(400).json({ error: 'targetAt must be an epoch-ms number or null' });
    // Setting (not clearing) a target the watcher could never fulfill would
    // silently no-op once plannedSwitchOnAt passes (see _checkReadyByPreheat)
    // — reject it up front instead, same eager check /api/switch/toggle uses.
    if (targetAt !== null && (!HA_TOKEN || !registry.switchEntityFor()))
        return res.status(400).json({ error: 'switch_entity nicht konfiguriert' });
    setReadyByTarget(targetAt);
    res.json(buildPreheatResponse());
});

// ── Live data ─────────────────────────────────────────────────────────────

router.get('/api/live/data', (req, res) => {
    res.json({
        isLive:           !!state.liveAccum,
        profileName:      state.liveAccum?.profileName || '',
        datapoints:       state.liveAccum ? state.liveAccum.datapoints : null,
        seq:              state.liveSeq,
        // #655: without this, a powered-off machine looked identical to an
        // idle-but-reachable one (state.liveAccum is null either way) — the
        // live tab kept showing "Ready to brew" indefinitely.
        machineReachable: state.machineReachable,
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
                // eslint-disable-next-line require-atomic-updates -- benign cache-fill race: concurrent requests before this resolves would all compute the same value from the same GitHub release
                _versionCache = data.tag_name?.replace(/^v/, '') || null;
                // eslint-disable-next-line require-atomic-updates -- see above
                _versionCacheAt = now;
            }
        } catch { /* ignore */ }
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

// ── Debug ─────────────────────────────────────────────────────────────────

// H2: only available outside production to avoid leaking internal network topology
if (process.env.NODE_ENV !== 'production') {
    router.get('/api/debug/machine', async (req, res) => {
        const baseUrl = registry.baseUrlFor();
        try {
            const r = await axios.get(`${baseUrl}/api/system/status`, { timeout: 5000 });
            res.json({ ok: true, baseUrl, data: r.data });
        } catch (e) {
            res.json({ ok: false, baseUrl, error: e.message });
        }
    });
}

module.exports = router;
