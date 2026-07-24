const express  = require('express');
const axios    = require('axios');
const router   = express.Router();

const { IMPORT_FETCH_MAX_BYTES } = require('../lib/constants');
const { shopifyJsonUrl } = require('../lib/import-parsers');
const { BUILTIN_PROVIDERS, matchProvider } = require('../lib/import-providers');
const { parseGenericShopifyProduct, parseJsonLd, parseOpenGraph, findDuplicateBean, enrichGenericBeanFromHtml } = require('../lib/import-generic');
const { assertPublicHost, SsrfBlockedError } = require('../lib/ssrf-guard');
const { loadImportSettings, saveImportSettings, loadLibrary, debugLog } = require('../lib/data');
const { log } = require('../lib/helpers');

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

// Shopify's per-variant `weight` field is often unreliable merchant data —
// e.g. a shipping-package placeholder entered once and left uncorrected
// across every size variant (#455, verified live against
// sproutcoffeeroasters.art: every "Espresso" variant reported weight:266
// regardless of whether its own option label said "250g" or "1KG"). The
// option label the merchant actually typed for the size (e.g. "250g",
// "1kg") is the trustworthy source — fall back to the raw `weight` field
// only when no such label is parseable.
function parseGramsFromLabel(s) {
    if (typeof s !== 'string') return null;
    const m = s.match(/(\d+(?:[.,]\d+)?)\s*(kg|g)\b/i);
    if (!m) return null;
    const n = parseFloat(m[1].replace(',', '.'));
    if (!Number.isFinite(n)) return null;
    return Math.round(/^k/i.test(m[2]) ? n * 1000 : n);
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
        if (typeof v?.price !== 'number') continue;
        const label = [v.option1, v.option2, v.option3, v.title].find(s => parseGramsFromLabel(s) != null);
        const weight = label ? parseGramsFromLabel(label) : (typeof v?.weight === 'number' ? v.weight : null);
        if (weight == null) continue;
        const key = `${v.price}|${weight}`;
        if (seen.has(key)) continue;
        seen.set(key, {
            id: v.id, title: v.option1 || v.title || null,
            price: v.price, weight,
            unit: v.unit_price_measurement?.quantity_unit || null,
        });
    }
    return [...seen.values()];
}

function attachVariants(bean, rawVariants) {
    const variants = distinctSizeVariants(rawVariants);
    if (variants.length > 1) bean.variants = variants;
}

// Fields the built-in Shopify JSON parsers can populate but that a theme
// may instead only render into the product page's HTML (see #423). Missing
// any of these makes one extra bounded HTML fetch worthwhile — as does a
// roaster that fell back to the bare hostname (#433), since the HTML page
// may carry a real shop name (og:site_name / header-logo alt) the JSON has
// no equivalent field for.
const HTML_ENRICH_FIELDS = ['process', 'variety', 'producer', 'region', 'altitude_m', 'roastType'];
function needsHtmlEnrich(bean, host) {
    if (HTML_ENRICH_FIELDS.some(f => !bean[f])) return true;
    return !bean.roaster || (host && bean.roaster.toLowerCase() === host.toLowerCase());
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
                    bean = provider.parser ? provider.parser(r.data) : parseGenericShopifyProduct(r.data, host);
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
            debugLog(`Import: generic-Shopify path for ${host}, jsonUrl=${jsonUrl}`);
            if (jsonUrl) {
                try {
                    const r = await safeGet(jsonUrl, FETCH_OPTS);
                    debugLog(`Import: JSON fetch ${jsonUrl} -> status ${r.status}, ${JSON.stringify(r.data).length} bytes`);
                    bean = parseGenericShopifyProduct(r.data, host);
                    if (bean) {
                        attachVariants(bean, r.data.variants);
                        bean.source = host;
                        method = 'generic-shopify';
                        debugLog(`Import: JSON-only bean fields present: ${Object.keys(bean).filter(k => bean[k] != null && bean[k] !== '').join(', ')}`);

                        // Some themes only render bean detail into the product
                        // page HTML, not this JSON (#423) — one extra bounded
                        // fetch, only when the JSON left detail fields empty.
                        const enrich = needsHtmlEnrich(bean, host);
                        debugLog(`Import: needsHtmlEnrich=${enrich}`);
                        if (enrich) {
                            try {
                                const htmlR = await safeGet(raw, FETCH_OPTS);
                                debugLog(`Import: HTML fetch ${raw} -> status ${htmlR.status}, ${typeof htmlR.data === 'string' ? htmlR.data.length : 0} chars`);
                                const before = { ...bean };
                                bean = enrichGenericBeanFromHtml(bean, htmlR.data, host);
                                const changedFields = Object.keys(bean).filter(k => bean[k] !== before[k]);
                                debugLog(`Import: HTML enrichment changed fields: ${changedFields.join(', ') || '(none)'}`);
                            } catch (htmlErr) {
                                if (htmlErr instanceof SsrfBlockedError) throw htmlErr;
                                // #480: page fetch/parse failed — keep the JSON-only bean,
                                // but log why so a "some fields stayed empty" report is
                                // diagnosable from the add-on logs instead of a guess.
                                log(`Import: HTML enrichment fetch failed for ${host}: ${htmlErr.message}`, true);
                            }
                        }
                    } else {
                        debugLog('Import: parseGenericShopifyProduct returned null (no title in JSON)');
                    }
                } catch (e) {
                    if (e instanceof SsrfBlockedError) throw e;
                    // not a Shopify shop (or fetch failed) — fall through
                    debugLog(`Import: JSON fetch failed for ${host}: ${e.message}`);
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
        // #451: extraBrewRecipes candidates are built before sourceUrl is known
        // (enrichGenericBeanFromHtml has no access to the request URL) — stamp
        // it on now so the import dialog can pass it straight to recipe creation.
        if (Array.isArray(bean.extraBrewRecipes)) {
            bean.extraBrewRecipes = bean.extraBrewRecipes.map(r => ({ ...r, sourceUrl: raw }));
        }

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
            // Strip a leading scheme, then cut at the first '/' with a plain
            // index lookup (not a regex) so a pathological run of '/'
            // characters can't drive polynomial backtracking.
            const withoutScheme = d.trim().toLowerCase().replace(/^https?:\/\//, '');
            const slashIdx = withoutScheme.indexOf('/');
            const host = (slashIdx === -1 ? withoutScheme : withoutScheme.slice(0, slashIdx)).replace(/^www\./, '');
            if (DOMAIN_RE.test(host)) domains.push(host);
        }
        s.customShopifyDomains = [...new Set(domains)].slice(0, 20);
    }

    saveImportSettings(s);
    res.json(s);
});

module.exports = router;
