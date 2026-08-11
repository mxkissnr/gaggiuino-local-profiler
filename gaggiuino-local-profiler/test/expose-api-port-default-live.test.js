// Real end-to-end verification for #803's expose_api_port option, "on"
// (default) side. Companion file test/expose-api-port-closed-live.test.js
// covers the "off" side on its own server/port -- see that file's header for
// why this is split across two files instead of two describe blocks sharing
// one process (each vitest test file gets its own module registry, so this
// is the same one-real-server-per-file pattern test/pwa-gating.test.js
// already uses for the same reason: server.js is a singleton at require time
// and there's no clean way to tear one instance down and boot a
// differently-configured one inside a single file without fighting Node's
// require cache across every transitively-required module, not just
// server.js's own).
//
// This test writes a *realistic* pre-existing options.json (unrelated keys
// only, no expose_api_port key at all) rather than omitting the file --
// that's the actual upgrade scenario the issue calls out ("an install whose
// options.json predates this option must behave exactly as today"), not the
// no-Supervisor-at-all standalone-Docker case (see lib/data.js's env-var
// fallback, covered separately in test/expose-api-port.test.js).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const PORT = 8195; // distinct from pwa-gating.test.js's 8198, screenshots.mjs's 8199, and expose-api-port-closed-live's 8196

const tmpDataDir = mkdtempSync(path.join(tmpdir(), 'glp-expose-api-port-default-'));
const constantsPath = require.resolve('../lib/constants.js');
const realConstants = require(constantsPath);
const optionsFile = path.join(tmpDataDir, 'options.json');

// Simulates an install whose options.json predates expose_api_port entirely
// -- only sync_interval is set, same shape the Supervisor has always written.
writeFileSync(optionsFile, JSON.stringify({ sync_interval: 5 }));

require.cache[constantsPath].exports = {
    ...realConstants,
    DATA_DIR: tmpDataDir,
    DEFAULT_PORT: PORT,
    TOKEN_FILE: path.join(tmpDataDir, 'api_token.txt'),
    PREHEAT_STATE_FILE: path.join(tmpDataDir, 'preheat_state.json'),
    OPTIONS_FILE: optionsFile,
    PROFILES_CACHE_FILE: path.join(tmpDataDir, 'profiles_cache.json'),
    BEAN_IMAGE_DIR: path.join(tmpDataDir, 'bean-images'),
};

const baseUrl = `http://127.0.0.1:${PORT}`;

async function waitForServer(url, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const r = await fetch(url);
            if (r.ok || r.status < 500) return;
        } catch { /* not up yet */ }
        await new Promise(r => setTimeout(r, 100));
    }
    throw new Error(`Server at ${url} did not come up within ${timeoutMs}ms`);
}

describe('GET /api/token — expose_api_port absent from options.json (#803)', () => {
    beforeAll(async () => {
        require('../server.js');
        await waitForServer(`${baseUrl}/api/status`);
    }, 15000);

    afterAll(() => {
        rmSync(tmpDataDir, { recursive: true, force: true });
    });

    it('/api/status reports exposeApiPort: true when the key is absent', async () => {
        const r = await fetch(`${baseUrl}/api/status`);
        expect(r.status).toBe(200);
        expect((await r.json()).exposeApiPort).toBe(true);
    });

    it('serves the token to a direct (non-Ingress) request -- upgrade-safe default', async () => {
        const r = await fetch(`${baseUrl}/api/token`);
        expect(r.status).toBe(200);
        const body = await r.json();
        expect(typeof body.apiToken).toBe('string');
        expect(body.apiToken.length).toBeGreaterThan(0);
    });
});
