// Service worker for the static GitHub Pages demo (#1193).
//
// The demo ships the real SPA with no backend, so this worker answers every
// API request from the fixtures recorded by scripts/demo-fixtures.mjs. It is a
// classic script (importScripts, not import) because it is copied verbatim
// into demo-dist/ rather than bundled. Reads replay fixtures; writes are
// accepted and thrown away, and the page is told so it can say nothing was
// saved.
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

async function fixtureResponse(entry, pathname, deltaMs) {
    const response = await fetch(new URL(`fixtures/${entry.file}`, self.registration.scope));
    if (!response.ok) {
        console.warn('[glp-demo] missing fixture file:', entry.file);
        return jsonResponse({ error: 'demo_missing' }, 404);
    }
    const status = entry.status || 200;
    const headers = entry.contentType ? { 'Content-Type': entry.contentType } : {};
    if (status === 204 || status === 205 || status === 304) return new Response(null, { status, headers });
    // JSON fixtures get their recorded wall-clock timestamps moved to the
    // present (and the machine reported online); anything else — photos,
    // downloads, plain text — is replayed byte-for-byte.
    const isJson = String(entry.contentType || '').split(';')[0].trim().toLowerCase() === 'application/json';
    if (isJson) {
        const text = await response.text();
        try {
            const shifted = self.GLPDemo.shiftTimestamps(JSON.parse(text), deltaMs);
            return new Response(JSON.stringify(self.GLPDemo.patchMachineOnline(pathname, shifted, Date.now())), { status, headers });
        } catch {
            return new Response(text, { status, headers });
        }
    }
    const body = await response.arrayBuffer();
    return new Response(body, { status, headers });
}

/**
 * Tells the requesting client that a write was accepted but not saved, so the
 * page's banner can say so. Best-effort: a request with no client id, or a
 * tab that has since closed, is simply skipped.
 */
async function notifyWriteDiscarded(event) {
    if (!event.clientId) return;
    const client = await self.clients.get(event.clientId);
    if (client) client.postMessage({ type: 'glp-demo-write' });
}

async function handle(request, event) {
    const manifest = await loadManifest();
    const route = self.GLPDemo.route(request.method, request.url, self.registration.scope, manifest);
    switch (route.kind) {
        case 'token':
            return jsonResponse(DEMO_TOKEN);
        case 'sse':
            return sseResponse();
        case 'fixture': {
            // Elapsed time since the fixtures were recorded: every wall-clock
            // timestamp in a JSON fixture is moved forward by this much, so a
            // snapshot taken weeks ago reads as if it were taken now.
            const generated = manifest.generated ? Date.parse(manifest.generated) : NaN;
            const deltaMs = Number.isFinite(generated) ? Date.now() - generated : 0;
            return fixtureResponse(route.entry, new URL(request.url).pathname, deltaMs);
        }
        case 'write':
            await notifyWriteDiscarded(event);
            return jsonResponse({ ok: true, demo: true });
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
    event.respondWith(handle(request, event));
});
