#!/usr/bin/env node
// Node-vs-Go live performance benchmark (#951, Phase 3 verification for the
// Go migration #901).
//
// The Go rewrite ships on its own HA add-on channel (`glp_go_preview`, port
// 8097) alongside the existing Node dev channel (`glp-dev-app`, port 8098),
// each with its own exposed API port and API token. This script hits both
// live instances with an identical workload and prints the deltas, so the
// Phase 4 cutover decision rests on real numbers instead of estimates.
//
// It measures three things:
//   - REST latency: a fixed request mix over endpoints that exist in BOTH
//     implementations (verified against routes/*.js and go/internal/*), at
//     each --concurrency level, reported as p50/p90/p95/p99/mean + req/s per
//     endpoint per instance, plus the Go-vs-Node delta.
//   - SSE: /api/events time-to-first-byte, then held-open delivery lag.
//     Where the target exposes the Go build's server-timestamped probe
//     (GET /api/debug/ingress/sse-probe, 5 ticks 200ms apart) the lag is
//     client-receive-minus-server-send, clock-skew-corrected; otherwise it
//     falls back to TTFB + inter-event gap on /api/events (the Node side has
//     no probe). Run with each --sse-clients count concurrently; flags any
//     client that starves.
//   - DB-heavy: GET /api/debug/export-db throughput (MB/s, GLP_DEV_BUILD-
//     gated, which both channels set) and a repeated full /shots.json sweep
//     (that route takes no pagination parameter).
//
// It also prints a Context block per instance (version/build, shot count, DB
// size) so the reader knows the two datasets differ and by how much — the
// numbers below are NOT a like-for-like comparison unless those match. The
// footer gives the export-db/import-db commands to align the two DBs.
//
// Every REST request's HTTP 429 count is tracked per endpoint/concurrency;
// if a target's rate limiter kicks in above 5% for a cell, the report flags
// that comparison as invalid (a limiter's latency is not the handler's).
// Pass --rps <n> to throttle the whole run below the limiter's threshold
// for an honest apples-to-apples comparison.
//
// Single-target mode (`--go URL --go-token T`, no --node) prints absolute
// numbers only. Non-zero exit only on a harness error, never on "Go was
// slower". RSS and boot time can't be read over HTTP — see the manual
// footer this prints for the exact commands.
//
// Run on demand from a machine that can reach both add-on ports:
//   node scripts/bench-node-vs-go.mjs \
//     --go   http://HOST:8097 --go-token   TOKEN_A \
//     --node http://HOST:8098 --node-token TOKEN_B

import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DEFAULTS = {
    iterations: 200,
    warmup: 10,
    concurrency: [1, 10],
    sseClients: [1, 5, 20],
    sseHoldMs: 6000,
    dbSweeps: 20,
    timeoutMs: 15000,
    rps: 0, // 0 = unthrottled
};

// A target's own rate limiter (Node: lib/middleware/rateLimit.js's global
// ceiling + the per-route limiters on backup/system/orders) can start
// returning 429 under the REST mix, which drops that endpoint's real
// latency samples on the floor and makes the Go-vs-Node column meaningless.
// Above this share of 429s for one endpoint/concurrency cell the report
// flags the comparison as invalid rather than printing a bogus delta.
const RATE_LIMIT_INVALID_FRAC = 0.05;

// Extra client-side lag (above the skew-corrected best-case baseline) beyond
// which an SSE client counts as starving. The Go probe ticks every 200ms, so
// two full intervals of added lag is unambiguous buffering/starvation, not
// jitter.
const SSE_STARVE_MS = 400;

const HELP = `bench-node-vs-go.mjs — live Node-vs-Go performance comparison (#951)

Usage:
  node scripts/bench-node-vs-go.mjs --go <url> --go-token <token> \\
                                    [--node <url> --node-token <token>] [options]

Targets:
  --go <url>            Base URL of the Go preview instance (e.g. http://ha.local:8097)
  --go-token <token>    X-GLP-Token for the Go instance
  --node <url>          Base URL of the Node dev instance (e.g. http://ha.local:8098)
  --node-token <token>  X-GLP-Token for the Node instance
                        Give only --go (+token) for single-target absolute numbers.

Options:
  --iterations <n>      REST requests per endpoint per concurrency level (default ${DEFAULTS.iterations})
  --warmup <n>          Warm-up requests per endpoint, not measured (default ${DEFAULTS.warmup})
  --concurrency <csv>   In-flight request counts to sweep (default ${DEFAULTS.concurrency.join(',')})
  --sse-clients <csv>   Concurrent SSE client counts to sweep (default ${DEFAULTS.sseClients.join(',')})
  --sse-hold <ms>       How long to hold each /api/events stream open (default ${DEFAULTS.sseHoldMs})
  --db-sweeps <n>       Full /shots.json fetches for the DB-heavy sweep (default ${DEFAULTS.dbSweeps})
  --timeout <ms>        Per-request timeout (default ${DEFAULTS.timeoutMs})
  --rps <n>             Cap total request rate (per target) to n req/s for the REST + DB
                        sweeps, so a rate-limited Node instance stops returning 429 and
                        the Go-vs-Node latency columns stay a fair comparison. Off by
                        default; SSE is never throttled.
  --only <rest|sse|db>  Run only these sections (repeatable or comma-separated)
  --json <path>         Also write the full machine-readable result object here
  --help                Show this help

Exit code is 0 unless the harness itself failed — a slower Go is still exit 0.`;

// ── CLI ──────────────────────────────────────────────────────────────────

