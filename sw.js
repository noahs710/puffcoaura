// Puffco BLE Controller — Service Worker
// Network-first caching strategy — always gets fresh files, updates cache.
// CACHE_NAME bump forces old clients to drop stale cache and re-fetch.
// APP_SHELL lists all assets with their exact version strings.

const CACHE_NAME = 'puffco-ble-shell-v2026-06-10-14';
const APP_SHELL = [
  './',
  './index.html',
  './style.css?v=18',
  './app.js?v=22',
  './swiper.min.js',
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

  // Network-first: try network, fall back to cache, update cache on success.
  event.respondWith(
    fetch(request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        return response;
      })
      .catch(() => caches.match(request))
  );
});
