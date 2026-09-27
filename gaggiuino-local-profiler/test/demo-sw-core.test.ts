import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { fixtureKey as recorderFixtureKey } from '../scripts/demo-fixtures.mjs';

// Part of #1193 (S2b): the pure routing surface of demo/sw/sw-core.js. The
// script is a classic service-worker script, so it is loaded in a fresh
// context with the globals it actually uses rather than imported.

interface FixtureEntry {
    status: number;
    contentType: string;
    file: string;
}

interface Manifest {
    entries: Record<string, FixtureEntry>;
}

type Route =
    | { kind: 'passthrough' }
    | { kind: 'token' }
    | { kind: 'sse' }
    | { kind: 'fixture'; entry: FixtureEntry }
    | { kind: 'write' }
    | { kind: 'missing'; key: string };

interface GlpDemo {
    fixtureKey(method: string, urlString: string): string;
    route(method: string, requestUrl: string, scopeUrl: string, manifest: Manifest): Route;
    shiftTimestamps(value: unknown, deltaMs: number): unknown;
    patchMachineOnline(pathname: string, body: unknown, nowMs: number): unknown;
}

function loadGlpDemo(): GlpDemo {
    const source = readFileSync(fileURLToPath(new URL('../demo/sw/sw-core.js', import.meta.url)), 'utf8');
    const context = { self: {} as { GLPDemo?: GlpDemo }, URL, URLSearchParams };
    runInNewContext(source, context);
    const glp = context.self.GLPDemo;
    if (!glp) throw new Error('sw-core.js did not expose self.GLPDemo');
    return glp;
}

const EMPTY_MANIFEST: Manifest = { entries: {} };

const MANIFEST: Manifest = {
    entries: {
        'GET /api/shots?limit=60': { status: 200, contentType: 'application/json', file: 'shots.json' },
        'GET /shots.json': { status: 200, contentType: 'application/json', file: 'shots-list.json' },
    },
};

const SCOPE = 'https://demo.example/gaggiuino-local-profiler/';

describe('sw-core fixtureKey matches the recorder (#1193)', () => {
    const glp = loadGlpDemo();
    const cases: ReadonlyArray<readonly [string, string]> = [
        ['get', '/api/shots?limit=50'],
        ['GET', 'http://127.0.0.1:8199/api/status'],
        ['GET', '/api/library?b=2&a=1'],
        ['GET', '/api/shots/5?t=1699999999'],
        ['GET', '/api/shots?limit=50&t=1&_=2'],
        ['GET', '/api/status?t=1'],
        ['GET', '/api/library?name=Ethiopia%20Yirgacheffe&roast=light'],
        ['HEAD', '/api/shots?limit=60'],
    ];

    for (const [method, url] of cases) {
        it(`agrees with scripts/demo-fixtures.mjs on ${method} ${url}`, () => {
            expect(glp.fixtureKey(method, url)).toBe(recorderFixtureKey(method, url));
        });
    }
});

describe('sw-core route (#1193)', () => {
    const glp = loadGlpDemo();

    it('serves the demo token without consulting the manifest', () => {
        expect(glp.route('GET', `${SCOPE}api/token`, SCOPE, EMPTY_MANIFEST)).toEqual({ kind: 'token' });
    });

    it('routes the SSE endpoint', () => {
        expect(glp.route('GET', `${SCOPE}api/events`, SCOPE, EMPTY_MANIFEST)).toEqual({ kind: 'sse' });
    });

    it('returns a recorded fixture, caching-busters normalised away', () => {
        expect(glp.route('GET', `${SCOPE}api/shots?limit=60&t=1`, SCOPE, MANIFEST)).toEqual({
            kind: 'fixture',
            entry: MANIFEST.entries['GET /api/shots?limit=60'],
        });
    });

    it('serves /shots.json at the scope root (no /api prefix)', () => {
        expect(glp.route('GET', `${SCOPE}shots.json`, SCOPE, MANIFEST)).toEqual({
            kind: 'fixture',
            entry: MANIFEST.entries['GET /shots.json'],
        });
    });

    it('reports a missing GET fixture with its manifest key', () => {
        expect(glp.route('GET', `${SCOPE}api/shots?limit=61`, SCOPE, MANIFEST)).toEqual({
            kind: 'missing',
            key: 'GET /api/shots?limit=61',
        });
    });

    it('classifies writes under api/', () => {
        expect(glp.route('POST', `${SCOPE}api/backup/restore`, SCOPE, MANIFEST)).toEqual({ kind: 'write' });
        expect(glp.route('PUT', `${SCOPE}api/shots/5`, SCOPE, MANIFEST)).toEqual({ kind: 'write' });
        expect(glp.route('DELETE', `${SCOPE}api/shots/5`, SCOPE, MANIFEST)).toEqual({ kind: 'write' });
    });

    it('treats HEAD as a read against the recorded GET fixture', () => {
        expect(glp.route('HEAD', `${SCOPE}api/shots?limit=60`, SCOPE, MANIFEST)).toEqual({
            kind: 'fixture',
            entry: MANIFEST.entries['GET /api/shots?limit=60'],
        });
        expect(glp.route('HEAD', `${SCOPE}api/shots?limit=61`, SCOPE, MANIFEST)).toEqual({
            kind: 'missing',
            key: 'GET /api/shots?limit=61',
        });
    });

    it('passes through requests outside the scope', () => {
        expect(glp.route('GET', 'https://demo.example/other/api/shots', SCOPE, MANIFEST)).toEqual({ kind: 'passthrough' });
    });

    it('passes through another origin that shares the path', () => {
        expect(glp.route('GET', 'https://evil.example/gaggiuino-local-profiler/api/shots', SCOPE, MANIFEST)).toEqual({
            kind: 'passthrough',
        });
    });

    it('passes through non-API paths under the scope', () => {
        expect(glp.route('GET', `${SCOPE}index.html`, SCOPE, MANIFEST)).toEqual({ kind: 'passthrough' });
        expect(glp.route('GET', `${SCOPE}assets/index.js`, SCOPE, MANIFEST)).toEqual({ kind: 'passthrough' });
    });

    it('treats a write outside api/ as passthrough', () => {
        expect(glp.route('POST', `${SCOPE}shots.json`, SCOPE, MANIFEST)).toEqual({ kind: 'passthrough' });
    });

    it('handles a scope without a trailing slash', () => {
        const bare = 'https://demo.example/gaggiuino-local-profiler';
        expect(glp.route('GET', `${bare}/api/token`, bare, EMPTY_MANIFEST)).toEqual({ kind: 'token' });
        expect(glp.route('GET', `${bare}/api/shots?limit=60`, bare, MANIFEST)).toEqual({
            kind: 'fixture',
            entry: MANIFEST.entries['GET /api/shots?limit=60'],
        });
    });
});

