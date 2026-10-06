// Pure routing helpers for the static demo service worker (#1193).
//
// This is an ES module (#1270): demo-sw.ts imports it and the demo build
// bundles both into demo-dist/demo-sw.js, and test/demo-sw-core.test.ts
// imports it directly. It is type-checked under both the DOM and the WebWorker
// lib, so it uses only ES2022, URL and URLSearchParams.
//
// fixtureKey() is a deliberate copy of the recorder's (scripts/demo-fixtures.mts):
// the manifest keys it wrote are the exact strings looked up here, so the two
// implementations have to normalise identically. test/demo-sw-core.test.ts
// asserts they agree on a table of URLs.

/** One recorded response: the status, content type and fixture file to replay. */
export interface FixtureEntry {
    status: number;
    contentType: string;
    file: string;
}

/** The recorded fixtures index: manifest key -> fixture entry. */
export interface Manifest {
    entries: Record<string, FixtureEntry>;
    /** ISO timestamp of the recording, used to age-shift JSON fixtures. */
    generated?: string;
}

/** How one request should be answered; see route(). */
export type Route =
    | { kind: 'passthrough' }
    | { kind: 'token' }
    | { kind: 'sse' }
    | { kind: 'fixture'; entry: FixtureEntry }
    | { kind: 'write' }
    | { kind: 'missing'; key: string };

/** One live-snapshot payload pushed over api/events during a shot replay. */
export interface LiveFrame {
    isLive: boolean;
    machineReachable: boolean;
    profileName: string;
    datapoints: Record<string, unknown> | null;
    seq: number;
    temperature: number | null;
    targetTemperature: number | null;
    pressure: number | null;
}

