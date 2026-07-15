const express        = require('express');
const router         = express.Router();
const libraryService = require('../lib/services/LibraryService');
const { loadOptions, getMachineUrl } = require('../lib/data');
const { STATIC_MAINTENANCE_TASKS }   = require('../lib/constants');

// Returns a program-owned string for a valid task, or null. Never returns
// the raw request string — callers must index maint[] with the returned
// value, not req.params.task, so the object key is never attacker-derived
// (severs the prototype-pollution taint chain rather than just filtering it).
function canonicalTask(raw) {
    if (typeof raw !== 'string') return null;
    for (const t of STATIC_MAINTENANCE_TASKS) if (t === raw) return t;
    const m = /^grinder_(\d+)$/.exec(raw);
    if (m && libraryService.getLibrary().grinders.some(g => g.id === Number(m[1]))) return `grinder_${Number(m[1])}`;
    return null;
}

function machineHostname() {
    try { return new URL(getMachineUrl(loadOptions())).hostname; } catch { return 'gaggiuino'; }
}

// Defaults to 1 (the existing default machine) for backward compatibility
// with older cached frontend clients that don't send machineId yet (#338).
function activeMachineId(req) {
    const v = parseInt(req.query.machineId, 10);
    return Number.isFinite(v) ? v : 1;
}

router.get('/api/maintenance', (req, res, next) => {
    try {
        const machineId = activeMachineId(req);
        const maint = libraryService.getMaintenance(machineId);
        res.json(libraryService.computeMaintenanceStats(maint, machineId));
    } catch (err) { next(err); }
});

router.post('/api/maintenance/:task/done', (req, res, next) => {
    try {
        const task = canonicalTask(req.params.task);
        if (!task) return res.status(404).json({ error: 'Unknown task' });
        const machineId = activeMachineId(req);
        const maint = libraryService.getMaintenance(machineId);
        maint[task].lastDate = new Date().toISOString();
        libraryService.saveMaintenance(maint, machineId);
        libraryService.addMaintenanceLogEntry(task, req.body?.notes || '', machineHostname(), machineId);
        res.json(libraryService.computeMaintenanceStats(maint, machineId));
    } catch (err) { next(err); }
});

router.post('/api/maintenance/:task/threshold', (req, res, next) => {
    try {
        const task = canonicalTask(req.params.task);
        if (!task) return res.status(404).json({ error: 'Unknown task' });
        const machineId = activeMachineId(req);
        const maint = libraryService.getMaintenance(machineId);
        const { threshold_shots, threshold_days } = req.body;
        if (threshold_shots !== undefined) {
            const v = parseInt(threshold_shots);
            maint[task].threshold_shots = (!isNaN(v) && v >= 1 && v <= 10000) ? v : null;
        }
        if (threshold_days !== undefined) {
            const v = parseInt(threshold_days);
            maint[task].threshold_days = (!isNaN(v) && v >= 1 && v <= 365) ? v : null;
        }
        libraryService.saveMaintenance(maint, machineId);
        res.json(libraryService.computeMaintenanceStats(maint, machineId));
    } catch (err) { next(err); }
});

router.get('/api/maintenance/log', (req, res, next) => {
    try { res.json(libraryService.getMaintenanceLog()); } catch (err) { next(err); }
});

router.post('/api/maintenance/log', (req, res, next) => {
    try {
        const { date, notes } = req.body || {};
        const task = canonicalTask(req.body?.task);
        if (!task) return res.status(400).json({ error: 'Invalid task' });
        if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Invalid date' });
        const machineId = activeMachineId(req);
        const entry = libraryService.addMaintenanceLogEntry(task, (notes || '').slice(0, 500), machineHostname(), machineId);
        res.json(entry);
    } catch (err) { next(err); }
});

router.delete('/api/maintenance/log/:id', (req, res, next) => {
    try {
        const id  = parseInt(req.params.id);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
        const log = libraryService.getMaintenanceLog();
        if (!log.find(e => e.id === id)) return res.status(404).json({ error: 'Not found' });
        const { getDb } = require('../lib/db');
        getDb().prepare('DELETE FROM maintenance_log WHERE id = ?').run(id);
        res.json({ ok: true });
    } catch (err) { next(err); }
});

module.exports = router;