export function parseArgs(argv) {
    const opts = {
        go: null, goToken: null, node: null, nodeToken: null,
        iterations: DEFAULTS.iterations,
        warmup: DEFAULTS.warmup,
        concurrency: [...DEFAULTS.concurrency],
        sseClients: [...DEFAULTS.sseClients],
        sseHoldMs: DEFAULTS.sseHoldMs,
        dbSweeps: DEFAULTS.dbSweeps,
        timeoutMs: DEFAULTS.timeoutMs,
        rps: DEFAULTS.rps,
        only: [],
        json: null,
        help: false,
    };

    const intList = (v) => String(v).split(',').map(s => parseInt(s.trim(), 10)).filter(n => Number.isFinite(n) && n > 0);
    const posInt = (v, name) => {
        const n = parseInt(v, 10);
        if (!Number.isFinite(n) || n <= 0) throw new Error(`--${name} needs a positive integer, got "${v}"`);
        return n;
    };

    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const need = () => {
            const v = argv[++i];
            if (v === undefined) throw new Error(`${a} needs a value`);
            return v;
        };
        switch (a) {
            case '--go':         opts.go = need(); break;
            case '--go-token':   opts.goToken = need(); break;
            case '--node':       opts.node = need(); break;
            case '--node-token': opts.nodeToken = need(); break;
            case '--iterations': opts.iterations = posInt(need(), 'iterations'); break;
            case '--warmup':     opts.warmup = Math.max(0, parseInt(need(), 10) || 0); break;
            case '--concurrency': opts.concurrency = intList(need()); break;
            case '--sse-clients': opts.sseClients = intList(need()); break;
            case '--sse-hold':   opts.sseHoldMs = posInt(need(), 'sse-hold'); break;
            case '--db-sweeps':  opts.dbSweeps = posInt(need(), 'db-sweeps'); break;
            case '--timeout':    opts.timeoutMs = posInt(need(), 'timeout'); break;
            case '--rps':        opts.rps = posInt(need(), 'rps'); break;
            case '--only':       opts.only.push(...String(need()).split(',').map(s => s.trim()).filter(Boolean)); break;
            case '--json':       opts.json = need(); break;
            case '--help': case '-h': opts.help = true; break;
            default:
                throw new Error(`unknown argument: ${a}`);
        }
    }

    if (opts.help) return opts;

    if (!opts.go) throw new Error('--go <url> is required (see --help)');
    if (!opts.goToken) throw new Error('--go-token <token> is required');
    if (opts.node && !opts.nodeToken) throw new Error('--node given without --node-token');
    if (!opts.concurrency.length) throw new Error('--concurrency resolved to an empty list');
    if (!opts.sseClients.length) throw new Error('--sse-clients resolved to an empty list');

    const badOnly = opts.only.filter(s => !['rest', 'sse', 'db'].includes(s));
    if (badOnly.length) throw new Error(`--only accepts rest|sse|db, got: ${badOnly.join(', ')}`);

    return opts;
}

export function targetsFromOpts(opts) {
    const targets = [{ key: 'go', label: 'Go', baseUrl: opts.go.replace(/\/+$/, ''), token: opts.goToken }];
    if (opts.node) targets.push({ key: 'node', label: 'Node', baseUrl: opts.node.replace(/\/+$/, ''), token: opts.nodeToken });
    return targets;
}

// ── Stats ────────────────────────────────────────────────────────────────

export function percentile(sortedAsc, p) {
    if (!sortedAsc.length) return NaN;
    const idx = Math.ceil((p / 100) * sortedAsc.length) - 1;
    return sortedAsc[Math.min(sortedAsc.length - 1, Math.max(0, idx))];
}

export function summarize(msSamples) {
    const xs = [...msSamples].filter(Number.isFinite).sort((a, b) => a - b);
    const n = xs.length;
    const sum = xs.reduce((s, x) => s + x, 0);
    return {
        count: n,
        mean: n ? sum / n : NaN,
        min: n ? xs[0] : NaN,
        max: n ? xs[n - 1] : NaN,
        p50: percentile(xs, 50),
        p90: percentile(xs, 90),
        p95: percentile(xs, 95),
        p99: percentile(xs, 99),
    };
}

// Signed relative delta of `go` against `node` as a percentage. Negative
// means the Go value is lower (faster / smaller). Returns null when either
// side is missing so callers render "—".
export function pctDelta(go, node) {
    if (!Number.isFinite(go) || !Number.isFinite(node) || node === 0) return null;
    return ((go - node) / node) * 100;
}

// ── HTTP helpers ─────────────────────────────────────────────────────────

function authHeaders(target) {
    return { 'X-GLP-Token': target.token, 'Accept': 'application/json' };
}

// One timed request. Always resolves — a network error or non-2xx is
// recorded, not thrown, so a single blip doesn't abort a run.
async function timedRequest(url, target, timeoutMs) {
    const start = performance.now();
    try {
        const res = await fetch(url, {
            headers: authHeaders(target),
            signal: AbortSignal.timeout(timeoutMs),
        });
        const buf = await res.arrayBuffer();
        return { ms: performance.now() - start, ok: res.ok, status: res.status, bytes: buf.byteLength };
    } catch (err) {
        return { ms: performance.now() - start, ok: false, status: 0, bytes: 0, error: String(err && err.message || err) };
    }
}

// A leaky-bucket pacer: gate() resolves at most `rps` times per second,
// spacing the grants evenly. rps <= 0 returns a no-op gate (unthrottled).
// Used to keep a rate-limited Node instance below its 429 threshold so the
// Go-vs-Node latency comparison stays honest (--rps).
export function makePacer(rps) {
    if (!Number.isFinite(rps) || rps <= 0) return () => Promise.resolve();
    const intervalMs = 1000 / rps;
    let nextAt = 0;
    return () => {
        const now = performance.now();
        const at = Math.max(now, nextAt);
        nextAt = at + intervalMs;
        const wait = at - now;
        return wait > 0 ? new Promise(r => setTimeout(r, wait)) : Promise.resolve();
    };
}

