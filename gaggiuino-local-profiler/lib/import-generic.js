// Fallback parsers tried, in order, for any shop that isn't one of the
// built-in registry entries (lib/import-providers.js): generic Shopify
// product JSON, JSON-LD Product markup, then OpenGraph/HTML meta tags.
// All three are best-effort — the user reviews the pre-filled bean form
// regardless, and the frontend shows which method produced the data.
const cheerio = require('cheerio');
const { findCountriesInText } = require('./coffee-countries');
const {
    matchFlavorTerms, normalizeImageUrl, priceFromProduct,
    roastTypeFromTags, extractAltitudeM, splitFlavors,
} = require('./import-parsers');

const today = () => new Date().toISOString().slice(0, 10);

// Some Shopify shops misuse the vendor field for an internal taxonomy tag
// (e.g. "Taste Profile_Fruity") or a bare lowercase descriptor word
// ("adventurous") instead of the actual roaster name (#400, verified against
// sproutcoffeeroasters.art) — neither reads as a brand, so the caller should
// fall back to something more useful (the shop's own domain) instead of
// showing that nonsense as the roaster. A single lowercase word is still
// trusted when it's also part of the shop's own domain (e.g. vendor
// "elbgold" on elbgold.com) — that reads as an actual lowercase-styled
// brand, not a taxonomy tag that slipped into the vendor field.
function looksLikeRoasterName(vendor, host = null) {
    if (typeof vendor !== 'string') return false;
    const v = vendor.trim();
    if (!v) return false;
    if (v.includes('_')) return false; // shop-tag style, e.g. "Taste Profile_Fruity"
    if (/^[a-z]+$/.test(v)) return typeof host === 'string' && host.toLowerCase().includes(v.toLowerCase());
    return true;
}

// Some shops encode roast type as a buyable variant option (e.g. a "Profile"
// option with values Espresso/Filter) rather than — or more reliably than —
// the shop's own tags taxonomy. Verified against sproutcoffeeroasters.art:
// its tags include "Roast_Omni" for every product regardless of which roast
// styles are actually purchasable, while the "Profile" option only lists the
// variants that exist. Prefer an options entry whose name suggests roast
// profile; fall back to tags when no such option exists.
function roastTypeFromProduct(product) {
    const options = Array.isArray(product?.options) ? product.options : [];
    const profileOption = options.find(o => /profile|roast/i.test(o?.name || ''));
    if (profileOption && Array.isArray(profileOption.values) && profileOption.values.length) {
        const fromOptions = roastTypeFromTags(profileOption.values);
        if (fromOptions) return fromOptions;
    }
    return roastTypeFromTags(product?.tags);
}

// Any Shopify storefront exposes this endpoint for a product page — no
// shop-specific spec-table parsing, just title/vendor/description/price/image
// plus best-effort flavor & origin extraction from the description prose.
// `host` (the shop's own domain, already known to the caller) is the roaster
// fallback when the vendor field doesn't look like a real roaster name.
function parseGenericShopifyProduct(product, host = null) {
    const title = String(product?.title || '').trim();
    if (!title) return null;
    const $    = cheerio.load(product.description || '');
    const text = $.text().replace(/\s+/g, ' ').trim();
    const originCodes = findCountriesInText(`${title} ${text}`);
    const vendor = typeof product?.vendor === 'string' ? product.vendor.trim() : '';
    return {
        name:       title,
        roaster:    looksLikeRoasterName(vendor, host) ? vendor : (host || null),
        notes:      '',
        flavors:    matchFlavorTerms(text),
        origin:     originCodes[0] || null,
        origins:    originCodes.map(code => ({ code })),
        roastType:  roastTypeFromProduct(product) || null,
        imageUrl:   normalizeImageUrl(product.featured_image),
        price_eur:  priceFromProduct(product),
        importedAt: today(),
    };
}

function firstProductNode(json) {
    const roots = Array.isArray(json) ? json : (Array.isArray(json['@graph']) ? json['@graph'] : [json]);
    for (const node of roots) {
        const type = node && node['@type'];
        if (type === 'Product' || (Array.isArray(type) && type.includes('Product'))) return node;
    }
    return null;
}

