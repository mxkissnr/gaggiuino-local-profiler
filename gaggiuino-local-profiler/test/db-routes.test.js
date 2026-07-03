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

const express       = require('express');
const systemRouter  = require('../routes/system');
const ordersRouter  = require('../routes/orders');
const libraryRouter = require('../routes/library');
const shotRepo      = require('../lib/repositories/ShotRepository');
const libraryService = require('../lib/services/LibraryService');
const { saveOrders, saveLibrary } = require('../lib/data');
const { getDb }     = require('../lib/db');

function makeApp() {
    // Mirror the server.js mounting order: library before orders, system after
    const app = express();
    app.use(express.json());
    app.use(libraryRouter);
    app.use(ordersRouter);
    app.use(systemRouter);
    app.use((err, req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
    return app;
}

let server, baseUrl;

beforeEach(async () => {
    getDb().exec('DELETE FROM shots; DELETE FROM annotations; DELETE FROM trash; DELETE FROM orders; DELETE FROM maintenance; DELETE FROM library;');
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