const DAY_MS = 86_400_000;

describe('sw-core shiftTimestamps (#1193)', () => {
    const glp = loadGlpDemo();

    it('shifts epoch-millisecond values under timestamp-shaped keys', () => {
        const input = {
            createdAt: 1_700_000_000_000,
            trashedAt: 1_700_000_000_000,
            machines: [{ updatedAt: 1_700_000_000_000 }],
        };
        const out = glp.shiftTimestamps(input, DAY_MS) as typeof input;
        expect(out.createdAt).toBe(1_700_000_000_000 + DAY_MS);
        expect(out.trashedAt).toBe(1_700_000_000_000 + DAY_MS);
        expect(out.machines[0].updatedAt).toBe(1_700_000_000_000 + DAY_MS);
    });

    it('shifts epoch-second values as whole seconds', () => {
        const out = glp.shiftTimestamps({ timestamp: 1_700_000_000 }, 4_000) as { timestamp: number };
        expect(out.timestamp).toBe(1_700_000_000 + 4);
    });

    it('shifts the maintenance log ts field', () => {
        const out = glp.shiftTimestamps({ ts: 1_700_000_000_000 }, 1_000) as { ts: number };
        expect(out.ts).toBe(1_700_000_000_000 + 1_000);
    });

    it('shifts full ISO date-time strings, re-serialised as ISO', () => {
        const out = glp.shiftTimestamps({ createdAt: '2024-01-15T10:00:00.000Z' }, DAY_MS) as { createdAt: string };
        expect(out.createdAt).toBe('2024-01-16T10:00:00.000Z');
    });

    it('shifts plain YYYY-MM-DD dates by whole days', () => {
        const out = glp.shiftTimestamps({ date: '2024-01-15' }, 3 * DAY_MS) as { date: string };
        expect(out.date).toBe('2024-01-18');
    });

    it('leaves measurement and id keys alone even when the value looks like an epoch', () => {
        const input = { id: 1_700_000_000_000, duration: 250, weight: 18.5, score: 85, shotCount: 42 };
        const out = glp.shiftTimestamps(input, DAY_MS) as typeof input;
        expect(out).toEqual(input);
    });

    it('leaves numbers outside the epoch ranges alone', () => {
        const out = glp.shiftTimestamps({ createdAt: 1000, timestamp: 500_000_000 }, DAY_MS) as {
            createdAt: number;
            timestamp: number;
        };
        expect(out.createdAt).toBe(1000);
        expect(out.timestamp).toBe(500_000_000);
    });

    it('leaves strings that are not ISO dates alone', () => {
        const out = glp.shiftTimestamps({ time: '08:30', date: 'yesterday', note: '2024-01-15' }, DAY_MS) as {
            time: string;
            date: string;
            note: string;
        };
        expect(out.time).toBe('08:30');
        expect(out.date).toBe('yesterday');
        expect(out.note).toBe('2024-01-15');
    });

    it('recurses through nested arrays and objects without mutating the input', () => {
        const input = { shots: [{ timestamp: 1_700_000_000, annotation: { roastDate: '2024-01-15' } }] };
        const out = glp.shiftTimestamps(input, DAY_MS) as typeof input;
        expect(out.shots[0].timestamp).toBe(1_700_000_000 + 86_400);
        expect(out.shots[0].annotation.roastDate).toBe('2024-01-16');
        expect(input.shots[0].timestamp).toBe(1_700_000_000);
        expect(input.shots[0].annotation.roastDate).toBe('2024-01-15');
        expect(out).not.toBe(input);
    });

    it('is a no-op for a missing or non-finite delta', () => {
        const input = { createdAt: 1_700_000_000_000 };
        expect(glp.shiftTimestamps(input, Number.NaN)).toEqual(input);
    });
});