// Scans <script type="application/ld+json"> blocks for a schema.org Product.
function parseJsonLd(html) {
    const $ = cheerio.load(html);
    let product = null;
    $('script[type="application/ld+json"]').each((_, el) => {
        if (product) return;
        let json;
        try { json = JSON.parse($(el).contents().text()); } catch { return; }
        product = firstProductNode(json);
    });
    if (!product) return null;
    const name = String(product.name || '').trim();
    if (!name) return null;
    const description = String(product.description || '').trim();
    const image  = Array.isArray(product.image) ? product.image[0] : product.image;
    const offers = Array.isArray(product.offers) ? product.offers[0] : product.offers;
    let price = null;
    if (offers && offers.price != null) {
        const p = parseFloat(offers.price);
        if (!Number.isNaN(p)) price = p;
    }
    const brand = product.brand && (product.brand.name || product.brand);
    const text  = `${name} ${description}`;
    const originCodes = findCountriesInText(text);
    return {
        name,
        roaster:    typeof brand === 'string' ? brand : null,
        notes:      description.slice(0, 500),
        flavors:    matchFlavorTerms(text),
        origin:     originCodes[0] || null,
        origins:    originCodes.map(code => ({ code })),
        imageUrl:   normalizeImageUrl(image),
        price_eur:  price,
        importedAt: today(),
    };
}

// Meta text below this length is considered too thin to reliably carry
// origin/flavor info — worth also scanning the visible page body (see
// BODY_SCAN_MAX_CHARS below).
const THIN_TEXT_CHARS = 80;
// Caps how much of the page body we scan for origin/flavor keywords, to
// avoid pulling in unrelated nav/footer/chrome text from arbitrary shops.
const BODY_SCAN_MAX_CHARS = 5000;

// Visible body text used as a fallback when meta tags are too thin. Prefers
// <main>/<article> (common product-description containers) over the whole
// <body> when one is present and non-trivial, to reduce nav/footer noise.
function bodyScanText($) {
    let $scope = $('main, article').first();
    if (!$scope.length || $scope.text().trim().length < THIN_TEXT_CHARS) $scope = $('body');
    return $scope.text().replace(/\s+/g, ' ').trim().slice(0, BODY_SCAN_MAX_CHARS);
}

// Merges a fallback list into a primary list, keeping the primary's items
// first and only appending genuinely new (case-insensitive) entries — so a
// meta-only hit is never discarded, just possibly extended by the body scan.
function mergeUnique(primary, fallback, max) {
    const seen = new Set(primary.map(v => v.toLowerCase()));
    const merged = [...primary];
    for (const v of fallback) {
        const key = v.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(v);
    }
    return typeof max === 'number' ? merged.slice(0, max) : merged;
}

// Last-resort fallback: og:title/og:image/og:description meta tags, which
// virtually every storefront (of any platform) sets for product pages.
function parseOpenGraph(html) {
    const $     = cheerio.load(html);
    const title = $('meta[property="og:title"]').attr('content')?.trim();
    if (!title) return null;
    const description = $('meta[property="og:description"]').attr('content')?.trim() || '';
    const image     = $('meta[property="og:image"]').attr('content');
    const siteName  = $('meta[property="og:site_name"]').attr('content')?.trim();
    const priceRaw  = $('meta[property="og:price:amount"]').attr('content')
        ?? $('meta[property="product:price:amount"]').attr('content');
    let price_eur = null;
    if (priceRaw != null) {
        const p = parseFloat(priceRaw);
        if (!Number.isNaN(p)) price_eur = p;
    }

    const text = `${title} ${description}`;
    let originCodes = findCountriesInText(text);
    let flavors     = matchFlavorTerms(text);

    // Meta description is often too short/generic to carry any tasting-note
    // or origin info — fall back to scanning the visible page body, which is
    // where most roaster pages actually put that prose.
    if (text.trim().length < THIN_TEXT_CHARS || (!originCodes.length && !flavors.length)) {
        const bodyText = bodyScanText($);
        if (bodyText) {
            const combined     = `${title} ${bodyText}`;
            const bodyOrigins  = findCountriesInText(combined);
            const bodyFlavors  = matchFlavorTerms(combined);
            originCodes = mergeUnique(originCodes, bodyOrigins);
            flavors     = mergeUnique(flavors, bodyFlavors, 8);
        }
    }

    return {
        name:       title,
        roaster:    siteName || null,
        notes:      description.slice(0, 500),
        flavors,
        origin:     originCodes[0] || null,
        origins:    originCodes.map(code => ({ code })),
        imageUrl:   normalizeImageUrl(image),
        price_eur,
        importedAt: today(),
    };
}

