import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import {
    parseArgs,
    percentile,
    summarize,
    pctDelta,
    parseProbeTicks,
    probeLag,
    runBench,
    renderMarkdown,
    rateLimitWarnings,
    makePacer,
    REST_ENDPOINTS,
} from '../scripts/bench-node-vs-go.mjs';

// A tiny in-process stand-in for a live GLP instance: canned JSON for every
// endpoint the harness calls plus a fake SSE probe stream. No network, no
// real server.js — this only has to be shaped enough for the harness to
// produce a well-formed result object.
function startStub({ withProbe = true, events = 'normal', restStatus = null } = {}) {
    let restHits = 0;
    const server = http.createServer((req, res) => {
        const url = req.url.split('?')[0];
        const json = (obj, status = 200) => {
            const body = JSON.stringify(obj);
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(body);
        };

        // Simulate a rate limiter: once restStatus is set, every Nth REST hit
        // gets a 429 instead of its normal response.
        if (restStatus && url !== '/api/events' && url !== '/api/debug/ingress/sse-probe') {
            restHits++;
            if (restHits % restStatus.everyNth === 0) return json({ error: 'Rate limit exceeded' }, 429);
        }

        if (url === '/api/status') return json({ shotCount: 3, glpVersion: '2.99.0', devBuild: 'go-preview-20260902_1200', machineVersion: 'v3.4.5' });
        if (url === '/api/version') return json({ current: '2.99.0', latest: '2.99.0', update_available: false, release_url: null });
        if (url === '/shots.json') return json(Array.from({ length: 3 }, (_, i) => ({ id: i + 1, score: 80 + i, profile: 'test', coffee: 'beans', timestamp: 1_700_000_000 + i })));
        if (url === '/api/shots/last') return json({ id: 3, score: 82, profile: 'test' });
        if (url === '/api/shots/3') return json({ id: 3, score: 82, datapoints: [[0, 0], [1, 9]] });
        if (url === '/api/shots/3/card') {
            const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
            res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length });
            return res.end(png);
        }
        if (url === '/api/library') return json({ beans: [], grinders: [], baskets: [] });
        if (url === '/api/library/beans-info') return json({});

        if (url === '/api/debug/export-db') {
            const buf = Buffer.alloc(64 * 1024, 7);
            res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': buf.length });
            return res.end(buf);
        }

        if (url === '/api/debug/ingress/sse-probe') {
            if (!withProbe) { res.writeHead(404); return res.end(); }
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
            let n = 0;
            const tick = () => {
                if (n >= 5) {
                    res.write('event: done\ndata: {}\n\n');
                    return res.end();
                }
                n++;
                res.write(`event: tick\ndata: ${JSON.stringify({ n, server_ms: Date.now() })}\n\n`);
                setTimeout(tick, 40);
            };
            tick();
            return;
        }

        if (url === '/api/events') {
            if (events === 'silent') {
                // Headers only, then nothing at all — a genuinely starved stream.
                res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
            res.write(`:${' '.repeat(2048)}\n\n`);
            if (events === 'normal') {
                res.write('event: preheat-update\ndata: {"ready":false}\n\n');
                res.write('event: live-snapshot\ndata: {"isLive":false}\n\n');
            }
            // events === 'idle': just the initial padding + keepalive comments,
            // no data events — a held-open stream with no shot running.
            const keepalive = setInterval(() => res.write(':ping\n\n'), 50);
            req.on('close', () => clearInterval(keepalive));
            return;
        }

        res.writeHead(404);
        res.end();
    });

    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
        });
    });
}

const FAST_OPTS = {
    iterations: 6, warmup: 2,
    concurrency: [1, 2], sseClients: [1, 2],
    sseHoldMs: 300, dbSweeps: 3, timeoutMs: 5000,
};

describe('bench-node-vs-go: pure helpers', () => {
    it('percentile picks the nearest-rank sample', () => {
        const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
        expect(percentile(xs, 50)).toBe(5);
        expect(percentile(xs, 90)).toBe(9);
        expect(percentile(xs, 100)).toBe(10);
        expect(percentile([], 50)).toBeNaN();
    });

    it('summarize returns finite percentiles for a real sample', () => {
        const s = summarize([10, 12, 11, 40, 13, 12, 11, 14, 10, 12]);
        expect(s.count).toBe(10);
        for (const k of ['mean', 'min', 'max', 'p50', 'p90', 'p95', 'p99']) {
            expect(Number.isFinite(s[k])).toBe(true);
        }
        expect(s.min).toBe(10);
        expect(s.max).toBe(40);
    });

    it('pctDelta is signed Go-vs-Node and null-safe', () => {
        expect(pctDelta(80, 100)).toBeCloseTo(-20);
        expect(pctDelta(120, 100)).toBeCloseTo(20);
        expect(pctDelta(1, 0)).toBeNull();
        expect(pctDelta(NaN, 5)).toBeNull();
    });

    it('parseProbeTicks + probeLag are clock-skew-corrected', () => {
        // server clock is 10s behind the client here — the constant offset
        // must not show up as lag.
        const blocks = [
            { atMs: 10_000, raw: 'event: tick\ndata: {"n":1,"server_ms":0}' },
            { atMs: 10_200, raw: 'event: tick\ndata: {"n":2,"server_ms":200}' },
            { atMs: 10_650, raw: 'event: tick\ndata: {"n":3,"server_ms":400}' }, // 250ms late
        ];
        const ticks = parseProbeTicks(blocks);
        expect(ticks).toHaveLength(3);
        const lag = probeLag(ticks);
        expect(lag.meanMs).toBeGreaterThanOrEqual(0);
        expect(lag.maxMs).toBeCloseTo(250, 0);
    });
});