// Bounded-concurrency worker pool. taskFn(i) is invoked `total` times with at
// most `concurrency` in flight; results are returned in call order. When a
// `pace` gate is given each task waits on it before starting, capping the
// aggregate request rate.
async function runPool(total, concurrency, taskFn, pace) {
    const results = new Array(total);
    let next = 0;
    const worker = async () => {
        for (;;) {
            const i = next++;
            if (i >= total) return;
            if (pace) await pace();
            results[i] = await taskFn(i);
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, total)) }, worker));
    return results;
}

// ── REST mix ─────────────────────────────────────────────────────────────

// Endpoints that exist in BOTH the Node app (routes/*.js) and the Go rewrite
// (go/internal/*). `needsShot` endpoints are skipped for an instance with no
// shots. There is intentionally no analytics/statistics endpoint here: the
// Node app computes analytics client-side from /shots.json, so no such REST
// route exists to compare.
export const REST_ENDPOINTS = [
    { name: 'GET /api/status',            path: () => '/api/status' },
    { name: 'GET /api/version',           path: () => '/api/version' },
    { name: 'GET /shots.json',            path: () => '/shots.json' },
    { name: 'GET /api/shots/last',        path: () => '/api/shots/last' },
    { name: 'GET /api/shots/{id}',        path: (ctx) => `/api/shots/${ctx.shotId}`, needsShot: true },
    { name: 'GET /api/shots/{id}/card',   path: (ctx) => `/api/shots/${ctx.shotId}/card`, needsShot: true },
    { name: 'GET /api/library',           path: () => '/api/library' },
    { name: 'GET /api/library/beans-info', path: () => '/api/library/beans-info' },
];

