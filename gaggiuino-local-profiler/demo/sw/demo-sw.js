// Service worker for the static GitHub Pages demo (#1193).
//
// The demo ships the real SPA with no backend, so this worker answers every
// API request from the fixtures recorded by scripts/demo-fixtures.mjs. It is a
// classic script (importScripts, not import) because it is copied verbatim
// into demo-dist/ rather than bundled. Reads replay fixtures; writes are
// refused for now (in-memory writes land in a later slice).
importScripts('sw-core.js');

const DEMO_TOKEN = { apiToken: 'demo' };

let manifestPromise = null;

/** Loads fixtures/manifest.json from the scope, retrying after a failure. */
function loadManifest() {
    if (!manifestPromise) {
        manifestPromise = fetch(new URL('fixtures/manifest.json', self.registration.scope))
            .then(response => {
                if (!response.ok) throw new Error(`fixtures/manifest.json: HTTP ${response.status}`);
                return response.json();
            })
            .catch(error => {
                manifestPromise = null;
                throw error;
            });
    }
    return manifestPromise;
}

function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

/**
 * A text/event-stream body that emits one comment and then stays open. Letting
 * it close immediately would make EventSource reconnect in a tight loop.
 */
function sseResponse() {
    const stream = new ReadableStream({
        start(controller) {
            controller.enqueue(new TextEncoder().encode(': demo\n\n'));
        },
    });
    return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
    });
}

async function fixtureResponse(entry) {
    const response = await fetch(new URL(`fixtures/${entry.file}`, self.registration.scope));
    if (!response.ok) {
        console.warn('[glp-demo] missing fixture file:', entry.file);
        return jsonResponse({ error: 'demo_missing' }, 404);
    }
    const status = entry.status || 200;
    const body = status === 204 || status === 205 || status === 304 ? null : await response.arrayBuffer();
    return new Response(body, {
        status,
        headers: entry.contentType ? { 'Content-Type': entry.contentType } : {},
    });
}

async function handle(request) {
    const manifest = await loadManifest();
    const route = self.GLPDemo.route(request.method, request.url, self.registration.scope, manifest);
    switch (route.kind) {
        case 'token':
            return jsonResponse(DEMO_TOKEN);
        case 'sse':
            return sseResponse();
        case 'fixture':
            return fixtureResponse(route.entry);
        case 'readonly':
            return jsonResponse({ error: 'demo_readonly' }, 403);
        case 'missing':
            console.warn('[glp-demo] no fixture for', route.key);
            return jsonResponse({ error: 'demo_missing' }, 404);
        default:
            return fetch(request);
    }
}

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', event => {
    const request = event.request;
    // route()'s passthrough decision depends only on the method and URL, so an
    // empty manifest is enough to decide whether to intercept at all.
    const route = self.GLPDemo.route(request.method, request.url, self.registration.scope, { entries: {} });
    if (route.kind === 'passthrough') return;
    event.respondWith(handle(request));
});
