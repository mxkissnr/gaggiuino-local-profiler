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

    /**
     * Classifies one request. The site is served from a sub-path, so paths are
     * taken relative to the scope before being rebuilt into a manifest key.
     *
     * Returns one of:
     *   { kind: 'passthrough' }           not ours — let the network handle it
     *   { kind: 'token' }                 GET api/token
     *   { kind: 'sse' }                   GET api/events
     *   { kind: 'fixture', entry }        GET with a recorded response
     *   { kind: 'readonly' }              any non-GET/HEAD under api/
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
            // Writes are refused under api/; anything else is not ours to touch.
            return isApi ? { kind: 'readonly' } : { kind: 'passthrough' };
        }

        const key = fixtureKey(upper, `/${relative}${url.search}`);
        const entry = manifest && manifest.entries ? manifest.entries[key] : undefined;
        return entry ? { kind: 'fixture', entry } : { kind: 'missing', key };
    }

    return { fixtureKey, route };
})();
