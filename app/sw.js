// Service worker: precache the whole app so it works offline.
// Strategy: stale-while-revalidate — serve from cache instantly, refresh the cache in the
// background, so edits show up on the next launch. Bump VERSION to force a clean re-cache
// (e.g. after adding or removing files).

const VERSION = 'v4.50';
const CACHE = `practice-room-${VERSION}`;

const FILES = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
  'metronome/index.html',
  'metronome/style.css',
  'metronome/app.js',
  'metronome/sounds/machine/low.wav',
  'metronome/sounds/machine/high.wav',
  'metronome/sounds/bass-snare/low.wav',
  'metronome/sounds/bass-snare/high.wav',
  'metronome/sounds/darabuka/low.wav',
  'metronome/sounds/darabuka/high.wav',
  'metronome/sounds/tapan/low.wav',
  'metronome/sounds/tapan/high.wav',
  'metronome/sounds/pier/pier_PAN.wav',
  'metronome/sounds/pier/pier_TA.wav',
  'drone/index.html',
  'drone/style.css',
  'drone/app.js',
  'player/index.html',
  'player/style.css',
  'player/app.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('practice-room-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req, { ignoreSearch: true });
    const network = fetch(req)
      .then((res) => {
        if (res.ok) cache.put(req, res.clone());
        return res;
      })
      .catch(() => null);

    if (cached) {
      e.waitUntil(network);   // refresh in the background
      return cached;
    }
    return (await network) || new Response('Offline', { status: 503, statusText: 'Offline' });
  })());
});
