const express  = require('express');
const axios    = require('axios');
const router   = express.Router();

const { ALLOWED_IMPORT_HOSTS } = require('../lib/constants');
const { parseKaffeebraun, parseHoploProduct, hoploJsonUrl } = require('../lib/import-parsers');

const FETCH_OPTS = {
    headers: { 'User-Agent': 'GLP/1.0 (Gaggiuino Local Profiler; private use)' },
    timeout: 8000,
};

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
        if (parsed.hostname.endsWith('hoppenworth-ploch.de')) {
            const jsonUrl = hoploJsonUrl(parsed);
            if (!jsonUrl) return res.status(400).json({ error: 'not a product url' });
            const r = await axios.get(jsonUrl, FETCH_OPTS);
            bean = parseHoploProduct(r.data);
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
