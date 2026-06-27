const express  = require('express');
const router   = express.Router();

const shotService              = require('../lib/services/ShotService');
const { validate }             = require('../lib/middleware/validate');
const { annotationSchema }     = require('../lib/validation/schemas');
const { MAX_SHOT_ID }          = require('../lib/constants');
const { log }                  = require('../lib/helpers');
const { generateShareCard, isAvailable: cardAvailable } = require('../lib/card');

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
        res.json({ ...shot, score: shotService.computeScore(shot) });
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

module.exports = router;
