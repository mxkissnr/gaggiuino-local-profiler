// #514 (403 on in-app add-on self-update): the Supervisor's api_bypass
// allowlist explicitly excludes /addons/self/update, so it falls through to
// the role check — ROLE_DEFAULT only allows `/.+/info`, ROLE_MANAGER is the
// minimum role whose regex matches /addons/self/update. `hassio_api: true`
// alone only opens the Supervisor API; the role is a separate gate that was
// missing from config.yaml since the earlier fix (#330, v1.121.2).
//
// process.env.SUPERVISOR_TOKEN must be set before routes/system (and the
// lib/constants it requires) are first loaded in this test file, since
// HA_TOKEN is captured once at module-require time.
process.env.SUPERVISOR_TOKEN = 'test-supervisor-token';

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { load as yamlLoad } from 'js-yaml';
const require = createRequire(import.meta.url);

const realFetch = globalThis.fetch;

describe('POST /api/update', () => {
    const express     = require('express');
    const systemRouter = require('../routes/system');

    function makeApp() {
        const app = express();
        app.use(systemRouter);
        return app;
    }

    let server, baseUrl;

    afterEach(async () => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        if (server) await new Promise(resolve => server.close(resolve));
    });

    async function requestUpdate() {
        server = makeApp().listen(0);
        await new Promise(resolve => server.once('listening', resolve));
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        return realFetch(`${baseUrl}/api/update`, { method: 'POST' });
    }

    it('logs the Supervisor body and returns a speaking error on a 403 (missing hassio_role)', async () => {
        vi.stubGlobal('fetch', vi.fn((url) => {
            expect(url).toBe('http://supervisor/addons/self/update');
            return Promise.resolve({ ok: false, status: 403, text: () => Promise.resolve('403: Forbidden') });
        }));
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        const r = await requestUpdate();
        expect(r.status).toBe(403);
        const data = await r.json();
        // Speaking message must not just echo the raw Supervisor text and must
        // point at the actual root cause (hassio_role), so a future regression
        // is diagnosable from the HA UI alone.
        expect(data.error).not.toBe('403: Forbidden');
        expect(data.error).toMatch(/hassio_role/i);
        expect(data.error).toMatch(/manager/i);
        // Must steer users toward updating the add-on, never reinstalling it —
        // a Supervisor uninstall wipes /data (the entire shot/library/order DB),
        // and config.yaml comes from the store repo anyway, so a plain update
        // (which re-reads it) is always sufficient; reinstall is never needed.
        expect(data.error.toLowerCase()).not.toMatch(/reinstall|uninstall/);
        expect(data.error).toMatch(/update/i);

        // The raw Supervisor response must still be logged, even though the
        // client no longer sees it verbatim.
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('403: Forbidden'));
        errorSpy.mockRestore();
    });

    it('passes non-403 error statuses through unchanged, still logging the body', async () => {
        vi.stubGlobal('fetch', vi.fn(() =>
            Promise.resolve({ ok: false, status: 500, text: () => Promise.resolve('internal supervisor error') })
        ));
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        const r = await requestUpdate();
        expect(r.status).toBe(500);
        expect((await r.json()).error).toBe('internal supervisor error');
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('internal supervisor error'));
        errorSpy.mockRestore();
    });

    it('returns {ok:true} and logs on a successful update trigger', async () => {
        vi.stubGlobal('fetch', vi.fn(() =>
            Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('') })
        ));
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

        const r = await requestUpdate();
        expect(r.status).toBe(200);
        expect(await r.json()).toEqual({ ok: true });
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Add-on update triggered via Supervisor API'));
        logSpy.mockRestore();
    });
});

describe('config.yaml hassio_role', () => {
    it('grants ROLE_MANAGER, the minimum role that matches /addons/self/update (#330 regressed this once already)', () => {
        const ROOT = path.resolve(import.meta.dirname, '..');
        const config = yamlLoad(fs.readFileSync(path.join(ROOT, 'config.yaml'), 'utf8'));
        expect(config.hassio_api).toBe(true);
        expect(config.hassio_role).toBe('manager');
    });
});
