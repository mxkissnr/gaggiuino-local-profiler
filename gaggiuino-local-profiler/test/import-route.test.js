import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// Same require-cache mocking pattern as bean-image.test.js — no real network
// calls from this route.
const axiosPath = require.resolve('axios');
const axiosGet  = vi.fn();
require.cache[axiosPath] = { exports: { get: axiosGet, default: { get: axiosGet } } };

const express      = require('express');
const importRouter = require('../routes/import');

function makeApp() {
    const app = express();
    app.use(importRouter);
    return app;
}

let server, baseUrl;

beforeEach(async () => {
    axiosGet.mockReset();
    server = makeApp().listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(() => server?.close());

describe('GET /api/import/url — size variants projection', () => {
    it('attaches distinct size variants when a Shopify product has real price/weight variation', async () => {
        axiosGet.mockResolvedValue({ data: {
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
    });

    it('omits variants when every variant shares the same price/weight (grind-type-only differences)', async () => {
        axiosGet.mockResolvedValue({ data: {
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
        axiosGet.mockResolvedValue({ data: {
            title: 'BOMBE', vendor: 'elbgold', description: '<p>Noten von Kirsche und Mandel.</p>', variants: null,
        }});
        const r = await fetch(`${baseUrl}/api/import/url?url=${encodeURIComponent('https://elbgold.com/products/bombe')}`);
        const data = await r.json();
        expect(data.variants).toBeUndefined();
    });

    it('omits variants for a single-variant product', async () => {
        axiosGet.mockResolvedValue({ data: {
            title: 'Test Bean - Ruanda', vendor: 'Hoppenworth & Ploch', description: '',
            variants: [{ id: 1, price: 1490, weight: 250, option1: '250g' }],
        }});
        const r = await fetch(`${baseUrl}/api/import/url?url=${encodeURIComponent('https://hoppenworth-ploch.de/products/test-bean')}`);
        const data = await r.json();
        expect(data.variants).toBeUndefined();
    });
});
