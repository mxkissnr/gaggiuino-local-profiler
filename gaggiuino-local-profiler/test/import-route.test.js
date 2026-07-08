import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import dns from 'dns';
const require = createRequire(import.meta.url);

// Same in-memory DB swap as db-routes.test.js — import settings (provider
// toggles, custom Shopify domains) are now persisted via the kv table, so
// the route needs a working DB even for the pre-existing variant tests.
const Database = require('better-sqlite3');
const dbPath    = require.resolve('../lib/db');
const realDb    = require(dbPath);
const memDb     = new Database(':memory:');
realDb.initSchema(memDb);
require.cache[dbPath].exports = { getDb: () => memDb, initSchema: realDb.initSchema };

// Same require-cache mocking pattern as bean-image.test.js — no real network
// calls from this route.
const axiosPath = require.resolve('axios');
const axiosGet  = vi.fn();
require.cache[axiosPath] = { exports: { get: axiosGet, default: { get: axiosGet } } };

const express      = require('express');
const importRouter = require('../routes/import');
const { saveImportSettings, loadImportSettings, loadLibrary, saveLibrary } = require('../lib/data');

// `dns` is a core singleton — monkeypatch its `.promises.lookup` in place
// (no require.cache trick needed, unlike the axios npm package above).
// Public by default; individual tests override with a private address.
const PUBLIC_ADDR = { address: '203.0.113.10', family: 4 };
let dnsLookup;

function makeApp() {
    const app = express();
    app.use(express.json());
    app.use(importRouter);
    return app;
}

let server, baseUrl;

