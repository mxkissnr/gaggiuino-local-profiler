const express        = require('express');
const router         = express.Router();
const libraryService = require('../lib/services/LibraryService');
const { loadOptions, getMachineUrl } = require('../lib/data');
const { STATIC_MAINTENANCE_TASKS }   = require('../lib/constants');

function isValidTask(task) {
    if (STATIC_MAINTENANCE_TASKS.has(task)) return true;
    if (/^grinder_\d+$/.test(task)) return libraryService.getLibrary().grinders.some(g => `grinder_${g.id}` === task);
    return false;
}

function machineHostname() {
    try { return new URL(getMachineUrl(loadOptions())).hostname; } catch { return 'gaggiuino'; }
}

router.get('/api/maintenance', (req, res, next) => {
    try {
        const maint = libraryService.getMaintenance();
        res.json(libraryService.computeMaintenanceStats(maint));
    } catch (err) { next(err); }
});

router.post('/api/maintenance/:task/done', (req, res, next) => {
    try {
        if (!isValidTask(req.params.task)) return res.status(404).json({ error: 'Unknown task' });
        const maint = libraryService.getMaintenance();
        maint[req.params.task].lastDate = new Date().toISOString();
        libraryService.saveMaintenance(maint);
        libraryService.addMaintenanceLogEntry(req.params.task, req.body?.notes || '', machineHostname());
        res.json(libraryService.computeMaintenanceStats(maint));
    } catch (err) { next(err); }
});

router.post('/api/maintenance/:task/threshold', (req, res, next) => {
    try {
        if (!isValidTask(req.params.task)) return res.status(404).json({ error: 'Unknown task' });
        const maint = libraryService.getMaintenance();
        const { threshold_shots, threshold_days } = req.body;
        if (threshold_shots !== undefined) {
            const v = parseInt(threshold_shots);
            maint[req.params.task].threshold_shots = (!isNaN(v) && v >= 1 && v <= 10000) ? v : null;
        }
        if (threshold_days !== undefined) {
            const v = parseInt(threshold_days);
            maint[req.params.task].threshold_days = (!isNaN(v) && v >= 1 && v <= 365) ? v : null;
        }
        libraryService.saveMaintenance(maint);
        res.json(libraryService.computeMaintenanceStats(maint));
    } catch (err) { next(err); }
});

router.get('/api/maintenance/log', (req, res, next) => {
    try { res.json(libraryService.getMaintenanceLog()); } catch (err) { next(err); }
});

router.post('/api/maintenance/log', (req, res, next) => {
    try {
        const { task, date, notes } = req.body || {};
        if (!task || !isValidTask(task)) return res.status(400).json({ error: 'Invalid task' });
        if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Invalid date' });
        const entry = libraryService.addMaintenanceLogEntry(task, (notes || '').slice(0, 500), machineHostname());
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
