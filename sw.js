// Puffco BLE Controller — GitHub Pages app shell cache
// Keeps the static UI available and avoids stale assets by versioning the cache.

const CACHE_NAME = 'puffco-ble-shell-v2026-06-10-04';
// APP_SHELL keys must match the URLs the page actually requests. index.html
// uses cache-buster query strings (?v=15 for all assets); pre-caching the
// un-versioned paths leaves the runtime cache to
// discover those assets the hard way, which fails on a cold offline start.
// style.css (v=13 -> v=14) and app.js (v=16 -> v=17) were bumped for the
// mobile swipeable views with bottom tab bar. The CACHE_NAME bump forces
// clients on the old shell to drop their cache and re-fetch everything.
const APP_SHELL = [
  './',
  './index.html',
  './style.css?v=14',
  './app.js?v=17',
  './ble-client.js?v=15',
  './Sortable.min.js?v=15',
  './manifest.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put('./index.html', copy));
          return response;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  event.respondWith(
    caches.match(request)
      .then((cached) => cached || fetch(request).then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        return response;
      }))
  );
});
