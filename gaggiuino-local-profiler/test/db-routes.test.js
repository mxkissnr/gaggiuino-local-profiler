import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// Same in-memory DB swap as backup.test.js: patch the require cache for lib/db.js
// before any route/repository is required, so every consumer shares the memory DB.
const Database  = require('better-sqlite3');
const dbPath    = require.resolve('../lib/db');
const realDb    = require(dbPath);
const memDb     = new Database(':memory:');
realDb.initSchema(memDb);
require.cache[dbPath].exports = { getDb: () => memDb, initSchema: realDb.initSchema };

// Orders routes sit behind the enable_orders guard; options.json does not exist
// in tests, so patch lib/data.js the same way to force the feature on (the guard
// captured the function reference at module load, hence patch before requiring routes).
const dataPath = require.resolve('../lib/data');
const realData = require(dataPath);
let ordersEnabled = true;
require.cache[dataPath].exports = { ...realData, isOrdersEnabled: () => ordersEnabled };

// Bean image downloads are network I/O — mocked here for route-wiring tests;
// ImageService's own validation/download logic has dedicated unit tests in
// test/bean-image.test.js.
const imageServicePath = require.resolve('../lib/services/ImageService');
const realImageService = require(imageServicePath);
const fetchBeanImageMock = (beanId, url) => url.includes('evil') ? Promise.resolve(null) : Promise.resolve('jpg');
const saveUploadedImageMock = (prefix, id, buffer, contentType) =>
    contentType === 'image/jpeg' || contentType === 'image/png' ? 'jpg' : null;
require.cache[imageServicePath].exports = {
    ...realImageService, fetchBeanImage: fetchBeanImageMock, deleteBeanImage: () => {},
    saveUploadedImage: saveUploadedImageMock, deleteImage: () => {},
};

const express           = require('express');
const systemRouter      = require('../routes/system');
const ordersRouter      = require('../routes/orders');
const libraryRouter     = require('../routes/library');
const maintenanceRouter = require('../routes/maintenance');
const shotRepo      = require('../lib/repositories/ShotRepository');
const libraryService = require('../lib/services/LibraryService');
const { saveOrders, saveLibrary, saveMenu } = require('../lib/data');
const { getDb }     = require('../lib/db');

