// Fallback parsers tried, in order, for any shop that isn't one of the
// built-in registry entries (lib/import-providers.js): generic Shopify
// product JSON, JSON-LD Product markup, then OpenGraph/HTML meta tags.
// All three are best-effort — the user reviews the pre-filled bean form
// regardless, and the frontend shows which method produced the data.
const cheerio = require('cheerio');
const { findCountriesInText } = require('./coffee-countries');
const { matchFlavorTerms, normalizeImageUrl, priceFromProduct } = require('./import-parsers');

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

module.exports = { parseGenericShopifyProduct, parseJsonLd, parseOpenGraph, findDuplicateBean, looksLikeRoasterName };
