const express = require('express');
const fs      = require('fs');
const router  = express.Router();

const { MAINTENANCE_FILE } = require('../lib/constants');
const { loadLibrary, saveLibrary } = require('../lib/data');
const { rateLimit, writeFileSafe } = require('../lib/helpers');

router.get('/api/library', (req, res) => {
    res.json(loadLibrary());
});

router.post('/api/library/bean', (req, res) => {
    if (!rateLimit(`lib:${req.ip}`, 30)) return res.status(429).json({ error: 'Rate limit exceeded' });
    const { name, roaster, roastDate, notes, stock_g, source, importedAt } = req.body;
    if (!name || typeof name !== 'string' || !name.trim())
        return res.status(400).json({ error: 'name required' });
    const s    = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
    const lib  = loadLibrary();
    const bean = {
        id: Date.now(), name: s(name, 200), roaster: s(roaster, 200),
        roastDate: s(roastDate, 10), notes: s(notes, 1000),
        stock_g: parseFloat(stock_g) || null,
    };
    if (source)     bean.source     = s(source, 200);
    if (importedAt) bean.importedAt = s(importedAt, 10);
    lib.beans.push(bean);
    saveLibrary(lib);
    res.json(bean);
});

router.put('/api/library/bean/:id', (req, res) => {
    const id  = parseInt(req.params.id, 10);
    const lib = loadLibrary();
    const idx = lib.beans.findIndex(b => b.id === id);
    if (idx === -1) return res.status(404).json({ error: 'not found' });
    const s = (v, max) => typeof v === 'string' ? v.trim().slice(0, max) : undefined;
    const { name, roaster, roastDate, notes, stock_g } = req.body;
    if (name !== undefined)      lib.beans[idx].name      = s(name, 200) || lib.beans[idx].name;
    if (roaster !== undefined)   lib.beans[idx].roaster   = s(roaster, 200);
    if (roastDate !== undefined) lib.beans[idx].roastDate = s(roastDate, 10);
    if (notes !== undefined)     lib.beans[idx].notes     = s(notes, 1000);
    if (stock_g !== undefined)   lib.beans[idx].stock_g   = parseFloat(stock_g) || null;
    saveLibrary(lib);
    res.json(lib.beans[idx]);
});

router.post('/api/library/bean/:id/delete', (req, res) => {
    const id  = parseInt(req.params.id, 10);
    const lib = loadLibrary();
    lib.beans = lib.beans.filter(b => b.id !== id);
    saveLibrary(lib);
    res.json({ ok: true });
});

router.post('/api/library/grinder', (req, res) => {
    if (!rateLimit(`lib:${req.ip}`, 30)) return res.status(429).json({ error: 'Rate limit exceeded' });
    const { name, notes } = req.body;
    if (!name || typeof name !== 'string' || !name.trim())
        return res.status(400).json({ error: 'name required' });
    const s       = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
    const lib     = loadLibrary();
    const grinder = { id: Date.now(), name: s(name, 200), notes: s(notes, 1000) };
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
    const { name, notes } = req.body;
    if (name  !== undefined) lib.grinders[idx].name  = s(name, 200) || lib.grinders[idx].name;
    if (notes !== undefined) lib.grinders[idx].notes = s(notes, 1000);
    saveLibrary(lib);
    res.json(lib.grinders[idx]);
});

router.post('/api/library/grinder/:id/delete', (req, res) => {
    const id  = parseInt(req.params.id, 10);
    const lib = loadLibrary();
    lib.grinders = lib.grinders.filter(g => g.id !== id);
    saveLibrary(lib);
    try {
        const maint = fs.existsSync(MAINTENANCE_FILE)
            ? JSON.parse(fs.readFileSync(MAINTENANCE_FILE, 'utf8')) : {};
        delete maint[`grinder_${id}`];
        writeFileSafe(MAINTENANCE_FILE, maint);
    } catch (e) {}
    res.json({ ok: true });
});

module.exports = router;
