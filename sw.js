// Puffco BLE Controller — Service Worker
// Dev PWA: no offline caching — all requests go to network directly.
// This guarantees zero stale-JS / blank-screen issues during development.
// Activate event clears all old caches on every update.

const CACHE_NAME = 'puffco-ble-shell-v2026-06-10-11';

self.addEventListener('install', (event) => {
  // No pre-cache needed — all fetches go to network
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  // Clear all old caches on activate
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

// Dev shortcut: no caching at all — always serve from network.
// This guarantees no stale JS/CSS is ever served during development.
self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(fetch(request));
});