async function resolveShotId(target, timeoutMs) {
    try {
        const res = await fetch(`${target.baseUrl}/api/shots/last`, {
            headers: authHeaders(target),
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) return null;
        const body = await res.json();
        return body && Number.isFinite(body.id) ? body.id : null;
    } catch {
        return null;
    }
}

async function benchRestForTarget(target, opts) {
    const shotId = await resolveShotId(target, opts.timeoutMs);
    const ctx = { shotId };
    const endpoints = {};
    const pace = makePacer(opts.rps);

    for (const ep of REST_ENDPOINTS) {
        if (ep.needsShot && shotId == null) {
            endpoints[ep.name] = { skipped: 'no shots on this instance' };
            continue;
        }
        const url = target.baseUrl + ep.path(ctx);
        const byConcurrency = {};

        for (const c of opts.concurrency) {
            // Warm-up (not measured) — lets JIT / connection pools / SQLite
            // page cache settle so the first measured request isn't an outlier.
            await runPool(opts.warmup, c, () => timedRequest(url, target, opts.timeoutMs), pace);

            const wall0 = performance.now();
            const runs = await runPool(opts.iterations, c, () => timedRequest(url, target, opts.timeoutMs), pace);
            const wallMs = performance.now() - wall0;

            const ok = runs.filter(r => r.ok);
            const rateLimited = runs.filter(r => r.status === 429).length;
            const stats = summarize(ok.map(r => r.ms));
            byConcurrency[c] = {
                ...stats,
                errors: runs.length - ok.length,
                runs: runs.length,
                rateLimited,
                rateLimitedFrac: runs.length ? rateLimited / runs.length : 0,
                reqPerSec: wallMs > 0 ? (opts.iterations / (wallMs / 1000)) : NaN,
                bytesMean: ok.length ? ok.reduce((s, r) => s + r.bytes, 0) / ok.length : NaN,
            };
        }
        endpoints[ep.name] = { url: ep.path(ctx), byConcurrency };
    }

    return { shotId, endpoints };
}

// ── SSE ──────────────────────────────────────────────────────────────────

// Reads an SSE stream for up to holdMs. Returns per-block client receive
// times (ms since epoch), the raw text of each block, and the TTFB (time
// from request start until the response headers arrived).
async function readSseStream(url, target, holdMs) {
    const start = performance.now();
    const ctrl = new AbortController();
    const holdTimer = setTimeout(() => ctrl.abort(), holdMs);
    const blocks = [];
    let ttfbMs = NaN;
    let connectError = null;
    let bytesTotal = 0;
    let sawKeepalive = false; // any `:` comment line (SSE keepalive) => the stream is alive, just idle

    try {
        const res = await fetch(url, {
            headers: { 'X-GLP-Token': target.token, 'Accept': 'text/event-stream' },
            signal: ctrl.signal,
        });
        ttfbMs = performance.now() - start;
        if (!res.ok) {
            connectError = `HTTP ${res.status}`;
            return { ttfbMs, blocks, connectError, status: res.status, bytesTotal, sawKeepalive };
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            bytesTotal += value.byteLength;
            buf += decoder.decode(value, { stream: true });
            let sep;
            while ((sep = buf.indexOf('\n\n')) !== -1) {
                const raw = buf.slice(0, sep);
                buf = buf.slice(sep + 2);
                if (!raw.trim()) continue;
                if (raw.trimStart().startsWith(':')) sawKeepalive = true;
                blocks.push({ atMs: Date.now(), raw });
            }
        }
    } catch (err) {
        if (err && err.name !== 'AbortError') connectError = String(err.message || err);
    } finally {
        clearTimeout(holdTimer);
    }
    return { ttfbMs, blocks, connectError, status: 200, bytesTotal, sawKeepalive };
}

// Parses `event: tick` / `data: {"n":N,"server_ms":M}` blocks from the Go
// probe. Returns [{ n, serverMs, atMs }].
export function parseProbeTicks(blocks) {
    const ticks = [];
    for (const b of blocks) {
        const raw = typeof b === 'string' ? b : b.raw;
        const atMs = typeof b === 'string' ? NaN : b.atMs;
        if (!/^event:\s*tick\s*$/m.test(raw)) continue;
        const m = raw.match(/^data:\s*(\{.*\})\s*$/m);
        if (!m) continue;
        try {
            const d = JSON.parse(m[1]);
            if (Number.isFinite(d.server_ms)) ticks.push({ n: d.n, serverMs: d.server_ms, atMs });
        } catch { /* not a probe tick */ }
    }
    return ticks;
}

// Given probe ticks, returns skew-corrected added lag per tick. The constant
// client/server clock offset is removed by subtracting the minimum observed
// (atMs - serverMs) — the best-case transit — so what's left is buffering /
// scheduling delay, which is the starvation signal.
export function probeLag(ticks) {
    const raw = ticks.map(t => t.atMs - t.serverMs).filter(Number.isFinite);
    if (!raw.length) return { perTick: [], meanMs: NaN, maxMs: NaN, baselineMs: NaN };
    const baseline = Math.min(...raw);
    const perTick = raw.map(x => x - baseline);
    return {
        perTick,
        baselineMs: baseline,
        meanMs: perTick.reduce((s, x) => s + x, 0) / perTick.length,
        maxMs: Math.max(...perTick),
    };
}

// Largest gap between consecutive client-side block receipts (ms). Used for
// the /api/events fallback where there is no server timestamp to diff against.
export function maxInterBlockGap(blocks) {
    if (blocks.length < 2) return NaN;
    let max = 0;
    for (let i = 1; i < blocks.length; i++) max = Math.max(max, blocks[i].atMs - blocks[i - 1].atMs);
    return max;
}

async function probeAvailable(target, timeoutMs) {
    try {
        const res = await fetch(`${target.baseUrl}/api/debug/ingress/sse-probe`, {
            headers: { 'X-GLP-Token': target.token, 'Accept': 'text/event-stream' },
            signal: AbortSignal.timeout(timeoutMs),
        });
        // Read one chunk to confirm it actually streams, then drop it.
        if (res.ok && res.body) {
            await res.body.cancel();
            return true;
        }
        return false;
    } catch {
        return false;
    }
}

async function benchSseForTarget(target, opts) {
    const hasProbe = await probeAvailable(target, opts.timeoutMs);
    const mode = hasProbe ? 'probe' : 'events-fallback';
    const url = hasProbe
        ? `${target.baseUrl}/api/debug/ingress/sse-probe`
        : `${target.baseUrl}/api/events`;
    // The Go probe self-terminates after ~1s; /api/events must be held.
    const holdMs = hasProbe ? Math.max(opts.timeoutMs, 4000) : opts.sseHoldMs;

    const scenarios = {};
    for (const clientCount of opts.sseClients) {
        const streams = await Promise.all(
            Array.from({ length: clientCount }, () => readSseStream(url, target, holdMs)),
        );

        const perClient = streams.map((s, idx) => {
            const base = { client: idx, ttfbMs: s.ttfbMs, blocks: s.blocks.length, connectError: s.connectError || null };
            if (mode === 'probe') {
                const ticks = parseProbeTicks(s.blocks);
                const lag = probeLag(ticks);
                return { ...base, ticks: ticks.length, lagMeanMs: lag.meanMs, lagMaxMs: lag.maxMs, starved: Number.isFinite(lag.maxMs) && lag.maxMs > SSE_STARVE_MS };
            }
            const gap = maxInterBlockGap(s.blocks);
            // Idle != starved: a held-open /api/events stream with no shot
            // running legitimately delivers nothing but the initial padding
            // and periodic `:` keepalives for the whole hold. Only a real
            // connect failure, or a stream that produced literally nothing
            // (no bytes, no keepalive) within holdMs, counts as starvation.
            const starved = !!s.connectError || (s.bytesTotal === 0 && !s.sawKeepalive);
            return { ...base, maxGapMs: gap, bytes: s.bytesTotal, sawKeepalive: s.sawKeepalive, starved };
        });

        const finite = (xs) => xs.filter(Number.isFinite);
        const ttfbs = finite(perClient.map(c => c.ttfbMs));
        scenarios[clientCount] = {
            clients: clientCount,
            ttfbMeanMs: ttfbs.length ? ttfbs.reduce((s, x) => s + x, 0) / ttfbs.length : NaN,
            ttfbMaxMs: ttfbs.length ? Math.max(...ttfbs) : NaN,
            lagMeanMs: mode === 'probe' ? avg(finite(perClient.map(c => c.lagMeanMs))) : avg(finite(perClient.map(c => c.maxGapMs))),
            lagMaxMs: mode === 'probe' ? maxOf(finite(perClient.map(c => c.lagMaxMs))) : maxOf(finite(perClient.map(c => c.maxGapMs))),
            starvedClients: perClient.filter(c => c.starved).length,
            perClient,
        };
    }

    return { mode, url: url.replace(target.baseUrl, ''), scenarios };
}

const avg = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);
const maxOf = (xs) => (xs.length ? Math.max(...xs) : NaN);

// ── DB-heavy ─────────────────────────────────────────────────────────────

