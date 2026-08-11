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
            // #803: stands in for the req.glpIsIngress server.js's real auth
            // middleware would have already set from its own isIngressRequest()
            // call -- that function itself is exercised for real (not faked)
            // in test/expose-api-port-closed-live.test.js's real-HTTP-server
            // test, which is what actually proves the Ingress bypass works.
            // This shim only unit-tests routes/system.js's own use of the flag.
            req.glpIsIngress = req.headers['x-test-ingress'] === '1';
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

    // #533 reverses #276's IP restriction. Direct-port access (http://<host>:8099)
    // is how the installable PWA runs, and it has no other way to get a token:
    // the UI has no token input, and #524 stopped caching one client-side. Under
    // #276 the PWA only kept working on a token cached before that change — once
    // #524 removed it, direct-port access broke outright (v2.19.1). Accepted
    // trade-off on a home LAN: reaching the port IS the boundary.
    it('grants the token to an unauthenticated caller from an ordinary LAN address (#533)', async () => {
        const r = await requestToken({ 'x-test-ip': nextFakeIp('192.168.1') });
        expect(r.status).toBe(200);
        expect((await r.json()).apiToken).toBe('test-token-abc123');
    });

    it('grants the token to a caller from the Docker default-bridge range (#533)', async () => {
        const r = await requestToken({ 'x-test-ip': nextFakeIp('172.17.0') });
        expect(r.status).toBe(200);
        expect((await r.json()).apiToken).toBe('test-token-abc123');
    });

    it('still grants the token to already-authenticated sessions regardless of IP', async () => {
        const r = await requestToken({ 'x-test-ip': nextFakeIp('203.0.113'), 'x-test-auth': '1' });
        expect(r.status).toBe(200);
        expect((await r.json()).apiToken).toBe('test-token-abc123');
    });

    it('no longer calls out to the Supervisor API to authorize a token request', async () => {
        // The Bearer-token fallback existed only to let HA-internal callers past
        // the IP check. With no IP check left there is nothing to fall back to,
        // and the route must not make an outbound request to serve a token.
        const fetchSpy = vi.fn(() => Promise.reject(new Error('route must not call out')));
        vi.stubGlobal('fetch', fetchSpy);
        const r = await requestToken({
            'x-test-ip': nextFakeIp('203.0.113'),
            authorization: 'Bearer whatever',
        });
        expect(r.status).toBe(200);
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('still rate-limits token requests per source IP', async () => {
        const ip = nextFakeIp('192.168.9');
        let last;
        for (let i = 0; i < 12; i++) last = await requestToken({ 'x-test-ip': ip });
        expect(last.status).toBe(429);
    });
});

// #803: routes/system.js's own use of isApiPortExposed()/req.glpIsIngress,
// with a real options.json driving the former -- complements (does not
// replace) the real-HTTP-server proof in test/expose-api-port-default-live
// .test.js and test/expose-api-port-closed-live.test.js, which exercise the
// actual isIngressRequest() wiring end to end.
describe('GET /api/token — expose_api_port gating', () => {
    const express = require('express');
    const fs      = require('fs');
    const os      = require('os');
    const path    = require('path');
    const state   = require('../lib/state');

    const constantsPath = require.resolve('../lib/constants');
    const realConstants = require(constantsPath);
    const dataPath       = require.resolve('../lib/data');
    const systemPath     = require.resolve('../routes/system');

    function withOptions(options) {
        const tmpFile = path.join(os.tmpdir(), `glp-test-token-expose-${Date.now()}-${Math.random()}.json`);
        fs.writeFileSync(tmpFile, JSON.stringify(options));
        require.cache[constantsPath].exports = { ...realConstants, OPTIONS_FILE: tmpFile };
        delete require.cache[dataPath];
        delete require.cache[systemPath];
        const freshRouter = require('../routes/system');
        return { tmpFile, freshRouter, restore: () => {
            fs.rmSync(tmpFile, { force: true });
            require.cache[constantsPath].exports = realConstants;
            delete require.cache[dataPath];
            delete require.cache[systemPath];
        }};
    }

    function makeAppWith(router) {
        const app = express();
        app.use((req, res, next) => {
            const fakeIp = req.headers['x-test-ip'];
            if (fakeIp) req.socket = { remoteAddress: fakeIp };
            req.glpIsIngress = req.headers['x-test-ingress'] === '1';
            next();
        });
        app.use(router);
        return app;
    }

    async function requestToken(router, headers) {
        const server = makeAppWith(router).listen(0);
        await new Promise(resolve => server.once('listening', resolve));
        const url = `http://127.0.0.1:${server.address().port}`;
        try {
            return await realFetch(`${url}/api/token`, { headers });
        } finally {
            server.close();
        }
    }

    beforeAll(() => { state.apiToken = 'test-token-expose-gate'; });
    afterAll(() => { state.apiToken = ''; });

    it('expose_api_port: true, non-Ingress request -> 200 with the token', async () => {
        const { freshRouter, restore } = withOptions({ expose_api_port: true });
        const r = await requestToken(freshRouter, { 'x-test-ip': '192.168.50.10' });
        expect(r.status).toBe(200);
        expect((await r.json()).apiToken).toBe('test-token-expose-gate');
        restore();
    });

    it('expose_api_port: false, non-Ingress request -> 403', async () => {
        const { freshRouter, restore } = withOptions({ expose_api_port: false });
        const r = await requestToken(freshRouter, { 'x-test-ip': '192.168.50.11' });
        expect(r.status).toBe(403);
        expect((await r.json()).apiToken).toBeUndefined();
        restore();
    });

    it('expose_api_port: false, req.glpIsIngress true -> 200 with the token', async () => {
        const { freshRouter, restore } = withOptions({ expose_api_port: false });
        const r = await requestToken(freshRouter, { 'x-test-ip': '192.168.50.12', 'x-test-ingress': '1' });
        expect(r.status).toBe(200);
        expect((await r.json()).apiToken).toBe('test-token-expose-gate');
        restore();
    });

    it('expose_api_port absent from options.json -> behaves as true', async () => {
        const { freshRouter, restore } = withOptions({ sync_interval: 5 });
        const r = await requestToken(freshRouter, { 'x-test-ip': '192.168.50.13' });
        expect(r.status).toBe(200);
        expect((await r.json()).apiToken).toBe('test-token-expose-gate');
        restore();
    });
});
