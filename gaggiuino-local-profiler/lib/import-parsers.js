const cheerio = require('cheerio');
const { mapOriginToCode, findCountryInText } = require('./coffee-countries');

const today = () => new Date().toISOString().slice(0, 10);

// Maps Shopify shop tags to the roast type: both espresso and filter → omni.
function roastTypeFromTags(tags) {
    if (!Array.isArray(tags)) return '';
    const joined   = tags.join(' ').toLowerCase();
    const espresso = /espresso/.test(joined);
    const filter   = /filter/.test(joined);
    if (espresso && filter) return 'omni';
    if (espresso) return 'espresso';
    if (filter)   return 'filter';
    return '';
}

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

// ── Shopify shops (hoppenworth-ploch.de, elbgold.com) ─────────────────────
// Any pasted product URL is rewritten to Shopify's product JSON endpoint —
// far more robust than scraping the themed HTML page.
function shopifyJsonUrl(parsedUrl, host) {
    const m = parsedUrl.pathname.match(/\/products\/([a-z0-9-]+)/i);
    return m ? `https://${host}/products/${m[1]}.js` : null;
}

// Backwards-compatible alias used by existing call sites/tests.
function hoploJsonUrl(parsedUrl) {
    return shopifyJsonUrl(parsedUrl, 'hoppenworth-ploch.de');
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
    // Herkunft here is the growing region/district — structured field since #235.
    // When it is itself just a mappable country name, don't duplicate it.
    const region = fields['Herkunft'] && !mapOriginToCode(fields['Herkunft'])
        ? fields['Herkunft'] : null;
    return {
        name:       title,
        roaster:    product.vendor || 'Hoppenworth & Ploch',
        notes:      '',
        flavors:    splitFlavors(fields['Geschmack']),
        region,
        origin:     origin || null,
        variety:    fields['Varietät'] || null,
        process:    fields['Prozess'] || null,
        roastType:  roastTypeFromTags(product.tags) || null,
        decaf:      /\bdecaf\b/i.test(title) || undefined,
        source:     'hoppenworth-ploch.de',
        importedAt: today(),
    };
}

// ── elbgold.com (Shopify) ─────────────────────────────────────────────────
// No spec table — the description is German prose (Word-paste spans). All
// extraction is best-effort; the user reviews the pre-filled form anyway.
function parseElbgoldProduct(product) {
    const title = String(product?.title || '').trim();
    if (!title) return null;
    const $     = cheerio.load(product.description || '');
    const text  = $.text().replace(/\s+/g, ' ').trim();

    // "Herkunft – Sidama, Bensa, Bombe" lives in a <strong> heading
    let region = null;
    $('strong, b, h2, h3, h4').each((_, el) => {
        if (region) return;
        const t = $(el).text().replace(/\s+/g, ' ').trim();
        const m = t.match(/^Herkunft\s*[–—:-]\s*(.{2,80})$/);
        if (m) region = m[1].trim();
    });

    // "Noten von gerösteter Mandel, Kirsche und Nougat, mit …" → flavor tags
    let flavors = [];
    const notesMatch = text.match(/Noten von ([^.!?]{3,140})/i);
    if (notesMatch) {
        flavors = splitFlavors(notesMatch[1].replace(/\s+und\s+/gi, ','))
            .map(f => f.replace(/^mit\s+(einem|einer)?\s*/i, '').trim())
            .filter(f => f && f.length <= 40)
            .slice(0, 8);
    }

    const tagText = (product.tags || []).join(' ');
    // Title/region are the most specific country signal; fall back to the
    // full prose only when they name nothing (the single-match rule in
    // findCountryInText guards against blends either way).
    const origin = findCountryInText(`${title} ${region || ''}`)
        || findCountryInText(text);
    return {
        name:       title,
        roaster:    product.vendor || 'elbgold',
        notes:      '',
        flavors,
        region,
        origin:     origin || null,
        variety:    null,
        process:    null,
        roastType:  roastTypeFromTags(product.tags) || null,
        decaf:      /\bdecaf|entkoffeiniert\b/i.test(`${title} ${tagText}`) || undefined,
        source:     'elbgold.com',
        importedAt: today(),
    };
}

module.exports = { parseKaffeebraun, parseHoploProduct, parseElbgoldProduct, hoploJsonUrl, shopifyJsonUrl, splitFlavors, roastTypeFromTags };
