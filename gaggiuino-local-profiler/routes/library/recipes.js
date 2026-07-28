const { loadLibrary, saveLibrary } = require('../../lib/data');
const { rateLimit } = require('../../lib/helpers');

function _parseSteps(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.slice(0, 30).map(step => ({
        text:       typeof step.text === 'string' ? step.text.trim().slice(0, 500) : '',
        duration_s: parseFloat(step.duration_s) || null,
    })).filter(s => s.text);
}

const VALID_BREW_METHODS = ['espresso', 'aeropress', 'v60', 'french_press', 'moka', 'cold_brew', 'other'];

// Registers recipe routes onto a shared router — see routes/library/beans.js
// for why this isn't its own express.Router() mounted as a sub-router.
module.exports = function registerRecipeRoutes(router) {

router.post('/api/library/recipe', (req, res) => {
    if (!rateLimit(`lib:${req.ip}`, 30)) return res.status(429).json({ error: 'Rate limit exceeded' });
    const { name, brewMethod, drinkType, targetDose_g, targetYield_g, targetTime_s,
            waterTemp_c, water_g, ice_g, grindSize, notes, profileName, beanName, steps, sourceUrl } = req.body;
    if (!name || typeof name !== 'string' || !name.trim())
        return res.status(400).json({ error: 'name required' });
    const s      = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
    const f      = v => parseFloat(v) || null;
    const safeUrl = v => { if (!v) return ''; try { const u = new URL(v.trim()); return (u.protocol==='http:'||u.protocol==='https:') ? u.href : ''; } catch { return ''; } };
    const lib    = loadLibrary();
    const recipe = {
        id: Date.now(), name: s(name, 200),
        brewMethod:    VALID_BREW_METHODS.includes(brewMethod) ? brewMethod : 'other',
        drinkType:     s(drinkType, 50),
        targetDose_g:  f(targetDose_g), targetYield_g: f(targetYield_g), targetTime_s: f(targetTime_s),
        waterTemp_c:   f(waterTemp_c), water_g: f(water_g), ice_g: f(ice_g),
        grindSize:     s(grindSize, 200),
        sourceUrl:     safeUrl(sourceUrl),
        steps:         _parseSteps(steps),
        notes:         s(notes, 1000), profileName: s(profileName, 200), beanName: s(beanName, 200),
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
    const { name, brewMethod, drinkType, targetDose_g, targetYield_g, targetTime_s,
            waterTemp_c, water_g, ice_g, grindSize, notes, profileName, beanName, steps, sourceUrl } = req.body;
    const safeUrl = v => { if (!v) return ''; try { const u = new URL(v.trim()); return (u.protocol==='http:'||u.protocol==='https:') ? u.href : ''; } catch { return ''; } };
    if (name !== undefined)         lib.recipes[idx].name         = s(name, 200) || lib.recipes[idx].name;
    if (brewMethod !== undefined)   lib.recipes[idx].brewMethod   = VALID_BREW_METHODS.includes(brewMethod) ? brewMethod : 'other';
    if (drinkType !== undefined)    lib.recipes[idx].drinkType    = s(drinkType, 50);
    if (targetDose_g !== undefined) lib.recipes[idx].targetDose_g = f(targetDose_g);
    if (targetYield_g !== undefined)lib.recipes[idx].targetYield_g= f(targetYield_g);
    if (targetTime_s !== undefined) lib.recipes[idx].targetTime_s = f(targetTime_s);
    if (waterTemp_c !== undefined)  lib.recipes[idx].waterTemp_c  = f(waterTemp_c);
    if (water_g !== undefined)      lib.recipes[idx].water_g      = f(water_g);
    if (ice_g !== undefined)        lib.recipes[idx].ice_g        = f(ice_g);
    if (grindSize !== undefined)    lib.recipes[idx].grindSize    = s(grindSize, 200);
    if (sourceUrl !== undefined)    lib.recipes[idx].sourceUrl    = safeUrl(sourceUrl);
    if (steps !== undefined)        lib.recipes[idx].steps        = _parseSteps(steps);
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

};
