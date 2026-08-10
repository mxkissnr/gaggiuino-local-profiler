// GET /api/events (#735) -- SSE stream test using a real http.createServer +
// native fetch() reading the streamed response body, same pattern as
// test/firmware-version-route.test.js's ephemeral-server setup. The auth
// middleware under test here mirrors server.js's real one (token header,
// plus the new query-param fallback scoped to exactly this one route --
// EventSource can't send custom headers) since server.js itself can't be
// require()d in a test process (see test/server-middleware-order.test.js's
// comment: it reads a hardcoded /data path and calls app.listen() as an
// import-time side effect).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import crypto from 'crypto';

const require = createRequire(import.meta.url);
const express = require('express');

const statePath = require.resolve('../lib/state');
const eventsPath = require.resolve('../lib/events');
const ssePath = require.resolve('../routes/sse');

function isTokenValid(state, token) {
    if (!state.apiToken || !token) return false;
    try {
        const a = Buffer.from(token);
        const b = Buffer.from(state.apiToken);
        if (a.length !== b.length) return false;
        return crypto.timingSafeEqual(a, b);
    } catch { return false; }
}

// Mirrors server.js's real auth middleware for the one route this PR
// touches -- see its own "#735" comment for the reasoning (query-param
// fallback scoped to /api/events only, everything else unauthenticated 401s).
function makeApp(state) {
    const app = express();
    app.use((req, res, next) => {
        req.glpAuthenticated = isTokenValid(state, req.headers['x-glp-token']);
        if (!req.glpAuthenticated && req.path === '/api/events') {
            req.glpAuthenticated = isTokenValid(state, req.query.token);
        }
        if (req.glpAuthenticated) return next();
        res.status(401).json({ error: 'Unauthorized' });
    });
    app.use(require('../routes/sse'));
    return app;
}

describe('GET /api/events', () => {
    let server, baseUrl, state, bus, EVENTS;

    beforeEach(async () => {
        delete require.cache[statePath];
        delete require.cache[eventsPath];
        delete require.cache[ssePath];
        state = require('../lib/state');
        ({ bus, EVENTS } = require('../lib/events'));
        state.apiToken = 'test-token-abc123';
        state.syncProgress.clear();

        server = makeApp(state).listen(0);
        await new Promise(resolve => server.once('listening', resolve));
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    afterEach(() => new Promise(resolve => server.close(resolve)));

    it('401s with no token and no Ingress headers', async () => {
        const r = await fetch(`${baseUrl}/api/events`);
        expect(r.status).toBe(401);
        r.body?.cancel();
    });

    it('200s with the X-GLP-Token header', async () => {
        const controller = new AbortController();
        const r = await fetch(`${baseUrl}/api/events`, {
            headers: { 'X-GLP-Token': 'test-token-abc123' },
            signal: controller.signal,
        });
        expect(r.status).toBe(200);
        expect(r.headers.get('content-type')).toContain('text/event-stream');
        controller.abort();
    });

    it('#738: sends X-Accel-Buffering: no so HA Ingress\'s nginx proxy does not buffer the stream', async () => {
        const controller = new AbortController();
        const r = await fetch(`${baseUrl}/api/events`, {
            headers: { 'X-GLP-Token': 'test-token-abc123' },
            signal: controller.signal,
        });
        expect(r.headers.get('x-accel-buffering')).toBe('no');
        controller.abort();
    });

    it('200s with only ?token= (EventSource can\'t send custom headers)', async () => {
        const controller = new AbortController();
        const r = await fetch(`${baseUrl}/api/events?token=test-token-abc123`, { signal: controller.signal });
        expect(r.status).toBe(200);
        controller.abort();
    });

    it('401s with a wrong ?token=', async () => {
        const r = await fetch(`${baseUrl}/api/events?token=wrong`);
        expect(r.status).toBe(401);
        r.body?.cancel();
    });

    it('primes a newly-connected client with the current syncProgress state', async () => {
        state.syncProgress.set(1, { current: 3, total: 10 });
        const controller = new AbortController();
        const r = await fetch(`${baseUrl}/api/events?token=test-token-abc123`, { signal: controller.signal });

        const reader = r.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        while (!buf.includes('\n\n')) {
            const { value } = await reader.read();
            buf += decoder.decode(value, { stream: true });
        }
        controller.abort();

        expect(buf).toContain('event: sync-progress');
        expect(buf).toContain(JSON.stringify({ machineId: 1, current: 3, total: 10 }));
    });

    it('streams a SYNC_PROGRESS event emitted on the bus after connecting', async () => {
        const controller = new AbortController();
        const r = await fetch(`${baseUrl}/api/events?token=test-token-abc123`, { signal: controller.signal });
        const reader = r.body.getReader();
        const decoder = new TextDecoder();

        // Give the route's bus.on() subscription a tick to attach before emitting.
        await new Promise(resolve => setTimeout(resolve, 20));
        bus.emit(EVENTS.SYNC_PROGRESS, { machineId: 2, current: 1, total: 8 });

        let buf = '';
        while (!buf.includes('\n\n')) {
            const { value } = await reader.read();
            buf += decoder.decode(value, { stream: true });
        }
        controller.abort();

        expect(buf).toContain('event: sync-progress');
        expect(buf).toContain(JSON.stringify({ machineId: 2, current: 1, total: 8 }));
    });

    it('fans out one emitted event to two concurrent connections', async () => {
        const c1 = new AbortController();
        const c2 = new AbortController();
        const r1 = await fetch(`${baseUrl}/api/events?token=test-token-abc123`, { signal: c1.signal });
        const r2 = await fetch(`${baseUrl}/api/events?token=test-token-abc123`, { signal: c2.signal });
        const reader1 = r1.body.getReader();
        const reader2 = r2.body.getReader();
        const decoder = new TextDecoder();

        await new Promise(resolve => setTimeout(resolve, 20));
        bus.emit(EVENTS.SYNC_COMPLETE, { machineId: 3, total: 20, success: true });

        async function readOne(reader) {
            let buf = '';
            while (!buf.includes('\n\n')) {
                const { value } = await reader.read();
                buf += decoder.decode(value, { stream: true });
            }
            return buf;
        }
        const [buf1, buf2] = await Promise.all([readOne(reader1), readOne(reader2)]);
        c1.abort();
        c2.abort();

        for (const buf of [buf1, buf2]) {
            expect(buf).toContain('event: sync-complete');
            expect(buf).toContain(JSON.stringify({ machineId: 3, total: 20, success: true }));
        }
    });

    it('removes its bus listeners once the client disconnects', async () => {
        // A priming entry so the route writes something immediately on
        // connect -- otherwise the first reader.read() below has nothing to
        // resolve with until the 20s keepalive ping, timing this test out.
        state.syncProgress.set(9, { current: 1, total: 10 });
        const before = bus.listenerCount(EVENTS.SYNC_PROGRESS);
        const controller = new AbortController();
        const r = await fetch(`${baseUrl}/api/events?token=test-token-abc123`, { signal: controller.signal });
        const reader = r.body.getReader();
        await reader.read(); // consume the priming write -- confirms the connection is live server-side
        expect(bus.listenerCount(EVENTS.SYNC_PROGRESS)).toBe(before + 1);

        controller.abort();
        await vi.waitFor(() => {
            expect(bus.listenerCount(EVENTS.SYNC_PROGRESS)).toBe(before);
        });
    });
});
