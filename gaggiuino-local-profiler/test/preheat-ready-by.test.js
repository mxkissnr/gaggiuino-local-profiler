import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// Same in-memory DB swap as db-routes.test.js: patch the require cache for
// lib/db.js before any route/repository is required, so every consumer
// shares the memory DB.
const Database  = require('better-sqlite3');
const dbPath    = require.resolve('../lib/db');
const realDb    = require(dbPath);
const memDb     = new Database(':memory:');
realDb.initSchema(memDb);
require.cache[dbPath].exports = { getDb: () => memDb, initSchema: realDb.initSchema };

// routes/system.js destructures HA_TOKEN from lib/constants at require-time
// (used by the new eager "switch configured?" check on POST
// /api/preheat/ready-by, mirroring /api/switch/toggle's own check) — real
// HA_TOKEN comes from process.env.SUPERVISOR_TOKEN, unset in tests, so patch
// it to a fixed present value here. Per-test "is switch_entity configured"
// variation is covered via the mutable mockOptions below instead.
const constantsPath = require.resolve('../lib/constants');
const realConstants = require(constantsPath);
require.cache[constantsPath].exports = { ...realConstants, HA_TOKEN: 'test-supervisor-token' };

// #541 needs a configured switch_entity + preheat_time — options.json does
// not exist in tests, so patch lib/data.js's loadOptions the same way
// db-routes.test.js patches isOrdersEnabled (module load order matters:
// lib/preheat.js and routes/system.js both destructure loadOptions at
// require-time, so this must run before either is required below). Mutable
// (not a fixed literal) so individual tests can flip switch_entity off —
// the destructured `loadOptions` binding in system.js/preheat.js still
// points at this same closure, which reads the current `mockOptions` value
// on every call.
const dataPath = require.resolve('../lib/data');
const realData = require(dataPath);
let mockOptions = { switch_entity: 'switch.espresso', preheat_time: '1' };
require.cache[dataPath].exports = {
    ...realData,
    loadOptions: () => mockOptions,
};

// callHaService is the HA call the ready-by watcher must reuse (same path
// as POST /api/switch/toggle) — mocked here so no real network call is made
// and so we can assert it was invoked with turn_on semantics.
const haPath = require.resolve('../lib/ha');
const realHa = require(haPath);
const callHaServiceMock = vi.fn().mockResolvedValue({});
require.cache[haPath].exports = { ...realHa, callHaService: callHaServiceMock };

const express       = require('express');
const systemRouter  = require('../routes/system');
const { startPreheatWatcher } = require('../lib/preheat');
const state = require('../lib/state');
const { getMachineRuntimeState } = require('../lib/machine-runtime-state');
const runtime = getMachineRuntimeState();

// #643: switch_entity now resolves from the machines registry (real, not
// mocked here), not from the lib/data.js loadOptions() mock above -- the
// registry's own OPTIONS_FILE-backed auto-seed (lib/machines/registry.js)
// is independent of this file's mockOptions and seeds switchEntity: null in
// tests (no on-disk options.json). Keep both in sync so switch_entity
// behaves as this test file intends regardless of which path resolves it.
const registry = require('../lib/machines/registry');
function setSwitchEntity(value) {
    mockOptions = { ...mockOptions, switch_entity: value };
    registry.getDefaultMachine(); // self-seeds machine #1 if not already present
    registry.updateMachine(1, { switchEntity: value || null });
}

function makeApp() {
    const app = express();
    app.use(express.json());
    app.use(systemRouter);
    app.use((err, req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
    return app;
}

let server, baseUrl;

beforeEach(async () => {
    runtime.machineOn        = false;
    runtime.switchOnAt       = null;
    state.readyByTargetAt   = null;
    state.plannedSwitchOnAt = null;
    mockOptions              = { switch_entity: 'switch.espresso', preheat_time: '1' };
    setSwitchEntity('switch.espresso');
    callHaServiceMock.mockClear();
    server = makeApp().listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(() => { server?.close(); vi.useRealTimers(); });
afterAll(() => vi.useRealTimers());

const T0 = Date.UTC(2024, 5, 15, 10, 0, 0);
// preheat_time is 1 minute (60000ms, see the loadOptions patch above).
const TARGET_AT           = T0 + 5 * 60 * 1000;  // 10:05
const PLANNED_SWITCH_ON_AT = TARGET_AT - 60 * 1000; // 10:04

describe('POST /api/preheat/ready-by (#541)', () => {
    it('sets readyByTargetAt/plannedSwitchOnAt, reflected on GET /api/preheat', async () => {
        const post = await fetch(`${baseUrl}/api/preheat/ready-by`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ targetAt: TARGET_AT }),
        });
        expect(post.status).toBe(200);
        const postBody = await post.json();
        expect(postBody.readyByTargetAt).toBe(TARGET_AT);
        expect(postBody.plannedSwitchOnAt).toBe(PLANNED_SWITCH_ON_AT);

        const get = await (await fetch(`${baseUrl}/api/preheat`)).json();
        expect(get.readyByTargetAt).toBe(TARGET_AT);
        expect(get.plannedSwitchOnAt).toBe(PLANNED_SWITCH_ON_AT);
    });

    it('targetAt: null clears a pending target', async () => {
        await fetch(`${baseUrl}/api/preheat/ready-by`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ targetAt: TARGET_AT }),
        });
        const clear = await fetch(`${baseUrl}/api/preheat/ready-by`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ targetAt: null }),
        });
        const body = await clear.json();
        expect(body.readyByTargetAt).toBeNull();
        expect(body.plannedSwitchOnAt).toBeNull();

        const get = await (await fetch(`${baseUrl}/api/preheat`)).json();
        expect(get.readyByTargetAt).toBeNull();
        expect(get.plannedSwitchOnAt).toBeNull();
    });

    it('rejects a non-number, non-null targetAt', async () => {
        const r = await fetch(`${baseUrl}/api/preheat/ready-by`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ targetAt: 'soon' }),
        });
        expect(r.status).toBe(400);
    });

    it('rejects a numeric targetAt when switch_entity is not configured, and does not write state', async () => {
        mockOptions = { switch_entity: '', preheat_time: '1' };
        setSwitchEntity('');
        const r = await fetch(`${baseUrl}/api/preheat/ready-by`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ targetAt: TARGET_AT }),
        });
        expect(r.status).toBe(400);
        expect(state.readyByTargetAt).toBeNull();
        expect(state.plannedSwitchOnAt).toBeNull();
    });

    it('the 30s watcher turns the switch on once plannedSwitchOnAt is reached, then clears the target (one-shot)', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(T0);
        try {
            const post = await fetch(`${baseUrl}/api/preheat/ready-by`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ targetAt: TARGET_AT }),
            });
            expect(post.status).toBe(200);
            expect(state.plannedSwitchOnAt).toBe(PLANNED_SWITCH_ON_AT);

            startPreheatWatcher();

            // Advance past plannedSwitchOnAt (10:04) — 4 min = 8 interval ticks.
            await vi.advanceTimersByTimeAsync(4 * 60 * 1000 + 1);

            expect(callHaServiceMock).toHaveBeenCalledTimes(1);
            expect(callHaServiceMock).toHaveBeenCalledWith('switch', 'turn_on', { entity_id: 'switch.espresso' });
            expect(state.readyByTargetAt).toBeNull();
            expect(state.plannedSwitchOnAt).toBeNull();

            // One more tick must not re-fire.
            await vi.advanceTimersByTimeAsync(30000);
            expect(callHaServiceMock).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });
});
