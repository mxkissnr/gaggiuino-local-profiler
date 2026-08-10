// Machine registry API (#317): CRUD for the machines this GLP instance
// manages, plus a reachability probe. Existing single-machine endpoints stay
// untouched — this is purely additive.
'use strict';
const express = require('express');
const router  = express.Router();

const registry = require('../lib/machines/registry');
const { getAdapter } = require('../lib/machines');
const { machineSchema } = require('../lib/validation/schemas');
const { assertMachineHost, SsrfBlockedError } = require('../lib/ssrf-guard');
const { log } = require('../lib/helpers');
const { syncShots, syncMachineShots } = require('../lib/sync');

// #729: fire a catch-up sync on every successful machine save, not just when
// the default machine's host changes -- a freshly configured non-default
// machine has shot history to import too. lib/sync.js's syncShots() is
// hard-coded to the default machine (see its own #341 header comment), so
// non-default machines go through syncMachineShots() instead.
function syncSoonAfterSave(machine) {
    const sync = machine.isDefault ? syncShots() : syncMachineShots(machine);
    sync.catch(err => log(`Sync after machine save failed: ${err.message}`, true));
}

// #731: "Verbindung testen" (public-src/components/machines-settings.js's
// testMachineForm()) saves the form first to get a testable machine id, the
// same POST/PUT this route already handles for an explicit "Speichern" --
// but that implicit save must not itself start an import, only a real save
// click should. The client marks that case with a `?sync=0` query param
// (not a body field -- machineSchema/machineSchema.partial() in
// lib/validation/schemas.js validate the body strictly). Absent or anything
// other than '0'/'false' keeps the previous default (sync fires), so every
// other/future caller of this route is unaffected.
function wantsSync(req) {
    return req.query.sync !== '0' && req.query.sync !== 'false';
}

// Machine hosts are the app owner's own trusted LAN configuration (a real
// Gaggiuino/GaggiMate controller), not untrusted external content — so this
// uses the narrower assertMachineHost() (blocks only loopback/link-local/
// cloud-metadata), not assertPublicHost() (which blocks the private/RFC1918
// ranges a real machine host lives in — see #336).
async function validateHost(host) {
    let hostname;
    try {
        hostname = new URL(/^https?:\/\//i.test(host) ? host : `http://${host}`).hostname;
    } catch {
        throw new Error('invalid host');
    }
    await assertMachineHost(hostname);
}

router.get('/api/machines', (req, res) => {
    registry.ensureDefaultMachine();
    res.json(registry.listMachines());
});

router.post('/api/machines', async (req, res) => {
    const parsed = machineSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'invalid machine', details: parsed.error.issues });
    if (parsed.data.host) { // #718: empty host is a valid "not configured yet" state -- nothing to validate
        try {
            await validateHost(parsed.data.host);
        } catch (e) {
            if (e instanceof SsrfBlockedError) return res.status(400).json({ error: 'host not allowed' });
            return res.status(400).json({ error: e.message });
        }
    }
    const machine = registry.createMachine(parsed.data);
    log(`Machine added: #${machine.id} "${machine.name}" (${machine.type}) host=${machine.host}`);
    registry.logRegistrySnapshot();
    if (wantsSync(req)) syncSoonAfterSave(machine);
    res.json(machine);
});

router.put('/api/machines/:id', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const existing = registry.getMachine(id);
    if (!existing) return res.status(404).json({ error: 'not found' });

    const parsed = machineSchema.partial().safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'invalid machine', details: parsed.error.issues });

    if (parsed.data.host) {
        try {
            await validateHost(parsed.data.host);
        } catch (e) {
            if (e instanceof SsrfBlockedError) return res.status(400).json({ error: 'host not allowed' });
            return res.status(400).json({ error: e.message });
        }
    }
    const machine = registry.updateMachine(id, parsed.data);
    // #713: host omitted from this line before -- during a live support
    // round there was no way to confirm from the log alone whether a host
    // change via Settings -> Machines actually took effect.
    const hostSuffix = parsed.data.host ? ` host=${parsed.data.host}` : '';
    log(`Machine updated: #${id}${hostSuffix}`);
    registry.logRegistrySnapshot();
    if (wantsSync(req)) syncSoonAfterSave(machine);
    res.json(machine);
});

router.delete('/api/machines/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    try {
        const ok = registry.deleteMachine(id);
        if (!ok) return res.status(404).json({ error: 'not found' });
        log(`Machine deleted: #${id}`);
        registry.logRegistrySnapshot();
        res.json({ ok: true });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

router.post('/api/machines/:id/test', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const machine = registry.getMachine(id);
    if (!machine) return res.status(404).json({ error: 'not found' });
    try {
        const adapter = getAdapter(machine);
        const status  = await adapter.getStatus(machine);
        res.json({ ok: true, reachable: true, status });
    } catch (e) {
        res.json({ ok: true, reachable: false, error: e.message });
    }
});

module.exports = router;
