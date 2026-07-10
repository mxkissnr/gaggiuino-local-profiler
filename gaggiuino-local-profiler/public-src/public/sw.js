// App-shell service worker for the installable PWA (v1.112.0).
//
// This file is only ever registered by pages served OUTSIDE HA Ingress —
// server.js only injects the <link rel="manifest"> (which main.js checks
// for before calling register()) for non-Ingress requests. The HA Companion
// App's embedded WebView loads GLP through Ingress and therefore never sees
// this script run. That's a deliberate structural fix: the previous
// installable-PWA attempt (v1.102.0) registered its service worker
// unconditionally and broke the Companion App's live shot graph, most
// likely because its fetch handler intercepted every request — including
// the plain `fetch()` polling `/api/system/status` every second for the
// live view. See CHANGELOG "Reverted the v1.102.0 installable-PWA service
// worker".
//
// Caching strategy: network-first with cache fallback, and ONLY for the
// app shell (this document + built /assets/ bundles) — never for anything
// under /api/. Network-first (not cache-first) means app updates always
// win when the network is reachable; the cache only kicks in offline or on
// a flaky connection. Fonts/CDN scripts are intentionally left uncached —
// they're cross-origin and already required online for Chart.js/ECharts.

const SHELL_CACHE = 'glp-shell-v1';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys.filter(k => k !== SHELL_CACHE).map(k => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const { request } = event;
    if (request.method !== 'GET') return;

    const url = new URL(request.url);

    // Never intercept API calls — this is the single most important line in
    // this file. The live-shot status poll and every other /api/ call must
    // always go straight to the network, unmediated.
    if (url.pathname.startsWith('/api/')) return;

    // Only shell-cache same-origin document navigations and built bundles.
    const isShellAsset = url.origin === self.location.origin &&
        (request.mode === 'navigate' || url.pathname === '/' || url.pathname === '/index.html' ||
         url.pathname.startsWith('/assets/'));
    if (!isShellAsset) return;

    event.respondWith(
        fetch(request)
            .then(res => {
                const copy = res.clone();
                caches.open(SHELL_CACHE).then(c => c.put(request, copy));
                return res;
            })
            .catch(() => caches.match(request))
    );
});