async function streamAndCount(url, target, timeoutMs) {
    const start = performance.now();
    try {
        const res = await fetch(url, { headers: authHeaders(target), signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) return { ok: false, status: res.status, bytes: 0, ms: performance.now() - start };
        let bytes = 0;
        const reader = res.body.getReader();
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
        }
        return { ok: true, status: res.status, bytes, ms: performance.now() - start };
    } catch (err) {
        // A dropped/aborted download (client timeout, server closing the
        // socket mid-stream — the add-on log's "DB export download failed:
        // broken pipe") is a measurement that didn't complete, not a reason
        // to abort the whole run.
        return { ok: false, status: 0, bytes: 0, ms: performance.now() - start, error: String(err && err.message || err) };
    }
}

async function benchDbForTarget(target, opts, log = () => {}) {
    const out = {};
    const pace = makePacer(opts.rps);

    // export-db: whole raw SQLite file. 404 when GLP_DEV_BUILD is unset.
    const exportUrl = `${target.baseUrl}/api/debug/export-db`;
    const exp = await streamAndCount(exportUrl, target, Math.max(opts.timeoutMs, 60000));
    if (exp.ok) {
        out.exportDb = {
            bytes: exp.bytes,
            wallMs: exp.ms,
            mbPerSec: exp.ms > 0 ? (exp.bytes / 1e6) / (exp.ms / 1000) : NaN,
        };
    } else if (exp.error) {
        log(`db: ${target.label} export-db download did not complete (${exp.error}) — skipping that metric`);
        out.exportDb = { skipped: `download failed: ${exp.error}` };
    } else {
        out.exportDb = { skipped: exp.status === 404 ? 'GLP_DEV_BUILD not set on this instance' : `HTTP ${exp.status}` };
    }

    // /shots.json sweep: the heaviest read the app serves (every shot, each
    // with a computed score). No pagination parameter exists on that route,
    // so "deep pagination" is a repeated full fetch instead.
    const sweepUrl = `${target.baseUrl}/shots.json`;
    const sweepRuns = [];
    const sweep0 = performance.now();
    for (let i = 0; i < opts.dbSweeps; i++) {
        await pace();
        sweepRuns.push(await streamAndCount(sweepUrl, target, opts.timeoutMs));
    }
    const sweepWall = performance.now() - sweep0;
    const okRuns = sweepRuns.filter(r => r.ok);
    const rateLimited = sweepRuns.filter(r => r.status === 429).length;
    const totalBytes = okRuns.reduce((s, r) => s + r.bytes, 0);
    out.shotsSweep = {
        sweeps: opts.dbSweeps,
        okSweeps: okRuns.length,
        rateLimited,
        rateLimitedFrac: sweepRuns.length ? rateLimited / sweepRuns.length : 0,
        listBytes: okRuns.length ? Math.round(totalBytes / okRuns.length) : NaN,
        wallMs: sweepWall,
        listsPerSec: sweepWall > 0 ? opts.dbSweeps / (sweepWall / 1000) : NaN,
        mbPerSec: sweepWall > 0 ? (totalBytes / 1e6) / (sweepWall / 1000) : NaN,
        ...summarizeNamed(okRuns.map(r => r.ms)),
    };

    return out;
}

function summarizeNamed(ms) {
    const s = summarize(ms);
    return { p50Ms: s.p50, p95Ms: s.p95, meanMs: s.mean };
}

// ── Context ──────────────────────────────────────────────────────────────

// Per-instance facts that make (or break) a fair comparison. Surfaced
// prominently — different shot counts / DB sizes mean the latency numbers
// below are not directly comparable.
async function contextForTarget(target, opts) {
    const ctx = { label: target.label, baseUrl: target.baseUrl };
    try {
        const res = await fetch(`${target.baseUrl}/api/status`, { headers: authHeaders(target), signal: AbortSignal.timeout(opts.timeoutMs) });
        if (res.ok) {
            const s = await res.json();
            ctx.glpVersion = s.glpVersion ?? null;
            ctx.devBuild = s.devBuild ?? null;
            ctx.shotCount = Number.isFinite(s.shotCount) ? s.shotCount : null;
            ctx.machineVersion = s.machineVersion ?? null;
        } else {
            ctx.statusError = `HTTP ${res.status}`;
        }
    } catch (err) {
        ctx.statusError = String(err && err.message || err);
    }

    try {
        const res = await fetch(`${target.baseUrl}/api/version`, { headers: authHeaders(target), signal: AbortSignal.timeout(opts.timeoutMs) });
        if (res.ok) {
            const v = await res.json();
            ctx.versionCurrent = v.current ?? null;
            ctx.versionLatest = v.latest ?? null;
        }
    } catch { /* non-fatal */ }

    // DB size: no endpoint reports it directly, so read the Content-Length of
    // the raw export (the DB file itself). A HEAD keeps the server from
    // streaming the whole file just for us to drop it — which is what logged
    // "DB export download failed: broken pipe" on the add-on. Both runtimes
    // route HEAD to their GET handler (Express by default, Go's ServeMux for
    // a "GET" pattern); if a target somehow doesn't, fall back to a GET whose
    // body we cancel.
    ctx.dbBytes = null;
    try {
        let res = await fetch(`${target.baseUrl}/api/debug/export-db`, { method: 'HEAD', headers: authHeaders(target), signal: AbortSignal.timeout(opts.timeoutMs) });
        if (res.status === 405 || res.status === 501) {
            res = await fetch(`${target.baseUrl}/api/debug/export-db`, { headers: authHeaders(target), signal: AbortSignal.timeout(opts.timeoutMs) });
            if (res.body) await res.body.cancel();
        }
        if (res.ok) {
            const len = res.headers.get('content-length');
            ctx.dbBytes = len ? parseInt(len, 10) : null;
        } else {
            ctx.dbSizeNote = res.status === 404 ? 'export-db gated off (GLP_DEV_BUILD unset)' : `export-db HTTP ${res.status}`;
        }
    } catch {
        ctx.dbBytes = null;
    }

    return ctx;
}