export const GLPDemo = (() => {
    // Cache-buster query keys the SPA appends to force a fresh fetch; a static
    // snapshot keys by the real resource, so both are dropped. Kept in sync
    // with CACHE_BUSTER_PARAMS in scripts/demo-fixtures.mts.
    const CACHE_BUSTER_PARAMS = new Set(['t', '_']);

    /** True for a plain JSON object (not null, not an array). */
    function isJsonObject(value: unknown): value is Record<string, unknown> {
        return typeof value === 'object' && value !== null && !Array.isArray(value);
    }

    /**
     * Normalises a request into the manifest key `"<METHOD> <path>?<sorted query>"`.
     * Query params are sorted so ordering differences do not split one resource
     * across two fixtures, and the cache-buster params above are dropped.
     */
    function fixtureKey(method: string, urlString: string): string {
        const url = new URL(urlString, 'http://fixture.invalid');
        const params = [...url.searchParams.entries()]
            .filter(([name]) => !CACHE_BUSTER_PARAMS.has(name))
            .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1));
        const query = params.map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`).join('&');
        return `${method.toUpperCase()} ${url.pathname}${query ? `?${query}` : ''}`;
    }

    /** A scope always has a trailing slash, even if the caller passed it bare. */
    function scopeOf(scopeUrl: string): URL {
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
    const EPOCH_MS = [1_500_000_000_000, 4_000_000_000_000] as const;
    const EPOCH_SECONDS = [1_500_000_000, 4_000_000_000] as const;
    const MS_PER_DAY = 86_400_000;
    const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
    const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

    function shiftDateString(value: string, deltaMs: number): string {
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
    function shiftTimestampValue(value: unknown, deltaMs: number): unknown {
        if (typeof value === 'number') {
            if (value >= EPOCH_MS[0] && value <= EPOCH_MS[1]) return value + deltaMs;
            if (value >= EPOCH_SECONDS[0] && value <= EPOCH_SECONDS[1]) return value + Math.round(deltaMs / 1000);
            return value;
        }
        if (typeof value === 'string') return shiftDateString(value, deltaMs);
        if (typeof value === 'object' && value !== null) return shiftNode(value, deltaMs);
        return value;
    }

    function shiftNode(value: unknown, deltaMs: number): unknown {
        if (Array.isArray(value)) return (value as unknown[]).map(item => shiftNode(item, deltaMs));
        if (isJsonObject(value)) {
            const out: Record<string, unknown> = {};
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
    function shiftTimestamps(value: unknown, deltaMs: number): unknown {
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
    function patchMachineOnline(pathname: string, body: unknown, nowMs: number): unknown {
        if (!isJsonObject(body)) return body;
        const path = String(pathname);

        if (STATUS_PATH.test(path)) {
            const next: Record<string, unknown> = {
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
                next.machines = (next.machines as unknown[]).map(machine => (
                    isJsonObject(machine) && machine.isDefault
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
            // pct is a 0..1 fraction (go/internal/system/preheat.go caps it at 1;
            // the frontend multiplies by 100 where it renders a percentage).
            return { ...body, ready: true, remaining: 0, pct: 1, elapsed: preheatTime * 60, temp: 93, targetTemp: 93 };
        }

        return body;
    }

    // ── Shot simulation (#1193 S3c) ──────────────────────────────────────────
    //
    // A recorded shot's detail fixture stores the finished shot's cumulative
    // datapoint arrays: timeInShot in tenths of a second, every other series in
    // the 0.1 units the charts divide by 10. Replaying one through the SSE
    // stream is exactly what a real brew looks like on GET /api/live/data / the
    // live-snapshot event (go/internal/system/poll.go LiveData): isLive true,
    // the datapoints accumulated SO FAR, an unchanged seq until the brew ends,
    // plus the idle-stat sensor fields.

    /**
     * One live-snapshot payload for a shot replayed up to `elapsedTenths`.
     * Every datapoint array is truncated to the samples whose timeInShot has
     * been reached — the arrays are parallel, so one cut applies to all.
     * temperature/targetTemperature/pressure carry the newest sample in real
     * units (the /10 the frontend charts apply), matching the idle-stat fields
     * the online patch (S3b2) sets; `seq` is passed through untouched.
     */
    function liveFrame(shot: unknown, elapsedTenths: number, seq: number): LiveFrame {
        const source = isJsonObject(shot) && isJsonObject(shot.datapoints) ? shot.datapoints : {};
        const times = Array.isArray(source.timeInShot) ? (source.timeInShot as unknown[]) : [];
        let count = 0;
        while (count < times.length) {
            const sample = times[count];
            if (typeof sample !== 'number' || sample > elapsedTenths) break;
            count += 1;
        }

        const datapoints: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(source)) {
            datapoints[key] = Array.isArray(value) ? (value as unknown[]).slice(0, count) : value;
        }

        const last = count - 1;
        const lastTenth = (key: string): number | null => {
            const series = datapoints[key];
            if (last < 0 || !Array.isArray(series)) return null;
            const value = (series as unknown[])[last];
            return typeof value === 'number' ? value / 10 : null;
        };
        return {
            isLive: true,
            machineReachable: true,
            profileName: isJsonObject(shot) && typeof shot.profileName === 'string' ? shot.profileName : '',
            datapoints,
            seq,
            temperature: lastTenth('temperature'),
            targetTemperature: lastTenth('targetTemperature'),
            pressure: lastTenth('pressure'),
        };
    }

    /**
     * The idle live-snapshot that ends a replay: the brew finished, so isLive
     * is false and the datapoints are gone — the same reachable-but-idle state
     * the online patch (S3b2) reports. `seq` is the incremented value the app
     * keys its post-brew shot reload off; 93 °C / 0 bar is what that patch also
     * reports for a reachable idle machine.
     */
    function idleFrame(seq: number): LiveFrame {
        return {
            isLive: false,
            machineReachable: true,
            profileName: '',
            datapoints: null,
            seq,
            temperature: 93,
            targetTemperature: 93,
            pressure: 0,
        };
    }

    /**
     * Manifest key of the recorded `GET /api/shots` first page — the live,
     * newest-first list the simulation takes the newest shot id from. Detail
     * reads (`GET /api/shots/{id}`, no `?`) and the trash/paged variants are
     * skipped so the plain newest-first page wins.
     */
    function shotsListKey(manifest: Manifest): string | null {
        const entries = manifest.entries;
        for (const key of Object.keys(entries)) {
            if (!key.startsWith('GET /api/shots?')) continue;
            const query = key.slice('GET /api/shots?'.length);
            if (query.includes('trash=1') || query.includes('cursor=')) continue;
            return key;
        }
        return null;
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
    function route(method: string, requestUrl: string, scopeUrl: string, manifest: Manifest): Route {
        const scope = scopeOf(scopeUrl);
        const url = new URL(requestUrl, scope.href);
        if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) {
            return { kind: 'passthrough' };
        }

        const relative = url.pathname.slice(scope.pathname.length);
        const isApi = relative.startsWith('api/');
        if (!isApi && relative !== 'shots.json') return { kind: 'passthrough' };

        const upper = method.toUpperCase();
        if (upper === 'GET' && relative === 'api/token') return { kind: 'token' };
        if (upper === 'GET' && relative === 'api/events') return { kind: 'sse' };
        if (upper !== 'GET' && upper !== 'HEAD') {
            // Writes under api/ are accepted and discarded a little further
            // down, in demo-sw.ts; anything else is not ours to touch.
            return isApi ? { kind: 'write' } : { kind: 'passthrough' };
        }

        // Reads are only ever recorded as GET, so a HEAD request probes the
        // GET fixture rather than a "HEAD /..." key that cannot exist.
        const key = fixtureKey(upper === 'HEAD' ? 'GET' : upper, `/${relative}${url.search}`);
        const entry = manifest.entries[key];
        return entry ? { kind: 'fixture', entry } : { kind: 'missing', key };
    }

    return { fixtureKey, route, shiftTimestamps, patchMachineOnline, liveFrame, idleFrame, shotsListKey };
})();
