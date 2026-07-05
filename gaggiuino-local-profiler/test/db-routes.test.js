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

const express           = require('express');
const systemRouter      = require('../routes/system');
const ordersRouter      = require('../routes/orders');
const libraryRouter     = require('../routes/library');
const maintenanceRouter = require('../routes/maintenance');
const shotRepo      = require('../lib/repositories/ShotRepository');
const libraryService = require('../lib/services/LibraryService');
const { saveOrders, saveLibrary } = require('../lib/data');
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