// ── Orchestration ────────────────────────────────────────────────────────

export async function runBench(opts, { log = () => {} } = {}) {
    const targets = targetsFromOpts(opts);
    const sections = opts.only.length ? opts.only : ['rest', 'sse', 'db'];
    const startedAt = new Date().toISOString();

    const result = {
        startedAt,
        options: {
            iterations: opts.iterations, warmup: opts.warmup,
            concurrency: opts.concurrency, sseClients: opts.sseClients,
            sseHoldMs: opts.sseHoldMs, dbSweeps: opts.dbSweeps, timeoutMs: opts.timeoutMs,
            rps: opts.rps || 0,
        },
        sections,
        targets: targets.map(t => ({ key: t.key, label: t.label, baseUrl: t.baseUrl })),
        context: {},
        rest: {},
        sse: {},
        db: {},
    };

    for (const t of targets) {
        log(`context: ${t.label} (${t.baseUrl})`);
        result.context[t.key] = await contextForTarget(t, opts);
    }

    if (sections.includes('rest')) {
        for (const t of targets) {
            log(`rest: ${t.label} — ${REST_ENDPOINTS.length} endpoints x concurrency [${opts.concurrency.join(', ')}] x ${opts.iterations} iterations`);
            result.rest[t.key] = await benchRestForTarget(t, opts);
        }
    }
    if (sections.includes('sse')) {
        for (const t of targets) {
            log(`sse: ${t.label} — client counts [${opts.sseClients.join(', ')}]`);
            result.sse[t.key] = await benchSseForTarget(t, opts);
        }
    }
    if (sections.includes('db')) {
        for (const t of targets) {
            log(`db: ${t.label} — export-db + ${opts.dbSweeps}x /shots.json`);
            result.db[t.key] = await benchDbForTarget(t, opts, log);
        }
    }

    result.finishedAt = new Date().toISOString();
    return result;
}

// ── Markdown rendering ───────────────────────────────────────────────────

const n1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : '—');
const n2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : '—');
const nInt = (x) => (Number.isFinite(x) ? String(Math.round(x)) : '—');
const bytesH = (x) => (Number.isFinite(x) ? `${(x / 1e6).toFixed(2)} MB` : '—');
const deltaCell = (go, node) => {
    const d = pctDelta(go, node);
    if (d === null) return '—';
    const sign = d > 0 ? '+' : '';
    return `${sign}${d.toFixed(1)}%`;
};

// Scans every REST endpoint/concurrency cell and the /shots.json sweep on
// each target for a 429 share above RATE_LIMIT_INVALID_FRAC, returning a
// human-readable warning line per offending cell. An empty list means no
// target was meaningfully rate-limited during the run.
export function rateLimitWarnings(result) {
    const out = [];
    const flag = (label, where, frac, n, total) => {
        if (Number.isFinite(frac) && frac > RATE_LIMIT_INVALID_FRAC) {
            out.push(`**${label}** ${where}: ${n}/${total} (${(frac * 100).toFixed(0)}%) rate-limited`);
        }
    };
    for (const t of result.targets) {
        const rest = result.rest?.[t.key]?.endpoints || {};
        for (const [name, ep] of Object.entries(rest)) {
            for (const [c, cell] of Object.entries(ep.byConcurrency || {})) {
                flag(t.label, `${name} @ c=${c}`, cell.rateLimitedFrac, cell.rateLimited, cell.runs);
            }
        }
        const sweep = result.db?.[t.key]?.shotsSweep;
        if (sweep) flag(t.label, 'GET /shots.json sweep', sweep.rateLimitedFrac, sweep.rateLimited, sweep.sweeps);
    }
    return out;
}

