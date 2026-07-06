// Installability-only service worker — deliberately no caching. GLP shows
// live shot data; a caching SW would risk serving stale readings offline.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => event.respondWith(fetch(event.request)));
