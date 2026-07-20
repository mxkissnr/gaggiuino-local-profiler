const express  = require('express');
const router   = express.Router();

const shotService              = require('../lib/services/ShotService');
const libraryService           = require('../lib/services/LibraryService');
const { validate }             = require('../lib/middleware/validate');
const { annotationSchema }     = require('../lib/validation/schemas');
const { MAX_SHOT_ID, BEAN_IMAGE_MAX_BYTES } = require('../lib/constants');
const { log }                  = require('../lib/helpers');
const { generateShareCard, isAvailable: cardAvailable } = require('../lib/card');
const { imagePath, CONTENT_TYPE_EXT, deleteImage, saveUploadedImage } = require('../lib/services/ImageService');

const VALID_IMAGE_EXTS = new Set(Object.values(CONTENT_TYPE_EXT));

function parseId(param) {
    const id = parseInt(param, 10);
    return (isNaN(id) || id < 1 || id > MAX_SHOT_ID) ? null : id;
}

router.get('/shots.json', (req, res, next) => {
    try {
        const includeTrash = req.query.trash === '1';
        const shots = includeTrash ? shotService.getTrash() : shotService.getAll();
        const result = shots.map(s => ({ ...s, score: shotService.computeScore(s) }));
        res.json(result);
    } catch (err) { next(err); }
});

router.get('/api/shots/last', (req, res, next) => {
    try {
        const shots = shotService.getAll();
        const last  = shots.length ? shots[shots.length - 1] : null;
        if (!last) return res.json(null);
        res.json({ ...last, score: shotService.computeScore(last) });
    } catch (err) { next(err); }
});

router.get('/api/shots/:id', (req, res, next) => {
    try {
        const id   = parseId(req.params.id);
        if (!id) return res.json(null);
        const shot = shotService.getById(id);
        if (!shot) return res.json(null);
        // #402: same-profile auto-compare — additive fields only, existing
        // consumers of this response are unaffected.
        const previous = shotService.getPreviousByProfile(shot);
        res.json({
            ...shot,
            score: shotService.computeScore(shot),
            previousShotId: previous ? previous.id : null,
            previousShot:   previous ? { ...previous, score: shotService.computeScore(previous) } : null,
        });
    } catch (err) { next(err); }
});

router.get('/api/shots/:id/card', async (req, res, next) => {
    try {
        if (!cardAvailable()) return res.status(503).json({ error: 'card module not available' });
        const id = parseId(req.params.id);
        if (!id) return res.status(400).json({ error: 'Invalid shot ID' });
        const shot = shotService.getById(id);
        if (!shot) return res.status(404).json({ error: 'Shot not found' });
        const format = req.query.format === 'story' ? 'story' : 'square';
        const score  = shotService.computeScore(shot);
        const png    = await generateShareCard(shot, score, format);
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Content-Disposition', `inline; filename="glp-shot-${id}-${format}.png"`);
        res.send(png);
    } catch (err) { next(err); }
});

router.post('/api/shots/:id/annotate', validate(annotationSchema), (req, res, next) => {
    try {
        const id = parseId(req.params.id);
        if (!id) return res.status(400).json({ error: 'Invalid shot ID' });
        shotService.saveAnnotation(id, req.body);
        // fire-and-forget: never let a notification failure break the save
        libraryService.checkLowStockNotify(req.body?.coffee).catch(() => {});
        res.json({ ok: true });
    } catch (err) { next(err); }
});

router.post('/api/shots/:id/trash', (req, res, next) => {
    try {
        const id = parseId(req.params.id);
        if (!id) return res.status(400).json({ error: 'Invalid shot ID' });
        shotService.trashShot(id);
        log(`Shot ${id} moved to trash`);
        res.json({ ok: true });
    } catch (err) { next(err); }
});

router.post('/api/shots/:id/restore', (req, res, next) => {
    try {
        const id = parseId(req.params.id);
        if (!id) return res.status(400).json({ error: 'Invalid shot ID' });
        shotService.restoreShot(id);
        log(`Shot ${id} restored from trash`);
        res.json({ ok: true });
    } catch (err) { next(err); }
});

router.post('/api/shots/:id/delete', (req, res, next) => {
    try {
        const id = parseId(req.params.id);
        if (!id) return res.status(400).json({ error: 'Invalid shot ID' });
        const shot = shotService.getById(id);
        if (!shot) return res.status(404).json({ error: 'Shot not found' });
        shotService.permanentDelete(id);
        const bl = shotService.getBlocklist();
        if (!bl.includes(id)) shotService.saveBlocklist([...bl, id]);
        log(`Shot ${id} deleted (added to blocklist)`);
        res.json({ ok: true });
    } catch (err) { next(err); }
});

// Serves a shot photo (e.g. cup/crema picture) uploaded by the user. 404 when
// the shot has none. Filename is derived from the numeric id with a 'shot-'
// prefix, so it never collides with bean (no prefix) or grinder ('grinder-')
// images sharing BEAN_IMAGE_DIR — mirrors routes/library.js's bean/grinder
// image routes.
router.get('/api/shots/:id/image', (req, res) => {
    const id   = parseId(req.params.id);
    const shot = id ? shotService.getById(id) : null;
    const ext  = shot?.image;
    if (!ext || !VALID_IMAGE_EXTS.has(ext)) return res.status(404).json({ error: 'no image' });
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.type(ext);
    res.sendFile(imagePath(id, ext, 'shot-'), err => { if (err && !res.headersSent) res.status(404).json({ error: 'no image' }); });
});

// Direct upload from the user's device — same pattern as the bean/grinder
// photo upload routes. No URL fetch, so no SSRF surface; just the shared
// content-type whitelist and size cap.
router.post('/api/shots/:id/image',
    express.raw({ type: Object.keys(CONTENT_TYPE_EXT), limit: BEAN_IMAGE_MAX_BYTES }),
    (req, res) => {
        const id = parseId(req.params.id);
        if (!id) return res.status(400).json({ error: 'Invalid shot ID' });
        const shot = shotService.getById(id);
        if (!shot) return res.status(404).json({ error: 'Shot not found' });
        if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: 'no image data' });
        const ext = saveUploadedImage('shot-', id, req.body, req.get('Content-Type'));
        if (!ext) return res.status(400).json({ error: 'unsupported image' });
        if (shot.image && shot.image !== ext) deleteImage(id, shot.image, 'shot-');
        const updated = shotService.setImage(id, ext);
        res.json({ ...updated, score: shotService.computeScore(updated) });
    });

router.delete('/api/shots/:id/image', (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid shot ID' });
    const shot = shotService.getById(id);
    if (!shot) return res.status(404).json({ error: 'Shot not found' });
    if (shot.image) deleteImage(id, shot.image, 'shot-');
    const updated = shotService.clearImage(id);
    res.json({ ok: true, shot: updated });
});

module.exports = router;