export function renderMarkdown(result) {
    const L = [];
    const keys = result.targets.map(t => t.key);
    const twoWay = keys.includes('go') && keys.includes('node');

    L.push('# Node-vs-Go benchmark');
    L.push('');
    const rpsNote = result.options.rps ? `, --rps ${result.options.rps}` : '';
    L.push(`Run ${result.startedAt} · sections: ${result.sections.join(', ')} · iterations ${result.options.iterations}, concurrency [${result.options.concurrency.join(', ')}], SSE clients [${result.options.sseClients.join(', ')}]${rpsNote}.`);
    L.push('');

    // ── Rate-limit sanity (surfaced first — an invalidated endpoint makes
    //    its whole row meaningless) ──
    const rlWarnings = rateLimitWarnings(result);
    if (rlWarnings.length) {
        L.push('## ⚠️ Rate-limited endpoints — comparison invalid');
        L.push('');
        L.push('One or both targets returned HTTP 429 for these endpoint/concurrency cells above the '
            + `${(RATE_LIMIT_INVALID_FRAC * 100).toFixed(0)}% threshold. Their latency and req/s numbers below reflect the limiter, not the handler — ignore the row or re-run with \`--rps <n>\` low enough that neither side 429s:`);
        L.push('');
        for (const w of rlWarnings) L.push(`- ${w}`);
        L.push('');
    }

    // ── Context (surfaced first, deliberately) ──
    L.push('## Context — the datasets are NOT identical');
    L.push('');
    L.push('| | ' + result.targets.map(t => t.label).join(' | ') + ' |');
    L.push('|---|' + result.targets.map(() => '---').join('|') + '|');
    const ctxRow = (label, fn) => L.push(`| ${label} | ` + keys.map(k => fn(result.context[k] || {})).join(' | ') + ' |');
    ctxRow('Base URL', c => c.baseUrl || '—');
    ctxRow('GLP version', c => c.glpVersion || c.versionCurrent || '—');
    ctxRow('Dev/preview build', c => c.devBuild || '—');
    ctxRow('Shot count', c => (Number.isFinite(c.shotCount) ? String(c.shotCount) : '—'));
    ctxRow('DB size', c => (Number.isFinite(c.dbBytes) ? bytesH(c.dbBytes) : (c.dbSizeNote || '—')));
    ctxRow('Machine firmware', c => c.machineVersion || '—');
    L.push('');
    if (twoWay) {
        const gc = result.context.go || {}, nc = result.context.node || {};
        const shotDelta = pctDelta(gc.shotCount, nc.shotCount);
        const dbDelta = pctDelta(gc.dbBytes, nc.dbBytes);
        const notes = [];
        if (shotDelta !== null && Math.abs(shotDelta) > 1) notes.push(`Go has ${shotDelta > 0 ? '+' : ''}${shotDelta.toFixed(0)}% the shot count of Node`);
        if (dbDelta !== null && Math.abs(dbDelta) > 1) notes.push(`Go's DB is ${dbDelta > 0 ? '+' : ''}${dbDelta.toFixed(0)}% the size of Node's`);
        if (notes.length) {
            L.push(`> **Read the latency numbers with this in mind:** ${notes.join('; ')}. Point both add-ons at a restored copy of the same \`glp.db\` for a like-for-like run.`);
            L.push('');
        }
    }

    // ── REST ──
    if (result.sections.includes('rest')) {
        L.push('## REST latency');
        L.push('');
        for (const c of result.options.concurrency) {
            L.push(`### Concurrency ${c}`);
            L.push('');
            if (twoWay) {
                L.push('| Endpoint | Go p50 | Go p95 | Go req/s | Node p50 | Node p95 | Node req/s | Δ p50 | Δ req/s | 429 Go/Node |');
                L.push('|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|');
            } else {
                L.push('| Endpoint | p50 ms | p90 ms | p95 ms | p99 ms | mean ms | req/s | errors | 429 |');
                L.push('|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|');
            }
            const rl = (cell) => (cell && cell.rateLimited ? `${cell.rateLimited}/${cell.runs}` : '0');
            for (const ep of REST_ENDPOINTS) {
                const g = result.rest.go?.endpoints?.[ep.name];
                if (twoWay) {
                    const nd = result.rest.node?.endpoints?.[ep.name];
                    if (g?.skipped && nd?.skipped) { L.push(`| ${ep.name} | _skipped_ | | | | | | | | |`); continue; }
                    const gc = g?.byConcurrency?.[c] || {};
                    const nc = nd?.byConcurrency?.[c] || {};
                    L.push(`| ${ep.name} | ${n1(gc.p50)} | ${n1(gc.p95)} | ${n1(gc.reqPerSec)} | ${n1(nc.p50)} | ${n1(nc.p95)} | ${n1(nc.reqPerSec)} | ${deltaCell(gc.p50, nc.p50)} | ${deltaCell(gc.reqPerSec, nc.reqPerSec)} | ${rl(gc)} / ${rl(nc)} |`);
                } else {
                    if (g?.skipped) { L.push(`| ${ep.name} | _skipped: ${g.skipped}_ | | | | | | | |`); continue; }
                    const s = g?.byConcurrency?.[c] || {};
                    L.push(`| ${ep.name} | ${n1(s.p50)} | ${n1(s.p90)} | ${n1(s.p95)} | ${n1(s.p99)} | ${n1(s.mean)} | ${n1(s.reqPerSec)} | ${nInt(s.errors)} | ${rl(s)} |`);
                }
            }
            L.push('');
        }
        if (twoWay) {
            L.push('_Δ is Go relative to Node. Negative Δ p50 = Go lower latency; positive Δ req/s = Go higher throughput. A non-zero 429 count means that cell hit the target\'s rate limiter — see the warning block above if it crossed the threshold._');
            L.push('');
        }
    }

    // ── SSE ──
    if (result.sections.includes('sse')) {
        L.push('## SSE — time-to-first-byte and delivery lag');
        L.push('');
        for (const k of keys) {
            const s = result.sse[k];
            if (!s) continue;
            const label = result.targets.find(t => t.key === k).label;
            const modeNote = s.mode === 'probe'
                ? `\`${s.url}\` — server-timestamped probe, lag is clock-skew-corrected client-receive-minus-server-send`
                : `\`${s.url}\` — no probe on this instance, lag column is the max inter-event gap (fallback)`;
            L.push(`### ${label} (${modeNote})`);
            L.push('');
            L.push('| Clients | TTFB mean | TTFB max | Lag mean | Lag max | Starved clients |');
            L.push('|--:|--:|--:|--:|--:|--:|');
            for (const cc of result.options.sseClients) {
                const sc = s.scenarios[cc];
                if (!sc) continue;
                L.push(`| ${cc} | ${n1(sc.ttfbMeanMs)} ms | ${n1(sc.ttfbMaxMs)} ms | ${n1(sc.lagMeanMs)} ms | ${n1(sc.lagMaxMs)} ms | ${sc.starvedClients}/${cc} |`);
            }
            L.push('');
        }
        if (twoWay && result.sse.go?.mode === 'probe' && result.sse.node?.mode !== 'probe') {
            L.push('_Go and Node are measured differently here (Go has the server-timestamped probe, Node does not), so the lag columns are not directly comparable — compare TTFB and starved-client counts instead._');
            L.push('');
        }
    }

    // ── DB ──
    if (result.sections.includes('db')) {
        L.push('## DB-heavy');
        L.push('');
        if (twoWay) {
            L.push('| Workload | Go | Node | Δ |');
            L.push('|---|--:|--:|--:|');
            const ge = result.db.go?.exportDb || {}, ne = result.db.node?.exportDb || {};
            L.push(`| export-db size | ${ge.skipped ? '_' + ge.skipped + '_' : bytesH(ge.bytes)} | ${ne.skipped ? '_' + ne.skipped + '_' : bytesH(ne.bytes)} | — |`);
            L.push(`| export-db throughput | ${n2(ge.mbPerSec)} MB/s | ${n2(ne.mbPerSec)} MB/s | ${deltaCell(ge.mbPerSec, ne.mbPerSec)} |`);
            const gs = result.db.go?.shotsSweep || {}, ns = result.db.node?.shotsSweep || {};
            L.push(`| /shots.json wall (${gs.sweeps ?? '?'} sweeps) | ${n1(gs.wallMs)} ms | ${n1(ns.wallMs)} ms | ${deltaCell(gs.wallMs, ns.wallMs)} |`);
            L.push(`| /shots.json throughput | ${n2(gs.mbPerSec)} MB/s | ${n2(ns.mbPerSec)} MB/s | ${deltaCell(gs.mbPerSec, ns.mbPerSec)} |`);
            L.push(`| /shots.json lists/s | ${n1(gs.listsPerSec)} | ${n1(ns.listsPerSec)} | ${deltaCell(gs.listsPerSec, ns.listsPerSec)} |`);
        } else {
            const e = result.db.go?.exportDb || {};
            const sw = result.db.go?.shotsSweep || {};
            L.push('| Workload | Value |');
            L.push('|---|--:|');
            L.push(`| export-db size | ${e.skipped ? '_' + e.skipped + '_' : bytesH(e.bytes)} |`);
            L.push(`| export-db throughput | ${e.skipped ? '—' : n2(e.mbPerSec) + ' MB/s'} |`);
            L.push(`| /shots.json wall (${sw.sweeps ?? '?'} sweeps) | ${n1(sw.wallMs)} ms |`);
            L.push(`| /shots.json throughput | ${n2(sw.mbPerSec)} MB/s |`);
            L.push(`| /shots.json lists/s | ${n1(sw.listsPerSec)} |`);
            L.push(`| /shots.json list size | ${bytesH(sw.listBytes)} |`);
        }
        L.push('');
    }

    L.push(manualFooter(result));
    return L.join('\n');
}

