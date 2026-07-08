const express = require('express');
const router  = express.Router();

const { loadLibrary, saveLibrary } = require('../lib/data');
const libraryService = require('../lib/services/LibraryService');
const { imagePath, CONTENT_TYPE_EXT, deleteBeanImage, deleteImage, saveUploadedImage } = require('../lib/services/ImageService');
const { BEAN_IMAGE_MAX_BYTES } = require('../lib/constants');
const { rateLimit } = require('../lib/helpers');
const {
    sanitizeOrigin, sanitizeOrigins, sanitizeRoastType, sanitizeFlavors,
    sanitizeAltitude, sanitizePrice, sanitizeBrewTemp, sanitizeBrewTime,
} = require('../lib/sanitize-bean');

router.get('/api/library', (req, res) => {
    res.json(loadLibrary());
});

// Lightweight bean metadata for external cards (shot card) — read-only,
// deliberately not behind the enable_orders guard.
router.get('/api/library/beans-info', (req, res, next) => {
    try { res.json(libraryService.getBeansInfo()); } catch (err) { next(err); }
});

router.post('/api/library/bean', (req, res) => {
    if (!rateLimit(`lib:${req.ip}`, 30)) return res.status(429).json({ error: 'Rate limit exceeded' });
    const { name, roaster, roastDate, notes, stock_g, decaf, origin, origins, variety, process, flavors, roastType, region, imageUrl,
        altitude_m, importer, harvest, price_eur, producer, certification, source, importedAt,
        brewTempC, brewRatio, brewTimeS, brewNotes, batchNumber } = req.body;
    if (!name || typeof name !== 'string' || !name.trim())
        return res.status(400).json({ error: 'name required' });
    const s    = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
    const lib  = loadLibrary();
    const parsedStock = parseFloat(stock_g) || null;
    // origins[] is the source of truth; a lone legacy `origin` string (e.g.
    // from the GLP QR import schema) is wrapped into a single-element array.
    let sanitizedOrigins = sanitizeOrigins(origins);
    if (!sanitizedOrigins.length) {
        const code = sanitizeOrigin(origin);
        if (code) sanitizedOrigins = [{ code }];
    }
    const bean = {
        id: Date.now(), name: s(name, 200), roaster: s(roaster, 200),
        roastDate: s(roastDate, 10), notes: s(notes, 1000),
        origin: sanitizedOrigins[0]?.code || '', origins: sanitizedOrigins,
        variety: s(variety, 200), process: s(process, 200),
        flavors: sanitizeFlavors(flavors),
        roastType: sanitizeRoastType(roastType),
        region: s(region, 200),
        altitude_m: sanitizeAltitude(altitude_m),
        importer: s(importer, 200), harvest: s(harvest, 50),
        price_eur: sanitizePrice(price_eur),
        producer: s(producer, 200), certification: s(certification, 200),
        brewTempC: sanitizeBrewTemp(brewTempC), brewRatio: s(brewRatio, 20),
        brewTimeS: sanitizeBrewTime(brewTimeS), brewNotes: s(brewNotes, 300),
        stock_g: parsedStock,
        decaf: !!decaf,
        bags: parsedStock || s(roastDate, 10) || s(batchNumber, 50)
            ? [{ id: Date.now() + 1, roastDate: s(roastDate, 10), stock_g: parsedStock, openedAt: Date.now(), batchNumber: s(batchNumber, 50) }]
            : [],
    };
    if (source)     bean.source     = s(source, 200);
    if (importedAt) bean.importedAt = s(importedAt, 10);
    lib.beans.push(bean);
    saveLibrary(lib);
    // fire-and-forget: resolve region to map coordinates, download the image
    if (bean.region) libraryService.geocodeBean(bean.id).catch(() => {});
    if (typeof imageUrl === 'string' && imageUrl) libraryService.setBeanImage(bean.id, imageUrl).catch(() => {});
    res.json(bean);
});

