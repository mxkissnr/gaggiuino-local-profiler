import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// Same in-memory DB swap as preheat-ready-by.test.js: patch the require
// cache for lib/db.js before any route/repository is required, so every
// consumer shares the memory DB.
const Database  = require('better-sqlite3');
const dbPath    = require.resolve('../lib/db');
const realDb    = require(dbPath);
const memDb     = new Database(':memory:');
realDb.initSchema(memDb);
require.cache[dbPath].exports = { getDb: () => memDb, initSchema: realDb.initSchema };

// lib/preheat.js destructures loadOptions at require-time -- patch it here,
// before lib/preheat is required below, so individual tests can force it to
// throw synchronously and prove the 30s watcher (#642) survives that instead
// of leaving an unhandled rejection behind.
const dataPath = require.resolve('../lib/data');
const realData = require(dataPath);
let loadOptionsShouldThrow = false;
require.cache[dataPath].exports = {
    ...realData,
    loadOptions: () => {
        if (loadOptionsShouldThrow) throw new Error('synthetic loadOptions failure');
        return { switch_entity: 'switch.espresso', preheat_time: '1' };
    },
};

// log() is spied on via the same require-cache patch technique, so the
// watcher's error path can be asserted without depending on console output.
const helpersPath = require.resolve('../lib/helpers');
const realHelpers = require(helpersPath);
const logSpy = vi.fn();
require.cache[helpersPath].exports = { ...realHelpers, log: logSpy };

const { startPreheatWatcher } = require('../lib/preheat');
const state = require('../lib/state');
const { getMachineRuntimeState } = require('../lib/machine-runtime-state');
const runtime = getMachineRuntimeState();

describe('startPreheatWatcher 30s interval guard (#642)', () => {
    beforeEach(() => {
        loadOptionsShouldThrow  = false;
        logSpy.mockClear();
        runtime.machineOn       = false;
        runtime.switchOnAt      = null;
        state.preheatNotifySent = false;
        state.readyByTargetAt   = null;
        state.plannedSwitchOnAt = null;
    });

    afterEach(() => { vi.useRealTimers(); });

    it('a rejection inside _checkPreheatNotify on a tick is caught and logged, not left unhandled', async () => {
        vi.useFakeTimers();
        runtime.machineOn  = true;
        runtime.switchOnAt = Date.now() - 10 * 60 * 1000; // well past preheat_time
        loadOptionsShouldThrow = true;

        startPreheatWatcher(runtime);
        await vi.advanceTimersByTimeAsync(30000);

        const messages = logSpy.mock.calls.map(c => c[0]);
        expect(messages.some(m => /Preheat notify check failed/.test(m))).toBe(true);
    });

    it('a rejection inside _checkReadyByPreheat on a tick is caught and logged, not left unhandled', async () => {
        vi.useFakeTimers();
        runtime.machineOn       = false;
        state.readyByTargetAt   = Date.now() - 1000;
        state.plannedSwitchOnAt = Date.now() - 1000; // already due
        loadOptionsShouldThrow  = true;

        startPreheatWatcher(runtime);
        await vi.advanceTimersByTimeAsync(30000);

        const messages = logSpy.mock.calls.map(c => c[0]);
        expect(messages.some(m => /Ready-by preheat check failed/.test(m))).toBe(true);
    });

    it('the watcher keeps ticking after a caught rejection (one bad tick does not kill the interval)', async () => {
        vi.useFakeTimers();
        runtime.machineOn  = true;
        runtime.switchOnAt = Date.now() - 10 * 60 * 1000;
        loadOptionsShouldThrow = true;

        startPreheatWatcher(runtime);
        await vi.advanceTimersByTimeAsync(30000);
        const firstTickErrorLogs = logSpy.mock.calls.filter(c => /check failed/.test(c[0])).length;
        expect(firstTickErrorLogs).toBeGreaterThan(0);

        loadOptionsShouldThrow = false;
        logSpy.mockClear();
        await vi.advanceTimersByTimeAsync(30000);
        const secondTickErrorLogs = logSpy.mock.calls.filter(c => /check failed/.test(c[0])).length;
        expect(secondTickErrorLogs).toBe(0);
    });
});