const NOW_MS = Date.UTC(2026, 0, 15, 10, 30, 0);

interface StatusFixture {
    machineReachable: boolean | null;
    machineOn: boolean | null;
    machineOnSince: number | null;
    lastMachineError: string | null;
    lastMachineSuccess: number | null;
    lastSync: number | null;
    machineVersion: string | null;
    machines: Array<Record<string, unknown>>;
    shotCount: number;
}

describe('sw-core patchMachineOnline (#1193)', () => {
    const glp = loadGlpDemo();
    const status: StatusFixture = {
        machineReachable: false,
        machineOn: true,
        machineOnSince: 1_700_000_000_000,
        lastMachineError: 'dial tcp 10.0.0.2: connect: connection refused',
        lastMachineSuccess: null,
        lastSync: null,
        machineVersion: null,
        machines: [
            { id: 1, isDefault: true, reachable: false, on: true },
            { id: 2, isDefault: false, reachable: null, on: null },
        ],
        shotCount: 42,
    };

    it('rewrites /api/status to the default machine reachable and idle', () => {
        const out = glp.patchMachineOnline('/gaggiuino-local-profiler/api/status', status, NOW_MS) as StatusFixture;
        expect(out.machineReachable).toBe(true);
        expect(out.machineOn).toBe(false);
        expect(out.machineOnSince).toBeNull();
        expect(out.lastMachineError).toBeNull();
        expect(out.lastSync).toBe(NOW_MS);
        expect(out.lastMachineSuccess).toBe(NOW_MS);
        expect(out.machineVersion).toBe('v1.0.0');
        expect(out.machines[0]).toEqual({ id: 1, isDefault: true, reachable: true, on: false });
        expect(out.machines[1]).toEqual({ id: 2, isDefault: false, reachable: null, on: null });
        expect(out.shotCount).toBe(42);
    });

    it('keeps a recorded machineVersion instead of inventing one', () => {
        const out = glp.patchMachineOnline('/api/status', { machineVersion: 'v9.9.9' }, NOW_MS) as {
            machineVersion: string;
        };
        expect(out.machineVersion).toBe('v9.9.9');
    });

    it('nulls the authenticated-only lastSyncError when present', () => {
        const out = glp.patchMachineOnline('/api/status', { machineReachable: false, lastSyncError: 'boom' }, NOW_MS) as {
            lastSyncError: string | null;
        };
        expect(out.lastSyncError).toBeNull();
    });

    it('rewrites /api/live/data to a reachable but idle machine', () => {
        const body = {
            machineReachable: false,
            isLive: false,
            temperature: null,
            targetTemperature: null,
            pressure: null,
            datapoints: { timeInShot: [1, 2, 3] },
            seq: 7,
        };
        const out = glp.patchMachineOnline('/api/live/data', body, NOW_MS) as typeof body;
        expect(out.machineReachable).toBe(true);
        expect(out.isLive).toBe(false);
        expect(out.temperature).toBe(93);
        expect(out.targetTemperature).toBe(93);
        expect(out.pressure).toBe(0);
        expect(out.datapoints).toEqual({ timeInShot: [1, 2, 3] });
        expect(out.seq).toBe(7);
    });

    it('rewrites /api/preheat to finished, leaving the other fields alone', () => {
        const body = { ready: false, remaining: 1200, pct: 0, temp: null, targetTemp: null, preheatTime: 20, plannedSwitchOnAt: null };
        const out = glp.patchMachineOnline('/api/preheat', body, NOW_MS) as typeof body & { elapsed: number };
        expect(out.ready).toBe(true);
        expect(out.remaining).toBe(0);
        expect(out.pct).toBe(100);
        expect(out.elapsed).toBe(1200);
        expect(out.temp).toBe(93);
        expect(out.targetTemp).toBe(93);
        expect(out.preheatTime).toBe(20);
        expect(out.plannedSwitchOnAt).toBeNull();
    });

    it('leaves other paths and non-object bodies unchanged', () => {
        expect(glp.patchMachineOnline('/api/shots', status, NOW_MS)).toBe(status);
        expect(glp.patchMachineOnline('/api/machines', status, NOW_MS)).toBe(status);
        expect(glp.patchMachineOnline('/api/machine/live', status, NOW_MS)).toBe(status);
        expect(glp.patchMachineOnline('/api/status', null, NOW_MS)).toBeNull();
        const arrayBody: unknown[] = [];
        expect(glp.patchMachineOnline('/api/live/data', arrayBody, NOW_MS)).toBe(arrayBody);
    });
});