describe('bench-node-vs-go: CLI parsing', () => {
    it('requires a --go target and token', () => {
        expect(() => parseArgs([])).toThrow(/--go/);
        expect(() => parseArgs(['--go', 'http://x'])).toThrow(/--go-token/);
    });

    it('parses list options and single-target mode', () => {
        const o = parseArgs(['--go', 'http://x:8097/', '--go-token', 'T', '--concurrency', '1,4,16', '--only', 'rest,sse']);
        expect(o.go).toBe('http://x:8097/');
        expect(o.concurrency).toEqual([1, 4, 16]);
        expect(o.only).toEqual(['rest', 'sse']);
        expect(o.node).toBeNull();
    });

    it('rejects an unknown --only section', () => {
        expect(() => parseArgs(['--go', 'http://x', '--go-token', 'T', '--only', 'bogus'])).toThrow(/rest\|sse\|db/);
    });
});

describe('bench-node-vs-go: single-target run against a stub', () => {
    let stub;
    let result;

    beforeAll(async () => {
        stub = await startStub({ withProbe: true });
        const opts = { ...FAST_OPTS, go: stub.baseUrl, goToken: 'stub-token', node: null, nodeToken: null, only: [], json: null, help: false };
        result = await runBench(opts);
    }, 30_000);

    afterAll(() => stub?.server.close());

    it('describes exactly one target', () => {
        expect(result.targets).toHaveLength(1);
        expect(result.targets[0].key).toBe('go');
    });

    it('captures instance context', () => {
        const c = result.context.go;
        expect(c.shotCount).toBe(3);
        expect(c.glpVersion).toBe('2.99.0');
        expect(c.devBuild).toContain('go-preview');
        expect(Number.isFinite(c.dbBytes)).toBe(true);
        expect(c.dbBytes).toBe(64 * 1024);
    });

    it('produces finite percentiles + req/s for every REST endpoint at every concurrency', () => {
        for (const ep of REST_ENDPOINTS) {
            const e = result.rest.go.endpoints[ep.name];
            expect(e, ep.name).toBeDefined();
            expect(e.skipped, `${ep.name} should not be skipped (stub has 3 shots)`).toBeUndefined();
            for (const c of FAST_OPTS.concurrency) {
                const s = e.byConcurrency[c];
                for (const k of ['p50', 'p90', 'p95', 'p99', 'mean', 'reqPerSec']) {
                    expect(Number.isFinite(s[k]), `${ep.name} c=${c} ${k}`).toBe(true);
                }
                expect(s.p50).toBeGreaterThanOrEqual(0);
                expect(s.p95).toBeGreaterThanOrEqual(s.p50);
                expect(s.errors).toBe(0);
            }
        }
    });

    it('measures SSE via the server-timestamped probe', () => {
        expect(result.sse.go.mode).toBe('probe');
        for (const cc of FAST_OPTS.sseClients) {
            const sc = result.sse.go.scenarios[cc];
            expect(sc.perClient).toHaveLength(cc);
            expect(Number.isFinite(sc.ttfbMeanMs)).toBe(true);
            expect(sc.perClient.every(p => p.ticks >= 1)).toBe(true);
        }
    });

    it('measures DB-heavy throughput', () => {
        const db = result.db.go;
        expect(db.exportDb.bytes).toBe(64 * 1024);
        expect(Number.isFinite(db.exportDb.mbPerSec)).toBe(true);
        expect(db.shotsSweep.okSweeps).toBe(FAST_OPTS.dbSweeps);
        expect(Number.isFinite(db.shotsSweep.listsPerSec)).toBe(true);
        expect(Number.isFinite(db.shotsSweep.mbPerSec)).toBe(true);
    });

    it('renders a readable markdown report with no NaN/undefined leaking', () => {
        const md = renderMarkdown(result);
        expect(md).toContain('# Node-vs-Go benchmark');
        expect(md).toContain('## Context');
        expect(md).toContain('## REST latency');
        expect(md).toContain('GET /api/status');
        expect(md).toContain('## SSE');
        expect(md).toContain('## DB-heavy');
        expect(md).toContain('ha addons stats');
        expect(md).not.toMatch(/\bNaN\b/);
        expect(md).not.toMatch(/\bundefined\b/);
        // single-target: no Δ columns
        expect(md).not.toContain('Δ p50');
    });
});

