// #931 regression: "Restock" must add to the existing milk stock, not
// overwrite it. Exercises the actual /api/library/milk/:id/restock route
// against an in-memory DB, same setup pattern as db-routes.test.js.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const Database = require('better-sqlite3');
const dbPath   = require.resolve('../lib/db');
const realDb   = require(dbPath);
const memDb    = new Database(':memory:');
realDb.initSchema(memDb);
require.cache[dbPath].exports = { getDb: () => memDb, initSchema: realDb.initSchema, getInstallId: () => 'test-install-id' };

const express       = require('express');
const libraryRouter = require('../routes/library');
const { saveLibrary } = require('../lib/data');
const { getDb }       = require('../lib/db');

function makeApp() {
    const app = express();
    app.use(express.json());
    app.use(libraryRouter);
    return app;
}

let server, baseUrl;

beforeEach(async () => {
    getDb().exec('DELETE FROM library;');
    saveLibrary({ beans: [], grinders: [], recipes: [], milks: [{ id: 1, name: 'Oat', emoji: '🥛', stockMl: 100 }], baskets: [], puckScreens: [] });
    server = makeApp().listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => server?.close());

describe('POST /api/library/milk/:id/restock (#931)', () => {
    it('adds to the existing stock instead of replacing it', async () => {
        const r = await fetch(`${baseUrl}/api/library/milk/1/restock`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ml: 200 }),
        });
        expect(r.status).toBe(200);
        expect((await r.json()).stockMl).toBe(300);
    });

    it('rejects a non-positive amount', async () => {
        const r = await fetch(`${baseUrl}/api/library/milk/1/restock`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ml: 0 }),
        });
        expect(r.status).toBe(400);
    });

    it('404s for an unknown milk id', async () => {
        const r = await fetch(`${baseUrl}/api/library/milk/999/restock`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ml: 100 }),
        });
        expect(r.status).toBe(404);
    });
});
