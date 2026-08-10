// #722: proves the dev-only raw-DB export route's gate actually gates --
// the important regression this guards against (see #638/#641/#643/#648's
// "a setting/gate must be proven to actually gate, not just proven to save/
// round-trip") is process.env.GLP_DEV_BUILD being unset ever letting this
// route respond with anything but a plain 404, since this endpoint reaching
// a real user's production install would be a data-exfiltration path.
//
// Mirrors test/dev-build-no-update-banner.test.js's pattern for setting/
// restoring GLP_DEV_BUILD around each test, including cleanup so the env var
// never leaks into other test files.
import { describe, it, expect, afterAll, afterEach } from 'vitest';
import { createRequire } from 'module';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
const require = createRequire(import.meta.url);

// res.download() needs a real file on disk, so this route (unlike most of
// the test suite) can't run against an in-memory better-sqlite3 database --
// point DATA_DIR at a scratch temp dir instead, same override pattern
// test/pwa-gating.test.js uses, so getDb()/DB_PATH resolve against a real
// throwaway glp.db instead of the actual /data.
const tmpDataDir = mkdtempSync(path.join(tmpdir(), 'glp-debug-export-db-'));
const constantsPath = require.resolve('../lib/constants');
const realConstants = require(constantsPath);
require.cache[constantsPath].exports = { ...realConstants, DATA_DIR: tmpDataDir };

const dbPath = require.resolve('../lib/db');
require(dbPath).getDb(); // creates the real glp.db file + schema in tmpDataDir

const express = require('express');
const debugRouter = require('../routes/debug');
const realFetch = globalThis.fetch;

async function startServer() {
    const app = express();
    app.use(debugRouter);
    const server = app.listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

describe('#722 GET /api/debug/export-db dev-build gate', () => {
    let server;

    afterEach(async () => {
        if (server) await new Promise(resolve => server.close(resolve));
        delete process.env.GLP_DEV_BUILD;
    });

    afterAll(() => {
        delete require.cache[constantsPath];
        delete require.cache[dbPath];
        globalThis.fetch = realFetch;
        rmSync(tmpDataDir, { recursive: true, force: true });
    });

    it('returns 404 when GLP_DEV_BUILD is unset', async () => {
        delete process.env.GLP_DEV_BUILD;
        let baseUrl;
        ({ server, baseUrl } = await startServer());
        const res = await realFetch(`${baseUrl}/api/debug/export-db`);
        expect(res.status).toBe(404);
    });

    it('streams the raw SQLite file as a download when GLP_DEV_BUILD is set', async () => {
        process.env.GLP_DEV_BUILD = 'dev-20260810_0800';
        let baseUrl;
        ({ server, baseUrl } = await startServer());
        const res = await realFetch(`${baseUrl}/api/debug/export-db`);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-disposition')).toMatch(/attachment; filename="glp-db-export-.*\.db"/);
        const bytes = new Uint8Array(await res.arrayBuffer());
        const header = Buffer.from(bytes.slice(0, 16)).toString('utf8');
        expect(header).toBe('SQLite format 3\0');
    });
});