describe('bench-node-vs-go: SSE fallback when no probe endpoint exists', () => {
    let stub;

    beforeAll(async () => {
        stub = await startStub({ withProbe: false });
    });
    afterAll(() => stub?.server.close());

    it('falls back to /api/events TTFB + inter-event gap', async () => {
        const opts = { ...FAST_OPTS, sseClients: [1], go: stub.baseUrl, goToken: 'T', node: null, nodeToken: null, only: ['sse'], json: null, help: false };
        const result = await runBench(opts);
        expect(result.sse.go.mode).toBe('events-fallback');
        expect(result.sse.go.url).toBe('/api/events');
        const sc = result.sse.go.scenarios[1];
        expect(sc.perClient).toHaveLength(1);
        expect(Number.isFinite(sc.ttfbMeanMs)).toBe(true);
        expect(sc.perClient[0].blocks).toBeGreaterThanOrEqual(1);
    }, 20_000);
});

describe('bench-node-vs-go: SSE fallback — idle is not starved', () => {
    it('an /api/events stream with only padding + keepalives (no shot running) is NOT flagged starved', async () => {
        const stub = await startStub({ withProbe: false, events: 'idle' });
        try {
            const opts = { ...FAST_OPTS, sseHoldMs: 400, sseClients: [2], go: stub.baseUrl, goToken: 'T', node: null, nodeToken: null, only: ['sse'], json: null, help: false };
            const result = await runBench(opts);
            const sc = result.sse.go.scenarios[2];
            expect(sc.starvedClients).toBe(0);
            expect(sc.perClient.every(p => p.sawKeepalive)).toBe(true);
        } finally {
            stub.server.close();
        }
    }, 20_000);

    it('an /api/events stream that sends nothing at all IS flagged starved', async () => {
        const stub = await startStub({ withProbe: false, events: 'silent' });
        try {
            const opts = { ...FAST_OPTS, sseHoldMs: 300, sseClients: [1], go: stub.baseUrl, goToken: 'T', node: null, nodeToken: null, only: ['sse'], json: null, help: false };
            const result = await runBench(opts);
            const sc = result.sse.go.scenarios[1];
            expect(sc.starvedClients).toBe(1);
        } finally {
            stub.server.close();
        }
    }, 20_000);
});

describe('bench-node-vs-go: --rps pacing', () => {
    it('parses --rps as a positive integer, rejects non-positive', () => {
        expect(parseArgs(['--go', 'http://x', '--go-token', 'T', '--rps', '25']).rps).toBe(25);
        expect(() => parseArgs(['--go', 'http://x', '--go-token', 'T', '--rps', '0'])).toThrow(/rps/);
        expect(parseArgs(['--go', 'http://x', '--go-token', 'T']).rps).toBe(0);
    });

    it('makePacer spaces grants to ~1000/rps ms and is a no-op when off', async () => {
        expect(makePacer(0)).toBeInstanceOf(Function);
        await makePacer(0)(); // resolves immediately, no throw

        const gate = makePacer(50); // 20ms spacing
        const t0 = performance.now();
        for (let i = 0; i < 5; i++) await gate();
        // 5 grants => 4 intervals => ~80ms minimum, allow scheduler slack.
        expect(performance.now() - t0).toBeGreaterThanOrEqual(60);
    });
});

describe('bench-node-vs-go: 429 detection + report warning', () => {
    it('counts 429s per endpoint/concurrency and flags a cell over the 5% threshold', async () => {
        // every 2nd REST hit is a 429 => ~50% rate-limited, well over threshold
        const stub = await startStub({ restStatus: { everyNth: 2 } });
        try {
            const opts = { ...FAST_OPTS, iterations: 8, warmup: 0, concurrency: [1], go: stub.baseUrl, goToken: 'T', node: null, nodeToken: null, only: ['rest'], json: null, help: false };
            const result = await runBench(opts);

            const cell = result.rest.go.endpoints['GET /api/status'].byConcurrency[1];
            expect(cell.rateLimited).toBeGreaterThan(0);
            expect(cell.runs).toBe(8);
            expect(cell.rateLimitedFrac).toBeGreaterThan(0.05);

            const warnings = rateLimitWarnings(result);
            expect(warnings.length).toBeGreaterThan(0);
            expect(warnings.join('\n')).toMatch(/GET \/api\/status @ c=1/);

            const md = renderMarkdown(result);
            expect(md).toContain('Rate-limited endpoints — comparison invalid');
            expect(md).toMatch(/429/);
        } finally {
            stub.server.close();
        }
    }, 30_000);

    it('a clean run produces no rate-limit warnings', async () => {
        const stub = await startStub();
        try {
            const opts = { ...FAST_OPTS, iterations: 4, warmup: 0, concurrency: [1], go: stub.baseUrl, goToken: 'T', node: null, nodeToken: null, only: ['rest'], json: null, help: false };
            const result = await runBench(opts);
            expect(rateLimitWarnings(result)).toEqual([]);
            expect(renderMarkdown(result)).not.toContain('comparison invalid');
        } finally {
            stub.server.close();
        }
    }, 20_000);
});
