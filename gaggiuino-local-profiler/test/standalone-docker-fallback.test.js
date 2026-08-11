// #764: standalone Docker (no Supervisor, e.g. HA Container on Unraid/
// TrueNAS) never gets SUPERVISOR_TOKEN or options.json. These tests pin the
// two env-var fallbacks that keep GLP usable there:
//   1. loadOptions() falls back to GLP_SYNC_INTERVAL/GLP_PREHEAT_TIME/
//      GLP_ENABLE_ORDERS/GLP_DEBUG_LOGGING when options.json doesn't exist.
//   2. HA_TOKEN/HA_API pair on GLP_HA_URL + GLP_HA_TOKEN when there's no
//      SUPERVISOR_TOKEN, so lib/ha.js's existing `if (!HA_TOKEN)` guards
//      still gate every call correctly.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const constantsPath = require.resolve('../lib/constants');
const dataPath       = require.resolve('../lib/data');

const ENV_KEYS = [
    'SUPERVISOR_TOKEN', 'GLP_HA_URL', 'GLP_HA_TOKEN',
    'GLP_SYNC_INTERVAL', 'GLP_PREHEAT_TIME', 'GLP_ENABLE_ORDERS', 'GLP_DEBUG_LOGGING',
    'GLP_EXPOSE_API_PORT',
];

describe('standalone Docker env-var fallbacks', () => {
    let savedEnv;

    beforeEach(() => {
        savedEnv = {};
        for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
    });

    afterEach(() => {
        for (const k of ENV_KEYS) {
            if (savedEnv[k] === undefined) delete process.env[k];
            else process.env[k] = savedEnv[k];
        }
        delete require.cache[constantsPath];
        delete require.cache[dataPath];
    });

    describe('lib/data.js loadOptions()', () => {
        let tmpFile;

        beforeEach(() => {
            tmpFile = path.join(os.tmpdir(), `glp-test-options-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
            delete require.cache[constantsPath];
            const realConstants = require(constantsPath);
            require.cache[constantsPath].exports = { ...realConstants, OPTIONS_FILE: tmpFile };
        });

        afterEach(() => {
            try { fs.unlinkSync(tmpFile); } catch { /* already gone */ }
        });

        it('falls back to env vars when options.json does not exist', () => {
            process.env.GLP_SYNC_INTERVAL = '15';
            process.env.GLP_PREHEAT_TIME  = '30';
            process.env.GLP_ENABLE_ORDERS = 'true';
            process.env.GLP_DEBUG_LOGGING = 'true';
            process.env.GLP_EXPOSE_API_PORT = 'false';
            delete require.cache[dataPath];
            const { loadOptions } = require(dataPath);

            expect(loadOptions()).toEqual({
                sync_interval: 15,
                preheat_time:  30,
                enable_orders: true,
                debug_logging: true,
                expose_api_port: false,
            });
        });

        // #803: unlike the three booleans above, expose_api_port must default
        // to true (open) when unset -- an existing standalone-Docker install
        // upgrading to this option must not suddenly start 403ing its own PWA.
        it('defaults to undefined/false/true when neither options.json nor env vars are set', () => {
            delete require.cache[dataPath];
            const { loadOptions } = require(dataPath);

            expect(loadOptions()).toEqual({
                sync_interval: undefined,
                preheat_time:  undefined,
                enable_orders: false,
                debug_logging: false,
                expose_api_port: true,
            });
        });

        it('prefers options.json over env vars when the file exists', () => {
            fs.writeFileSync(tmpFile, JSON.stringify({ sync_interval: 7 }));
            process.env.GLP_SYNC_INTERVAL = '15';
            delete require.cache[dataPath];
            const { loadOptions } = require(dataPath);

            expect(loadOptions()).toEqual({ sync_interval: 7 });
        });
    });

    describe('lib/constants.js HA_TOKEN/HA_API pairing', () => {
        it('stays unavailable with neither SUPERVISOR_TOKEN nor GLP_HA_URL/GLP_HA_TOKEN', () => {
            delete require.cache[constantsPath];
            const { HA_TOKEN, HA_API } = require(constantsPath);
            expect(HA_TOKEN).toBeUndefined();
            expect(HA_API).toBeNull();
        });

        it('activates via GLP_HA_URL + GLP_HA_TOKEN when there is no SUPERVISOR_TOKEN', () => {
            process.env.GLP_HA_URL   = 'http://homeassistant.local:8123/';
            process.env.GLP_HA_TOKEN = 'test-long-lived-token';
            delete require.cache[constantsPath];
            const { HA_TOKEN, HA_API } = require(constantsPath);
            expect(HA_TOKEN).toBe('test-long-lived-token');
            expect(HA_API).toBe('http://homeassistant.local:8123/api');
        });

        it('ignores GLP_HA_TOKEN when GLP_HA_URL is not set', () => {
            process.env.GLP_HA_TOKEN = 'test-long-lived-token';
            delete require.cache[constantsPath];
            const { HA_TOKEN, HA_API } = require(constantsPath);
            expect(HA_TOKEN).toBeUndefined();
            expect(HA_API).toBeNull();
        });

        it('prefers SUPERVISOR_TOKEN over GLP_HA_URL/GLP_HA_TOKEN when both are present', () => {
            process.env.SUPERVISOR_TOKEN = 'supervisor-token';
            process.env.GLP_HA_URL       = 'http://homeassistant.local:8123';
            process.env.GLP_HA_TOKEN     = 'long-lived-token';
            delete require.cache[constantsPath];
            const { HA_TOKEN, HA_API } = require(constantsPath);
            expect(HA_TOKEN).toBe('supervisor-token');
            expect(HA_API).toBe('http://supervisor/core/api');
        });
    });
});
