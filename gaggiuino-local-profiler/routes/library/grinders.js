const express = require('express');

const { loadLibrary, saveLibrary } = require('../../lib/data');
const libraryService = require('../../lib/services/LibraryService');
const { imagePath, CONTENT_TYPE_EXT, deleteImage, saveUploadedImage } = require('../../lib/services/ImageService');
const { BEAN_IMAGE_MAX_BYTES } = require('../../lib/constants');
const { rateLimit } = require('../../lib/helpers');

const VALID_IMAGE_EXTS = new Set(Object.values(CONTENT_TYPE_EXT));

// Registers grinder routes onto a shared router — see routes/library/beans.js
// for why this isn't its own express.Router() mounted as a sub-router.
module.exports = function registerGrinderRoutes(router) {

router.post('/api/library/grinder', (req, res) => {
    if (!rateLimit(`lib:${req.ip}`, 30)) return res.status(429).json({ error: 'Rate limit exceeded' });
    const { name, notes, burrType, purchaseDate, burrsResetAt } = req.body;
    if (!name || typeof name !== 'string' || !name.trim())
        return res.status(400).json({ error: 'name required' });
    const s       = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
    const lib     = loadLibrary();
    const grinder = {
        id: Date.now(), name: s(name, 200), notes: s(notes, 1000),
        burrType: s(burrType, 200), purchaseDate: s(purchaseDate, 10),
        // Burr wear starts counting from the purchase date if known, otherwise
        // from the beginning of time (no filter) until the first manual reset.
        burrsResetAt: s(burrsResetAt, 10) || s(purchaseDate, 10),
    };
    lib.grinders.push(grinder);
    saveLibrary(lib);
    res.json(grinder);
});

router.put('/api/library/grinder/:id', (req, res) => {
    const id  = parseInt(req.params.id, 10);
    const lib = loadLibrary();
    const idx = lib.grinders.findIndex(g => g.id === id);
    if (idx === -1) return res.status(404).json({ error: 'not found' });
    const s = (v, max) => typeof v === 'string' ? v.trim().slice(0, max) : undefined;
    const { name, notes, burrType, purchaseDate, burrsResetAt } = req.body;
    if (name         !== undefined) lib.grinders[idx].name         = s(name, 200) || lib.grinders[idx].name;
    if (notes        !== undefined) lib.grinders[idx].notes        = s(notes, 1000);
    if (burrType     !== undefined) lib.grinders[idx].burrType     = s(burrType, 200);
    if (purchaseDate !== undefined) lib.grinders[idx].purchaseDate = s(purchaseDate, 10);
    if (burrsResetAt !== undefined) lib.grinders[idx].burrsResetAt = s(burrsResetAt, 10);
    saveLibrary(lib);
    res.json(lib.grinders[idx]);
});

// Manual "burrs replaced" marker — resets the wear counter (shots/grams since
// last burr swap) to zero without touching the calendar-based cleaning
// maintenance system.
router.post('/api/library/grinder/:id/reset-burrs', (req, res) => {
    const id  = parseInt(req.params.id, 10);
    const lib = loadLibrary();
    const idx = lib.grinders.findIndex(g => g.id === id);
    if (idx === -1) return res.status(404).json({ error: 'not found' });
    lib.grinders[idx].burrsResetAt = new Date().toISOString();
    saveLibrary(lib);
    res.json({ ...lib.grinders[idx], wear: libraryService.computeGrinderWearStats(lib.grinders[idx]) });
});

router.post('/api/library/grinder/:id/delete', (req, res) => {
    const id      = parseInt(req.params.id, 10);
    const lib     = loadLibrary();
    const grinder = lib.grinders.find(g => g.id === id);
    if (grinder?.image) deleteImage(id, grinder.image, 'grinder-');
    lib.grinders = lib.grinders.filter(g => g.id !== id);
    saveLibrary(lib);
    try {
        const maint = libraryService.getMaintenance();
        if (`grinder_${id}` in maint) {
            delete maint[`grinder_${id}`];
            libraryService.saveMaintenance(maint);
        }
    } catch { /* ignore */ }
    res.json({ ok: true });
});

// Grinder photo — direct upload from the user's device (no URL import path
// exists for grinders, unlike beans). Body is the raw image bytes; the
// Content-Type header selects the extension and must match the same
// image-type whitelist beans use. No SSRF surface since there's no URL fetch.
router.post('/api/library/grinder/:id/image',
    express.raw({ type: Object.keys(CONTENT_TYPE_EXT), limit: BEAN_IMAGE_MAX_BYTES }),
    (req, res) => {
        const id      = parseInt(req.params.id, 10);
        const lib     = loadLibrary();
        const grinder = lib.grinders.find(g => g.id === id);
        if (!grinder) return res.status(404).json({ error: 'not found' });
        if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: 'no image data' });
        const ext = saveUploadedImage('grinder-', id, req.body, req.get('Content-Type'));
        if (!ext) return res.status(400).json({ error: 'unsupported image' });
        if (grinder.image && grinder.image !== ext) deleteImage(id, grinder.image, 'grinder-');
        grinder.image = ext;
        saveLibrary(lib);
        res.json(grinder);
    });

router.get('/api/library/grinder/:id/image', (req, res) => {
    const id      = parseInt(req.params.id, 10);
    const lib     = loadLibrary();
    const grinder = lib.grinders.find(g => g.id === id);
    const ext     = grinder?.image;
    if (!ext || !VALID_IMAGE_EXTS.has(ext)) return res.status(404).json({ error: 'no image' });
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.type(ext);
    res.sendFile(imagePath(id, ext, 'grinder-'), err => { if (err && !res.headersSent) res.status(404).json({ error: 'no image' }); });
});

};
