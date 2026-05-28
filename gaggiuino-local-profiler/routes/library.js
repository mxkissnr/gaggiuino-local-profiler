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
    const { name, roaster, roastDate, notes, stock_g, decaf, source, importedAt } = req.body;
    if (!name || typeof name !== 'string' || !name.trim())
        return res.status(400).json({ error: 'name required' });
    const s    = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
    const lib  = loadLibrary();
    const parsedStock = parseFloat(stock_g) || null;
    const bean = {
        id: Date.now(), name: s(name, 200), roaster: s(roaster, 200),
        roastDate: s(roastDate, 10), notes: s(notes, 1000),
        stock_g: parsedStock,
        decaf: !!decaf,
        bags: parsedStock || s(roastDate, 10)
            ? [{ id: Date.now() + 1, roastDate: s(roastDate, 10), stock_g: parsedStock, openedAt: Date.now() }]
            : [],
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
    const { name, roaster, roastDate, notes, stock_g, decaf } = req.body;
    if (name !== undefined)      lib.beans[idx].name      = s(name, 200) || lib.beans[idx].name;
    if (roaster !== undefined)   lib.beans[idx].roaster   = s(roaster, 200);
    if (roastDate !== undefined) lib.beans[idx].roastDate = s(roastDate, 10);
    if (notes !== undefined)     lib.beans[idx].notes     = s(notes, 1000);
    if (stock_g !== undefined)   lib.beans[idx].stock_g   = parseFloat(stock_g) || null;
    if (decaf !== undefined)     lib.beans[idx].decaf     = !!decaf;
    // Keep active bag in sync with top-level fields
    if ((roastDate !== undefined || stock_g !== undefined) && lib.beans[idx].bags?.length) {
        const last = lib.beans[idx].bags[lib.beans[idx].bags.length - 1];
        if (roastDate !== undefined) last.roastDate = s(roastDate, 10);
        if (stock_g !== undefined)   last.stock_g   = parseFloat(stock_g) || null;
    }
    saveLibrary(lib);
    res.json(lib.beans[idx]);
});

router.post('/api/library/bean/:id/new-bag', (req, res) => {
    const id  = parseInt(req.params.id, 10);
    const lib = loadLibrary();
    const idx = lib.beans.findIndex(b => b.id === id);
    if (idx === -1) return res.status(404).json({ error: 'not found' });
    const s        = (v, max) => typeof v === 'string' ? v.trim().slice(0, max) : '';
    const roastDate = s(req.body?.roastDate, 10);
    const stock_g   = parseFloat(req.body?.stock_g) || null;
    const bag = { id: Date.now(), roastDate, stock_g, openedAt: Date.now() };
    if (!Array.isArray(lib.beans[idx].bags)) lib.beans[idx].bags = [];
    lib.beans[idx].bags.push(bag);
    lib.beans[idx].roastDate = roastDate;
    lib.beans[idx].stock_g   = stock_g;
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

// ── Recipes ───────────────────────────────────────────────────────────────

router.post('/api/library/recipe', (req, res) => {
    if (!rateLimit(`lib:${req.ip}`, 30)) return res.status(429).json({ error: 'Rate limit exceeded' });
    const { name, drinkType, targetDose_g, targetYield_g, targetTime_s, notes, profileName, beanName } = req.body;
    if (!name || typeof name !== 'string' || !name.trim())
        return res.status(400).json({ error: 'name required' });
    const s      = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
    const f      = v => parseFloat(v) || null;
    const lib    = loadLibrary();
    const recipe = {
        id: Date.now(), name: s(name, 200), drinkType: s(drinkType, 50),
        targetDose_g: f(targetDose_g), targetYield_g: f(targetYield_g), targetTime_s: f(targetTime_s),
        notes: s(notes, 1000), profileName: s(profileName, 200), beanName: s(beanName, 200),
    };
    if (!Array.isArray(lib.recipes)) lib.recipes = [];
    lib.recipes.push(recipe);
    saveLibrary(lib);
    res.json(recipe);
});

router.put('/api/library/recipe/:id', (req, res) => {
    const id  = parseInt(req.params.id, 10);
    const lib = loadLibrary();
    if (!Array.isArray(lib.recipes)) lib.recipes = [];
    const idx = lib.recipes.findIndex(r => r.id === id);
    if (idx === -1) return res.status(404).json({ error: 'not found' });
    const s = (v, max) => typeof v === 'string' ? v.trim().slice(0, max) : undefined;
    const f = v => v !== undefined ? (parseFloat(v) || null) : undefined;
    const { name, drinkType, targetDose_g, targetYield_g, targetTime_s, notes, profileName, beanName } = req.body;
    if (name !== undefined)         lib.recipes[idx].name         = s(name, 200) || lib.recipes[idx].name;
    if (drinkType !== undefined)    lib.recipes[idx].drinkType    = s(drinkType, 50);
    if (targetDose_g !== undefined) lib.recipes[idx].targetDose_g = f(targetDose_g);
    if (targetYield_g !== undefined)lib.recipes[idx].targetYield_g= f(targetYield_g);
    if (targetTime_s !== undefined) lib.recipes[idx].targetTime_s = f(targetTime_s);
    if (notes !== undefined)        lib.recipes[idx].notes        = s(notes, 1000);
    if (profileName !== undefined)  lib.recipes[idx].profileName  = s(profileName, 200);
    if (beanName !== undefined)     lib.recipes[idx].beanName     = s(beanName, 200);
    saveLibrary(lib);
    res.json(lib.recipes[idx]);
});

router.post('/api/library/recipe/:id/delete', (req, res) => {
    const id  = parseInt(req.params.id, 10);
    const lib = loadLibrary();
    if (!Array.isArray(lib.recipes)) lib.recipes = [];
    lib.recipes = lib.recipes.filter(r => r.id !== id);
    saveLibrary(lib);
    res.json({ ok: true });
});

module.exports = router;
