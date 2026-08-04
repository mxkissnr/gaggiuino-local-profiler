// #648: routes/maintenance.js's machineHostname() read getMachineUrl(loadOptions())
// straight off options.json's machine_host, ignoring registry.updateMachine()
// writes to the machines table entirely -- same root cause #638/#641 fixed
// elsewhere. Cosmetic (display/log text stored on maintenance log rows), but
// after a host edit, newly-written entries should show the current hostname,
// not the stale one forever.
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
const registryPath     = require.resolve('../lib/machines/registry');
const dataPath         = require.resolve('../lib/data');
const maintenancePath  = require.resolve('../routes/maintenance');
const libraryServicePath = require.resolve('../lib/services/LibraryService');

describe('#648 maintenance log entries use the registry\'s current default-machine host, not stale options.json', () => {
    let memDb, tmpFile, server, baseUrl;

    beforeEach(async () => {
        memDb = new Database(':memory:');
        realDb.initSchema(memDb);
        require.cache[dbPath].exports = { getDb: () => memDb, initSchema: realDb.initSchema };

        tmpFile = path.join(os.tmpdir(), `glp-test-options-648-maint-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
        fs.writeFileSync(tmpFile, JSON.stringify({ machine_host: 'options-host.local' }));
        require.cache[constantsPath].exports = { ...realConstants, OPTIONS_FILE: tmpFile };

        delete require.cache[registryPath];
        delete require.cache[dataPath];
        delete require.cache[maintenancePath];
        delete require.cache[libraryServicePath];

        const registry = require('../lib/machines/registry');
        registry.ensureDefaultMachine(); // seeds machine #1's host from options.json ('options-host.local')

        const express = require('express');
        const maintenanceRouter = require('../routes/maintenance');
        const app = express();
        app.use(express.json());
        app.use(maintenanceRouter);
        server = app.listen(0);
        await new Promise(resolve => server.once('listening', resolve));
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    afterEach(async () => {
        if (server) await new Promise(resolve => server.close(resolve));
        memDb.close();
        require.cache[dbPath].exports = realDb;
        require.cache[constantsPath].exports = realConstants;
        fs.rmSync(tmpFile, { force: true });
    });

    it('logs the registry\'s current default-machine hostname, not the stale options.json one', async () => {
        const registry = require('../lib/machines/registry');
        registry.updateMachine(1, { host: 'updated-host.local' });

        const done = await fetch(`${baseUrl}/api/maintenance/descaling/done`, { method: 'POST' });
        expect(done.status).toBe(200);

        const [entry] = await (await fetch(`${baseUrl}/api/maintenance/log`)).json();
        expect(entry.machine).toBe('updated-host.local');
        expect(entry.machine).not.toBe('options-host.local');
    });

    it('falls back to options.json\'s hostname when the registry has no usable host', async () => {
        const registry = require('../lib/machines/registry');
        const spy = vi.spyOn(registry, 'getDefaultMachine').mockReturnValue(null);

        const done = await fetch(`${baseUrl}/api/maintenance/descaling/done`, { method: 'POST' });
        expect(done.status).toBe(200);

        const [entry] = await (await fetch(`${baseUrl}/api/maintenance/log`)).json();
        expect(entry.machine).toBe('options-host.local');

        spy.mockRestore();
    });
});
