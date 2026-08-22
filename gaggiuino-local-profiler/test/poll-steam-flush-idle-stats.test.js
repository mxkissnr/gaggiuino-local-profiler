// #902: lib/poll.js's pollViaGaggiuinoStatus() steam/flush live-session
// tracking (state.steamAccum/flushAccum, mirroring the existing brew
// start/stop/accumulate blocks around state.liveAccum) and
// buildLiveDataResponse()'s always-present idle stats fields (temperature/
// targetTemperature/pressure/waterLevel, sourced from
// defaultRuntime.machineStatus regardless of isLive/isSteaming/isFlushing).
// Same in-memory-DB + mocked-axios pattern as
// test/default-machine-host-live-sync.test.js/
// test/live-preheat-sse-events.test.js.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const Database = require('better-sqlite3');

const dbPath            = require.resolve('../lib/db');
const realDb             = require(dbPath);
const axiosPath          = require.resolve('axios');
const realAxios          = require(axiosPath);
const registryPath       = require.resolve('../lib/machines/registry');
const dataPath           = require.resolve('../lib/data');
const pollPath           = require.resolve('../lib/poll');
const liveTransportPath  = require.resolve('../lib/live-transport');
const realLiveTransport  = require(liveTransportPath);
const state              = require('../lib/state');

