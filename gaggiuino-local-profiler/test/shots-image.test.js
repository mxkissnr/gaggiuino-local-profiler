import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createRequire } from 'module';
import { mkdtempSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
const require = createRequire(import.meta.url);

const tmpDir = mkdtempSync(path.join(tmpdir(), 'glp-shot-images-'));

// Redirect bean/shot image storage to a scratch dir, same pattern as
// test/bean-image.test.js, so uploads actually round-trip through real files.
const constantsPath = require.resolve('../lib/constants');
const realConstants  = require(constantsPath);
require.cache[constantsPath].exports = { ...realConstants, BEAN_IMAGE_DIR: tmpDir };

// Same in-memory DB swap as test/db-routes.test.js: patch the require cache
// for lib/db.js before any route/repository is required.
const Database = require('better-sqlite3');
const dbPath   = require.resolve('../lib/db');
const realDb   = require(dbPath);
const memDb    = new Database(':memory:');
realDb.initSchema(memDb);
require.cache[dbPath].exports = { getDb: () => memDb, initSchema: realDb.initSchema };

const express  = require('express');
const shotsRouter = require('../routes/shots');
const shotRepo     = require('../lib/repositories/ShotRepository');
const { imagePath } = require('../lib/services/ImageService');
const { getDb }      = require('../lib/db');

function makeApp() {
    const app = express();
    app.use(express.json());
    app.use(shotsRouter);
    app.use((err, req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
    return app;
}

let server, baseUrl;

beforeEach(async () => {
    getDb().exec('DELETE FROM shots; DELETE FROM annotations; DELETE FROM trash;');
    server = makeApp().listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => {
    server?.close();
    rmSync(tmpDir, { recursive: true, force: true });
});

describe('shot image upload/retrieve/delete', () => {
    it('round-trips a successful upload through GET', async () => {
        shotRepo.upsert({ id: 1, timestamp: 1000, duration: 250 });
        const up = await fetch(`${baseUrl}/api/shots/1/image`, {
            method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: Buffer.from('fake-jpeg-bytes'),
        });
        expect(up.status).toBe(200);
        expect((await up.json()).image).toBe('jpg');
        expect(existsSync(imagePath(1, 'jpg', 'shot-'))).toBe(true);

        const get = await fetch(`${baseUrl}/api/shots/1/image`);
        expect(get.status).toBe(200);
        expect(get.headers.get('content-type')).toContain('image/jpeg');
        expect(Buffer.from(await get.arrayBuffer()).toString()).toBe('fake-jpeg-bytes');

        // shot record itself now reports the image field
        const shotGet = await (await fetch(`${baseUrl}/api/shots/1`)).json();
        expect(shotGet.image).toBe('jpg');
    });

    it('rejects an oversized upload', async () => {
        shotRepo.upsert({ id: 2, timestamp: 1000, duration: 250 });
        const big = Buffer.alloc(2 * 1024 * 1024, 1); // exceeds BEAN_IMAGE_MAX_BYTES (1.5MB)
        const r = await fetch(`${baseUrl}/api/shots/2/image`, {
            method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: big,
        });
        expect(r.status).toBe(413);
    });

    it('rejects an unsupported content type', async () => {
        shotRepo.upsert({ id: 3, timestamp: 1000, duration: 250 });
        const r = await fetch(`${baseUrl}/api/shots/3/image`, {
            method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'not an image',
        });
        expect(r.status).toBe(400);
    });

    it('DELETE removes the file and clears the shot image field', async () => {
        shotRepo.upsert({ id: 4, timestamp: 1000, duration: 250 });
        await fetch(`${baseUrl}/api/shots/4/image`, {
            method: 'POST', headers: { 'Content-Type': 'image/png' }, body: Buffer.from('fake-png-bytes'),
        });
        expect(existsSync(imagePath(4, 'png', 'shot-'))).toBe(true);

        const del = await fetch(`${baseUrl}/api/shots/4/image`, { method: 'DELETE' });
        expect(del.status).toBe(200);
        expect(existsSync(imagePath(4, 'png', 'shot-'))).toBe(false);

        const shotGet = await (await fetch(`${baseUrl}/api/shots/4`)).json();
        expect(shotGet.image).toBeUndefined();
    });

    it('404s the GET route when no photo has been uploaded', async () => {
        shotRepo.upsert({ id: 5, timestamp: 1000, duration: 250 });
        const r = await fetch(`${baseUrl}/api/shots/5/image`);
        expect(r.status).toBe(404);
    });

    it('404s the GET route for an unknown shot id', async () => {
        const r = await fetch(`${baseUrl}/api/shots/999/image`);
        expect(r.status).toBe(404);
    });

    it('a shot-prefixed image never collides with a bean/grinder image of the same numeric id', async () => {
        shotRepo.upsert({ id: 42, timestamp: 1000, duration: 250 });
        await fetch(`${baseUrl}/api/shots/42/image`, {
            method: 'POST', headers: { 'Content-Type': 'image/webp' }, body: Buffer.from('shot-bytes'),
        });
        expect(imagePath(42, 'webp', 'shot-')).not.toBe(imagePath(42, 'webp'));
        expect(imagePath(42, 'webp', 'shot-')).not.toBe(imagePath(42, 'webp', 'grinder-'));
    });
});
