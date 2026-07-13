// Machine registry API (#317): CRUD for the machines this GLP instance
// manages, plus a reachability probe. Existing single-machine endpoints stay
// untouched — this is purely additive.
'use strict';
const express = require('express');
const router  = express.Router();

const registry = require('../lib/machines/registry');
const { getAdapter } = require('../lib/machines');
const { machineSchema } = require('../lib/validation/schemas');
const { assertPublicHost, SsrfBlockedError } = require('../lib/ssrf-guard');
const { log } = require('../lib/helpers');

async function validateHost(host) {
    let hostname;
    try {
        hostname = new URL(/^https?:\/\//i.test(host) ? host : `http://${host}`).hostname;
    } catch {
        throw new Error('invalid host');
    }
    await assertPublicHost(hostname);
}

router.get('/api/machines', (req, res) => {
    registry.ensureDefaultMachine();
    res.json(registry.listMachines());
});

router.post('/api/machines', async (req, res) => {
    const parsed = machineSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'invalid machine', details: parsed.error.issues });
    try {
        await validateHost(parsed.data.host);
    } catch (e) {
        if (e instanceof SsrfBlockedError) return res.status(400).json({ error: 'host not allowed' });
        return res.status(400).json({ error: e.message });
    }
    const machine = registry.createMachine(parsed.data);
    log(`Machine added: #${machine.id} "${machine.name}" (${machine.type})`);
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
    log(`Machine updated: #${id}`);
    res.json(machine);
});

router.delete('/api/machines/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    try {
        const ok = registry.deleteMachine(id);
        if (!ok) return res.status(404).json({ error: 'not found' });
        log(`Machine deleted: #${id}`);
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
