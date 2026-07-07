// Registry of built-in shop parsers, replacing the old routes/import.js
// if/else host chain. Each entry can be disabled by the user (persisted via
// lib/data.js loadImportSettings/saveImportSettings) without touching code.
const { parseKaffeebraun, parseHoploProduct, parseElbgoldProduct } = require('./import-parsers');

// kind 'html'    → fetch the pasted URL directly, parser(html) => bean|null
// kind 'shopify' → rewrite to <host>/products/<handle>.js, parser(productJson) => bean|null
const BUILTIN_PROVIDERS = [
    { id: 'kaffeebraun',       label: 'Kaffee Braun',        hostSuffix: 'kaffeebraun.com',      kind: 'html',    parser: parseKaffeebraun,    builtin: true },
    { id: 'hoppenworth-ploch', label: 'Hoppenworth & Ploch',  hostSuffix: 'hoppenworth-ploch.de', kind: 'shopify', parser: parseHoploProduct,   builtin: true },
    { id: 'elbgold',           label: 'elbgold',              hostSuffix: 'elbgold.com',          kind: 'shopify', parser: parseElbgoldProduct, builtin: true },
];

function hostMatches(host, suffix) {
    return host === suffix || host.endsWith(`.${suffix}`);
}

// host must already be lowercased with a leading "www." stripped.
// disabledIds: Set<string> of builtin provider ids to skip entirely.
// customDomains: string[] of user-added Shopify domains (also normalized).
function matchProvider(host, disabledIds, customDomains) {
    for (const p of BUILTIN_PROVIDERS) {
        if (disabledIds && disabledIds.has(p.id)) continue;
        if (hostMatches(host, p.hostSuffix)) return p;
    }
    if (Array.isArray(customDomains)) {
        for (const d of customDomains) {
            if (hostMatches(host, d)) {
                // parser: null signals routes/import.js to use the generic
                // Shopify product-JSON parser instead of a bespoke one.
                return { id: `custom:${d}`, label: d, hostSuffix: d, kind: 'shopify', parser: null, builtin: false };
            }
        }
    }
    return null;
}

module.exports = { BUILTIN_PROVIDERS, matchProvider };
