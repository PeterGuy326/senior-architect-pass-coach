const CACHE_NAME = "architect-pass-coach-pages-v14";
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

  const network = fetch(request).then((response) => {
    const cacheControl = String(response.headers.get("cache-control") || "").toLowerCase();
    const vary = String(response.headers.get("vary") || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const cacheable = response.status === 200
      && response.type !== "error"
      && response.type !== "opaque"
      && request.cache !== "no-store"
      && !request.headers.has("range")
      && !/(?:^|,)\s*no-store(?:\s*(?:,|$))/u.test(cacheControl)
      && !vary.includes("*");
    return { response, cacheCopy: cacheable ? response.clone() : null };
  });

  event.waitUntil(
    network
      .then(({ cacheCopy }) => (
        cacheCopy ? caches.open(CACHE_NAME).then((cache) => cache.put(request, cacheCopy)) : undefined
      ))
      .catch(() => undefined),
  );

  event.respondWith(
    network
      .then(({ response }) => response)
      .catch(async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        if (request.mode === "navigate") return caches.match("./index.html");
        throw new Error("OFFLINE_ASSET_UNAVAILABLE");
      }),
  );
});