function manualFooter(result) {
    const slugs = { go: 'glp_go_preview', node: 'gaggiuino_local_profiler_dev' };
    const lines = [
        '## Measure these manually (not available over HTTP)',
        '',
        'RSS / memory and add-on boot time can only be read from the Supervisor host:',
        '',
        '```',
    ];
    for (const t of result.targets) {
        lines.push(`# ${t.label} resident memory`);
        lines.push(`ha addons stats ${slugs[t.key] || '<slug>'}`);
    }
    lines.push('');
    lines.push('# boot time: restart the add-on and time until it reports healthy');
    for (const t of result.targets) {
        lines.push(`ha addons restart ${slugs[t.key] || '<slug>'} && \\`);
        lines.push(`  time (until ha addons info ${slugs[t.key] || '<slug>'} | grep -q "state: started"; do sleep 0.2; done)`);
    }
    lines.push('```');
    lines.push('');
    lines.push('Take the memory reading after a benchmark run (warm), not at idle.');
    lines.push('');
    lines.push('## Make the two datasets identical before a like-for-like run');
    lines.push('');
    lines.push('The Context table above only matches if both add-ons serve the same');
    lines.push('`glp.db`. Both dev/preview builds expose the raw DB over HTTP — copy one');
    lines.push("channel's DB into the other, then re-run:");
    lines.push('');
    lines.push('```');
    lines.push('# pull the Node dev DB, load it into the Go preview build');
    lines.push('curl -sf -H "X-GLP-Token: $NODE_TOKEN"  http://HOST:8098/api/debug/export-db -o /tmp/glp.db');
    lines.push('curl -sf -H "X-GLP-Token: $GO_TOKEN" -X POST --data-binary @/tmp/glp.db \\');
    lines.push('     -H "Content-Type: application/octet-stream" http://HOST:8097/api/debug/import-db');
    lines.push('# (swap the URLs/tokens to go the other direction)');
    lines.push('```');
    lines.push('');
    lines.push('`import-db` replaces the target\'s DB wholesale and both builds reload it');
    lines.push('in place — no add-on restart needed. Re-run the benchmark afterwards and');
    lines.push('the Context shot counts / DB sizes should line up.');
    return lines.join('\n');
}

// ── Entry point ──────────────────────────────────────────────────────────

export async function main(argv = process.argv.slice(2)) {
    let opts;
    try {
        opts = parseArgs(argv);
    } catch (err) {
        console.error(`error: ${err.message}\n`);
        console.error(HELP);
        process.exitCode = 2;
        return;
    }
    if (opts.help) {
        console.log(HELP);
        return;
    }

    const result = await runBench(opts, { log: (m) => console.error(`[bench] ${m}`) });
    const md = renderMarkdown(result);
    console.log(md);

    if (opts.json) {
        writeFileSync(opts.json, JSON.stringify(result, null, 2) + '\n');
        console.error(`[bench] wrote ${opts.json}`);
    }
}

const invokedDirectly = process.argv[1] &&
    fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedDirectly) {
    main().catch(err => {
        console.error(`[bench] harness error: ${err && err.stack || err}`);
        process.exitCode = 1;
    });
}
