/* QuakeAlert service worker — app shell cache + notification click handling */
const CACHE = "quakealert-v3";
const SHELL = [
  "./",
  "./index.html",
  "./app.css",
  "./app.js",
  "./manifest.webmanifest",
  "./vendor/leaflet.js",
  "./vendor/leaflet.css",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // live data: network only, never cache
  if (url.hostname.includes("earthquake.usgs.gov") || url.hostname.includes("seismicportal.eu")) return;
  // map tiles: network first, fall back to cache
  if (url.hostname.includes("cartocdn.com") || url.hostname.includes("tile.openstreetmap.org") ||
      url.hostname.includes("arcgisonline.com") || url.hostname.includes("opentopomap.org")) {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE + "-tiles").then((c) => c.put(e.request, copy));
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }
  // app shell: network first so updates always reach users; cache fallback offline.
  // "no-cache" forces revalidation with the server (fast 304s) — otherwise the
  // browser HTTP cache can serve a stale shell for up to its max-age window
  if (e.request.method === "GET" && url.origin === location.origin) {
    e.respondWith(
      fetch(e.request.url, { cache: "no-cache" })
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
          return res;
        })
        .catch(() => caches.match(e.request))
    );
  }
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const id = e.notification.data?.id;
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ("focus" in client) {
          client.focus();
          if (id) client.postMessage({ type: "open-event", id });
          return;
        }
      }
      return self.clients.openWindow(id ? "./#ev=" + encodeURIComponent(id) : "./");
    })
  );
});
