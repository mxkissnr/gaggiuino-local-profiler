import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const { isSupervisorIp } = require('../lib/helpers');

// Captured before any test stubs globalThis.fetch, so the test client's own
// HTTP calls stay real even while a test replaces fetch to mock the route
// handler's outbound call to the (fake) Supervisor API.
const realFetch = globalThis.fetch;

describe('isSupervisorIp', () => {
    it('trusts loopback addresses', () => {
        expect(isSupervisorIp('127.0.0.1')).toBe(true);
        expect(isSupervisorIp('::1')).toBe(true);
        expect(isSupervisorIp('::ffff:127.0.0.1')).toBe(true);
    });

    it('trusts the HA Supervisor-internal network (172.30.0.0/16)', () => {
        expect(isSupervisorIp('172.30.32.1')).toBe(true);
        expect(isSupervisorIp('172.30.255.254')).toBe(true);
        expect(isSupervisorIp('::ffff:172.30.32.1')).toBe(true);
    });

    it('does not trust ordinary LAN / Docker-bridge addresses (#276)', () => {
        expect(isSupervisorIp('192.168.1.50')).toBe(false);
        expect(isSupervisorIp('10.0.0.5')).toBe(false);
        expect(isSupervisorIp('172.17.0.2')).toBe(false); // default Docker bridge
        expect(isSupervisorIp('172.16.0.5')).toBe(false);
        expect(isSupervisorIp('172.31.0.5')).toBe(false);
    });

    it('does not trust public addresses', () => {
        expect(isSupervisorIp('203.0.113.5')).toBe(false);
    });
});

describe('GET /api/token', () => {
    const express     = require('express');
    const systemRouter = require('../routes/system');
    const state        = require('../lib/state');

    function makeApp() {
        const app = express();
        // Test-only shim: lets each request declare the "source IP" and
        // authentication state the real server.js middleware would have
        // already computed, without needing a real socket per source address.
        app.use((req, res, next) => {
            const fakeIp = req.headers['x-test-ip'];
            if (fakeIp) req.socket = { remoteAddress: fakeIp };
            req.glpAuthenticated = req.headers['x-test-auth'] === '1';
            next();
        });
        app.use(systemRouter);
        app.use((err, req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
        return app;
    }

    let server, baseUrl;
    let ipCounter = 0;

    beforeAll(() => { state.apiToken = 'test-token-abc123'; });
    afterAll(() => { state.apiToken = ''; });
    afterEach(() => { vi.unstubAllGlobals(); });

    async function requestToken(headers) {
        server = makeApp().listen(0);
        await new Promise(resolve => server.once('listening', resolve));
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        try {
            return await realFetch(`${baseUrl}/api/token`, { headers });
        } finally {
            server.close();
        }
    }

    // Each case uses a distinct fake IP so the in-memory rate limiter
    // (keyed by `token:${ip}`) never trips between test cases.
    function nextFakeIp(prefix) { return `${prefix}.${++ipCounter}`; }

    it('grants the token to loopback callers', async () => {
        const r = await requestToken({ 'x-test-ip': '127.0.0.1' });
        expect(r.status).toBe(200);
        expect((await r.json()).apiToken).toBe('test-token-abc123');
    });

    it('grants the token to callers on the HA Supervisor-internal network', async () => {
        const r = await requestToken({ 'x-test-ip': nextFakeIp('172.30.32') });
        expect(r.status).toBe(200);
        expect((await r.json()).apiToken).toBe('test-token-abc123');
    });

    it('denies unauthenticated callers from an ordinary LAN address (#276)', async () => {
        const r = await requestToken({ 'x-test-ip': nextFakeIp('192.168.1') });
        expect(r.status).toBe(401);
    });

    it('denies unauthenticated callers from the Docker default-bridge range', async () => {
        const r = await requestToken({ 'x-test-ip': nextFakeIp('172.17.0') });
        expect(r.status).toBe(401);
    });

    it('still grants the token to already-authenticated sessions regardless of IP', async () => {
        const r = await requestToken({ 'x-test-ip': nextFakeIp('203.0.113'), 'x-test-auth': '1' });
        expect(r.status).toBe(200);
        expect((await r.json()).apiToken).toBe('test-token-abc123');
    });

    it('grants the token via a valid HA Supervisor bearer token from a non-internal IP', async () => {
        vi.stubGlobal('fetch', vi.fn((url) => {
            if (url === 'http://supervisor/info') return Promise.resolve({ ok: true });
            return Promise.reject(new Error(`unexpected fetch to ${url}`));
        }));
        const r = await requestToken({
            'x-test-ip': nextFakeIp('203.0.113'),
            authorization: 'Bearer valid-supervisor-token',
        });
        expect(r.status).toBe(200);
        expect((await r.json()).apiToken).toBe('test-token-abc123');
    });

    it('denies an invalid HA Supervisor bearer token', async () => {
        vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false })));
        const r = await requestToken({
            'x-test-ip': nextFakeIp('203.0.113'),
            authorization: 'Bearer bogus-token',
        });
        expect(r.status).toBe(401);
    });
});
