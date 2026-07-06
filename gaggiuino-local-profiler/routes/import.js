const express  = require('express');
const axios    = require('axios');
const router   = express.Router();

const { ALLOWED_IMPORT_HOSTS } = require('../lib/constants');
const { parseKaffeebraun, parseHoploProduct, parseElbgoldProduct, shopifyJsonUrl } = require('../lib/import-parsers');

const FETCH_OPTS = {
    headers: { 'User-Agent': 'GLP/1.0 (Gaggiuino Local Profiler; private use)' },
    timeout: 8000,
};

// Shopify variants often combine two option dimensions (e.g. size × grind
// type) — grind-type-only variants share the same price/weight, so a raw
// variant list would show duplicate entries for the same bag size. Dedupe by
// (price, weight) and label each with its size-relevant option (option1),
// not the full combined variant title.
function distinctSizeVariants(variants) {
    if (!Array.isArray(variants)) return [];
    const seen = new Map();
    for (const v of variants) {
        if (typeof v?.price !== 'number' || typeof v?.weight !== 'number') continue;
        const key = `${v.price}|${v.weight}`;
        if (seen.has(key)) continue;
        seen.set(key, {
            id: v.id, title: v.option1 || v.title || null,
            price: v.price, weight: v.weight,
            unit: v.unit_price_measurement?.quantity_unit || null,
        });
    }
    return [...seen.values()];
}

router.get('/api/import/url', async (req, res) => {
    const raw = req.query.url;
    if (!raw) return res.status(400).json({ error: 'url required' });
    let parsed;
    try { parsed = new URL(raw); } catch { return res.status(400).json({ error: 'invalid url' }); }
    if (!ALLOWED_IMPORT_HOSTS.includes(parsed.hostname))
        return res.status(400).json({ error: 'unsupported domain' });
    if (!['http:', 'https:'].includes(parsed.protocol))
        return res.status(400).json({ error: 'unsupported protocol' });
    try {
        let bean;
        const shopifyParser = parsed.hostname.endsWith('hoppenworth-ploch.de') ? parseHoploProduct
            : parsed.hostname.endsWith('elbgold.com') ? parseElbgoldProduct
            : null;
        if (shopifyParser) {
            const host    = parsed.hostname.replace(/^www\./, '');
            const jsonUrl = shopifyJsonUrl(parsed, host);
            if (!jsonUrl) return res.status(400).json({ error: 'not a product url' });
            const r = await axios.get(jsonUrl, FETCH_OPTS);
            bean = shopifyParser(r.data);
            if (bean) {
                const variants = distinctSizeVariants(r.data.variants);
                if (variants.length > 1) bean.variants = variants;
            }
        } else {
            const r = await axios.get(raw, FETCH_OPTS);
            bean = parseKaffeebraun(r.data);
        }
        if (!bean) return res.status(404).json({ error: 'product not found on page' });
        res.json(bean);
    } catch (e) {
        res.status(500).json({ error: 'fetch failed' });
    }
});

module.exports = router;