router.put('/api/library/bean/:id', (req, res) => {
    const id  = parseInt(req.params.id, 10);
    const lib = loadLibrary();
    const idx = lib.beans.findIndex(b => b.id === id);
    if (idx === -1) return res.status(404).json({ error: 'not found' });
    const s = (v, max) => typeof v === 'string' ? v.trim().slice(0, max) : undefined;
    const { name, roaster, roastDate, notes, stock_g, decaf, origin, origins, variety, process, flavors, roastType, region,
        altitude_m, importer, harvest, price_eur, producer, certification,
        brewTempC, brewRatio, brewTimeS, brewNotes, batchNumber } = req.body;
    if (name !== undefined)      lib.beans[idx].name      = s(name, 200) || lib.beans[idx].name;
    if (roaster !== undefined)   lib.beans[idx].roaster   = s(roaster, 200);
    if (roastDate !== undefined) lib.beans[idx].roastDate = s(roastDate, 10);
    if (notes !== undefined)     lib.beans[idx].notes     = s(notes, 1000);
    if (origins !== undefined) {
        lib.beans[idx].origins = sanitizeOrigins(origins);
        lib.beans[idx].origin  = lib.beans[idx].origins[0]?.code || '';
    } else if (origin !== undefined) {
        const code = sanitizeOrigin(origin);
        lib.beans[idx].origins = code ? [{ code }] : [];
        lib.beans[idx].origin  = code;
    }
    if (variety !== undefined)   lib.beans[idx].variety   = s(variety, 200) ?? '';
    if (process !== undefined)   lib.beans[idx].process   = s(process, 200) ?? '';
    if (flavors !== undefined)   lib.beans[idx].flavors   = sanitizeFlavors(flavors);
    if (roastType !== undefined) lib.beans[idx].roastType = sanitizeRoastType(roastType);
    if (altitude_m !== undefined)    lib.beans[idx].altitude_m    = sanitizeAltitude(altitude_m);
    if (importer !== undefined)      lib.beans[idx].importer      = s(importer, 200) ?? '';
    if (harvest !== undefined)       lib.beans[idx].harvest       = s(harvest, 50) ?? '';
    if (price_eur !== undefined)     lib.beans[idx].price_eur     = sanitizePrice(price_eur);
    if (producer !== undefined)      lib.beans[idx].producer      = s(producer, 200) ?? '';
    if (certification !== undefined) lib.beans[idx].certification = s(certification, 200) ?? '';
    if (brewTempC !== undefined) lib.beans[idx].brewTempC = sanitizeBrewTemp(brewTempC);
    if (brewRatio !== undefined) lib.beans[idx].brewRatio = s(brewRatio, 20) ?? '';
    if (brewTimeS !== undefined) lib.beans[idx].brewTimeS = sanitizeBrewTime(brewTimeS);
    if (brewNotes !== undefined) lib.beans[idx].brewNotes = s(brewNotes, 300) ?? '';
    let regionChanged = false;
    if (region !== undefined) {
        const newRegion = s(region, 200) ?? '';
        regionChanged = newRegion !== (lib.beans[idx].region || '');
        lib.beans[idx].region = newRegion;
        if (regionChanged) lib.beans[idx].location = null; // stale coords
    }
    if (stock_g !== undefined)   lib.beans[idx].stock_g   = parseFloat(stock_g) || null;
    if (decaf !== undefined)     lib.beans[idx].decaf     = !!decaf;
    // Keep active bag in sync with top-level fields
    if ((roastDate !== undefined || stock_g !== undefined || batchNumber !== undefined) && lib.beans[idx].bags?.length) {
        const last = lib.beans[idx].bags[lib.beans[idx].bags.length - 1];
        if (roastDate !== undefined)    last.roastDate   = s(roastDate, 10);
        if (stock_g !== undefined)      last.stock_g     = parseFloat(stock_g) || null;
        if (batchNumber !== undefined)  last.batchNumber = s(batchNumber, 50) ?? '';
    }
    saveLibrary(lib);
    if (regionChanged && lib.beans[idx].region) libraryService.geocodeBean(id).catch(() => {});
    res.json(lib.beans[idx]);
});

router.post('/api/library/bean/:id/new-bag', (req, res) => {
    const id  = parseInt(req.params.id, 10);
    const lib = loadLibrary();
    const idx = lib.beans.findIndex(b => b.id === id);
    if (idx === -1) return res.status(404).json({ error: 'not found' });
    const s        = (v, max) => typeof v === 'string' ? v.trim().slice(0, max) : '';
    const roastDate   = s(req.body?.roastDate, 10);
    const stock_g     = parseFloat(req.body?.stock_g) || null;
    const batchNumber = s(req.body?.batchNumber, 50);
    const bag = { id: Date.now(), roastDate, stock_g, openedAt: Date.now(), batchNumber };
    if (!Array.isArray(lib.beans[idx].bags)) lib.beans[idx].bags = [];
    lib.beans[idx].bags.push(bag);
    lib.beans[idx].roastDate = roastDate;
    lib.beans[idx].stock_g   = stock_g;
    saveLibrary(lib);
    res.json(lib.beans[idx]);
});

