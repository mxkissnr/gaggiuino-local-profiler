// #603: notify_preheat_ready mute toggle on the preheat-ready notification
// (lib/preheat.js's _checkPreheatNotify, driven by the 30s watcher — same
// fake-timer harness as test/preheat-ready-by.test.js).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const dataPath = require.resolve('../lib/data');
const realData = require(dataPath);
let mockOptions  = { preheat_time: '1' };
let mockSettings = { baristaNotifyService: 'notify.mobile_app_barista' };
require.cache[dataPath].exports = {
    ...realData,
    loadOptions:       () => mockOptions,
    loadOrdersSettings: () => mockSettings,
};

const haPath = require.resolve('../lib/ha');
const realHa = require(haPath);
const sendHaNotify = vi.fn(async () => {});
require.cache[haPath].exports = { ...realHa, sendHaNotify, getHaLanguage: async () => 'de' };

const { startPreheatWatcher } = require('../lib/preheat');
const state = require('../lib/state');
const { getMachineRuntimeState } = require('../lib/machine-runtime-state');
const runtime = getMachineRuntimeState();

const T0 = Date.UTC(2024, 5, 15, 10, 0, 0);

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    runtime.machineOn     = true;
    runtime.switchOnAt    = T0 - 61 * 1000; // preheat_time=1min already elapsed
    state.preheatNotifySent = false;
    mockOptions  = { preheat_time: '1' };
    mockSettings = { baristaNotifyService: 'notify.mobile_app_barista' };
    sendHaNotify.mockClear();
});

afterEach(() => { vi.useRealTimers(); });

describe('preheat-ready notification (notify_preheat_ready)', () => {
    it('fires by default once preheat time has elapsed (undefined toggle == on)', async () => {
        startPreheatWatcher();
        await vi.advanceTimersByTimeAsync(30000);
        expect(sendHaNotify).toHaveBeenCalledTimes(1);
        expect(sendHaNotify.mock.calls[0][0]).toBe('notify.mobile_app_barista');
    });

    it('stays silent once notify_preheat_ready is turned off', async () => {
        mockSettings = { baristaNotifyService: 'notify.mobile_app_barista', notify_preheat_ready: false };
        startPreheatWatcher();
        await vi.advanceTimersByTimeAsync(30000);
        expect(sendHaNotify).not.toHaveBeenCalled();
    });
});
