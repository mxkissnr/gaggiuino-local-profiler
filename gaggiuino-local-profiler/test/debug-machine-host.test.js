// #648: GET /api/debug/machine (dev-only, gated behind NODE_ENV !== 'production')
// resolved the polled host straight from options.json's machine_host, ignoring
// registry.updateMachine() writes to the machines table entirely -- same root
// cause #638/#641 fixed for lib/poll.js/lib/sync.js. Editing the default
// machine's host via the Settings UI never took effect for this endpoint,
// which kept polling the *old* host forever.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const dbPath        = require.resolve('../lib/db');
const realDb        = require(dbPath);
const constantsPath = require.resolve('../lib/constants');
const realConstants = require(constantsPath);
const axiosPath      = require.resolve('axios');
const realAxios      = require(axiosPath);
const registryPath  = require.resolve('../lib/machines/registry');
const dataPath      = require.resolve('../lib/data');
const systemPath    = require.resolve('../routes/system');

describe('#648 GET /api/debug/machine resolves host from the registry, not stale options.json', () => {
    let memDb, tmpFile, axiosGetMock, server, baseUrl;

    beforeEach(async () => {
        memDb = new Database(':memory:');
        realDb.initSchema(memDb);
        require.cache[dbPath].exports = { getDb: () => memDb, initSchema: realDb.initSchema };

        tmpFile = path.join(os.tmpdir(), `glp-test-options-648-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
        fs.writeFileSync(tmpFile, JSON.stringify({ machine_host: 'options-host.local' }));
        require.cache[constantsPath].exports = { ...realConstants, OPTIONS_FILE: tmpFile };

        axiosGetMock = vi.fn().mockResolvedValue({ data: { ok: true } });
        require.cache[axiosPath].exports = { get: axiosGetMock };

        delete require.cache[registryPath];
        delete require.cache[dataPath];
        delete require.cache[systemPath];

        const registry = require('../lib/machines/registry');
        registry.ensureDefaultMachine(); // seeds machine #1's host from options.json ('options-host.local')

        const express = require('express');
        const systemRouter = require('../routes/system');
        const app = express();
        app.use(express.json());
        app.use(systemRouter);
        server = app.listen(0);
        await new Promise(resolve => server.once('listening', resolve));
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    afterEach(async () => {
        if (server) await new Promise(resolve => server.close(resolve));
        memDb.close();
        require.cache[dbPath].exports = realDb;
        require.cache[constantsPath].exports = realConstants;
        require.cache[axiosPath].exports = realAxios;
        fs.rmSync(tmpFile, { force: true });
    });

    it('uses the registry\'s current default-machine host, not the stale options.json one', async () => {
        const registry = require('../lib/machines/registry');
        registry.updateMachine(1, { host: 'updated-host.local' });

        const r = await fetch(`${baseUrl}/api/debug/machine`);
        const body = await r.json();

        expect(body.baseUrl).toBe('http://updated-host.local');
        expect(body.baseUrl).not.toContain('options-host.local');
        expect(axiosGetMock).toHaveBeenCalledWith('http://updated-host.local/api/system/status', expect.anything());
    });

    it('falls back to options.json when the registry has no usable host', async () => {
        const registry = require('../lib/machines/registry');
        const spy = vi.spyOn(registry, 'getDefaultMachine').mockReturnValue(null);

        const r = await fetch(`${baseUrl}/api/debug/machine`);
        const body = await r.json();

        expect(body.baseUrl).toBe('http://options-host.local');

        spy.mockRestore();
    });
});
