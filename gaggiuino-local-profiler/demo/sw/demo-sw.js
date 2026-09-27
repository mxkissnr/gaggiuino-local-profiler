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

// A simulate request from the demo banner (public-src/demo/banner.ts). The
// string is a values-must-match contract between the two, same as sse.ts's
// EVENTS — the worker is a classic script and cannot import the TS constant.
const SIMULATE_MESSAGE = 'glp-demo-simulate';
// The named SSE event the app routes to the Live view (sse.ts's
// EVENTS.LIVE_SNAPSHOT, backend lib/events.js).
const LIVE_SNAPSHOT_EVENT = 'live-snapshot';

// One replay frame every 500 ms, advancing half a second of shot time each
// frame — so the recorded shot plays back at real speed.
const SIM_INTERVAL_MS = 500;
const SIM_STEP_TENTHS = 5;
// sse.ts marks a silent stream stale after 40 s; a comment well inside that
// window keeps the demo connection looking alive between frames.
const SSE_KEEPALIVE_MS = 20000;

// Open `api/events` streams (their ReadableStream controllers), so a
// simulation can push live-snapshot frames onto every connected tab.
const sseStreams = new Set();
const SSE_ENCODER = new TextEncoder();

// The increasing seq the fake machine reports: unchanged while a shot runs,
// incremented when one ends — exactly lib/poll.js's liveSeq, and what the app
// watches for to reload the shot list after a brew.
let liveSeq = 0;
let simulateRunning = false;

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

/** Forgets one stream and stops its keepalive. */
function dropStream(entry) {
    if (!entry) return;
    if (entry.timer) clearInterval(entry.timer);
    sseStreams.delete(entry);
}

/**
 * A text/event-stream body that emits one comment and then stays open with a
 * periodic comment. Letting it close immediately would make EventSource
 * reconnect in a tight loop, and the keepalive keeps sse.ts from marking the
 * stream stale between frames. Its controller is held in sseStreams so a
 * simulation can push live-snapshot events onto it; both the stream's cancel
 * callback and a failed enqueue drop it.
 */
function sseResponse() {
    let entry = null;
    const stream = new ReadableStream({
        start(controller) {
            controller.enqueue(SSE_ENCODER.encode(': demo\n\n'));
            entry = {
                controller,
                timer: setInterval(() => {
                    try {
                        controller.enqueue(SSE_ENCODER.encode(': keepalive\n\n'));
                    } catch {
                        dropStream(entry);
                    }
                }, SSE_KEEPALIVE_MS),
            };
            sseStreams.add(entry);
        },
        cancel() {
            dropStream(entry);
        },
    });
    return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
    });
}

/** Enqueues one named SSE event to every open stream, dropping dead ones. */
function broadcast(type, data) {
    const bytes = SSE_ENCODER.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    for (const entry of [...sseStreams]) {
        try {
            entry.controller.enqueue(bytes);
        } catch {
            dropStream(entry);
        }
    }
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

/** Parses one recorded fixture file, or null when it is missing/not JSON. */
async function fetchFixtureJson(entry) {
    if (!entry) return null;
    const response = await fetch(new URL(`fixtures/${entry.file}`, self.registration.scope));
    return response.ok ? response.json() : null;
}

/**
 * The newest recorded shot's full detail fixture: the first (newest-first) id
 * in the recorded GET /api/shots list page, then its GET /api/shots/{id}.
 * Null when either fixture is absent, so a simulate on an incomplete download
 * is a no-op rather than a crash.
 */
async function loadNewestShot(manifest) {
    const listKey = self.GLPDemo.shotsListKey(manifest);
    if (!listKey) return null;
    const list = await fetchFixtureJson(manifest.entries[listKey]);
    const id = list && Array.isArray(list.shots) && list.shots.length ? list.shots[0].id : null;
    if (id == null) return null;
    return fetchFixtureJson(manifest.entries[self.GLPDemo.fixtureKey('GET', `api/shots/${id}`)]);
}

/**
 * Starts a replay unless one is already running. Synchronous, so the guard
 * check and set are atomic; the async body clears the flag when it settles.
 */
function startSimulation() {
    if (simulateRunning) return;
    simulateRunning = true;
    const done = () => { simulateRunning = false; };
    // Promise chain rather than async/await + finally: require-atomic-updates
    // can't see that nothing else writes the flag while a run is active.
    replayShot().then(done, error => {
        console.warn('[glp-demo] simulate failed:', error);
        done();
    });
}

/**
 * Replays the newest recorded shot as a live brew: one live-snapshot every
 * 500 ms until the shot's last timeInShot, then one idle frame whose
 * incremented seq triggers the app's post-brew shot-list reload.
 */
async function replayShot() {
    const shot = await loadNewestShot(await loadManifest());
    if (!shot) {
        console.warn('[glp-demo] simulate: no shot fixture to replay');
        return;
    }
    const times = (shot.datapoints && shot.datapoints.timeInShot) || [];
    const endTenths = times.length ? times[times.length - 1] : 0;
    const seq = liveSeq;
    await new Promise(resolve => {
        let elapsed = 0;
        const timer = setInterval(() => {
            elapsed += SIM_STEP_TENTHS;
            if (elapsed < endTenths) {
                broadcast(LIVE_SNAPSHOT_EVENT, self.GLPDemo.liveFrame(shot, elapsed, seq));
                return;
            }
            clearInterval(timer);
            broadcast(LIVE_SNAPSHOT_EVENT, self.GLPDemo.liveFrame(shot, endTenths, seq));
            liveSeq = seq + 1;
            broadcast(LIVE_SNAPSHOT_EVENT, self.GLPDemo.idleFrame(liveSeq));
            resolve();
        }, SIM_INTERVAL_MS);
    });
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

// The demo banner's "Simulate a shot" button asks the worker to replay a
// recorded shot down every open api/events stream.
self.addEventListener('message', event => {
    const data = event.data;
    if (data && data.type === SIMULATE_MESSAGE) startSimulation();
});
