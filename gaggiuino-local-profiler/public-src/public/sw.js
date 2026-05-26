const CACHE = 'glp-shell-v1';

// Assets to pre-cache on install
const SHELL = [
    './',
    './manifest.json',
    './icon.png',
    'https://fonts.bunny.net/css?family=figtree:400,600&display=swap',
    'https://cdn.jsdelivr.net/npm/chart.js',
    'https://cdn.jsdelivr.net/npm/qrcode@1.5.4/build/qrcode.min.js',
];

self.addEventListener('install', e => {
    e.waitUntil(
        caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', e => {
    e.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', e => {
    const url = new URL(e.request.url);

    // Never intercept API calls — always go to network
    if (url.pathname.includes('/api/') || url.pathname.endsWith('/shots.json')) {
        return;
    }

    // Open Food Facts lookup — network only
    if (url.hostname === 'world.openfoodfacts.org') {
        return;
    }

    // CDN and app shell — cache first, fallback to network
    e.respondWith(
        caches.match(e.request).then(cached => {
            if (cached) return cached;
            return fetch(e.request).then(response => {
                if (response.ok) {
                    const clone = response.clone();
                    caches.open(CACHE).then(c => c.put(e.request, clone));
                }
                return response;
            });
        })
    );
});
