const CACHE = 'liferpg-20261026-update-v1';
const ASSETS = [
  './', './index.html', './app.css', './app.mjs',
  './modules/state.mjs', './modules/sync.mjs',
  './modules/study.mjs', './modules/study-view.mjs',
  './modules/audio.mjs', './modules/calendar.mjs', './manifest.webmanifest',
  './icon-180.png', './icon-192.png', './icon-512.png'
];
const SCOPE = new URL(self.registration.scope);
const STATIC_URLS = new Set(ASSETS.map(path => new URL(path, SCOPE).href));

// Fetch every asset with cache:'reload' instead of cache.addAll: GitHub Pages
// serves files with max-age=600, and addAll would happily copy a 10-minute-old
// index.html into the brand new cache. That is exactly the "I updated but still
// see the old version" bug.
self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const responses = await Promise.all(ASSETS.map(async (path) => {
      const response = await fetch(path, { cache: 'reload' });
      if (!response.ok) throw new Error('Missing required app resource: ' + path);
      return response;
    }));
    const cache = await caches.open(CACHE);
    await Promise.all(ASSETS.map((path, index) => cache.put(new URL(path, SCOPE).href, responses[index])));
    // A first installation activates normally. Updates wait for the user's
    // explicit refresh action, keeping the running page and its modules together.
  })());
});

self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') e.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k.startsWith('liferpg-') && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== SCOPE.origin || !url.pathname.startsWith(SCOPE.pathname)) return;

  if (e.request.mode === 'navigate') {
    e.respondWith((async () => {
      // The app shell and its unversioned modules must come from the same release.
      // A waiting worker offers the new release through the app's update action.
      if (url.pathname === SCOPE.pathname || url.pathname === new URL('./index.html', SCOPE).pathname) {
        const current = await caches.open(CACHE);
        const shell = await current.match(new URL('./index.html', SCOPE).href);
        if (shell) return shell;
      }
      return fetch(e.request).catch(async () => {
      const cache = await caches.open(CACHE);
      const index = await cache.match(new URL('./index.html', SCOPE).href);
      if (index) return index;
      throw new Error('App is unavailable offline');
      });
    })());
    return;
  }

  url.search = ''; url.hash = '';
  if (!STATIC_URLS.has(url.href)) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(url.href);
    if (hit) return hit;
    const response = await fetch(e.request);
    if (response.ok && !response.redirected && (response.type === 'basic' || response.type === 'default')) {
      e.waitUntil(cache.put(url.href, response.clone()).catch(() => {}));
    }
    return response;
  })());
});