beforeEach(async () => {
    axiosGet.mockReset();
    dnsLookup = vi.spyOn(dns.promises, 'lookup').mockResolvedValue([PUBLIC_ADDR]);
    saveImportSettings({ disabledProviders: [], customShopifyDomains: [] });
    server = makeApp().listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(() => { server?.close(); dnsLookup.mockRestore(); });

describe('GET /api/import/url — size variants projection', () => {
    it('attaches distinct size variants when a Shopify product has real price/weight variation', async () => {
        axiosGet.mockResolvedValue({ status: 200, headers: {}, data: {
            title: 'Test Bean - Ruanda', vendor: 'Hoppenworth & Ploch', description: '',
            variants: [
                { id: 1, price: 1490, weight: 250, option1: '250g', unit_price_measurement: { quantity_unit: 'g' } },
                { id: 2, price: 5200, weight: 1000, option1: '1kg', unit_price_measurement: { quantity_unit: 'g' } },
            ],
        }});
        const r = await fetch(`${baseUrl}/api/import/url?url=${encodeURIComponent('https://hoppenworth-ploch.de/products/test-bean')}`);
        const data = await r.json();
        expect(data.variants).toEqual([
            { id: 1, title: '250g', price: 1490, weight: 250, unit: 'g' },
            { id: 2, title: '1kg', price: 5200, weight: 1000, unit: 'g' },
        ]);
        expect(data.importMethod).toBe('builtin:hoppenworth-ploch');
    });

    it('omits variants when every variant shares the same price/weight (grind-type-only differences)', async () => {
        axiosGet.mockResolvedValue({ status: 200, headers: {}, data: {
            title: 'Test Bean - Ruanda', vendor: 'Hoppenworth & Ploch', description: '',
            variants: [
                { id: 1, price: 1690, weight: 250, option1: 'Filter 250g', option2: 'ganze Bohne' },
                { id: 2, price: 1690, weight: 250, option1: 'Filter 250g', option2: 'gemahlen für Filter' },
            ],
        }});
        const r = await fetch(`${baseUrl}/api/import/url?url=${encodeURIComponent('https://hoppenworth-ploch.de/products/test-bean')}`);
        const data = await r.json();
        expect(data.variants).toBeUndefined();
    });

    it('omits variants for products with no variants array at all (elbgold)', async () => {
        axiosGet.mockResolvedValue({ status: 200, headers: {}, data: {
            title: 'BOMBE', vendor: 'elbgold', description: '<p>Noten von Kirsche und Mandel.</p>', variants: null,
        }});
        const r = await fetch(`${baseUrl}/api/import/url?url=${encodeURIComponent('https://elbgold.com/products/bombe')}`);
        const data = await r.json();
        expect(data.variants).toBeUndefined();
        expect(data.importMethod).toBe('builtin:elbgold');
    });

    it('omits variants for a single-variant product', async () => {
        axiosGet.mockResolvedValue({ status: 200, headers: {}, data: {
            title: 'Test Bean - Ruanda', vendor: 'Hoppenworth & Ploch', description: '',
            variants: [{ id: 1, price: 1490, weight: 250, option1: '250g' }],
        }});
        const r = await fetch(`${baseUrl}/api/import/url?url=${encodeURIComponent('https://hoppenworth-ploch.de/products/test-bean')}`);
        const data = await r.json();
        expect(data.variants).toBeUndefined();
    });
});

describe('GET /api/import/url — provider registry toggling', () => {
    it('skips a disabled built-in provider entirely, falling back to the generic Shopify parser', async () => {
        saveImportSettings({ disabledProviders: ['elbgold'], customShopifyDomains: [] });
        axiosGet.mockResolvedValue({ status: 200, headers: {}, data: {
            title: 'BOMBE', vendor: 'elbgold', description: '<p>Noten von Kirsche und Mandel.</p>',
        }});
        const r = await fetch(`${baseUrl}/api/import/url?url=${encodeURIComponent('https://elbgold.com/products/bombe')}`);
        const data = await r.json();
        expect(r.status).toBe(200);
        expect(data.importMethod).toBe('generic-shopify');
        // the elbgold-specific parser defaults roaster to 'elbgold' when vendor
        // is falsy-checked differently; the generic parser just reads vendor.
        expect(data.roaster).toBe('elbgold');
    });

    it('routes a user-added custom Shopify domain through the generic Shopify parser, labelled distinctly', async () => {
        saveImportSettings({ disabledProviders: [], customShopifyDomains: ['myroaster.example'] });
        axiosGet.mockResolvedValue({ status: 200, headers: {}, data: {
            title: 'House Blend', vendor: 'My Roaster', description: '',
        }});
        const r = await fetch(`${baseUrl}/api/import/url?url=${encodeURIComponent('https://myroaster.example/products/house-blend')}`);
        const data = await r.json();
        expect(r.status).toBe(200);
        expect(data.name).toBe('House Blend');
        expect(data.importMethod).toBe('custom-shopify');
    });
});

describe('GET /api/import/url — generic fallback chain', () => {
    it('falls back to the generic Shopify product-JSON endpoint for an unknown shop', async () => {
        axiosGet.mockResolvedValue({ status: 200, headers: {}, data: {
            title: 'Ethiopia Washed', vendor: 'Random Roastery', description: '<p>Noten von Zitrone.</p>',
            featured_image: '//cdn.shopify.com/random.jpg',
        }});
        const r = await fetch(`${baseUrl}/api/import/url?url=${encodeURIComponent('https://randomroaster.example/products/ethiopia')}`);
        const data = await r.json();
        expect(r.status).toBe(200);
        expect(data.name).toBe('Ethiopia Washed');
        expect(data.roaster).toBe('Random Roastery');
        expect(data.importMethod).toBe('generic-shopify');
        expect(axiosGet).toHaveBeenCalledWith(
            'https://randomroaster.example/products/ethiopia.js',
            expect.any(Object),
        );
    });

    it('parses schema.org JSON-LD Product markup when the page is not a Shopify product', async () => {
        const html = `<html><head>
            <script type="application/ld+json">${JSON.stringify({
                '@context': 'https://schema.org', '@type': 'Product',
                name: 'Colombia Huila', description: 'Notes of caramel and orange.',
                brand: { name: 'Some Roastery' }, image: 'https://cdn.example.com/img.jpg',
                offers: { '@type': 'Offer', price: '14.90', priceCurrency: 'EUR' },
            })}</script>
        </head><body></body></html>`;
        axiosGet.mockResolvedValue({ status: 200, headers: {}, data: html });
        const r = await fetch(`${baseUrl}/api/import/url?url=${encodeURIComponent('https://anotherblog.example/coffee/colombia')}`);
        const data = await r.json();
        expect(r.status).toBe(200);
        expect(data.name).toBe('Colombia Huila');
        expect(data.roaster).toBe('Some Roastery');
        expect(data.price_eur).toBe(14.9);
        expect(data.importMethod).toBe('jsonld');
    });

    it('falls back to OpenGraph meta tags when neither Shopify JSON nor JSON-LD is present', async () => {
        const html = `<html><head>
            <meta property="og:title" content="Kenya AA">
            <meta property="og:description" content="Bright acidity, notes of blackcurrant.">
            <meta property="og:image" content="https://cdn.example.com/kenya.jpg">
        </head><body></body></html>`;
        axiosGet.mockResolvedValue({ status: 200, headers: {}, data: html });
        const r = await fetch(`${baseUrl}/api/import/url?url=${encodeURIComponent('https://yetanothershop.example/product/kenya')}`);
        const data = await r.json();
        expect(r.status).toBe(200);
        expect(data.name).toBe('Kenya AA');
        expect(data.imageUrl).toBe('https://cdn.example.com/kenya.jpg');
        expect(data.importMethod).toBe('opengraph');
    });

    it('returns 404 when none of the fallback methods find usable data', async () => {
        axiosGet.mockResolvedValue({ status: 200, headers: {}, data: '<html><head></head><body>nothing here</body></html>' });
        const r = await fetch(`${baseUrl}/api/import/url?url=${encodeURIComponent('https://emptypage.example/x')}`);
        expect(r.status).toBe(404);
    });

    it('reads og:site_name as roaster and og:price:amount as price_eur in the OpenGraph fallback', async () => {
        const html = `<html><head>
            <meta property="og:title" content="Kenya AA">
            <meta property="og:site_name" content="Kenya Roasters GmbH">
            <meta property="og:price:amount" content="15.90">
        </head><body></body></html>`;
        axiosGet.mockResolvedValue({ status: 200, headers: {}, data: html });
        const r = await fetch(`${baseUrl}/api/import/url?url=${encodeURIComponent('https://yetanothershop2.example/product/kenya')}`);
        const data = await r.json();
        expect(data.roaster).toBe('Kenya Roasters GmbH');
        expect(data.price_eur).toBe(15.9);
    });
});

describe('GET /api/import/url — duplicate warning', () => {
    it('warns when the imported URL was already imported into an existing bean', async () => {
        const lib = loadLibrary();
        lib.beans.push({ id: 999, name: 'Some Existing Bean', roaster: 'Whoever', sourceUrl: 'https://dupshop.example/products/repeat' });
        saveLibrary(lib);
        axiosGet.mockResolvedValue({ status: 200, headers: {}, data: {
            title: 'Some New Title', vendor: 'Whoever', description: '',
        }});
        const r = await fetch(`${baseUrl}/api/import/url?url=${encodeURIComponent('https://dupshop.example/products/repeat')}`);
        const data = await r.json();
        expect(data.duplicateWarning).toMatchObject({ id: 999, name: 'Some Existing Bean' });
    });

    it('warns on a case-insensitive name+roaster match even for a different URL', async () => {
        const lib = loadLibrary();
        lib.beans.push({ id: 998, name: 'Ethiopia Washed', roaster: 'Random Roastery' });
        saveLibrary(lib);
        axiosGet.mockResolvedValue({ status: 200, headers: {}, data: {
            title: 'ethiopia washed', vendor: 'random roastery', description: '',
        }});
        const r = await fetch(`${baseUrl}/api/import/url?url=${encodeURIComponent('https://freshshop.example/products/ethiopia')}`);
        const data = await r.json();
        expect(data.duplicateWarning).toMatchObject({ id: 998 });
    });

    it('does not warn for a genuinely new bean', async () => {
        axiosGet.mockResolvedValue({ status: 200, headers: {}, data: {
            title: 'Brand New Bean', vendor: 'Nobody Yet', description: '',
        }});
        const r = await fetch(`${baseUrl}/api/import/url?url=${encodeURIComponent('https://newshop.example/products/brand-new')}`);
        const data = await r.json();
        expect(data.duplicateWarning).toBeUndefined();
        expect(data.sourceUrl).toBe('https://newshop.example/products/brand-new');
    });
});

describe('GET /api/import/url — SSRF hardening', () => {
    it('rejects a URL whose hostname resolves to a private address, without attempting any fallback', async () => {
        dnsLookup.mockResolvedValue([{ address: '10.1.2.3', family: 4 }]);
        const r = await fetch(`${baseUrl}/api/import/url?url=${encodeURIComponent('https://internal-service.example/products/x')}`);
        expect(r.status).toBe(400);
        const data = await r.json();
        expect(data.error).toBe('blocked address');
        expect(axiosGet).not.toHaveBeenCalled();
    });

    it('rejects a redirect that points at a private address', async () => {
        dnsLookup.mockImplementation(async hostname =>
            hostname === 'internal.example' ? [{ address: '192.168.1.5', family: 4 }] : [PUBLIC_ADDR]);
        axiosGet.mockResolvedValueOnce({
            status: 302, headers: { location: 'https://internal.example/products/x.js' }, data: '',
        });
        const r = await fetch(`${baseUrl}/api/import/url?url=${encodeURIComponent('https://public-shop.example/products/x')}`);
        expect(r.status).toBe(400);
        const data = await r.json();
        expect(data.error).toBe('blocked address');
        expect(axiosGet).toHaveBeenCalledTimes(1); // never followed the redirect
    });

    it('rejects non-https URLs outright', async () => {
        const r = await fetch(`${baseUrl}/api/import/url?url=${encodeURIComponent('http://kaffeebraun.com/products/x')}`);
        expect(r.status).toBe(400);
        expect(axiosGet).not.toHaveBeenCalled();
    });
});

describe('import provider settings endpoints', () => {
    it('GET returns all built-ins enabled and no custom domains by default', async () => {
        const r = await fetch(`${baseUrl}/api/import/settings`);
        const data = await r.json();
        expect(data.providers.map(p => p.id).sort()).toEqual(['elbgold', 'hoppenworth-ploch', 'kaffeebraun']);
        expect(data.providers.every(p => p.enabled)).toBe(true);
        expect(data.customShopifyDomains).toEqual([]);
    });

    it('POST persists disabled providers and validated custom domains, rejecting garbage entries', async () => {
        const r = await fetch(`${baseUrl}/api/import/settings`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ disabledProviders: ['kaffeebraun', 'not-a-real-id'], customShopifyDomains: ['shop.example.com', 'not a domain', 'https://other-shop.example/path'] }),
        });
        expect(r.status).toBe(200);
        const saved = loadImportSettings();
        expect(saved.disabledProviders).toEqual(['kaffeebraun']);
        expect(saved.customShopifyDomains).toEqual(['shop.example.com', 'other-shop.example']);
    });
});