function makeApp() {
    // Mirror the server.js mounting order: library before orders, system after
    const app = express();
    app.use(express.json());
    app.use(libraryRouter);
    app.use(maintenanceRouter);
    app.use(ordersRouter);
    app.use(systemRouter);
    app.use((err, req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
    return app;
}

let server, baseUrl;

beforeEach(async () => {
    getDb().exec('DELETE FROM shots; DELETE FROM annotations; DELETE FROM trash; DELETE FROM orders; DELETE FROM maintenance; DELETE FROM maintenance_log; DELETE FROM library;');
    server = makeApp().listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => server?.close());

describe('GET /api/status', () => {
    it('reports shotCount from the database, not the frozen legacy JSON file', async () => {
        shotRepo.upsertMany([
            { id: 1, timestamp: 1000, duration: 250 },
            { id: 2, timestamp: 2000, duration: 260 },
            { id: 3, timestamp: 3000, duration: 270 },
        ]);
        const r = await fetch(`${baseUrl}/api/status`);
        expect(r.status).toBe(200);
        expect((await r.json()).shotCount).toBe(3);
    });
});

describe('POST /api/orders/:id/complete', () => {
    it('links the latest non-trashed shot from the database', async () => {
        shotRepo.upsertMany([
            { id: 10, timestamp: 1000, duration: 250 },
            { id: 11, timestamp: 2000, duration: 260 },
            { id: 12, timestamp: 3000, duration: 270 },
        ]);
        shotRepo.moveToTrash(12); // latest shot is in trash → must fall back to 11
        saveOrders([{ id: 'ord1', item: 'Espresso', customer: 'Max', status: 'accepted', createdAt: Date.now() }]);

        const r = await fetch(`${baseUrl}/api/orders/ord1/complete`, { method: 'POST' });
        expect(r.status).toBe(200);
        expect((await r.json()).shotId).toBe(11);
    });

    it('persists orderedBy into the database annotation, preserving existing fields', async () => {
        shotRepo.upsert({ id: 20, timestamp: 1000, duration: 250, annotation: { coffee: 'El Cubanito', dose: 18 } });
        saveOrders([{ id: 'ord2', item: 'Cappuccino', customer: 'Anna', haUserId: 'u1', status: 'accepted', createdAt: Date.now() }]);

        const r = await fetch(`${baseUrl}/api/orders/ord2/complete`, { method: 'POST' });
        expect(r.status).toBe(200);

        const ann = shotRepo.getAnnotation(20);
        expect(ann.coffee).toBe('El Cubanito');           // pre-existing fields intact
        expect(ann.orderedBy).toMatchObject({ customer: 'Anna', haUserId: 'u1', orderId: 'ord2', item: 'Cappuccino' });
    });

    it('sets shotId to null when no shots exist', async () => {
        saveOrders([{ id: 'ord3', item: 'Lungo', customer: 'Max', status: 'accepted', createdAt: Date.now() }]);
        const r = await fetch(`${baseUrl}/api/orders/ord3/complete`, { method: 'POST' });
        expect((await r.json()).shotId).toBeNull();
    });
});

describe('GET /api/orders/stats', () => {
    it('groups case/whitespace variants of the same customer into one card', async () => {
        const now = Date.now();
        saveOrders([
            { id: 'a', item: 'Espresso', customer: 'Max', status: 'done', createdAt: now, completedAt: now },
            { id: 'b', item: 'Espresso', customer: 'max', status: 'done', createdAt: now + 1000, completedAt: now + 1000 },
            { id: 'c', item: 'Cappuccino', customer: 'Max ', status: 'done', createdAt: now + 2000, completedAt: now + 2000 },
        ]);
        const stats = await (await fetch(`${baseUrl}/api/orders/stats`)).json();
        expect(stats.customers).toHaveLength(1);
        expect(stats.customers[0]).toMatchObject({ name: 'Max ', count: 3, favItem: 'Espresso', lastAt: now + 2000 });
    });

    it('keeps distinct customers separate', async () => {
        const now = Date.now();
        saveOrders([
            { id: 'a', item: 'Espresso', customer: 'Max', status: 'done', createdAt: now, completedAt: now },
            { id: 'b', item: 'Espresso', customer: 'Anna', status: 'done', createdAt: now + 1000, completedAt: now + 1000 },
        ]);
        const stats = await (await fetch(`${baseUrl}/api/orders/stats`)).json();
        expect(stats.customers.map(c => c.name).sort()).toEqual(['Anna', 'Max']);
    });
});

describe('orders-disabled guard', () => {
    it('does not swallow non-orders routes mounted after the orders router', async () => {
        ordersEnabled = false;
        try {
            const gated = await fetch(`${baseUrl}/api/orders/menu`);
            expect(gated.status).toBe(404);
            // system router is mounted after the orders router in this app,
            // mirroring server.js — it must still respond with orders disabled
            const status = await fetch(`${baseUrl}/api/status`);
            expect(status.status).toBe(200);
        } finally { ordersEnabled = true; }
    });
});

describe('GET /api/orders/active-beans', () => {
    const bag = (openedAt) => ({ id: 1, roastDate: '2026-06-01', stock_g: 250, openedAt });

    it('hides beans whose active bag is fully consumed', async () => {
        saveLibrary({ beans: [
            { id: 1, name: 'Lucky Punch', stock_g: 250, bags: [bag(0)] },
            { id: 2, name: 'El Cubanito', stock_g: 500, bags: [bag(0)] },
        ], grinders: [], recipes: [] });
        // 14 shots à 18 g = 252 g -> Lucky Punch is empty; El Cubanito untouched
        shotRepo.upsertMany(Array.from({ length: 14 }, (_, i) => (
            { id: i + 1, timestamp: 1000 + i, duration: 250 }
        )));
        for (let i = 1; i <= 14; i++) shotRepo.saveAnnotation(i, { coffee: 'lucky punch', dose: '18' });

        const r     = await fetch(`${baseUrl}/api/orders/active-beans`);
        const beans = await r.json();
        expect(beans.map(b => b.name)).toEqual(['El Cubanito']);
        expect(beans[0].remaining).toBe(500);
    });

    it('only counts consumption since the active bag was opened', async () => {
        const openedAt = 5000 * 1000; // ms — shots before this belong to earlier bags
        saveLibrary({ beans: [
            { id: 1, name: 'Dolce', stock_g: 250, bags: [bag(0), bag(openedAt)] },
        ], grinders: [], recipes: [] });
        shotRepo.upsertMany([
            { id: 1, timestamp: 1000, duration: 250 }, // old bag
            { id: 2, timestamp: 6000, duration: 250 }, // active bag
        ]);
        shotRepo.saveAnnotation(1, { coffee: 'Dolce', dose: 18 });
        shotRepo.saveAnnotation(2, { coffee: 'Dolce', dose: 18 });

        const beans = await (await fetch(`${baseUrl}/api/orders/active-beans`)).json();
        expect(beans).toHaveLength(1);
        expect(beans[0].remaining).toBe(232); // 250 - 18, the pre-bag shot does not count
    });

    it('exposes customer-facing description fields', async () => {
        saveLibrary({ beans: [
            { id: 1, name: 'El Cubanito', stock_g: 500, roaster: 'Kaffee Braun',
              notes: 'Brauner Zucker, Nuss, Tabaknote', origin: 'Kuba', process: 'Natural' },
        ], grinders: [], recipes: [] });
        const [bean] = await (await fetch(`${baseUrl}/api/orders/active-beans`)).json();
        expect(bean).toMatchObject({
            notes: 'Brauner Zucker, Nuss, Tabaknote', origin: 'Kuba', process: 'Natural',
        });
    });

    it('keeps excluding beans without stock tracking', async () => {
        saveLibrary({ beans: [{ id: 1, name: 'Untracked' }], grinders: [], recipes: [] });
        const beans = await (await fetch(`${baseUrl}/api/orders/active-beans`)).json();
        expect(beans).toEqual([]);
    });
});

describe('GET /api/orders/active-milks', () => {
    it('excludes milks that are out of stock', async () => {
        saveLibrary({ beans: [], grinders: [], recipes: [], milks: [
            { id: 1, name: 'Oat', stockMl: 500 },
            { id: 2, name: 'Whole Milk', stockMl: 0 },
        ] });
        const milks = await (await fetch(`${baseUrl}/api/orders/active-milks`)).json();
        expect(milks.map(m => m.name)).toEqual(['Oat']);
        expect(milks[0].remaining).toBe(500);
    });
});

describe('POST /api/orders/:id/complete — milk deduction', () => {
    it('deducts the menu item\'s configured milkMl from the matching milk (case-insensitive)', async () => {
        saveLibrary({ beans: [], grinders: [], recipes: [], milks: [
            { id: 1, name: 'Oat', stockMl: 500 },
        ] });
        saveMenu([{ id: 'm1', name: 'Latte', emoji: '☕', milkMl: 200 }]);
        saveOrders([{ id: 'ord1', item: 'Latte', variant: 'oat', customer: 'Max', status: 'accepted', createdAt: Date.now() }]);

        const r = await fetch(`${baseUrl}/api/orders/ord1/complete`, { method: 'POST' });
        expect(r.status).toBe(200);

        const milks = await (await fetch(`${baseUrl}/api/orders/active-milks`)).json();
        expect(milks[0].remaining).toBe(300);
    });

    it('clamps at zero and does not throw when the order outweighs remaining stock', async () => {
        saveLibrary({ beans: [], grinders: [], recipes: [], milks: [
            { id: 1, name: 'Oat', stockMl: 100 },
        ] });
        saveMenu([{ id: 'm1', name: 'Latte', emoji: '☕', milkMl: 200 }]);
        saveOrders([{ id: 'ord1', item: 'Latte', variant: 'Oat', customer: 'Max', status: 'accepted', createdAt: Date.now() }]);

        const r = await fetch(`${baseUrl}/api/orders/ord1/complete`, { method: 'POST' });
        expect(r.status).toBe(200);
        const milks = await (await fetch(`${baseUrl}/api/orders/active-milks`)).json();
        expect(milks).toEqual([]); // stockMl clamped to 0 -> filtered out of active milks
    });

    it('does not touch milk stock when the item has no milkMl configured', async () => {
        saveLibrary({ beans: [], grinders: [], recipes: [], milks: [
            { id: 1, name: 'Oat', stockMl: 500 },
        ] });
        saveMenu([{ id: 'm1', name: 'Espresso', emoji: '☕' }]);
        saveOrders([{ id: 'ord1', item: 'Espresso', variant: null, customer: 'Max', status: 'accepted', createdAt: Date.now() }]);

        await fetch(`${baseUrl}/api/orders/ord1/complete`, { method: 'POST' });
        const milks = await (await fetch(`${baseUrl}/api/orders/active-milks`)).json();
        expect(milks[0].remaining).toBe(500);
    });
});

describe('bean extra fields (altitude/importer/harvest/price/producer/certification)', () => {
    it('sanitizes and round-trips all six fields', async () => {
        const r = await fetch(`${baseUrl}/api/library/bean`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: 'Full Bean', altitude_m: '1900', importer: 'Rehm Coffee', harvest: '04-06.25',
                price_eur: '14.9', producer: 'Finca La Maravilla', certification: 'Bio, Fairtrade',
            }),
        });
        const bean = await r.json();
        expect(bean).toMatchObject({
            altitude_m: 1900, importer: 'Rehm Coffee', harvest: '04-06.25',
            price_eur: 14.9, producer: 'Finca La Maravilla', certification: 'Bio, Fairtrade',
        });

        const put = await fetch(`${baseUrl}/api/library/bean/${bean.id}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ altitude_m: '5000', price_eur: '-3' }),
        });
        const updated = await put.json();
        expect(updated.altitude_m).toBeNull(); // out of the 0-3000 range
        expect(updated.price_eur).toBeNull();  // negative rejected
    });
});

describe('bean brew recommendation fields (manual-only)', () => {
    it('sanitizes and round-trips all four fields', async () => {
        const r = await fetch(`${baseUrl}/api/library/bean`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: 'Brew Bean', brewTempC: '94', brewRatio: '1:2.2', brewTimeS: '28',
                brewNotes: 'a bit hotter than usual',
            }),
        });
        const bean = await r.json();
        expect(bean).toMatchObject({
            brewTempC: 94, brewRatio: '1:2.2', brewTimeS: 28, brewNotes: 'a bit hotter than usual',
        });

        const put = await fetch(`${baseUrl}/api/library/bean/${bean.id}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ brewTempC: '150', brewTimeS: '1' }),
        });
        const updated = await put.json();
        expect(updated.brewTempC).toBeNull(); // out of the 80-100°C range
        expect(updated.brewTimeS).toBeNull(); // below the 5s minimum
    });

    it('leaves brew fields unset (not zero/empty strings) when omitted', async () => {
        const r = await fetch(`${baseUrl}/api/library/bean`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Plain Bean' }),
        });
        const bean = await r.json();
        expect(bean.brewTempC).toBeNull();
        expect(bean.brewTimeS).toBeNull();
        expect(bean.brewRatio).toBe('');
        expect(bean.brewNotes).toBe('');
    });
});

