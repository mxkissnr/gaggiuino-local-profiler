// #638: the default machine's host must always be read live from the
// registry. Before this fix, lib/poll.js's pollViaGaggiuinoStatus() and
// lib/sync.js's syncShots() both called getMachineBaseUrl(opts)/getMachineUrl(opts)
// straight off options.json's machine_host -- so editing the default
// machine's host via the Settings UI (registry.updateMachine()) never
// reached the live-poll loop or periodic sync, which kept hitting the
// original host forever.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const dbPath         = require.resolve('../lib/db');
const realDb         = require(dbPath);
const constantsPath  = require.resolve('../lib/constants');
const realConstants  = require(constantsPath);
const axiosPath      = require.resolve('axios');
const realAxios      = require(axiosPath);
const registryPath   = require.resolve('../lib/machines/registry');
const dataPath       = require.resolve('../lib/data');
const pollPath       = require.resolve('../lib/poll');
const syncPath       = require.resolve('../lib/sync');

describe('#638 default-machine host stays live (registry, not stale options.json)', () => {
    let memDb, tmpFile, axiosGetMock;

    beforeEach(() => {
        memDb = new Database(':memory:');
        realDb.initSchema(memDb);
        require.cache[dbPath].exports = { getDb: () => memDb, initSchema: realDb.initSchema };

        tmpFile = path.join(os.tmpdir(), `glp-test-options-638-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
        fs.writeFileSync(tmpFile, JSON.stringify({ machine_host: 'options-host.local' }));
        require.cache[constantsPath].exports = { ...realConstants, OPTIONS_FILE: tmpFile };

        // axios.get is stubbed to reject immediately -- pollViaGaggiuinoStatus()
        // and syncShots() both hit their outer try/catch right after the call,
        // which is fine here: the point of these tests is which URL each
        // function invoked axios.get with, not a real response.
        axiosGetMock = vi.fn().mockRejectedValue(new Error('network disabled in test'));
        require.cache[axiosPath].exports = { get: axiosGetMock };

        delete require.cache[registryPath];
        delete require.cache[dataPath];
        delete require.cache[pollPath];
        delete require.cache[syncPath];

        const registry = require('../lib/machines/registry');
        registry.ensureDefaultMachine(); // seeds machine #1 host from options.json ('options-host.local')
    });

    afterEach(() => {
        memDb.close();
        require.cache[dbPath].exports = realDb;
        require.cache[constantsPath].exports = realConstants;
        require.cache[axiosPath].exports = realAxios;
        fs.rmSync(tmpFile, { force: true });
    });

    it('pollViaGaggiuinoStatus() uses the registry\'s current default-machine host, not the stale options.json one', async () => {
        const registry = require('../lib/machines/registry');
        registry.updateMachine(1, { host: 'updated-host.local' });

        const { pollViaGaggiuinoStatus } = require('../lib/poll');
        const { MachineRuntimeState } = require('../lib/machine-runtime-state');
        await pollViaGaggiuinoStatus(new MachineRuntimeState());

        expect(axiosGetMock).toHaveBeenCalledTimes(1);
        const [url] = axiosGetMock.mock.calls[0];
        expect(url).toBe('http://updated-host.local/api/system/status');
        expect(url).not.toContain('options-host.local');
    });

    it('syncShots() uses the registry\'s current default-machine host, not the stale options.json one', async () => {
        const registry = require('../lib/machines/registry');
        registry.updateMachine(1, { host: 'updated-host.local' });

        const { syncShots } = require('../lib/sync');
        const ok = await syncShots({ machineOn: true });

        expect(ok).toBe(false); // axios.get was stubbed to reject -- confirms the request was actually attempted
        expect(axiosGetMock).toHaveBeenCalledTimes(1);
        const [url] = axiosGetMock.mock.calls[0];
        expect(url).toBe('http://updated-host.local/api/shots/latest');
        expect(url).not.toContain('options-host.local');
    });

    it('pollViaGaggiuinoStatus() falls back to options.json when the registry has no usable host', async () => {
        // Defensive path (should not happen in practice once ensureDefaultMachine()
        // has seeded a row) -- must not throw, and must keep resolving from
        // options.json exactly as before this fix.
        const registry = require('../lib/machines/registry');
        const spy = vi.spyOn(registry, 'getDefaultMachine').mockReturnValue(null);

        const { pollViaGaggiuinoStatus } = require('../lib/poll');
        const { MachineRuntimeState } = require('../lib/machine-runtime-state');
        await pollViaGaggiuinoStatus(new MachineRuntimeState());

        expect(axiosGetMock).toHaveBeenCalledTimes(1);
        const [url] = axiosGetMock.mock.calls[0];
        expect(url).toBe('http://options-host.local/api/system/status');

        spy.mockRestore();
    });

    it('syncShots() falls back to options.json when the registry has no usable host', async () => {
        const registry = require('../lib/machines/registry');
        const spy = vi.spyOn(registry, 'getDefaultMachine').mockReturnValue(null);

        const { syncShots } = require('../lib/sync');
        await syncShots({ machineOn: true });

        expect(axiosGetMock).toHaveBeenCalledTimes(1);
        const [url] = axiosGetMock.mock.calls[0];
        expect(url).toBe('http://options-host.local/api/shots/latest');

        spy.mockRestore();
    });
});
