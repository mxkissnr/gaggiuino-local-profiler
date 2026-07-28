const { loadLibrary, saveLibrary } = require('../../lib/data');
const { rateLimit } = require('../../lib/helpers');

// Registers milk routes onto a shared router — see routes/library/beans.js
// for why this isn't its own express.Router() mounted as a sub-router.
module.exports = function registerMilkRoutes(router) {

router.get('/api/library/milks', (req, res) => {
    const lib = loadLibrary();
    res.json((lib.milks || []).map(m => ({ id: m.id, name: m.name, emoji: m.emoji || '🥛', stockMl: m.stockMl })));
});

router.post('/api/library/milk/:id/deduct', (req, res) => {
    const id  = parseInt(req.params.id, 10);
    const ml  = parseFloat(req.body?.ml) || 0;
    if (ml <= 0) return res.status(400).json({ error: 'ml must be positive' });
    const lib  = loadLibrary();
    const milk = lib.milks?.find(m => m.id === id);
    if (!milk) return res.status(404).json({ error: 'not found' });
    milk.stockMl   = Math.max(0, (milk.stockMl || 0) - ml);
    milk.updatedAt = Date.now();
    saveLibrary(lib);
    res.json(milk);
});

router.post('/api/library/milk', (req, res) => {
    if (!rateLimit(`lib:${req.ip}`, 30)) return res.status(429).json({ error: 'Rate limit exceeded' });
    const { name, emoji, stockMl } = req.body || {};
    if (!name?.trim()) return res.status(400).json({ error: 'name required' });
    const lib  = loadLibrary();
    const milk = { id: Date.now(), name: String(name).trim().slice(0, 100),
                   emoji: emoji?.trim() || '🥛', stockMl: parseFloat(stockMl) || 0, updatedAt: Date.now() };
    lib.milks.push(milk);
    saveLibrary(lib);
    res.json(milk);
});

router.put('/api/library/milk/:id', (req, res) => {
    const id  = parseInt(req.params.id, 10);
    const lib = loadLibrary();
    const idx = lib.milks.findIndex(m => m.id === id);
    if (idx === -1) return res.status(404).json({ error: 'not found' });
    const { name, emoji, stockMl } = req.body || {};
    if (name  !== undefined) lib.milks[idx].name    = String(name).trim().slice(0, 100) || lib.milks[idx].name;
    if (emoji !== undefined) lib.milks[idx].emoji   = String(emoji).trim() || lib.milks[idx].emoji;
    if (stockMl !== undefined) lib.milks[idx].stockMl = parseFloat(stockMl) || 0;
    lib.milks[idx].updatedAt = Date.now();
    saveLibrary(lib);
    res.json(lib.milks[idx]);
});

router.delete('/api/library/milk/:id', (req, res) => {
    const id  = parseInt(req.params.id, 10);
    const lib = loadLibrary();
    lib.milks = lib.milks.filter(m => m.id !== id);
    saveLibrary(lib);
    res.json({ ok: true });
});

};
