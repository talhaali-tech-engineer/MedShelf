// Offline support: serve the app from the cache, refresh the cache in the background.
// Bump CACHE on every release so old files are dropped.

const CACHE = 'medshelf-v2';
const SHELL = [
  './',
  'index.html',
  'css/styles.css',
  'js/app.js',
  'js/ai.js',
  'js/chart.js',
  'js/core.js',
  'js/db.js',
  'js/icons.js',
  'js/sample.js',
  'js/ui.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  const fresh = fetch(request).then(async (response) => {
    if (response.ok) await (await caches.open(CACHE)).put(request, response.clone());
    return response;
  });
  event.waitUntil(fresh.catch(() => {}));
  event.respondWith(caches.match(request, { ignoreSearch: true }).then((cached) => cached ?? fresh));
});
