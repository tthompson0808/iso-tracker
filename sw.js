const CACHE = "iso-tracker-6";
const ASSETS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./css/app.css",
  "./js/app.js",
  "./js/audio.js",
  "./js/chart.js",
  "./js/db.js",
  "./js/engine.js",
  "./js/io.js",
  "./js/lock.js",
  "./js/plan.js",
  "./js/progress.js",
  "./js/time.js",
  "./fonts/oswald-700.woff2",
  "./fonts/outfit-400.woff2",
  "./fonts/outfit-600.woff2",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

function isCode(url) {
  return /\.(html|js|css|webmanifest)$/.test(url.pathname);
}

function putIfOk(request, response) {
  if (!response || !response.ok) return response;
  const copy = response.clone();
  caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
  return response;
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || event.request.method !== "GET") return;
  if (event.request.mode === "navigate" || isCode(url)) {
    const fallback = event.request.mode === "navigate" ? "./index.html" : event.request;
    event.respondWith(
      fetch(event.request)
        .then((res) => putIfOk(event.request.mode === "navigate" ? "./index.html" : event.request, res))
        .catch(() => caches.match(fallback)),
    );
    return;
  }
  event.respondWith(
    caches.match(event.request).then((hit) => hit || fetch(event.request).then((res) => putIfOk(event.request, res))),
  );
});
