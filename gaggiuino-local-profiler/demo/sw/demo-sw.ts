// Service worker for the static GitHub Pages demo (#1193).
//
// The demo ships the real SPA with no backend, so this worker answers every
// API request from the fixtures recorded by scripts/demo-fixtures.mts. It is
// TypeScript (#1270): the demo build bundles it with its core (demo/sw/
// sw-core.ts) into a single classic script, demo-dist/demo-sw.js, so this file
// is not copied verbatim. Reads replay fixtures; writes are accepted and
// thrown away, and the page is told so it can say nothing was saved.
import { GLPDemo, type FixtureEntry, type Manifest } from './sw-core.ts';

declare const self: ServiceWorkerGlobalScope;

const DEMO_TOKEN = { apiToken: 'demo' };

// A simulate request from the demo banner (public-src/demo/banner.ts). The
// string is a values-must-match contract between the two, same as sse.ts's
// EVENTS — the worker is bundled separately from the SPA, so it must not
// import the SPA's TS constant.
const SIMULATE_MESSAGE = 'glp-demo-simulate';
// The named SSE event the app routes to the Live view (sse.ts's
// EVENTS.LIVE_SNAPSHOT).
const LIVE_SNAPSHOT_EVENT = 'live-snapshot';

// One replay frame every 500 ms, advancing half a second of shot time each
// frame — so the recorded shot plays back at real speed.
const SIM_INTERVAL_MS = 500;
const SIM_STEP_TENTHS = 5;
// sse.ts marks a silent stream stale after 40 s, but only re-arms that timer
// on a dispatched named event — an SSE comment line does not fire one. The
// keepalive below therefore sends an idle live-snapshot (a real event the app
// already routes) well inside the 40 s window, so S.sseActive stays true
// between replays.
const SSE_KEEPALIVE_MS = 20000;

// Open `api/events` streams (their ReadableStream controllers), so a
// simulation can push live-snapshot frames onto every connected tab.
interface SseStream {
    controller: { enqueue(chunk: Uint8Array): void };
    timer: ReturnType<typeof setInterval>;
}
const sseStreams = new Set<SseStream>();
const SSE_ENCODER = new TextEncoder();

// The increasing seq the fake machine reports: unchanged while a shot runs,
// incremented when one ends — the seq the app watches to reload the shot
// list after a brew.
let liveSeq = 0;
let simulateRunning = false;

let manifestPromise: Promise<Manifest> | null = null;

/** Loads fixtures/manifest.json from the scope, retrying after a failure. */
function loadManifest(): Promise<Manifest> {
    if (!manifestPromise) {
        manifestPromise = fetch(new URL('fixtures/manifest.json', self.registration.scope))
            .then(response => {
                if (!response.ok) throw new Error(`fixtures/manifest.json: HTTP ${response.status}`);
                return response.json() as Promise<Manifest>;
            })
            .catch(error => {
                manifestPromise = null;
                throw error;
            });
    }
    return manifestPromise;
}

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

/** Forgets one stream and stops its keepalive. */
function dropStream(entry: SseStream | null): void {
    if (!entry) return;
    if (entry.timer) clearInterval(entry.timer);
    sseStreams.delete(entry);
}