describe('bag batch number (manual-only, per-bag)', () => {
    it('saves batchNumber on the initial bag created via POST and round-trips it', async () => {
        const r = await fetch(`${baseUrl}/api/library/bean`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Batch Bean', roastDate: '2026-06-01', stock_g: 250, batchNumber: 'L2405-13' }),
        });
        const bean = await r.json();
        expect(bean.bags).toHaveLength(1);
        expect(bean.bags[0].batchNumber).toBe('L2405-13');
    });

    it('does not break bag creation when batchNumber is omitted', async () => {
        const r = await fetch(`${baseUrl}/api/library/bean`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'No Batch Bean', roastDate: '2026-06-01', stock_g: 250 }),
        });
        const bean = await r.json();
        expect(bean.bags).toHaveLength(1);
        expect(bean.bags[0].batchNumber).toBe('');
    });

    it('caps batchNumber length like other optional string fields', async () => {
        const long = 'X'.repeat(80);
        const r = await fetch(`${baseUrl}/api/library/bean`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Long Batch Bean', roastDate: '2026-06-01', batchNumber: long }),
        });
        const bean = await r.json();
        expect(bean.bags[0].batchNumber).toHaveLength(50);
        expect(bean.bags[0].batchNumber).toBe(long.slice(0, 50));
    });

    it('updates the active bag batchNumber via PUT', async () => {
        const r = await fetch(`${baseUrl}/api/library/bean`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Editable Batch Bean', roastDate: '2026-06-01', stock_g: 250, batchNumber: 'L2405-13' }),
        });
        const bean = await r.json();

        const put = await fetch(`${baseUrl}/api/library/bean/${bean.id}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ batchNumber: 'L2409-07' }),
        });
        const updated = await put.json();
        expect(updated.bags[0].batchNumber).toBe('L2409-07');
    });

    it('accepts batchNumber on POST .../new-bag', async () => {
        const r = await fetch(`${baseUrl}/api/library/bean`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Multi-bag Bean', roastDate: '2026-05-01', stock_g: 250, batchNumber: 'L2405-13' }),
        });
        const bean = await r.json();

        const newBag = await fetch(`${baseUrl}/api/library/bean/${bean.id}/new-bag`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ roastDate: '2026-06-20', stock_g: 250, batchNumber: 'L2406-20' }),
        });
        const withNewBag = await newBag.json();
        expect(withNewBag.bags).toHaveLength(2);
        expect(withNewBag.bags[0].batchNumber).toBe('L2405-13');
        expect(withNewBag.bags[1].batchNumber).toBe('L2406-20');
    });
});

describe('bean origin/variety/process fields', () => {
    it('stores origin as an uppercased ISO alpha-2 code and keeps variety/process', async () => {
        const r = await fetch(`${baseUrl}/api/library/bean`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Yirgacheffe', origin: 'et', variety: 'Heirloom', process: 'Washed' }),
        });
        expect(r.status).toBe(200);
        const bean = await r.json();
        expect(bean).toMatchObject({ origin: 'ET', variety: 'Heirloom', process: 'Washed' });
    });

    it('drops non-ISO origin values instead of storing free text', async () => {
        const r = await fetch(`${baseUrl}/api/library/bean`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Mystery', origin: 'Äthiopien' }),
        });
        expect((await r.json()).origin).toBe('');
    });

    it('updates the new fields via PUT', async () => {
        saveLibrary({ beans: [{ id: 7, name: 'Dolce', origin: '', variety: '', process: '' }], grinders: [], recipes: [] });
        const r = await fetch(`${baseUrl}/api/library/bean/7`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ origin: 'br', variety: 'Bourbon', process: 'Natural' }),
        });
        expect(await r.json()).toMatchObject({ origin: 'BR', variety: 'Bourbon', process: 'Natural' });
    });
});

describe('bean blend origins (origins[] array)', () => {
    it('stores multiple origins, deduped, with optional per-country percent', async () => {
        const r = await fetch(`${baseUrl}/api/library/bean`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: 'Bombe Blend',
                origins: [{ code: 'br', percent: '70' }, { code: 'in', percent: '30' }, { code: 'br' }],
            }),
        });
        const bean = await r.json();
        expect(bean.origins).toEqual([{ code: 'BR', percent: 70 }, { code: 'IN', percent: 30 }]);
        expect(bean.origin).toBe('BR'); // derived: first origin, backward-compat for external consumers
    });

    it('caps at 5 origins and drops invalid codes', async () => {
        const r = await fetch(`${baseUrl}/api/library/bean`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: 'Kitchen Sink',
                origins: [{ code: 'br' }, { code: 'in' }, { code: 'et' }, { code: 'co' }, { code: 'ke' }, { code: 'vn' }, { code: 'not-a-code' }],
            }),
        });
        const bean = await r.json();
        expect(bean.origins).toHaveLength(5);
    });

    it('treats an out-of-range percent as unset rather than storing it', async () => {
        const r = await fetch(`${baseUrl}/api/library/bean`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Weird %', origins: [{ code: 'br', percent: '150' }] }),
        });
        expect((await r.json()).origins).toEqual([{ code: 'BR' }]);
    });

    it('updates origins via PUT, replacing the derived legacy origin field', async () => {
        saveLibrary({ beans: [{ id: 20, name: 'Old Single', origin: 'ET', origins: [{ code: 'ET' }] }], grinders: [], recipes: [] });
        const r = await fetch(`${baseUrl}/api/library/bean/20`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ origins: [{ code: 'br' }, { code: 'in' }] }),
        });
        const bean = await r.json();
        expect(bean.origins).toEqual([{ code: 'BR' }, { code: 'IN' }]);
        expect(bean.origin).toBe('BR');
    });

    it('a legacy single-field PUT still replaces origins with a single-element array', async () => {
        saveLibrary({ beans: [{ id: 21, name: 'Blend', origin: 'BR', origins: [{ code: 'BR' }, { code: 'IN' }] }], grinders: [], recipes: [] });
        const r = await fetch(`${baseUrl}/api/library/bean/21`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ origin: 'et' }),
        });
        const bean = await r.json();
        expect(bean.origins).toEqual([{ code: 'ET' }]);
        expect(bean.origin).toBe('ET');
    });
});

describe('LibraryService.migrateOriginToOrigins', () => {
    it('wraps a legacy single origin into an origins array, idempotently', () => {
        saveLibrary({ beans: [
            { id: 1, name: 'A', origin: 'ET' },
            { id: 2, name: 'B', origin: '' },
            { id: 3, name: 'C', origin: 'BR', origins: [{ code: 'BR' }] }, // already migrated
        ], grinders: [], recipes: [] });

        const changed = libraryService.migrateOriginToOrigins();
        expect(changed).toBe(2); // only the two beans without an origins array yet

        const lib = libraryService.getLibrary();
        expect(lib.beans.find(b => b.id === 1).origins).toEqual([{ code: 'ET' }]);
        expect(lib.beans.find(b => b.id === 2).origins).toEqual([]);
        expect(lib.beans.find(b => b.id === 3).origins).toEqual([{ code: 'BR' }]); // untouched

        expect(libraryService.migrateOriginToOrigins()).toBe(0); // idempotent second call
    });
});

describe('bean roastType/flavors/variety (misc fields)', () => {
    it('whitelists roastType and drops unknown values', async () => {
        const ok = await (await fetch(`${baseUrl}/api/library/bean`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Roasty', roastType: 'filter' }),
        })).json();
        expect(ok.roastType).toBe('filter');

        const bad = await (await fetch(`${baseUrl}/api/library/bean/${ok.id}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ roastType: 'nuclear' }),
        })).json();
        expect(bad.roastType).toBe('');
    });

    it('stores flavors deduped and capped, round-trips via PUT', async () => {
        const r = await fetch(`${baseUrl}/api/library/bean`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Tasty', flavors: ['Aprikose', ' aprikose ', 'Karamell', 42, ''] }),
        });
        const bean = await r.json();
        expect(bean.flavors).toEqual(['Aprikose', 'Karamell']);

        const put = await fetch(`${baseUrl}/api/library/bean/${bean.id}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ flavors: Array.from({ length: 30 }, (_, i) => `f${i}`) }),
        });
        expect((await put.json()).flavors).toHaveLength(20); // cap
    });

    it('exposes variety on /api/orders/active-beans', async () => {
        saveLibrary({ beans: [
            { id: 1, name: 'El Cubanito', stock_g: 500, variety: 'Robusta', origin: 'CU',
              bags: [{ id: 1, roastDate: '2026-06-01', stock_g: 500, openedAt: 0 }] },
        ], grinders: [], recipes: [] });
        const [bean] = await (await fetch(`${baseUrl}/api/orders/active-beans`)).json();
        expect(bean).toMatchObject({ variety: 'Robusta', origin: 'CU' });
    });
});

describe('bean image (POST imageUrl -> fire-and-forget download -> serve)', () => {
    const tick = () => new Promise(r => setTimeout(r, 10));

    it('sets bean.image after an allowed imageUrl download resolves', async () => {
        const r = await fetch(`${baseUrl}/api/library/bean`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Picture Perfect', imageUrl: 'https://cdn.shopify.com/img.jpg' }),
        });
        const bean = await r.json();
        expect(bean.image).toBeUndefined(); // response returns before the async download finishes
        await tick();
        const lib = await (await fetch(`${baseUrl}/api/library`)).json();
        expect(lib.beans.find(b => b.id === bean.id).image).toBe('jpg');
    });

    it('leaves bean.image unset when the download is rejected', async () => {
        const r = await fetch(`${baseUrl}/api/library/bean`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'No Picture', imageUrl: 'https://evil.example.com/img.jpg' }),
        });
        const bean = await r.json();
        await tick();
        const lib = await (await fetch(`${baseUrl}/api/library`)).json();
        expect(lib.beans.find(b => b.id === bean.id).image).toBeUndefined();
    });

    it('GET .../image 404s when the bean has no image', async () => {
        saveLibrary({ beans: [{ id: 1, name: 'Plain' }], grinders: [], recipes: [] });
        expect((await fetch(`${baseUrl}/api/library/bean/1/image`)).status).toBe(404);
        expect((await fetch(`${baseUrl}/api/library/bean/999/image`)).status).toBe(404);
    });
});

describe('GET /api/library/beans-info', () => {
    it('returns descriptive fields with the active bag roast date', async () => {
        saveLibrary({ beans: [
            { id: 1, name: 'Shyira', roaster: 'H&P', origin: 'RW', variety: 'Red Bourbon', process: 'Washed',
              roastDate: '2026-05-01', bags: [
                { id: 10, roastDate: '2026-05-01', stock_g: 250, openedAt: 0 },
                { id: 11, roastDate: '2026-06-20', stock_g: 250, openedAt: 1000 },
              ] },
            { id: 2, name: 'Untracked' },
        ], grinders: [], recipes: [] });
        const beans = await (await fetch(`${baseUrl}/api/library/beans-info`)).json();
        expect(beans).toHaveLength(2); // no stock filtering
        expect(beans[0]).toMatchObject({
            name: 'Shyira', origin: 'RW', variety: 'Red Bourbon', process: 'Washed',
            roastDate: '2026-06-20', decaf: false,
        });
        expect(beans[1]).toMatchObject({ name: 'Untracked', origin: null, roastDate: null });
    });

    it('stays reachable with orders disabled', async () => {
        ordersEnabled = false;
        try {
            saveLibrary({ beans: [{ id: 1, name: 'Dolce' }], grinders: [], recipes: [] });
            const r = await fetch(`${baseUrl}/api/library/beans-info`);
            expect(r.status).toBe(200);
        } finally { ordersEnabled = true; }
    });
});

describe('GET /api/maintenance/log', () => {
    it('enriches grinder log entries with the grinder name', async () => {
        saveLibrary({ beans: [], grinders: [{ id: 1779521986327, name: 'Kingrinder K6' }], recipes: [] });
        const done = await fetch(`${baseUrl}/api/maintenance/grinder_1779521986327/done`, { method: 'POST' });
        expect(done.status).toBe(200);

        const [entry] = await (await fetch(`${baseUrl}/api/maintenance/log`)).json();
        expect(entry).toMatchObject({ task: 'grinder_1779521986327', grinderName: 'Kingrinder K6' });
    });

    it('omits grinderName when the grinder was deleted since', async () => {
        saveLibrary({ beans: [], grinders: [{ id: 42, name: 'DF64' }], recipes: [] });
        await fetch(`${baseUrl}/api/maintenance/grinder_42/done`, { method: 'POST' });
        saveLibrary({ beans: [], grinders: [], recipes: [] });

        const [entry] = await (await fetch(`${baseUrl}/api/maintenance/log`)).json();
        expect(entry.task).toBe('grinder_42');
        expect(entry.grinderName).toBeUndefined();
    });
});

describe('POST /api/library/grinder/:id/delete', () => {
    it('removes the grinder maintenance entry from the database', async () => {
        saveLibrary({ beans: [], grinders: [{ id: 42, name: 'DF64' }], recipes: [] });
        const maint = libraryService.getMaintenance();
        maint.grinder_42 = { lastDate: '2026-06-01', threshold_shots: 50, threshold_days: null };
        libraryService.saveMaintenance(maint);

        const r = await fetch(`${baseUrl}/api/library/grinder/42/delete`, { method: 'POST' });
        expect(r.status).toBe(200);
        expect(libraryService.getMaintenance().grinder_42).toBeUndefined();
    });
});

describe('grinder extra fields (burrType/purchaseDate) and photo upload', () => {
    it('sanitizes and round-trips burrType/purchaseDate', async () => {
        const r = await fetch(`${baseUrl}/api/library/grinder`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'DF64', burrType: 'Konisch Stahl', purchaseDate: '01.03.2026' }),
        });
        const grinder = await r.json();
        expect(grinder).toMatchObject({ burrType: 'Konisch Stahl', purchaseDate: '01.03.2026' });

        const r2 = await fetch(`${baseUrl}/api/library/grinder/${grinder.id}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ burrType: 'Flach Keramik' }),
        });
        expect((await r2.json()).burrType).toBe('Flach Keramik');
    });

    it('uploads a photo and serves it back', async () => {
        saveLibrary({ beans: [], grinders: [{ id: 42, name: 'DF64' }], recipes: [] });
        const r = await fetch(`${baseUrl}/api/library/grinder/42/image`, {
            method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: Buffer.from('fake-jpeg-bytes'),
        });
        expect(r.status).toBe(200);
        expect((await r.json()).image).toBe('jpg');
    });

    it('rejects an upload for a nonexistent grinder', async () => {
        saveLibrary({ beans: [], grinders: [], recipes: [] });
        const r = await fetch(`${baseUrl}/api/library/grinder/999/image`, {
            method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: Buffer.from('x'),
        });
        expect(r.status).toBe(404);
    });

    it('404s the image route when no photo has been uploaded', async () => {
        saveLibrary({ beans: [], grinders: [{ id: 7, name: 'K6' }], recipes: [] });
        const r = await fetch(`${baseUrl}/api/library/grinder/7/image`);
        expect(r.status).toBe(404);
    });

    it('rejects an unsupported content type (express.raw skips parsing it)', async () => {
        saveLibrary({ beans: [], grinders: [{ id: 8, name: 'K6' }], recipes: [] });
        const r = await fetch(`${baseUrl}/api/library/grinder/8/image`, {
            method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'not an image',
        });
        expect(r.status).toBe(400);
    });
});

