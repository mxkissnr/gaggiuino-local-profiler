import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// Same in-memory DB swap as test/shots-image.test.js: patch the require
// cache for lib/db.js before any route/repository is required — shot
// defaults are persisted via the kv table (#654), same as import settings.
const Database = require('better-sqlite3');
const dbPath   = require.resolve('../lib/db');
const realDb   = require(dbPath);
const memDb    = new Database(':memory:');
realDb.initSchema(memDb);
require.cache[dbPath].exports = { getDb: () => memDb, initSchema: realDb.initSchema };

const express     = require('express');
const shotsRouter = require('../routes/shots');
const { getDb }   = require('../lib/db');

function makeApp() {
    const app = express();
    app.use(express.json());
    app.use(shotsRouter);
    app.use((err, req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
    return app;
}

let server, baseUrl;

beforeEach(async () => {
    getDb().exec("DELETE FROM kv WHERE key = 'shot_defaults';");
    server = makeApp().listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => { server?.close(); });

describe('GET/POST /api/shots/defaults (#654)', () => {
    it('GET returns all-null/empty defaults before anything was ever saved', async () => {
        const r = await fetch(`${baseUrl}/api/shots/defaults`);
        expect(r.status).toBe(200);
        expect(await r.json()).toEqual({
            drinkType: null, coffee: null, beanId: null,
            basketId: null, puckScreenId: null, grinder: '', dose: null,
        });
    });

    it('POST saves and echoes back the configured defaults, GET then returns them', async () => {
        const body = {
            drinkType: 'espresso', coffee: 'Kenya AA', beanId: 7,
            basketId: 3, puckScreenId: 5, grinder: 'Niche Zero', dose: 18.5,
        };
        const post = await fetch(`${baseUrl}/api/shots/defaults`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        expect(post.status).toBe(200);
        expect(await post.json()).toEqual(body);

        const get = await (await fetch(`${baseUrl}/api/shots/defaults`)).json();
        expect(get).toEqual(body);
    });

    it('is not shadowed by the /api/shots/:id route (registration order)', async () => {
        // Regression guard: 'defaults' must never be captured as a numeric
        // shot id by the GET /api/shots/:id route registered further down.
        const r = await fetch(`${baseUrl}/api/shots/defaults`);
        const data = await r.json();
        expect(data).not.toBeNull();
        expect(data).toHaveProperty('grinder');
    });

    it('rejects a non-numeric dose/beanId via the shotDefaultsSchema validator', async () => {
        const r = await fetch(`${baseUrl}/api/shots/defaults`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dose: 'a lot' }),
        });
        expect(r.status).toBe(400);
    });

    it('a saved value survives being unset again to null/empty on a later POST', async () => {
        await fetch(`${baseUrl}/api/shots/defaults`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ grinder: 'Niche Zero', dose: 18 }),
        });
        const r = await fetch(`${baseUrl}/api/shots/defaults`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        });
        expect(await r.json()).toEqual({
            drinkType: null, coffee: null, beanId: null,
            basketId: null, puckScreenId: null, grinder: '', dose: null,
        });
    });
});