// ── HTML-only bean-detail enrichment ────────────────────────────────────────
// Some Shopify themes render bean detail (process/variety/producer/origin/
// elevation/tasting-notes/brew-guide) only into the product page's HTML, not
// the /products/<handle>.js JSON that parseGenericShopifyProduct reads
// (verified against sproutcoffeeroasters.art, #423). These helpers are
// best-effort HTML scrapers with no shop-specific markup assumptions beyond
// generic patterns (a <details> accordion, an h1 title with a short
// subtitle) — the caller only uses their output to fill in fields the JSON
// left empty.

// A tasting-notes subtitle often sits as a short text block immediately
// after the <h1> title, before any price/variant markup — e.g. Sprout's
// "White Peach, Strawberry, Jasmine" h4. Heuristic: the first non-empty
// sibling after the h1's wrapping block, as long as it reads like a short
// comma-separated list (no sentence-ending punctuation) rather than prose.
function extractTastingNotesSubtitle($) {
    const $h1 = $('h1').first();
    if (!$h1.length) return null;
    let $block = $h1.closest('div');
    if (!$block.length) return null;
    let $sib = $block.next();
    while ($sib.length) {
        const text = $sib.text().replace(/\s+/g, ' ').trim();
        if (!text) { $sib = $sib.next(); continue; }
        return (text.length <= 100 && !/[.!?]/.test(text)) ? text : null;
    }
    return null;
}

// Converts block-level line breaks into literal "\n" before reading .text() —
// cheerio's plain .text() concatenates adjacent block content with NO
// separator at all when the source HTML has no incidental whitespace between
// tags (common with minified themes), silently running lines together (e.g.
// "EspressoIn: 19.7gOut: 48g" instead of three separate lines, #433). Used
// everywhere multi-line accordion/metafield content is read.
function textWithLineBreaks($, $el) {
    const $clone = $el.clone();
    $clone.find('br, p, div, li, h1, h2, h3, h4, h5, h6, tr').after('\n');
    return $clone.text();
}

// Label→bean-field map for the "Label - Value" / "Label: Value" lines found
// in spec/detail accordions (any separator among -, –, —, :). Covers the
// English labels seen on sproutcoffeeroasters.art plus German synonyms used
// by other shops' equivalent accordions.
const ACCORDION_LABEL_FIELDS = {
    process: 'process', prozess: 'process',
    variety: 'variety', varietal: 'variety', cultivar: 'variety', sorte: 'variety',
    producer: 'producer', erzeuger: 'producer', produzent: 'producer',
    origin: 'region', region: 'region', terroir: 'region', herkunft: 'region', ursprung: 'region',
    elevation: 'altitude_m', altitude: 'altitude_m', 'höhe': 'altitude_m', hoehe: 'altitude_m', lage: 'altitude_m',
};
const ACCORDION_LABEL_RE = new RegExp(
    `^(${Object.keys(ACCORDION_LABEL_FIELDS).join('|')})\\s*[-–—:]\\s*(.+)$`, 'i'
);

// Text lines within an accordion's content block, deduped: one entry per <p>
// (covers shops that lay out each label/value pair in its own paragraph with
// no separating whitespace, like Sprout's Details accordion) plus one entry
// per <br>-delimited line (covers shops that use a single block of <br>-
// joined lines instead, like Sprout's own Brew Guide accordion).
function accordionLines($, $content) {
    const lines = new Set();
    for (const raw of textWithLineBreaks($, $content).split('\n')) {
        const t = raw.replace(/[ \t]+/g, ' ').trim();
        if (t) lines.add(t);
    }
    return [...lines];
}

// Scans every <details> accordion's content for "Label - Value" lines and
// maps recognized labels to bean fields. Not scoped to any one accordion
// name ("Details") — any accordion can carry these lines.
function scanAccordionLabelValues($) {
    const fields = {};
    $('details').each((_, el) => {
        const $content = $(el).find('.details-content').first();
        if (!$content.length) return;
        for (const line of accordionLines($, $content)) {
            const m = line.match(ACCORDION_LABEL_RE);
            if (!m) continue;
            const field = ACCORDION_LABEL_FIELDS[m[1].toLowerCase()];
            const value = m[2].trim();
            if (!field || !value || fields[field]) continue;
            fields[field] = field === 'altitude_m' ? extractAltitudeM(value) : value;
        }
    });
    return fields;
}

// Keys that make a block of lines read as an espresso brew recipe (In/Out/
// Time/Ratio/Temp) rather than unrelated prose. Requiring 3-of-5 keeps this
// generic instead of hard-coding an exact recipe shape.
const BREW_RECIPE_KEY_RE = /^(In|Out|Time|Ratio|Temp)\s*:/i;

