// Offline cache for the app shell: after the first visit the app opens in the
// field without internet. Bump VERSION when files change.
const VERSION = "det-0.1.0";
const FILES = ["./", "index.html", "css/app.css", "js/app.js", "js/link.js", "js/proto.js", "js/waterfall.js",
  "js/detect.js", "js/video.js", "js/hunt.js", "js/demo.js", "vendor/web-serial-polyfill.js",
  "manifest.webmanifest", "icons/icon.svg", "icons/icon-192.png", "icons/icon-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
// Network first (fresh files when online), cache when offline.
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  e.respondWith(fetch(e.request).then(r => {
    const copy = r.clone();
    caches.open(VERSION).then(c => c.put(e.request, copy));
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
