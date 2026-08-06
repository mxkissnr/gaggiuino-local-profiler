// Gaggiuino settings/control proxy (#597) — REST endpoints mirroring
// routes/system.js's /api/machine/* multi-machine-aware pattern (same
// resolveMachine-by-query/body-machineId convention, same getAdapter()
// dispatch) for the machine capabilities that pattern doesn't already
// cover: settings read/write, operation-mode/tare/service-test commands,
// active-profile persistence, and firmware OTA. Split into its own file
// rather than added to the already-large system.js, since none of this
// touches system.js's existing profile-cache/preheat/live-data state.
//
// Gaggiuino-only: every route below requires adapter.capabilities().settingsProxy
// (only the Gaggiuino adapter sets it — see requireSettingsProxySupport()),
// since GaggiMate's machine has no equivalent REST/WS surface to proxy.
'use strict';
const express = require('express');
const router  = express.Router();

const { getAdapter } = require('../lib/machines');
const registry = require('../lib/machines/registry');
const { log } = require('../lib/helpers');
const { GAGGIUINO_SETTINGS_CATEGORIES } = require('../lib/constants');
const {
    operationModeSchema, serviceTestPeripheralSchema, settingsPayloadSchema,
} = require('../lib/validation/schemas');
const { getLatestFirmwareRelease } = require('../lib/machines/gaggiuino/firmware-check');

// Same resolution convention as routes/system.js's resolveMachine(): an
// explicit machineId (query on GET, body on POST) if it names a known
// machine, otherwise the registry's default machine.
function resolveMachine(rawId) {
    registry.ensureDefaultMachine();
    const machineId = rawId != null && rawId !== '' ? parseInt(rawId, 10) : NaN;
    if (!Number.isNaN(machineId)) {
        const machine = registry.getMachine(machineId);
        if (machine) return machine;
    }
    return registry.getDefaultMachine();
}

function requireSettingsProxySupport(adapter, machine, res) {
    if (adapter.capabilities().settingsProxy) return true;
    res.status(501).json({
        error: 'not supported',
        reason: `${machine.type} machines do not support the settings/control proxy`,
    });
    return false;
}

// ── Settings ─────────────────────────────────────────────────────────────

router.get('/api/machine/settings', async (req, res) => {
    const machine = resolveMachine(req.query.machineId);
    const adapter = getAdapter(machine);
    if (!requireSettingsProxySupport(adapter, machine, res)) return;
    const category = req.query.category;
    if (category !== undefined && !GAGGIUINO_SETTINGS_CATEGORIES.includes(category) && category !== 'versions')
        return res.status(400).json({ error: `unknown settings category: ${category}` });
    try {
        const settings = await adapter.getSettings(machine, category);
        res.json(settings);
    } catch (e) {
        log(`Machine settings fetch failed: ${e.message}`, true);
        res.status(502).json({ error: e.message });
    }
});

// Registered before the /:category route below so this exact path always
// wins the match (Express resolves routes in registration order).
router.post('/api/machine/settings/save', async (req, res) => {
    const machine = resolveMachine(req.body?.machineId);
    const adapter = getAdapter(machine);
    if (!requireSettingsProxySupport(adapter, machine, res)) return;
    try {
        await adapter.saveSettings(machine);
        log(`Persisted in-RAM settings to flash on machine #${machine.id} "${machine.name}"`);
        res.json({ ok: true });
    } catch (e) {
        log(`Machine settings save failed: ${e.message}`, true);
        res.status(502).json({ error: e.message });
    }
});