// Numeric range midpoint, e.g. "92-93" -> 92.5, "27-29 seconds" -> 28. Mirrors
// extractAltitudeM's own range-averaging convention (see above) so brew-guide
// ranges resolve the same way altitude ranges already do elsewhere in this
// file. A single number ("94 Celsius") passes through unchanged.
function _rangeMidpoint(raw) {
    if (!raw) return null;
    const nums = (raw.match(/\d+(?:\.\d+)?/g) || []).map(Number);
    if (!nums.length) return null;
    return nums.length > 1 ? (nums[0] + nums[1]) / 2 : nums[0];
}

// "1 - 2.4" -> "1:2.4" — the ratio line's two numbers are the dose:yield pair
// itself, not a min/max range to average, so this only reformats the
// separator to match the bean form's own brewRatio convention ("1:2.2").
function _ratioLabel(raw) {
    if (!raw) return null;
    const nums = raw.match(/\d+(?:\.\d+)?/g);
    return nums && nums.length >= 2 ? `${nums[0]}:${nums[1]}` : null;
}

function _brewLineValue(lines, key) {
    const re = new RegExp(`^${key}\\s*:\\s*(.+)$`, 'i');
    for (const line of lines) {
        const m = line.match(re);
        if (m) return m[1].trim();
    }
    return null;
}

// Finds an accordion whose heading matches /brew\s*guide/i, splits its
// content into heading-delimited blocks (a heading is a short line with no
// colon, not itself a recipe key/value line), and extracts both the plain
// espresso recipe's full text (heading exactly "espresso", falling back to
// the first block with >=3 recipe keys — never the "Milky Espresso" or "Pour
// Over" variants also commonly present) and its structured Temp/Time/Ratio
// values, plus a general prep/caveat sentence: the first free-text line found
// anywhere in the accordion, not scoped to the chosen block (verified against
// sproutcoffeeroasters.art, #433: the pre-infusion caveat sentence sits under
// "Milky Espresso"'s lines, not "Espresso"'s, but reads as a general machine
// note that applies regardless of which recipe block it's nested under).
function extractEspressoBrewGuide($) {
    let $content = null;
    $('details').each((_, el) => {
        if ($content) return;
        const $summary = $(el).find('summary').first().clone();
        $summary.find('span').remove();
        if (/brew\s*guide/i.test($summary.text().trim())) {
            $content = $(el).find('.details-content').first();
        }
    });
    if (!$content || !$content.length) return null;

    const lines = textWithLineBreaks($, $content).split('\n').map(l => l.replace(/[ \t]+/g, ' ').trim());

    const blocks = [];
    let current = null;
    let prepNote = null;
    for (const line of lines) {
        if (!line) continue;
        const isKeyLine = BREW_RECIPE_KEY_RE.test(line);
        const isHeading = !isKeyLine && line.length <= 40 && !/[.!?]$/.test(line);
        if (isHeading) {
            if (current) blocks.push(current);
            current = { heading: line, lines: [] };
            continue;
        }
        if (current) current.lines.push(line);
        if (!prepNote && !isKeyLine && line.length > 40) prepNote = line;
    }
    if (current) blocks.push(current);

    const candidates = blocks
        .map(b => ({ ...b, keyCount: new Set(b.lines.map(l => (l.match(BREW_RECIPE_KEY_RE) || [])[1]).filter(Boolean).map(k => k.toLowerCase())).size }))
        .filter(b => b.keyCount >= 3);
    if (!candidates.length) return null;
    const chosen = candidates.find(b => /^espresso$/i.test(b.heading)) || candidates[0];

    const timeMid = _rangeMidpoint(_brewLineValue(chosen.lines, 'Time'));
    return {
        text:      `${chosen.heading}\n${chosen.lines.join('\n')}`.trim(),
        brewTempC: _rangeMidpoint(_brewLineValue(chosen.lines, 'Temp')),
        brewTimeS: timeMid == null ? null : Math.round(timeMid),
        brewRatio: _ratioLabel(_brewLineValue(chosen.lines, 'Ratio')),
        brewNotes: prepNote,
    };
}

// Shopify themes commonly set the header logo's alt text to the shop's
// display name (often suffixed " - Home" for accessibility) — a fallback
// roaster-name signal for when og:site_name is absent (verified against
// sproutcoffeeroasters.art, #433: this theme's static HTML sets neither
// og:site_name nor a usable <title>, but does set the logo alt text).
function shopNameFromLogoAlt($) {
    const alt = $('.header-logo__image, .header-logo img, .site-header__logo img').first().attr('alt');
    if (typeof alt !== 'string') return null;
    const cleaned = alt.replace(/\s*[-–—]\s*Home\s*$/i, '').trim();
    return cleaned || null;
}

