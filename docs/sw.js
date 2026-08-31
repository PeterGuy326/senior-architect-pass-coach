const CACHE_NAME = "architect-pass-coach-pages-v22";
const CACHE_PREFIX = "architect-pass-coach-pages-";
const CORE_ASSETS = Object.freeze([
  "./",
  "./index.html",
  "./assets/landing.css",
  "./src/landing.mjs",
  "./manifest.webmanifest",
]);

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(CORE_ASSETS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  let foundLegacyCache = false;
  event.waitUntil(
    caches.keys()
      .then((names) => {
        const legacyNames = names
          .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME);
        foundLegacyCache = legacyNames.length > 0;
        return Promise.all(legacyNames.map((name) => caches.delete(name)));
      })
      .then(() => self.clients.claim())
      .then(() => (foundLegacyCache
        ? self.clients.matchAll({ type: "window" })
        : []))
      .then((clients) => clients.filter((client) => {
        try {
          return new URL(client.url).href.startsWith(self.registration.scope);
        } catch {
          return false;
        }
      }))
      .then((clients) => Promise.all(clients.map(async (client) => {
        try {
          await client.navigate(self.registration.scope);
        } catch { /* the window may close during activation */ }
      }))),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/v1/")) return;

  const isCacheable = (response) => {
    const cacheControl = String(response.headers.get("cache-control") || "").toLowerCase();
    const vary = String(response.headers.get("vary") || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    return response.status === 200
      && response.type !== "error"
      && response.type !== "opaque"
      && request.cache !== "no-store"
      && !request.headers.has("range")
      && !/(?:^|,)\s*no-store(?:\s*(?:,|$))/u.test(cacheControl)
      && !vary.includes("*");
  };

  const refresh = async () => {
    try {
      const response = await fetch(request);
      if (isCacheable(response)) {
        // A failed cache write must never mask a good network response.
        try {
          const cache = await caches.open(CACHE_NAME);
          await cache.put(request, response.clone());
        } catch { /* ignore */ }
      }
      return response;
    } catch {
      return null;
    }
  };

  event.respondWith((async () => {
    if (request.mode === "navigate") {
      const response = await refresh();
      if (response) return response;
      return caches.match("./index.html");
    }
    const cached = request.cache !== "no-store" ? await caches.match(request) : null;
    if (cached) {
      event.waitUntil(refresh());
      return cached;
    }
    const response = await refresh();
    if (response) return response;
    throw new Error("OFFLINE_ASSET_UNAVAILABLE");
  })());
});
