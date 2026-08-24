const CACHE_NAME = "architect-pass-coach-pages-v21";
const CACHE_PREFIX = "architect-pass-coach-pages-";
const CORE_ASSETS = Object.freeze([
  "./",
  "./index.html",
  "./privacy.html",
  "./pair.html",
  "./assets/app.css",
  "./assets/engine-codex.svg",
  "./assets/engine-qoder.svg",
  "./src/app.mjs",
  "./src/chat-view.mjs",
  "./src/harness-actions.mjs",
  "./src/harness-action-router.mjs",
  "./src/dialog-interaction.mjs",
  "./src/local-agent-gate.mjs",
  "./src/harness.mjs",
  "./src/local-agent-client.mjs",
  "./src/pair.mjs",
  "./src/indexeddb-store.mjs",
  "./src/progress-rules.mjs",
  "./src/response-behavior.mjs",
  "./src/content-worker.mjs",
  "./src/github-content.mjs",
  "./src/objective-parser.mjs",
  "./data/curriculum.json",
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
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names
          .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
          .map((name) => caches.delete(name)),
      ))
      .then(() => self.clients.claim()),
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
    const cached = request.cache !== "no-store" ? await caches.match(request) : null;
    if (cached) {
      event.waitUntil(refresh());
      return cached;
    }
    const response = await refresh();
    if (response) return response;
    if (request.mode === "navigate") return caches.match("./index.html");
    throw new Error("OFFLINE_ASSET_UNAVAILABLE");
  })());
});
