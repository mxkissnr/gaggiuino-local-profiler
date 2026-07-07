// Fallback parsers tried, in order, for any shop that isn't one of the
// built-in registry entries (lib/import-providers.js): generic Shopify
// product JSON, JSON-LD Product markup, then OpenGraph/HTML meta tags.
// All three are best-effort — the user reviews the pre-filled bean form
// regardless, and the frontend shows which method produced the data.
const cheerio = require('cheerio');
const { findCountriesInText } = require('./coffee-countries');
const { extractFlavorKeywords, normalizeImageUrl, priceFromProduct } = require('./import-parsers');

const today = () => new Date().toISOString().slice(0, 10);

// Any Shopify storefront exposes this endpoint for a product page — no
// shop-specific spec-table parsing, just title/vendor/description/price/image
// plus best-effort flavor & origin extraction from the description prose.
function parseGenericShopifyProduct(product) {
    const title = String(product?.title || '').trim();
    if (!title) return null;
    const $    = cheerio.load(product.description || '');
    const text = $.text().replace(/\s+/g, ' ').trim();
    const originCodes = findCountriesInText(`${title} ${text}`);
    return {
        name:       title,
        roaster:    product.vendor || null,
        notes:      '',
        flavors:    extractFlavorKeywords(text),
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
        flavors:    extractFlavorKeywords(text),
        origin:     originCodes[0] || null,
        origins:    originCodes.map(code => ({ code })),
        imageUrl:   normalizeImageUrl(image),
        price_eur:  price,
        importedAt: today(),
    };
}

// Last-resort fallback: og:title/og:image/og:description meta tags, which
// virtually every storefront (of any platform) sets for product pages.
function parseOpenGraph(html) {
    const $     = cheerio.load(html);
    const title = $('meta[property="og:title"]').attr('content')?.trim();
    if (!title) return null;
    const description = $('meta[property="og:description"]').attr('content')?.trim() || '';
    const image = $('meta[property="og:image"]').attr('content');
    const text  = `${title} ${description}`;
    const originCodes = findCountriesInText(text);
    return {
        name:       title,
        roaster:    null,
        notes:      description.slice(0, 500),
        flavors:    extractFlavorKeywords(text),
        origin:     originCodes[0] || null,
        origins:    originCodes.map(code => ({ code })),
        imageUrl:   normalizeImageUrl(image),
        importedAt: today(),
    };
}

module.exports = { parseGenericShopifyProduct, parseJsonLd, parseOpenGraph };
