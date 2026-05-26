const express = require('express');
const router  = express.Router();

const { STATIC_MAINTENANCE_TASKS } = require('../lib/constants');
const { loadLibrary, loadMaintenance, saveMaintenance, computeMaintenanceStats } = require('../lib/data');

function isValidMaintenanceTask(task) {
    if (STATIC_MAINTENANCE_TASKS.has(task)) return true;
    if (/^grinder_\d+$/.test(task)) return loadLibrary().grinders.some(g => `grinder_${g.id}` === task);
    return false;
}

router.get('/api/maintenance', (req, res) => {
    res.json(computeMaintenanceStats(loadMaintenance()));
});

router.post('/api/maintenance/:task/done', (req, res) => {
    if (!isValidMaintenanceTask(req.params.task)) return res.status(404).json({ error: 'Unknown task' });
    const maint = loadMaintenance();
    maint[req.params.task].lastDate = new Date().toISOString().split('T')[0];
    saveMaintenance(maint);
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

module.exports = router;