router.delete('/api/library/bean/:id/bag/:bagId', (req, res) => {
    const id    = parseInt(req.params.id, 10);
    const bagId = parseInt(req.params.bagId, 10);
    const lib   = loadLibrary();
    const bean  = lib.beans.find(b => b.id === id);
    if (!bean) return res.status(404).json({ error: 'not found' });
    if (!Array.isArray(bean.bags) || bean.bags.length <= 1)
        return res.status(400).json({ error: 'cannot delete last bag' });
    bean.bags = bean.bags.filter(bg => bg.id !== bagId);
    const last = bean.bags[bean.bags.length - 1];
    bean.roastDate = last.roastDate;
    bean.stock_g   = last.stock_g;
    saveLibrary(lib);
    res.json(bean);
});

router.post('/api/library/bean/:id/delete', (req, res) => {
    const id   = parseInt(req.params.id, 10);
    const lib  = loadLibrary();
    const bean = lib.beans.find(b => b.id === id);
    if (bean?.image) deleteBeanImage(id, bean.image);
    lib.beans = lib.beans.filter(b => b.id !== id);
    saveLibrary(lib);
    res.json({ ok: true });
});

// Serves a downloaded bean image (see LibraryService.setBeanImage). 404 when
// the bean has none. Filename is derived from the numeric id, never from a
// client-supplied path, so no traversal is possible.
const VALID_IMAGE_EXTS = new Set(Object.values(CONTENT_TYPE_EXT));

router.get('/api/library/bean/:id/image', (req, res) => {
    const id   = parseInt(req.params.id, 10);
    const lib  = loadLibrary();
    const bean = lib.beans.find(b => b.id === id);
    const ext  = bean?.image;
    if (!ext || !VALID_IMAGE_EXTS.has(ext)) return res.status(404).json({ error: 'no image' });
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.type(ext);
    res.sendFile(imagePath(id, ext), err => { if (err && !res.headersSent) res.status(404).json({ error: 'no image' }); });
});

// Manual upload fallback — the auto-import fetch (setBeanImage/fetchBeanImage)
// is fire-and-forget and can silently fail (redirect, unexpected content-type,
// timeout) with no visibility to the user. Mirrors the grinder photo upload
// route; no URL fetch here, so no SSRF surface.
router.post('/api/library/bean/:id/image',
    express.raw({ type: Object.keys(CONTENT_TYPE_EXT), limit: BEAN_IMAGE_MAX_BYTES }),
    (req, res) => {
        const id   = parseInt(req.params.id, 10);
        const lib  = loadLibrary();
        const bean = lib.beans.find(b => b.id === id);
        if (!bean) return res.status(404).json({ error: 'not found' });
        if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: 'no image data' });
        const ext = saveUploadedImage('', id, req.body, req.get('Content-Type'));
        if (!ext) return res.status(400).json({ error: 'unsupported image' });
        if (bean.image && bean.image !== ext) deleteBeanImage(id, bean.image);
        bean.image = ext;
        saveLibrary(lib);
        res.json(bean);
    });

// ── Milk ──────────────────────────────────────────────────────────────────

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

router.post('/api/library/grinder', (req, res) => {
    if (!rateLimit(`lib:${req.ip}`, 30)) return res.status(429).json({ error: 'Rate limit exceeded' });
    const { name, notes, burrType, purchaseDate } = req.body;
    if (!name || typeof name !== 'string' || !name.trim())
        return res.status(400).json({ error: 'name required' });
    const s       = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
    const lib     = loadLibrary();
    const grinder = {
        id: Date.now(), name: s(name, 200), notes: s(notes, 1000),
        burrType: s(burrType, 200), purchaseDate: s(purchaseDate, 10),
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
    const { name, notes, burrType, purchaseDate } = req.body;
    if (name         !== undefined) lib.grinders[idx].name         = s(name, 200) || lib.grinders[idx].name;
    if (notes        !== undefined) lib.grinders[idx].notes        = s(notes, 1000);
    if (burrType     !== undefined) lib.grinders[idx].burrType     = s(burrType, 200);
    if (purchaseDate !== undefined) lib.grinders[idx].purchaseDate = s(purchaseDate, 10);
    saveLibrary(lib);
    res.json(lib.grinders[idx]);
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
    } catch (e) {}
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

// ── Recipes ───────────────────────────────────────────────────────────────

function _parseSteps(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.slice(0, 30).map(step => ({
        text:       typeof step.text === 'string' ? step.text.trim().slice(0, 500) : '',
        duration_s: parseFloat(step.duration_s) || null,
    })).filter(s => s.text);
}

const VALID_BREW_METHODS = ['espresso', 'aeropress', 'v60', 'french_press', 'moka', 'cold_brew', 'other'];

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

module.exports = router;
