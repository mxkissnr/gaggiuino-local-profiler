import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// Tiny limit/window injected via env before the module is first required —
// keeps this test fast instead of hammering the real 600/min production
// ceiling (see lib/middleware/rateLimit.js).
process.env.GLP_RATE_LIMIT_MAX        = '3';
process.env.GLP_RATE_LIMIT_WINDOW_MS  = '60000';

const express               = require('express');
const { createApiRateLimiter } = require('../lib/middleware/rateLimit');

let server, baseUrl;

beforeAll(async () => {
    const app = express();
    app.use(createApiRateLimiter());
    app.get('/api/status', (req, res) => res.json({ ok: true }));
    app.get('/assets/app.js', (req, res) => res.type('js').send('// asset'));
    server = app.listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => server?.close());

describe('app-level rate limiter', () => {
    it('allows requests up to the configured ceiling', async () => {
        for (let i = 0; i < 3; i++) {
            const r = await fetch(`${baseUrl}/api/status`);
            expect(r.status).toBe(200);
        }
    });

    it('returns 429 with the app JSON error shape once the ceiling is exceeded', async () => {
        const r = await fetch(`${baseUrl}/api/status`);
        expect(r.status).toBe(429);
        expect(await r.json()).toEqual({ error: 'Too many requests' });
    });

    it('does not throttle static asset paths', async () => {
        for (let i = 0; i < 5; i++) {
            const r = await fetch(`${baseUrl}/assets/app.js`);
            expect(r.status).toBe(200);
        }
    });
});
