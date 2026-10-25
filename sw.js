// Offline support: serve the app from the cache, refresh the cache in the background.
// Bump CACHE on every release so old files are dropped.

const CACHE = 'medshelf-v8';
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

// Only the app's own files are handled here. Everything else, such as the demo
// video in docs/, goes straight to the network: videos stream in ranged pieces,
// which can't be cached.
const SHELL_PATHS = new Set(SHELL.map((p) => (p === './' ? '' : p)));

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || request.headers.has('range')) return;
  const path = url.pathname.slice(new URL(self.registration.scope).pathname.length);
  if (!SHELL_PATHS.has(path)) return;
  const fresh = fetch(request).then(async (response) => {
    if (response.status === 200) await (await caches.open(CACHE)).put(request, response.clone());
    return response;
  });
  event.waitUntil(fresh.catch(() => {}));
  event.respondWith(caches.match(request, { ignoreSearch: true }).then((cached) => cached ?? fresh));
});