describe('bean photo manual upload fallback (auto-import can silently fail)', () => {
    it('uploads a photo and serves it back', async () => {
        saveLibrary({ beans: [{ id: 42, name: 'Dolce' }], grinders: [], recipes: [] });
        const r = await fetch(`${baseUrl}/api/library/bean/42/image`, {
            method: 'POST', headers: { 'Content-Type': 'image/png' }, body: Buffer.from('fake-png-bytes'),
        });
        expect(r.status).toBe(200);
        expect((await r.json()).image).toBe('jpg'); // mocked saveUploadedImage always returns 'jpg'
    });

    it('rejects an upload for a nonexistent bean', async () => {
        saveLibrary({ beans: [], grinders: [], recipes: [] });
        const r = await fetch(`${baseUrl}/api/library/bean/999/image`, {
            method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: Buffer.from('x'),
        });
        expect(r.status).toBe(404);
    });

    it('rejects an unsupported content type (express.raw skips parsing it)', async () => {
        saveLibrary({ beans: [{ id: 9, name: 'Dolce' }], grinders: [], recipes: [] });
        const r = await fetch(`${baseUrl}/api/library/bean/9/image`, {
            method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'not an image',
        });
        expect(r.status).toBe(400);
    });

    it('replacing an existing photo still returns 200 and the new extension', async () => {
        saveLibrary({ beans: [{ id: 10, name: 'Dolce', image: 'png' }], grinders: [], recipes: [] });
        const r = await fetch(`${baseUrl}/api/library/bean/10/image`, {
            method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: Buffer.from('new-bytes'),
        });
        expect(r.status).toBe(200);
        expect((await r.json()).image).toBe('jpg');
    });
});
