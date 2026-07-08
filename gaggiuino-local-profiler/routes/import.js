const express  = require('express');
const axios    = require('axios');
const router   = express.Router();

const { IMPORT_FETCH_MAX_BYTES } = require('../lib/constants');
const { shopifyJsonUrl } = require('../lib/import-parsers');
const { BUILTIN_PROVIDERS, matchProvider } = require('../lib/import-providers');
const { parseGenericShopifyProduct, parseJsonLd, parseOpenGraph, findDuplicateBean } = require('../lib/import-generic');
const { assertPublicHost, SsrfBlockedError } = require('../lib/ssrf-guard');
const { loadImportSettings, saveImportSettings, loadLibrary } = require('../lib/data');

const FETCH_OPTS = {
    headers: { 'User-Agent': 'GLP/1.0 (Gaggiuino Local Profiler; private use)' },
    timeout: 8000,
    maxContentLength: IMPORT_FETCH_MAX_BYTES,
};

const MAX_REDIRECT_HOPS = 3;

// Fetches a URL with SSRF hardening applied to every hop: https-only, a
// private/loopback/link-local IP check before each request (initial URL and
// every redirect target — axios itself never follows redirects here), and
// the existing size cap. This now guards arbitrary hostnames, not just the
// 3 formerly-hardcoded shop domains, since the generic fallback chain below
// fetches whatever the user pastes.
async function safeGet(startUrl, opts) {
    let current = startUrl;
    for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
        const parsed = new URL(current);
        if (parsed.protocol !== 'https:') throw new Error('unsupported protocol');
        await assertPublicHost(parsed.hostname);
        const r = await axios.get(current, { ...opts, maxRedirects: 0, validateStatus: s => s < 400 });
        if (r.status >= 300 && r.status < 400) {
            const loc = r.headers?.location;
            if (!loc) throw new Error('redirect without location');
            current = new URL(loc, current).toString();
            continue;
        }
        return r;
    }
    throw new Error('too many redirects');
}

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

function attachVariants(bean, rawVariants) {
    const variants = distinctSizeVariants(rawVariants);
    if (variants.length > 1) bean.variants = variants;
}

router.get('/api/import/url', async (req, res) => {
    const raw = req.query.url;
    if (!raw) return res.status(400).json({ error: 'url required' });
    let parsed;
    try { parsed = new URL(raw); } catch { return res.status(400).json({ error: 'invalid url' }); }
    if (parsed.protocol !== 'https:')
        return res.status(400).json({ error: 'unsupported protocol' });

    const settings = loadImportSettings();
    const disabled = new Set(settings.disabledProviders);
    const host      = parsed.hostname.replace(/^www\./, '').toLowerCase();
    const provider  = matchProvider(host, disabled, settings.customShopifyDomains);

    try {
        let bean = null;
        let method = null;
        let html = null;

        // 1. Registry match: a built-in parser, or a user-added Shopify domain.
        if (provider) {
            if (provider.kind === 'shopify') {
                const jsonUrl = shopifyJsonUrl(parsed, host);
                if (jsonUrl) {
                    const r = await safeGet(jsonUrl, FETCH_OPTS);
                    const parseFn = provider.parser || parseGenericShopifyProduct;
                    bean = parseFn(r.data);
                    if (bean) {
                        attachVariants(bean, r.data.variants);
                        bean.source = provider.builtin ? provider.hostSuffix : host;
                        method = provider.builtin ? `builtin:${provider.id}` : 'custom-shopify';
                    }
                }
            } else {
                const r = await safeGet(raw, FETCH_OPTS);
                bean = provider.parser(r.data);
                if (bean) {
                    bean.source = provider.hostSuffix;
                    method = `builtin:${provider.id}`;
                }
            }
        }

        // 2. Generic Shopify attempt — every Shopify storefront exposes
        // /products/<handle>.js regardless of whether it's a known shop.
        if (!bean) {
            const jsonUrl = shopifyJsonUrl(parsed, host);
            if (jsonUrl) {
                try {
                    const r = await safeGet(jsonUrl, FETCH_OPTS);
                    bean = parseGenericShopifyProduct(r.data);
                    if (bean) {
                        attachVariants(bean, r.data.variants);
                        bean.source = host;
                        method = 'generic-shopify';
                    }
                } catch (e) {
                    if (e instanceof SsrfBlockedError) throw e;
                    // not a Shopify shop (or fetch failed) — fall through
                }
            }
        }

        // 3. JSON-LD Product markup, 4. OpenGraph/HTML meta fallback — both
        // read the same fetched page, so only fetch it once.
        if (!bean) {
            const r = await safeGet(raw, FETCH_OPTS);
            html = r.data;
            bean = parseJsonLd(html);
            if (bean) { bean.source = host; method = 'jsonld'; }
        }
        if (!bean && html != null) {
            bean = parseOpenGraph(html);
            if (bean) { bean.source = host; method = 'opengraph'; }
        }

        if (!bean) return res.status(404).json({ error: 'product not found on page' });
        bean.importMethod = method;
        bean.sourceUrl = raw;

        const dup = findDuplicateBean(bean, loadLibrary().beans);
        if (dup) bean.duplicateWarning = { id: dup.id, name: dup.name, roaster: dup.roaster || '' };

        res.json(bean);
    } catch (e) {
        if (e instanceof SsrfBlockedError) return res.status(400).json({ error: 'blocked address' });
        res.status(500).json({ error: 'fetch failed' });
    }
});

// ── Import provider settings ────────────────────────────────────────────────

router.get('/api/import/settings', (req, res) => {
    const s = loadImportSettings();
    res.json({
        providers: BUILTIN_PROVIDERS.map(p => ({
            id: p.id, label: p.label, hostSuffix: p.hostSuffix,
            enabled: !s.disabledProviders.includes(p.id),
        })),
        customShopifyDomains: s.customShopifyDomains,
    });
});

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

router.post('/api/import/settings', (req, res) => {
    const body = req.body || {};
    const s = loadImportSettings();

    if (Array.isArray(body.disabledProviders)) {
        const validIds = new Set(BUILTIN_PROVIDERS.map(p => p.id));
        s.disabledProviders = body.disabledProviders.filter(id => typeof id === 'string' && validIds.has(id));
    }

    if (Array.isArray(body.customShopifyDomains)) {
        const domains = [];
        for (const d of body.customShopifyDomains) {
            if (typeof d !== 'string') continue;
            const host = d.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
            if (DOMAIN_RE.test(host)) domains.push(host);
        }
        s.customShopifyDomains = [...new Set(domains)].slice(0, 20);
    }

    saveImportSettings(s);
    res.json(s);
});

module.exports = router;
