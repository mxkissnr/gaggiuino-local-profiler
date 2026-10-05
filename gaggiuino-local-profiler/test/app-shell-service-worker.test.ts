import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

// Part of #1404 (slice 4): public-src/public/sw.js is a classic service-worker
// script, not a module, so it is loaded in a fresh context with only the
// globals its fetch handler touches rather than imported.

type FetchHandler = (event: ShellFetchEvent) => void;

interface ShellFetchEvent {
    request: { method: string; mode: string; url: string };
    respondWith: (response: Promise<unknown>) => void;
}

interface ShellResponse {
    clone: () => unknown;
}

interface ShellCache {
    put: (request: unknown, response: unknown) => Promise<void>;
}

interface Sandbox {
    self: {
        addEventListener: (type: string, handler: FetchHandler) => void;
        skipWaiting: () => void;
        clients: { claim: () => Promise<void> };
        location: { origin: string };
    };
    URL: typeof URL;
    caches: {
        open: (name: string) => Promise<ShellCache>;
        match: (request: unknown) => Promise<unknown>;
        keys: () => Promise<string[]>;
        delete: (name: string) => Promise<boolean>;
    };
    fetch: (request: unknown) => Promise<ShellResponse>;
}

const ORIGIN = 'https://glp.example';

function loadAppShellSw() {
    const source = readFileSync(fileURLToPath(new URL('../public-src/public/sw.js', import.meta.url)), 'utf8');
    const handlers = new Map<string, FetchHandler>();
    const put = vi.fn<ShellCache['put']>(() => Promise.resolve());
    const open = vi.fn<(name: string) => Promise<ShellCache>>(() => Promise.resolve({ put }));
    const match = vi.fn<(request: unknown) => Promise<unknown>>(() => Promise.resolve(undefined));
    const fetchMock = vi.fn<(request: unknown) => Promise<ShellResponse>>(
        () => Promise.resolve({ clone: () => ({}) })
    );
    const sandbox: Sandbox = {
        self: {
            addEventListener: (type, handler) => { handlers.set(type, handler); },
            skipWaiting: () => {},
            clients: { claim: () => Promise.resolve() },
            location: { origin: ORIGIN },
        },
        URL,
        caches: {
            open,
            match,
            keys: () => Promise.resolve([]),
            delete: () => Promise.resolve(true),
        },
        fetch: fetchMock,
    };
    runInNewContext(source, sandbox);
    return { handlers, put, fetchMock };
}

function dispatchFetch(handlers: Map<string, FetchHandler>, url: string) {
    const handler = handlers.get('fetch');
    if (!handler) throw new Error('sw.js did not register a fetch handler');
    const respondWith = vi.fn<(response: Promise<unknown>) => void>();
    handler({ request: { method: 'GET', mode: 'no-cors', url }, respondWith });
    return { respondWith };
}

describe('app-shell service worker skips .wasm (#1404)', () => {
    it('does not intercept a .wasm asset, so it is never put into the cache', () => {
        const { handlers, put, fetchMock } = loadAppShellSw();
        const { respondWith } = dispatchFetch(handlers, `${ORIGIN}/assets/ort-wasm-simd-threaded.wasm`);
        expect(respondWith).not.toHaveBeenCalled();
        expect(fetchMock).not.toHaveBeenCalled();
        expect(put).not.toHaveBeenCalled();
    });

    it('still intercepts a normal /assets/ bundle', () => {
        const { handlers, fetchMock } = loadAppShellSw();
        const { respondWith } = dispatchFetch(handlers, `${ORIGIN}/assets/index-abc123.js`);
        expect(respondWith).toHaveBeenCalledTimes(1);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
