const express  = require('express');
const axios    = require('axios');
const cheerio  = require('cheerio');
const router   = express.Router();

const { ALLOWED_IMPORT_HOSTS } = require('../lib/constants');

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
        const r = await axios.get(raw, {
            headers: { 'User-Agent': 'GLP/1.0 (Gaggiuino Local Profiler; private use)' },
            timeout: 8000,
        });
        const $ = cheerio.load(r.data);
        const name = $('.product-detail-name').first().text().trim();
        if (!name) return res.status(404).json({ error: 'product not found on page' });
        const props = {};
        $('tr.properties-row').each((_, row) => {
            const key = $(row).find('th.properties-label').text().replace(':', '').trim();
            const val = $(row).find('td.properties-value span').map((_, el) => $(el).text().trim()).get().join(', ');
            if (key && val) props[key] = val;
        });
        const roastLabel = $('.degree.roest .description').first().text().trim();
        const roastScore = $('.degree.roest .value-score').first().text().trim();
        const noteParts  = [
            props['Aroma'],
            props['Herkunft']         ? `Herkunft: ${props['Herkunft']}`             : '',
            props['Aufbereitungsart'] ? `Aufbereitung: ${props['Aufbereitungsart']}` : '',
            roastLabel                ? `Röstgrad: ${roastLabel} (${roastScore}/5)`  : '',
        ].filter(Boolean);
        res.json({
            name,
            roaster:    'Kaffee Braun',
            notes:      noteParts.join(' · '),
            source:     'kaffeebraun.com',
            importedAt: new Date().toISOString().slice(0, 10),
        });
    } catch (e) {
        res.status(500).json({ error: 'fetch failed' });
    }
});

module.exports = router;