router.post('/api/machine/settings/:category', async (req, res) => {
    const machine = resolveMachine(req.body?.machineId);
    const adapter = getAdapter(machine);
    if (!requireSettingsProxySupport(adapter, machine, res)) return;
    const { category } = req.params;
    if (!GAGGIUINO_SETTINGS_CATEGORIES.includes(category))
        return res.status(400).json({ error: `unknown or read-only settings category: ${category}` });
    const parsed = settingsPayloadSchema.safeParse(req.body?.settings ?? req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid settings payload', details: parsed.error.issues });
    try {
        const result = await adapter.updateSettings(machine, category, parsed.data);
        log(`Updated "${category}" settings on machine #${machine.id} "${machine.name}"`);
        res.json(result);
    } catch (e) {
        log(`Machine settings update failed: ${e.message}`, true);
        res.status(502).json({ error: e.message });
    }
});

// ── Operation mode / tare / service test ────────────────────────────────

router.post('/api/machine/opmode', async (req, res) => {
    const machine = resolveMachine(req.body?.machineId);
    const adapter = getAdapter(machine);
    if (!requireSettingsProxySupport(adapter, machine, res)) return;
    const parsed = operationModeSchema.safeParse(req.body?.mode);
    if (!parsed.success) return res.status(400).json({ error: 'invalid mode', details: parsed.error.issues });
    try {
        await adapter.setOperationMode(machine, parsed.data);
        log(`Set operation mode to ${parsed.data} on machine #${machine.id} "${machine.name}"`);
        res.json({ ok: true });
    } catch (e) {
        log(`Machine opmode set failed: ${e.message}`, true);
        res.status(502).json({ error: e.message });
    }
});

router.post('/api/machine/tare', async (req, res) => {
    const machine = resolveMachine(req.body?.machineId);
    const adapter = getAdapter(machine);
    if (!requireSettingsProxySupport(adapter, machine, res)) return;
    try {
        await adapter.tare(machine);
        log(`Tare requested on machine #${machine.id} "${machine.name}"`);
        res.json({ ok: true });
    } catch (e) {
        log(`Machine tare failed: ${e.message}`, true);
        res.status(502).json({ error: e.message });
    }
});

router.post('/api/machine/service-test', async (req, res) => {
    const machine = resolveMachine(req.body?.machineId);
    const adapter = getAdapter(machine);
    if (!requireSettingsProxySupport(adapter, machine, res)) return;
    const parsed = serviceTestPeripheralSchema.safeParse(req.body?.peripheral);
    if (!parsed.success) return res.status(400).json({ error: 'invalid peripheral', details: parsed.error.issues });
    try {
        await adapter.serviceTest(machine, parsed.data);
        log(`Service test "${parsed.data}" triggered on machine #${machine.id} "${machine.name}"`);
        res.json({ ok: true });
    } catch (e) {
        log(`Machine service test failed: ${e.message}`, true);
        res.status(502).json({ error: e.message });
    }
});

// ── Active-profile persistence ──────────────────────────────────────────
// Distinct from routes/system.js's /api/machine/profile* (saved-profile-slot
// CRUD) — this persists the currently *active* profile + its ID to flash.

router.post('/api/machine/profile/save', async (req, res) => {
    const machine = resolveMachine(req.body?.machineId);
    const adapter = getAdapter(machine);
    if (!requireSettingsProxySupport(adapter, machine, res)) return;
    try {
        await adapter.saveActiveProfile(machine);
        log(`Persisted active profile to flash on machine #${machine.id} "${machine.name}"`);
        res.json({ ok: true });
    } catch (e) {
        log(`Active profile save failed: ${e.message}`, true);
        res.status(502).json({ error: e.message });
    }
});

// ── Firmware / OTA ───────────────────────────────────────────────────────

router.get('/api/machine/firmware/progress', async (req, res) => {
    const machine = resolveMachine(req.query.machineId);
    const adapter = getAdapter(machine);
    if (!requireSettingsProxySupport(adapter, machine, res)) return;
    try {
        const progress = await adapter.getFirmwareProgress(machine);
        res.json(progress);
    } catch (e) {
        log(`Firmware progress fetch failed: ${e.message}`, true);
        res.status(502).json({ error: e.message });
    }
});

router.post('/api/machine/firmware/update', async (req, res) => {
    const machine = resolveMachine(req.body?.machineId);
    const adapter = getAdapter(machine);
    if (!requireSettingsProxySupport(adapter, machine, res)) return;
    try {
        const result = await adapter.triggerFirmwareUpdate(machine);
        log(`Firmware update triggered on machine #${machine.id} "${machine.name}"`);
        res.json(result);
    } catch (e) {
        log(`Firmware update trigger failed: ${e.message}`, true);
        res.status(502).json({ error: e.message });
    }
});

// #620 Phase 1: "is an update even available", ahead of actually triggering
// one via the route above. Compares the machine's own installed hash
// (GET /api/settings/versions) against the latest matching GitHub release
// for its configured system.releaseChannel — see firmware-check.js for the
// channel<->tag-prefix mapping and its documented, unverified assumption.
router.get('/api/machine/firmware/version', async (req, res) => {
    const machine = resolveMachine(req.query.machineId);
    const adapter = getAdapter(machine);
    if (!requireSettingsProxySupport(adapter, machine, res)) return;
    try {
        const [versions, systemSettings] = await Promise.all([
            adapter.getSettings(machine, 'versions'),
            adapter.getSettings(machine, 'system'),
        ]);
        const installed = versions?.coreVersion || null;
        const latest     = await getLatestFirmwareRelease(systemSettings?.releaseChannel);
        // ASSUMPTION (flagged alongside the channel<->tag-prefix mapping in
        // firmware-check.js, not verified any further than that): a raw
        // string comparison, with no format/length/case normalization. The
        // one real machine checked while researching #620 reported a
        // coreVersion that matched its GitHub release tag's hash suffix
        // exactly (both short, lowercase hex, e.g. "7889b7d") -- but nothing
        // guarantees that holds for every firmware build. If installed and
        // latest ever differ only in case or truncation length while
        // referring to the same actual commit, this reports a phantom
        // update forever (never the reverse -- a genuinely different commit
        // could not accidentally compare equal this way).
        const updateAvailable = !!(installed && latest && installed !== latest.hash);
        res.json({
            installed,
            latest:          latest?.hash || null,
            updateAvailable,
            releaseUrl:      latest?.releaseUrl || null,
        });
    } catch (e) {
        log(`Firmware version check failed: ${e.message}`, true);
        res.status(502).json({ error: e.message });
    }
});

// ── Live sensor/system state (#597) ─────────────────────────────────────
// Reads from lib/gaggiuino-live-client.js's cache (persistent WS session,
// reused across polls) rather than opening a fresh connection per request —
// see that module's header comment. Returns null for either field until the
// first push arrives after this machine's session (re)connects.

router.get('/api/machine/live', async (req, res) => {
    const machine = resolveMachine(req.query.machineId);
    const adapter = getAdapter(machine);
    if (!requireSettingsProxySupport(adapter, machine, res)) return;
    try {
        const [sensorSnap, sysState] = await Promise.all([
            adapter.getLiveSensorSnapshot(machine),
            adapter.getLiveSystemState(machine),
        ]);
        res.json({ sensorSnap, sysState });
    } catch (e) {
        log(`Machine live state fetch failed: ${e.message}`, true);
        res.status(502).json({ error: e.message });
    }
});

module.exports = router;
