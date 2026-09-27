// Pure routing helpers for the static demo service worker (#1193).
//
// This is a classic script, not a module: demo-sw.js loads it with
// importScripts(), and the unit test loads it with vm.runInNewContext(). It
// must therefore export through `self.GLPDemo` and use no import/export.
//
// fixtureKey() is a deliberate copy of the recorder's (scripts/demo-fixtures.mjs):
// the manifest keys it wrote are the exact strings looked up here, so the two
// implementations have to normalise identically. test/demo-sw-core.test.ts
// asserts they agree on a table of URLs.
self.GLPDemo = (() => {
    // Cache-buster query keys the SPA appends to force a fresh fetch; a static
    // snapshot keys by the real resource, so both are dropped. Kept in sync
    // with CACHE_BUSTER_PARAMS in scripts/demo-fixtures.mjs.
    const CACHE_BUSTER_PARAMS = new Set(['t', '_']);

    /**
     * Normalises a request into the manifest key `"<METHOD> <path>?<sorted query>"`.
     * Query params are sorted so ordering differences do not split one resource
     * across two fixtures, and the cache-buster params above are dropped.
     */
    function fixtureKey(method, urlString) {
        const url = new URL(urlString, 'http://fixture.invalid');
        const params = [...url.searchParams.entries()]
            .filter(([name]) => !CACHE_BUSTER_PARAMS.has(name))
            .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1));
        const query = params.map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`).join('&');
        return `${String(method).toUpperCase()} ${url.pathname}${query ? `?${query}` : ''}`;
    }

    /** A scope always has a trailing slash, even if the caller passed it bare. */
    function scopeOf(scopeUrl) {
        const scope = new URL(scopeUrl, 'http://fixture.invalid');
        if (!scope.pathname.endsWith('/')) scope.pathname += '/';
        return scope;
    }

    // #1193: keys whose values are wall-clock timestamps rather than
    // measurements. `timestamp`/`date`/`time` are exact field names; the
    // suffix alternatives cover camelCase fields (createdAt, roastDate,
    // trashedAt, plannedSwitchOnAt...). `ts` is MaintenanceLogEntry's own
    // Unix-ms field, which the capitalised `Ts` suffix alone would miss, so
    // it is matched explicitly.
    const TIMESTAMP_KEY = /^(timestamp|date|time|ts)$|(At|Time|Date|Ts)$/;

    // Fixtures are recorded in this window (2017-07-14 .. 2096-10-02), which
    // is what lets a bare number be told apart from a duration/weight/count.
    const EPOCH_MS = [1_500_000_000_000, 4_000_000_000_000];
    const EPOCH_SECONDS = [1_500_000_000, 4_000_000_000];
    const MS_PER_DAY = 86_400_000;
    const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
    const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

    function shiftDateString(value, deltaMs) {
        if (DATE_ONLY.test(value)) {
            const parsed = Date.parse(`${value}T00:00:00.000Z`);
            if (Number.isNaN(parsed)) return value;
            const days = Math.round(deltaMs / MS_PER_DAY);
            return new Date(parsed + days * MS_PER_DAY).toISOString().slice(0, 10);
        }
        if (ISO_DATE_TIME.test(value)) {
            const parsed = Date.parse(value);
            if (Number.isNaN(parsed)) return value;
            return new Date(parsed + deltaMs).toISOString();
        }
        return value;
    }

    /** Shifts one scalar found under a timestamp-shaped key. */
    function shiftTimestampValue(value, deltaMs) {
        if (typeof value === 'number') {
            if (value >= EPOCH_MS[0] && value <= EPOCH_MS[1]) return value + deltaMs;
            if (value >= EPOCH_SECONDS[0] && value <= EPOCH_SECONDS[1]) return value + Math.round(deltaMs / 1000);
            return value;
        }
        if (typeof value === 'string') return shiftDateString(value, deltaMs);
        if (value && typeof value === 'object') return shiftNode(value, deltaMs);
        return value;
    }

    function shiftNode(value, deltaMs) {
        if (Array.isArray(value)) return value.map(item => shiftNode(item, deltaMs));
        if (value && typeof value === 'object') {
            const out = {};
            for (const [key, child] of Object.entries(value)) {
                out[key] = TIMESTAMP_KEY.test(key) ? shiftTimestampValue(child, deltaMs) : shiftNode(child, deltaMs);
            }
            return out;
        }
        return value;
    }

    /**
     * Returns a copy of parsed JSON with every wall-clock timestamp moved by
     * deltaMs, so a recording made weeks ago reads as if it were made now.
     * Only values under TIMESTAMP_KEY names are touched — ids, durations,
     * weights, scores and every other number pass through untouched. A
     * non-finite delta (a manifest with no usable `generated`) is a no-op.
     */
    function shiftTimestamps(value, deltaMs) {
        const delta = typeof deltaMs === 'number' && Number.isFinite(deltaMs) ? deltaMs : 0;
        return shiftNode(value, delta);
    }

    // The endpoints the app polls for machine state. The site is served from a
    // sub-path, so each matches on the pathname suffix.
    const STATUS_PATH = /(^|\/)api\/status$/;
    const LIVE_DATA_PATH = /(^|\/)api\/live\/data$/;
    const PREHEAT_PATH = /(^|\/)api\/preheat$/;

    // Stand-in firmware version for the reachable demo machine; only filled in
    // where the recorded status left it null (components/status.ts renders it
    // only once a machine hostname is known).
    const MACHINE_VERSION = 'v1.0.0';

    /**
     * Rewrites one recorded JSON body into the "online but idle" shape the app
     * expects, so the demo shows a reachable machine that is merely idle rather
     * than the unreachable one the recording captured. `nowMs` is the wall-clock
     * the response is being replayed at, used for the sync stamps below.
     *
     *   GET /api/status    — default machine reachable and switched off, last
     *                        sync/success moved to now, recorded probe/sync
     *                        errors cleared.
     *   GET /api/live/data — reachable-but-idle (#655) boiler numbers; the
     *                        recorded datapoints are left untouched.
     *   GET /api/preheat   — preheat finished, so the Live view shows "ready"
     *                        instead of a countdown the machine never ran.
     *
     * Any other pathname (or a non-object body) is returned untouched.
     */
    function patchMachineOnline(pathname, body, nowMs) {
        if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
        const path = String(pathname);

        if (STATUS_PATH.test(path)) {
            const next = {
                ...body,
                machineReachable: true,
                machineOn: false,
                machineOnSince: null,
                // Both sync stamps are epoch ms: lastMachineSuccess is documented
                // as Unix ms, and components/status.ts reads lastSync through
                // new Date(...), which takes the same epoch-ms number.
                lastSync: nowMs,
                lastMachineSuccess: nowMs,
            };
            if ('machineVersion' in next && !next.machineVersion) next.machineVersion = MACHINE_VERSION;
            if ('lastMachineError' in next) next.lastMachineError = null;
            if ('lastSyncError' in next) next.lastSyncError = null;
            if (Array.isArray(next.machines)) {
                next.machines = next.machines.map(machine => (
                    machine && typeof machine === 'object' && machine.isDefault
                        ? { ...machine, reachable: true, on: false }
                        : machine
                ));
            }
            return next;
        }

        if (LIVE_DATA_PATH.test(path)) {
            return {
                ...body,
                machineReachable: true,
                isLive: false,
                temperature: 93,
                targetTemperature: 93,
                pressure: 0,
            };
        }

        if (PREHEAT_PATH.test(path)) {
            const preheatTime = typeof body.preheatTime === 'number' ? body.preheatTime : 0;
            return { ...body, ready: true, remaining: 0, pct: 100, elapsed: preheatTime * 60, temp: 93, targetTemp: 93 };
        }

        return body;
    }

    /**
     * Classifies one request. The site is served from a sub-path, so paths are
     * taken relative to the scope before being rebuilt into a manifest key.
     *
     * Returns one of:
     *   { kind: 'passthrough' }           not ours — let the network handle it
     *   { kind: 'token' }                 GET api/token
     *   { kind: 'sse' }                   GET api/events
     *   { kind: 'fixture', entry }        GET with a recorded response
     *   { kind: 'write' }                 any non-GET/HEAD under api/
     *   { kind: 'missing', key }          GET with no recorded response
     */
    function route(method, requestUrl, scopeUrl, manifest) {
        const scope = scopeOf(scopeUrl);
        const url = new URL(requestUrl, scope.href);
        if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) {
            return { kind: 'passthrough' };
        }

        const relative = url.pathname.slice(scope.pathname.length);
        const isApi = relative.startsWith('api/');
        if (!isApi && relative !== 'shots.json') return { kind: 'passthrough' };

        const upper = String(method).toUpperCase();
        if (upper === 'GET' && relative === 'api/token') return { kind: 'token' };
        if (upper === 'GET' && relative === 'api/events') return { kind: 'sse' };
        if (upper !== 'GET' && upper !== 'HEAD') {
            // Writes under api/ are accepted and discarded a little further
            // down, in demo-sw.js; anything else is not ours to touch.
            return isApi ? { kind: 'write' } : { kind: 'passthrough' };
        }

        // Reads are only ever recorded as GET, so a HEAD request probes the
        // GET fixture rather than a "HEAD /..." key that cannot exist.
        const key = fixtureKey(upper === 'HEAD' ? 'GET' : upper, `/${relative}${url.search}`);
        const entry = manifest && manifest.entries ? manifest.entries[key] : undefined;
        return entry ? { kind: 'fixture', entry } : { kind: 'missing', key };
    }

    return { fixtureKey, route, shiftTimestamps, patchMachineOnline };
})();
