// Real end-to-end verification for #803's expose_api_port option, "off"
// side -- see test/expose-api-port-default-live.test.js's header for why
// this is a separate file/server/port rather than a second describe block.
//
// This is the test the issue specifically asks for: proof that turning the
// option off actually changes GET /api/token's behaviour, not just that the
// option can be saved (the #638-class rule -- a heuristic IP restriction on
// this exact endpoint shipped unnoticed as a regression once already,
// v2.19.1). Same real-HTTP-server approach as test/pwa-gating.test.js, for
// the same reason: a request sent from this Node process naturally arrives
// with remoteAddress 127.0.0.1, which isSupervisorIp() trusts, so the
// genuine "X-Ingress-Path header + trusted IP" combination server.js's
// isIngressRequest() checks is exercised for real here, not simulated or
// re-implemented in the test.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const PORT = 8196; // distinct from pwa-gating.test.js's 8198, screenshots.mjs's 8199, and expose-api-port-default-live's 8195
// Same hardcoded, realistic literal as pwa-gating.test.js's GENUINE_INGRESS_PATH
// -- deliberately NOT derived from HA_INGRESS_PREFIX, see that file's #801
// comment for why a test must not feed a constant back into the same
// constant it's checked against.
const GENUINE_INGRESS_PATH = '/api/hassio_ingress/m5QxZH_2iLVDiQr862wpJ5d6NlZJG5I9nlC-sMh4yQU';

const tmpDataDir = mkdtempSync(path.join(tmpdir(), 'glp-expose-api-port-closed-'));
const constantsPath = require.resolve('../lib/constants.js');
const realConstants = require(constantsPath);
const optionsFile = path.join(tmpDataDir, 'options.json');

writeFileSync(optionsFile, JSON.stringify({ expose_api_port: false }));

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

describe('GET /api/token — expose_api_port: false (#803)', () => {
    beforeAll(async () => {
        require('../server.js');
        await waitForServer(`${baseUrl}/api/status`);
    }, 15000);

    afterAll(() => {
        rmSync(tmpDataDir, { recursive: true, force: true });
    });

    it('/api/status reports exposeApiPort: false', async () => {
        const r = await fetch(`${baseUrl}/api/status`);
        expect(r.status).toBe(200);
        expect((await r.json()).exposeApiPort).toBe(false);
    });

    it('rejects a direct (non-Ingress) request with 403', async () => {
        const r = await fetch(`${baseUrl}/api/token`);
        expect(r.status).toBe(403);
        const body = await r.json();
        expect(body.apiToken).toBeUndefined();
    });

    // The Ingress panel must keep working fully even with the port closed to
    // the LAN -- this is the exact live-check the PR description also calls
    // out for manual verification against the real dev add-on.
    it('still serves the token to a genuine Ingress request', async () => {
        const r = await fetch(`${baseUrl}/api/token`, {
            headers: { 'X-Ingress-Path': GENUINE_INGRESS_PATH },
        });
        expect(r.status).toBe(200);
        const body = await r.json();
        expect(typeof body.apiToken).toBe('string');
        expect(body.apiToken.length).toBeGreaterThan(0);
    });

    it('a spoofed X-Ingress-Path from this same trusted loopback source still needs the header to be genuine', async () => {
        // Sanity companion to the two above: an Ingress-shaped header value that
        // doesn't start with HA_INGRESS_PREFIX must NOT be treated as Ingress,
        // even from the same trusted source address the "genuine" case above
        // uses -- otherwise the middle test above would pass for the wrong
        // reason (loopback alone, not the header check).
        const r = await fetch(`${baseUrl}/api/token`, {
            headers: { 'X-Ingress-Path': '/api/some_other_thing' },
        });
        expect(r.status).toBe(403);
    });
});
