const express = require('express');
const router  = express.Router();

const { STATIC_MAINTENANCE_TASKS } = require('../lib/constants');
const {
    loadLibrary, loadOptions, getMachineUrl,
    loadMaintenance, saveMaintenance, computeMaintenanceStats,
    loadMaintenanceLog, saveMaintenanceLog, addMaintenanceLogEntry,
} = require('../lib/data');

function isValidMaintenanceTask(task) {
    if (STATIC_MAINTENANCE_TASKS.has(task)) return true;
    if (/^grinder_\d+$/.test(task)) return loadLibrary().grinders.some(g => `grinder_${g.id}` === task);
    return false;
}

function machineHostname() {
    try { return new URL(getMachineUrl(loadOptions())).hostname; } catch { return 'gaggiuino'; }
}

router.get('/api/maintenance', (req, res) => {
    res.json(computeMaintenanceStats(loadMaintenance()));
});

router.post('/api/maintenance/:task/done', (req, res) => {
    if (!isValidMaintenanceTask(req.params.task)) return res.status(404).json({ error: 'Unknown task' });
    const maint = loadMaintenance();
    maint[req.params.task].lastDate = new Date().toISOString().split('T')[0];
    saveMaintenance(maint);
    addMaintenanceLogEntry(req.params.task, req.body?.notes || '', machineHostname());
    res.json(computeMaintenanceStats(maint));
});

router.post('/api/maintenance/:task/threshold', (req, res) => {
    if (!isValidMaintenanceTask(req.params.task)) return res.status(404).json({ error: 'Unknown task' });
    const maint = loadMaintenance();
    const { threshold_shots, threshold_days } = req.body;
    if (threshold_shots !== undefined) {
        const v = parseInt(threshold_shots);
        maint[req.params.task].threshold_shots = (!isNaN(v) && v >= 1 && v <= 10000) ? v : null;
    }
    if (threshold_days !== undefined) {
        const v = parseInt(threshold_days);
        maint[req.params.task].threshold_days = (!isNaN(v) && v >= 1 && v <= 365) ? v : null;
    }
    saveMaintenance(maint);
    res.json(computeMaintenanceStats(maint));
});

// ── Maintenance Log ───────────────────────────────────────────────────────

router.get('/api/maintenance/log', (req, res) => {
    res.json(loadMaintenanceLog());
});

router.post('/api/maintenance/log', (req, res) => {
    const { task, date, notes } = req.body || {};
    if (!task || !isValidMaintenanceTask(task)) return res.status(400).json({ error: 'Invalid task' });
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Invalid date' });
    const entries = loadMaintenanceLog();
    const d       = date || new Date().toISOString().split('T')[0];
    const entry   = {
        id:              Date.now(),
        ts:              Math.floor(new Date(d + 'T12:00:00').getTime() / 1000),
        date:            d,
        task,
        machine:         machineHostname(),
        shotCountAtTime: null,
        notes:           (notes || '').slice(0, 500),
    };
    entries.unshift(entry);
    entries.sort((a, b) => b.ts - a.ts);
    if (entries.length > 500) entries.splice(500);
    saveMaintenanceLog(entries);
    res.json(entry);
});

router.delete('/api/maintenance/log/:id', (req, res) => {
    const id      = parseInt(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
    const entries = loadMaintenanceLog();
    const idx     = entries.findIndex(e => e.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    entries.splice(idx, 1);
    saveMaintenanceLog(entries);
    res.json({ ok: true });
});

module.exports = router;
