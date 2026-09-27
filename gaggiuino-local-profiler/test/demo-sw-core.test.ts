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
    | { kind: 'readonly' }
    | { kind: 'missing'; key: string };

interface GlpDemo {
    fixtureKey(method: string, urlString: string): string;
    route(method: string, requestUrl: string, scopeUrl: string, manifest: Manifest): Route;
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

    it('refuses writes under api/', () => {
        expect(glp.route('POST', `${SCOPE}api/backup/restore`, SCOPE, MANIFEST)).toEqual({ kind: 'readonly' });
        expect(glp.route('DELETE', `${SCOPE}api/shots/5`, SCOPE, MANIFEST)).toEqual({ kind: 'readonly' });
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
