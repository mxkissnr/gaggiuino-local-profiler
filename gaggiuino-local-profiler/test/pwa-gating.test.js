// Real end-to-end verification for the server-side PWA gate (v1.112.0):
// index.html must NOT carry the manifest link / SW registration hook when
// served through HA Ingress, and MUST carry it otherwise. This is the exact
// mechanism meant to stop a repeat of the v1.102.0 regression, where an
// installable-PWA service worker broke the HA Companion App's live shot
// graph — see CHANGELOG "Reverted the v1.102.0 installable-PWA service
// worker".
//
// Unlike the rest of the test suite, this boots the REAL server.js as a real
// HTTP listener (same pattern scripts/screenshots.mjs uses to drive a real
// browser) and issues genuine fetch() requests against it — no mocked
// req/res objects, no monkey-patched Express app. A request sent from this
// Node process naturally arrives with remoteAddress 127.0.0.1, which
// isSupervisorIp() trusts (loopback), so the "X-Ingress-Path header + trusted
// IP" combination server.js's isIngressRequest() checks is exercised for
// real, not simulated.
//
// What this test CANNOT prove: it never touches a real HA Supervisor/Ingress
// proxy or the HA Companion App itself, so it cannot confirm the Companion
// App's live shot graph keeps working. That final check is manual only —
// see the PR/commit notes.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const PORT = 8198; // distinct from the app's real 8099 and screenshots.mjs's 8199

const tmpDataDir = mkdtempSync(path.join(tmpdir(), 'glp-pwa-gating-'));
const constantsPath = require.resolve('../lib/constants.js');
const realConstants = require(constantsPath);
const HA_INGRESS_PATH = realConstants.HA_INGRESS_PATH;

// Every *_FILE/*_DIR constant is a hardcoded '/data/...' literal (not derived
// from DATA_DIR at runtime) — same override list scripts/screenshots.mjs uses,
// so this run never touches the real /data.
require.cache[constantsPath].exports = {
    ...realConstants,
    DATA_DIR: tmpDataDir,
    DEFAULT_PORT: PORT,
    TOKEN_FILE: path.join(tmpDataDir, 'api_token.txt'),
    PREHEAT_STATE_FILE: path.join(tmpDataDir, 'preheat_state.json'),
    OPTIONS_FILE: path.join(tmpDataDir, 'options.json'),
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

describe('index.html PWA gating — real server, real HTTP', () => {
    beforeAll(async () => {
        require('../server.js'); // starts listening on PORT against tmpDataDir
        await waitForServer(`${baseUrl}/api/status`);
    }, 15000);

    afterAll(() => {
        rmSync(tmpDataDir, { recursive: true, force: true });
    });

    it('serves index.html WITHOUT the manifest link for a genuine Ingress request', async () => {
        const r = await fetch(baseUrl + '/', {
            headers: { 'X-Ingress-Path': HA_INGRESS_PATH },
        });
        expect(r.status).toBe(200);
        const html = await r.text();
        expect(html).not.toContain('rel="manifest"');
        expect(html).toContain('<html'); // sanity: still got the real page, not an error body
    });

    it('serves index.html WITH the manifest link for a direct (non-Ingress) request', async () => {
        const r = await fetch(baseUrl + '/');
        expect(r.status).toBe(200);
        const html = await r.text();
        expect(html).toContain('<link rel="manifest" href="manifest.json">');
    });

    it('does not grant Ingress treatment for an X-Ingress-Path that does not match HA_INGRESS_PATH', async () => {
        // Trusted loopback IP, but the header value itself is wrong — the real
        // isIngressRequest() check requires both the trusted IP AND a header
        // that startsWith(HA_INGRESS_PATH).
        const r = await fetch(baseUrl + '/', {
            headers: { 'X-Ingress-Path': '/api/hassio_ingress/some_other_addon' },
        });
        expect(r.status).toBe(200);
        const html = await r.text();
        expect(html).toContain('rel="manifest"');
    });

    it('same gating applies to the explicit /index.html path', async () => {
        const ingress = await fetch(baseUrl + '/index.html', {
            headers: { 'X-Ingress-Path': HA_INGRESS_PATH },
        });
        const direct = await fetch(baseUrl + '/index.html');
        expect(await ingress.text()).not.toContain('rel="manifest"');
        expect(await direct.text()).toContain('rel="manifest"');
    });
});
