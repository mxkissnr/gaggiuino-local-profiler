const express      = require('express');
const router       = express.Router();
const shotService  = require('../lib/services/ShotService');
const libService   = require('../lib/services/LibraryService');
const { GLP_VERSION, MAX_SHOT_ID } = require('../lib/constants');
const { log, rateLimit }           = require('../lib/helpers');
const { getDb }                    = require('../lib/db');
const { annotationSchema }         = require('../lib/validation/schemas');
const { sanitizeBeanFields, sanitizeGrinderFields, sanitizeRecipeFields } = require('../lib/sanitize-bean');

// A restored coffee_library bypasses the regular POST/PUT bean/grinder/recipe
// routes entirely (it's written straight to the DB), so it never went through
// their field sanitizers — a crafted backup could otherwise inject
// unsanitized strings (e.g. into bean.notes/flavors) that later render
// unescaped in the frontend. Re-run the same per-field sanitizers here.
function sanitizeRestoredLibrary(lib) {
    if (!lib || typeof lib !== 'object') return lib;
    return {
        ...lib,
        beans:    Array.isArray(lib.beans) ? lib.beans.map(sanitizeBeanFields) : lib.beans,
        grinders: Array.isArray(lib.grinders) ? lib.grinders.map(sanitizeGrinderFields) : lib.grinders,
        recipes:  Array.isArray(lib.recipes) ? lib.recipes.map(sanitizeRecipeFields) : lib.recipes,
    };
}

router.get('/api/backup', (req, res, next) => {
    try {
        const shots = shotService.getAll();
        const trash = shotService.getTrash();
        const annotationsObj = Object.fromEntries(
            shots.map(s => [String(s.id), s.annotation]).filter(([, a]) => a && Object.keys(a).length)
        );
        const trashObj = Object.fromEntries(
            trash.map(s => {
                const row = getDb().prepare('SELECT deleted_at FROM trash WHERE shot_id = ?').get(s.id);
                return [String(s.id), row?.deleted_at ?? Date.now()];
            })
        );
        const bundle = {
            glp_backup:     true,
            version:        GLP_VERSION,
            created:        new Date().toISOString(),
            shots:          shots.map(({ annotation: _, score: __, ...rest }) => rest),
            annotations:    annotationsObj,
            coffee_library: libService.getLibrary(),
            blocklist:      shotService.getBlocklist(),
            trash:          trashObj,
        };
        const filename = `glp-backup-${new Date().toISOString().slice(0, 10)}.json`;
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.json(bundle);
    } catch (err) { next(err); }
});

router.post('/api/restore', (req, res, next) => {
    if (!rateLimit(`restore:${req.ip}`, 3)) return res.status(429).json({ error: 'Rate limit exceeded' });
    try {
        const b = req.body;
        if (!b || b.glp_backup !== true || !Array.isArray(b.shots))
            return res.status(400).json({ error: 'Invalid backup file' });
        if (b.shots.length > MAX_SHOT_ID)
            return res.status(400).json({ error: `Backup contains too many shots (max ${MAX_SHOT_ID})` });
        for (let i = 0; i < b.shots.length; i++) {
            const s = b.shots[i];
            if (s === null || typeof s !== 'object')
                return res.status(400).json({ error: `Backup shot #${i} is not a valid object` });
            if (!Number.isInteger(s.id) || s.id <= 0)
                return res.status(400).json({ error: `Backup shot #${i} has an invalid id (${s.id})` });
            if (typeof s.timestamp !== 'number')
                return res.status(400).json({ error: `Backup shot #${i} (id=${s.id}) has an invalid or missing timestamp` });
        }

        const db = getDb();
        db.transaction(() => {
            db.prepare('DELETE FROM shots').run();
            db.prepare('DELETE FROM annotations').run();
            db.prepare('DELETE FROM trash').run();
            db.prepare('DELETE FROM blocklist').run();

            for (const shot of b.shots) shotService.upsertShot(shot);
            if (b.annotations && typeof b.annotations === 'object') {
                for (const [id, ann] of Object.entries(b.annotations)) {
                    const parsed = annotationSchema.safeParse(ann);
                    if (parsed.success) shotService.saveAnnotation(parseInt(id), parsed.data);
                }
            }
            if (b.coffee_library) libService.saveLibrary(sanitizeRestoredLibrary(b.coffee_library));
            if (Array.isArray(b.blocklist)) shotService.saveBlocklist(b.blocklist.map(Number));
        })();

        log(`Restore completed from backup v${b.version || '?'} (${b.shots.length} shots)`);
        res.json({ ok: true, shots: b.shots.length });
    } catch (err) { next(err); }
});

module.exports = router;