/** Encodes one named SSE event (its `event:`/`data:` lines). */
function encodeEvent(type: string, data: unknown): Uint8Array {
    return SSE_ENCODER.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * A text/event-stream body that emits one comment and then stays open. Letting
 * it close immediately would make EventSource reconnect in a tight loop. Its
 * controller is held in sseStreams so a simulation can push live-snapshot
 * events onto it; both the stream's cancel callback and a failed enqueue drop
 * it. Every SSE_KEEPALIVE_MS it also emits an idle live-snapshot so the page's
 * own stale watchdog (sse.ts) keeps seeing a dispatched event; while a replay
 * is running its frames already do that, so the idle one is skipped to avoid
 * clobbering the live view mid-brew.
 */
function sseResponse(): Response {
    let entry: SseStream | null = null;
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(SSE_ENCODER.encode(': demo\n\n'));
            entry = {
                controller,
                timer: setInterval(() => {
                    try {
                        if (!simulateRunning) {
                            controller.enqueue(encodeEvent(LIVE_SNAPSHOT_EVENT, GLPDemo.idleFrame(liveSeq)));
                        }
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
function broadcast(type: string, data: unknown): void {
    const bytes = encodeEvent(type, data);
    for (const entry of [...sseStreams]) {
        try {
            entry.controller.enqueue(bytes);
        } catch {
            dropStream(entry);
        }
    }
}

async function fixtureResponse(entry: FixtureEntry, pathname: string, deltaMs: number): Promise<Response> {
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
    const isJson = (String(entry.contentType || '').split(';')[0] ?? '').trim().toLowerCase() === 'application/json';
    if (isJson) {
        const text = await response.text();
        try {
            const shifted = GLPDemo.shiftTimestamps(JSON.parse(text) as unknown, deltaMs);
            return new Response(JSON.stringify(GLPDemo.patchMachineOnline(pathname, shifted, Date.now())), { status, headers });
        } catch {
            return new Response(text, { status, headers });
        }
    }
    const body = await response.arrayBuffer();
    return new Response(body, { status, headers });
}

/** True for a plain JSON object (not null, not an array). */
function isJsonObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parses one recorded fixture file, or null when it is missing/not JSON. */
async function fetchFixtureJson(entry: FixtureEntry | undefined): Promise<unknown> {
    if (!entry) return null;
    const response = await fetch(new URL(`fixtures/${entry.file}`, self.registration.scope));
    return response.ok ? response.json() as Promise<unknown> : null;
}

/**
 * The newest recorded shot's full detail fixture: the first (newest-first) id
 * in the recorded GET /api/shots list page, then its GET /api/shots/{id}.
 * Null when either fixture is absent, so a simulate on an incomplete download
 * is a no-op rather than a crash.
 */
async function loadNewestShot(manifest: Manifest): Promise<unknown> {
    const listKey = GLPDemo.shotsListKey(manifest);
    if (!listKey) return null;
    const list = await fetchFixtureJson(manifest.entries[listKey]);
    const shots = isJsonObject(list) && Array.isArray(list.shots) ? (list.shots as unknown[]) : [];
    const first = shots[0];
    const id = isJsonObject(first) && typeof first.id === 'number' ? first.id : null;
    if (id == null) return null;
    return fetchFixtureJson(manifest.entries[GLPDemo.fixtureKey('GET', `api/shots/${id}`)]);
}

/**
 * Starts a replay unless one is already running. Synchronous, so the guard
 * check and set are atomic. Returns a promise that resolves when the replay
 * settles — the caller hands it to event.waitUntil() so the browser keeps the
 * worker alive for the whole 25–40 s shot — or null when a replay is already
 * active. The async body clears the flag when it settles.
 */
function startSimulation(): Promise<void> | null {
    if (simulateRunning) return null;
    simulateRunning = true;
    const done = (): void => { simulateRunning = false; };
    // Promise chain rather than async/await + finally: require-atomic-updates
    // can't see that nothing else writes the flag while a run is active.
    return replayShot().then(done, error => {
        console.warn('[glp-demo] simulate failed:', error);
        done();
    });
}

/**
 * Replays the newest recorded shot as a live brew: one live-snapshot every
 * 500 ms until the shot's last timeInShot, then one idle frame whose
 * incremented seq triggers the app's post-brew shot-list reload.
 */
async function replayShot(): Promise<void> {
    const shot = await loadNewestShot(await loadManifest());
    if (!isJsonObject(shot)) {
        console.warn('[glp-demo] simulate: no shot fixture to replay');
        return;
    }
    const datapoints = isJsonObject(shot.datapoints) ? shot.datapoints : {};
    const times = Array.isArray(datapoints.timeInShot) ? (datapoints.timeInShot as unknown[]) : [];
    const lastTime = times.length ? times[times.length - 1] : 0;
    const endTenths = typeof lastTime === 'number' ? lastTime : 0;
    const seq = liveSeq;
    await new Promise<void>(resolve => {
        let elapsed = 0;
        const timer = setInterval(() => {
            elapsed += SIM_STEP_TENTHS;
            if (elapsed < endTenths) {
                broadcast(LIVE_SNAPSHOT_EVENT, GLPDemo.liveFrame(shot, elapsed, seq));
                return;
            }
            clearInterval(timer);
            broadcast(LIVE_SNAPSHOT_EVENT, GLPDemo.liveFrame(shot, endTenths, seq));
            liveSeq = seq + 1;
            broadcast(LIVE_SNAPSHOT_EVENT, GLPDemo.idleFrame(liveSeq));
            resolve();
        }, SIM_INTERVAL_MS);
    });
}

/**
 * Tells the requesting client that a write was accepted but not saved, so the
 * page's banner can say so. Best-effort: a request with no client id, or a
 * tab that has since closed, is simply skipped.
 */
async function notifyWriteDiscarded(event: FetchEvent): Promise<void> {
    if (!event.clientId) return;
    const client = await self.clients.get(event.clientId);
    if (client) client.postMessage({ type: 'glp-demo-write' });
}

async function handle(request: Request, event: FetchEvent): Promise<Response> {
    const manifest = await loadManifest();
    const route = GLPDemo.route(request.method, request.url, self.registration.scope, manifest);
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

self.addEventListener('install', () => { void self.skipWaiting(); });

self.addEventListener('activate', (event: ExtendableEvent) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event: FetchEvent) => {
    const request = event.request;
    // route()'s passthrough decision depends only on the method and URL, so an
    // empty manifest is enough to decide whether to intercept at all.
    const route = GLPDemo.route(request.method, request.url, self.registration.scope, { entries: {} });
    if (route.kind === 'passthrough') return;
    event.respondWith(handle(request, event));
});

// The demo banner's "Simulate a shot" button asks the worker to replay a
// recorded shot down every open api/events stream. waitUntil holds the worker
// open for the replay — pending timers alone do not stop the browser from
// terminating an idle worker, which would freeze the shot partway through.
self.addEventListener('message', (event: ExtendableMessageEvent) => {
    const data: unknown = event.data;
    if (!isJsonObject(data) || data.type !== SIMULATE_MESSAGE) return;
    const replay = startSimulation();
    if (replay) event.waitUntil(replay);
});
