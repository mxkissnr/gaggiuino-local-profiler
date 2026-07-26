// #516: the in-app add-on self-update button (added in #515, granting
// `hassio_role: manager`) was dropped before release. `manager` isn't a
// narrow grant — per the Supervisor's role regex it also covers `/backups*`,
// `/core/*`, `/host/*`, `/os/*` and `/supervisor/*`, not just `/addons/*` —
// and the button was redundant anyway: Home Assistant already creates its
// own Supervisor-backed update entity for every add-on
// (`update.<slug>_glp_update`), which never touches this app's own token or
// permissions. These tests pin down the reverse of #514/#515's assertions so
// the removed route/role can't quietly come back.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { load as yamlLoad } from 'js-yaml';
const require = createRequire(import.meta.url);

const realFetch = globalThis.fetch;

describe('POST /api/update', () => {
    const express      = require('express');
    const systemRouter = require('../routes/system');

    function makeApp() {
        const app = express();
        app.use(systemRouter);
        app.use((req, res) => res.status(404).json({ error: 'not found' }));
        return app;
    }

    it('no longer exists (404) — self-update was removed in favor of HA\'s own update entity', async () => {
        const server = makeApp().listen(0);
        await new Promise(resolve => server.once('listening', resolve));
        const baseUrl = `http://127.0.0.1:${server.address().port}`;
        try {
            const r = await realFetch(`${baseUrl}/api/update`, { method: 'POST' });
            expect(r.status).toBe(404);
        } finally {
            server.close();
        }
    });
});

describe('GET /api/version', () => {
    const express      = require('express');
    const systemRouter = require('../routes/system');

    it('still exists — the harmless version-check/banner is unaffected by dropping self-update', async () => {
        const app = express();
        app.use(systemRouter);
        const server = app.listen(0);
        await new Promise(resolve => server.once('listening', resolve));
        const baseUrl = `http://127.0.0.1:${server.address().port}`;
        try {
            const r = await realFetch(`${baseUrl}/api/version`);
            expect(r.status).toBe(200);
            const data = await r.json();
            expect(data).toHaveProperty('current');
            expect(data).toHaveProperty('update_available');
        } finally {
            server.close();
        }
    });
});

describe('config.yaml permissions', () => {
    const ROOT = path.resolve(import.meta.dirname, '..');
    const config = yamlLoad(fs.readFileSync(path.join(ROOT, 'config.yaml'), 'utf8'));

    it('does not grant hassio_role (#515\'s "manager" role was reverted, #516)', () => {
        expect(config.hassio_role).toBeUndefined();
    });

    it('keeps hassio_api: true — GET http://supervisor/info (routes/system.js, /api/token verification) still needs it, and /info is in the Supervisor\'s api_bypass allowlist (no elevated role needed)', () => {
        expect(config.hassio_api).toBe(true);
    });
});
