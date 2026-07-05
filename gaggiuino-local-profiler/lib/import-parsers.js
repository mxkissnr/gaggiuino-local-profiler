const cheerio = require('cheerio');
const { mapOriginToCode } = require('./coffee-countries');

const today = () => new Date().toISOString().slice(0, 10);

// Splits a tasting-notes string into flavor tags: separators , and ;, trailing
// parenthesized qualifiers ("Schwarzer Tee (Filter)") stripped, deduped.
function splitFlavors(text) {
    if (typeof text !== 'string') return [];
    const seen = new Set();
    const out  = [];
    for (const raw of text.split(/[;,]/)) {
        const s = raw.replace(/\s*\([^)]*\)\s*$/, '').trim();
        if (!s || s.length > 50) continue;
        const key = s.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(s);
    }
    return out;
}

// ── kaffeebraun.com (Shopware) ────────────────────────────────────────────
// Parses the product detail page HTML. Returns null when no product found.
function parseKaffeebraun(html) {
    const $ = cheerio.load(html);
    const name = $('.product-detail-name').first().text().trim();
    if (!name) return null;
    const props = {};
    $('tr.properties-row').each((_, row) => {
        const key = $(row).find('th.properties-label').text().replace(':', '').trim();
        const val = $(row).find('td.properties-value span').map((_, el) => $(el).text().trim()).get().filter(Boolean).join(', ');
        if (key && val) props[key] = val;
    });
    const roastLabel = $('.degree.roest .description').first().text().trim();
    const roastScore = $('.degree.roest .value-score').first().text().trim();
    // Herkunft maps to the structured origin field when it is a single known
    // country; blends/unknown strings stay in notes.
    const origin    = mapOriginToCode(props['Herkunft']);
    // Aroma becomes structured flavor tags; only the leftovers stay in notes.
    const noteParts = [
        props['Herkunft'] && !origin ? `Herkunft: ${props['Herkunft']}`            : '',
        roastLabel                   ? `Röstgrad: ${roastLabel} (${roastScore}/5)` : '',
    ].filter(Boolean);
    return {
        name,
        roaster:    'Kaffee Braun',
        notes:      noteParts.join(' · '),
        flavors:    splitFlavors(props['Aroma']),
        origin:     origin || null,
        variety:    props['Varietät'] || null,
        process:    props['Aufbereitungsart'] || null,
        source:     'kaffeebraun.com',
        importedAt: today(),
    };
}

// ── hoppenworth-ploch.de (Shopify) ────────────────────────────────────────
// Any pasted product URL is rewritten to Shopify's product JSON endpoint —
// far more robust than scraping the themed HTML page.
function hoploJsonUrl(parsedUrl) {
    const m = parsedUrl.pathname.match(/\/products\/([a-z0-9-]+)/i);
    return m ? `https://hoppenworth-ploch.de/products/${m[1]}.js` : null;
}

// Parses the Shopify product JSON. The description HTML carries a structured
// "Auf einen Blick" list (Geschmack / Prozess / Varietät / Herkunft = region);
// the country sits in the title pattern "Name - Land".
function parseHoploProduct(product) {
    const title = String(product?.title || '').trim();
    if (!title) return null;
    const $ = cheerio.load(product.description || '');
    const fields = {};
    $('li').each((_, el) => {
        if ($(el).find('li').length) return; // skip tab containers, keep leaf items
        const text = $(el).text().replace(/\s+/g, ' ').trim();
        const idx  = text.indexOf(':');
        if (idx <= 0 || idx > 30) return;
        const key = text.slice(0, idx).trim();
        const val = text.slice(idx + 1).trim();
        if (key && val && !fields[key]) fields[key] = val;
    });
    const countryPart = title.includes(' - ') ? title.split(' - ').pop().trim() : '';
    const origin      = mapOriginToCode(countryPart) || mapOriginToCode(fields['Herkunft']);
    // Geschmack becomes structured flavor tags; the growing region stays in notes.
    const noteParts   = [
        fields['Herkunft'] ? `Herkunft: ${fields['Herkunft']}` : '',
    ].filter(Boolean);
    return {
        name:       title,
        roaster:    product.vendor || 'Hoppenworth & Ploch',
        notes:      noteParts.join(' · '),
        flavors:    splitFlavors(fields['Geschmack']),
        origin:     origin || null,
        variety:    fields['Varietät'] || null,
        process:    fields['Prozess'] || null,
        decaf:      /\bdecaf\b/i.test(title) || undefined,
        source:     'hoppenworth-ploch.de',
        importedAt: today(),
    };
}

module.exports = { parseKaffeebraun, parseHoploProduct, hoploJsonUrl, splitFlavors };
