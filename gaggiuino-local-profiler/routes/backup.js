const express = require('express');
const fs      = require('fs');
const router  = express.Router();

const { GLP_VERSION, DATA_FILE, ANNOTATIONS_FILE, LIBRARY_FILE, BLOCKLIST_FILE, TRASH_FILE, MAX_SHOT_ID } = require('../lib/constants');
const { log, rateLimit, writeFileSafe } = require('../lib/helpers');

router.get('/api/backup', (req, res) => {
    try {
        const read = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; } };
        const bundle = {
            glp_backup:     true,
            version:        GLP_VERSION,
            created:        new Date().toISOString(),
            shots:          read(DATA_FILE, []),
            annotations:    read(ANNOTATIONS_FILE, {}),
            coffee_library: read(LIBRARY_FILE, { beans: [], grinders: [] }),
            blocklist:      read(BLOCKLIST_FILE, []),
            trash:          read(TRASH_FILE, {}),
        };
        const filename = `glp-backup-${new Date().toISOString().slice(0, 10)}.json`;
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Content-Type', 'application/json');
        res.json(bundle);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Note: /api/restore uses a 50mb body limit — registered before the global 16kb limit in server.js
router.post('/api/restore', (req, res) => {
    if (!rateLimit(`restore:${req.ip}`, 3)) return res.status(429).json({ error: 'Rate limit exceeded' });
    try {
        const b = req.body;
        if (!b || b.glp_backup !== true || !Array.isArray(b.shots))
            return res.status(400).json({ error: 'Invalid backup file' });
        if (b.shots.length > MAX_SHOT_ID)
            return res.status(400).json({ error: `Backup contains too many shots (max ${MAX_SHOT_ID})` });
        if (Array.isArray(b.shots))          writeFileSafe(DATA_FILE,       b.shots);
        if (b.annotations && typeof b.annotations === 'object')
                                             writeFileSafe(ANNOTATIONS_FILE, b.annotations);
        if (b.coffee_library && typeof b.coffee_library === 'object')
                                             writeFileSafe(LIBRARY_FILE,    b.coffee_library);
        if (Array.isArray(b.blocklist))      writeFileSafe(BLOCKLIST_FILE,  b.blocklist);
        if (b.trash && typeof b.trash === 'object')
                                             writeFileSafe(TRASH_FILE,      b.trash);
        log(`Restore completed from backup v${b.version || '?'} (${b.shots.length} shots)`);
        res.json({ ok: true, shots: b.shots.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
