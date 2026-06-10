// Puffco BLE Controller — GitHub Pages app shell cache
// Keeps the static UI available and avoids stale assets by versioning the cache.

const CACHE_NAME = 'puffco-ble-shell-v2026-06-09-03';
// APP_SHELL keys must match the URLs the page actually requests. index.html
// uses cache-buster query strings (?v=11 for style.css, ?v=14 for the JS
// files); pre-caching the un-versioned paths leaves the runtime cache to
// discover those assets the hard way, which fails on a cold offline start.
// Sortable.min.js is required by app.js (drag/drop) and was previously not
// pre-cached at all — adding it here guarantees it ships with the shell.
const APP_SHELL = [
  './',
  './index.html',
  './style.css?v=11',
  './app.js?v=14',
  './ble-client.js?v=14',
  './Sortable.min.js?v=14',
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