// Fills in process/variety/producer/region/altitude_m/flavors/notes/brew
// fields/roaster on a JSON-derived bean from the fetched product-page HTML,
// but only for fields the JSON left empty (or, for roaster, only when the
// JSON fell back to the shop hostname) — an HTML-only signal never overwrites
// a real JSON one. roastType is deliberately not touched here: it's fully
// derivable from the JSON's own options/tags (see roastTypeFromProduct
// above), so there is no HTML-only roastType signal to add. `host` (the
// shop's own domain) is optional — passed by the caller when known, so the
// roaster fallback can tell "vendor field fell back to the hostname" apart
// from "vendor field genuinely IS this lowercase-styled name".
function enrichGenericBeanFromHtml(bean, html, host = null) {
    if (!bean || typeof html !== 'string' || !html.trim()) return bean;
    const $ = cheerio.load(html);
    const out = { ...bean };

    const subtitle = extractTastingNotesSubtitle($);
    if (subtitle) out.flavors = mergeUnique(bean.flavors || [], splitFlavors(subtitle), 8);

    const fields = scanAccordionLabelValues($);
    if (!out.process && fields.process) out.process = fields.process;
    if (!out.variety && fields.variety) out.variety = fields.variety;
    if (!out.producer && fields.producer) out.producer = fields.producer;
    if (!out.region && fields.region) out.region = fields.region;
    if (!out.altitude_m && fields.altitude_m != null) out.altitude_m = fields.altitude_m;

    if (fields.region) {
        const extraCodes = findCountriesInText(fields.region);
        if (extraCodes.length) {
            const existing = Array.isArray(out.origins) ? out.origins : [];
            const have = new Set(existing.map(o => o.code));
            const merged = [...existing];
            for (const code of extraCodes) {
                if (have.has(code)) continue;
                have.add(code);
                merged.push({ code });
            }
            out.origins = merged;
            if (!out.origin) out.origin = merged[0]?.code || null;
        }
    }

    // Roaster fallback (#433): only when the JSON parse had nothing usable
    // (vendor missing, or a taxonomy-tag/domain-fallback value equal to the
    // hostname itself) — a real vendor-derived name is never overwritten.
    if (!out.roaster || (host && out.roaster.toLowerCase() === host.toLowerCase())) {
        const siteName = $('meta[property="og:site_name"]').attr('content')?.trim() || shopNameFromLogoAlt($);
        if (siteName && looksLikeRoasterName(siteName, host)) out.roaster = siteName;
    }

    const brewGuide = extractEspressoBrewGuide($);
    if (brewGuide) {
        if (!out.notes) out.notes = `Roaster brew guide (espresso): ${brewGuide.text}`.trim();
        if (out.brewTempC == null && brewGuide.brewTempC != null) out.brewTempC = brewGuide.brewTempC;
        if (out.brewTimeS == null && brewGuide.brewTimeS != null) out.brewTimeS = brewGuide.brewTimeS;
        if (!out.brewRatio && brewGuide.brewRatio) out.brewRatio = brewGuide.brewRatio;
        if (!out.brewNotes && brewGuide.brewNotes) out.brewNotes = brewGuide.brewNotes;
    }

    return out;
}

// Case-insensitive match against a candidate's sourceUrl (exact) or its
// name+roaster combination — used to warn (non-blockingly) that an import
// looks like a bean already in the library. Returns the matching bean, or
// null.
function findDuplicateBean({ name, roaster, sourceUrl }, beans) {
    if (!Array.isArray(beans)) return null;
    const url = typeof sourceUrl === 'string' ? sourceUrl.trim() : '';
    if (url) {
        const byUrl = beans.find(b => typeof b.sourceUrl === 'string' && b.sourceUrl.trim() === url);
        if (byUrl) return byUrl;
    }
    const normName    = String(name || '').trim().toLowerCase();
    const normRoaster = String(roaster || '').trim().toLowerCase();
    if (!normName) return null;
    return beans.find(b =>
        String(b.name || '').trim().toLowerCase() === normName &&
        String(b.roaster || '').trim().toLowerCase() === normRoaster
    ) || null;
}

module.exports = {
    parseGenericShopifyProduct, parseJsonLd, parseOpenGraph, findDuplicateBean, looksLikeRoasterName,
    enrichGenericBeanFromHtml,
};
