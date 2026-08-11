const CACHE_NAME = "architect-pass-coach-pages-v8";
const CORE_ASSETS = Object.freeze([
  "./",
  "./index.html",
  "./privacy.html",
  "./pair.html",
  "./assets/app.css",
  "./src/app.mjs",
  "./src/chat-view.mjs",
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
        names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name)),
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

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        if (request.mode === "navigate") return caches.match("./index.html");
        throw new Error("OFFLINE_ASSET_UNAVAILABLE");
      }),
  );
});