describe('pollViaGaggiuinoStatus() steam/flush sessions + idle stats (#902)', () => {
    let memDb, axiosGetMock, liveTransportMock;

    beforeEach(() => {
        memDb = new Database(':memory:');
        realDb.initSchema(memDb);
        require.cache[dbPath].exports = { getDb: () => memDb, initSchema: realDb.initSchema };

        axiosGetMock = vi.fn();
        require.cache[axiosPath].exports = { get: axiosGetMock };

        delete require.cache[registryPath];
        delete require.cache[dataPath];
        delete require.cache[pollPath];
        // A single mutable mock object, mutated via vi.fn().mockReturnValue()
        // rather than reassigned -- lib/poll.js's own `const liveTransport =
        // require('./live-transport')` binding captures this exact object
        // reference once at its own require() time, so replacing
        // require.cache[...].exports wholesale mid-test (after poll.js has
        // already been required) would leave poll.js still holding the old
        // reference.
        liveTransportMock = { getLiveSensorSnapshot: vi.fn(() => null), getLiveSystemState: vi.fn(() => null) };
        require.cache[liveTransportPath].exports = liveTransportMock;

        const registry = require('../lib/machines/registry');
        registry.ensureDefaultMachine();
        registry.updateMachine(1, { host: 'gaggiuino.local' });

        state.steamAccum = null;
        state.steamSeq   = 0;
        state.flushAccum = null;
        state.flushSeq   = 0;
        state.liveAccum  = null;
        state.liveSeq    = 0;

        // #549: lib/poll.js's defaultRuntime resolves to this same
        // getMachineRuntimeState() singleton (id 1) -- reset it so tests
        // that read buildLiveDataResponse()'s idle-stats fields aren't
        // seeing machineStatus left over from an earlier test in this file.
        const { getMachineRuntimeState } = require('../lib/machine-runtime-state');
        getMachineRuntimeState().machineStatus = null;
    });

    afterEach(() => {
        memDb.close();
        require.cache[dbPath].exports = realDb;
        require.cache[axiosPath].exports = realAxios;
        require.cache[liveTransportPath].exports = realLiveTransport;
    });

    it('starts a steam session on steamSwitchState:true (REST-only fallback, no live transport) and accumulates datapoints', async () => {
        axiosGetMock.mockResolvedValue({ data: {
            brewSwitchState: false, steamSwitchState: true,
            temperature: '150', pressure: '0.2', targetTemperature: '150',
        } });

        const { pollViaGaggiuinoStatus } = require('../lib/poll');
        const { MachineRuntimeState } = require('../lib/machine-runtime-state');
        const runtime = new MachineRuntimeState();

        await pollViaGaggiuinoStatus(runtime);
        expect(state.steamAccum).not.toBeNull();
        expect(state.steamAccum.datapoints.timeInMode).toHaveLength(1);
        expect(state.steamAccum.datapoints.temperature[0]).toBe(1500); // x10-scaled

        await pollViaGaggiuinoStatus(runtime);
        expect(state.steamAccum.datapoints.timeInMode).toHaveLength(2);
    });

    it('ends the steam session and bumps steamSeq once steamSwitchState flips back to false', async () => {
        axiosGetMock.mockResolvedValueOnce({ data: { steamSwitchState: true, temperature: '150' } });
        const { pollViaGaggiuinoStatus } = require('../lib/poll');
        const { MachineRuntimeState } = require('../lib/machine-runtime-state');
        const runtime = new MachineRuntimeState();

        await pollViaGaggiuinoStatus(runtime);
        expect(state.steamAccum).not.toBeNull();
        expect(state.steamSeq).toBe(0);

        axiosGetMock.mockResolvedValueOnce({ data: { steamSwitchState: false, temperature: '92' } });
        await pollViaGaggiuinoStatus(runtime);

        expect(state.steamAccum).toBeNull();
        expect(state.steamSeq).toBe(1);
    });

    it('starts/accumulates/ends a flush session driven by sysState.operationMode (only available via a live transport)', async () => {
        liveTransportMock.getLiveSystemState.mockReturnValue({ operationMode: 'FLUSH' });
        axiosGetMock.mockResolvedValue({ data: { temperature: '93', pressure: '1.0' } });

        const { pollViaGaggiuinoStatus } = require('../lib/poll');
        const { MachineRuntimeState } = require('../lib/machine-runtime-state');
        const runtime = new MachineRuntimeState();

        await pollViaGaggiuinoStatus(runtime);
        expect(state.flushAccum).not.toBeNull();
        expect(state.flushAccum.datapoints.timeInMode).toHaveLength(1);

        // operation mode ends -- no more FLUSH sysState.
        liveTransportMock.getLiveSystemState.mockReturnValue({ operationMode: 'BREW_AUTO' });
        await pollViaGaggiuinoStatus(runtime);
        expect(state.flushAccum).toBeNull();
        expect(state.flushSeq).toBe(1);
    });

    it('buildLiveDataResponse() reflects the steam/flush session fields matching GET /api/live/data\'s shape', async () => {
        axiosGetMock.mockResolvedValue({ data: { steamSwitchState: true, temperature: '150' } });
        const { pollViaGaggiuinoStatus, buildLiveDataResponse } = require('../lib/poll');
        const { getMachineRuntimeState } = require('../lib/machine-runtime-state');
        const runtime = getMachineRuntimeState(); // same singleton instance lib/poll.js's own defaultRuntime resolves to

        await pollViaGaggiuinoStatus(runtime);

        const resp = buildLiveDataResponse();
        expect(resp.isSteaming).toBe(true);
        expect(resp.steamSeq).toBe(0);
        expect(resp.steamDatapoints.timeInMode).toHaveLength(1);
        expect(resp.isFlushing).toBe(false);
        expect(resp.flushDatapoints).toBeNull();
    });

    it('buildLiveDataResponse() always exposes idle stats (temperature/targetTemperature/pressure/waterLevel), not gated behind isLive/isSteaming/isFlushing', async () => {
        axiosGetMock.mockResolvedValue({ data: {
            brewSwitchState: false, steamSwitchState: false,
            temperature: '91.5', targetTemperature: '93', pressure: '0.1', waterLevel: '64',
        } });
        const { pollViaGaggiuinoStatus, buildLiveDataResponse } = require('../lib/poll');
        const { getMachineRuntimeState } = require('../lib/machine-runtime-state');
        const runtime = getMachineRuntimeState();

        await pollViaGaggiuinoStatus(runtime);

        const resp = buildLiveDataResponse();
        expect(resp.isLive).toBe(false);
        expect(resp.isSteaming).toBe(false);
        expect(resp.isFlushing).toBe(false);
        expect(resp.temperature).toBe(91.5);
        expect(resp.targetTemperature).toBe(93);
        expect(resp.pressure).toBe(0.1);
        expect(resp.waterLevel).toBe(64);
    });

    it('buildLiveDataResponse() reports null idle stats before any poll has populated defaultRuntime.machineStatus', () => {
        const { buildLiveDataResponse } = require('../lib/poll');
        const resp = buildLiveDataResponse();
        expect(resp.temperature).toBeNull();
        expect(resp.targetTemperature).toBeNull();
        expect(resp.pressure).toBeNull();
        expect(resp.waterLevel).toBeNull();
    });

    it('stopLivePolling() clears an in-progress steam/flush session, same as it does state.liveAccum', () => {
        state.steamAccum = { startTime: Date.now(), datapoints: { timeInMode: [1], pressure: [1], temperature: [1] } };
        state.flushAccum = { startTime: Date.now(), datapoints: { timeInMode: [1], pressure: [1], temperature: [1] } };

        const { startLivePolling, stopLivePolling } = require('../lib/poll');
        const { MachineRuntimeState } = require('../lib/machine-runtime-state');
        const runtime = new MachineRuntimeState();

        startLivePolling(runtime);
        stopLivePolling(runtime);

        expect(state.steamAccum).toBeNull();
        expect(state.flushAccum).toBeNull();
    });
});
