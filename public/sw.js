'use strict';
// Claude Deck service worker. Its only job: when the local server isn't running, show a page
// that says so (instead of a browser error) when the installed app is opened.
// Nothing else is cached; the dashboard always talks to the live server.

const CACHE = 'claude-deck-offline-v3';
const OFFLINE = '/offline.html';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll([OFFLINE, '/icons/icon-192.png'])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(() => caches.match(OFFLINE)));
  } else if (event.request.method === 'GET' && new URL(event.request.url).pathname.startsWith('/icons/')) {
    // The offline page's icon, when the server is down.
    event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
  }
});
