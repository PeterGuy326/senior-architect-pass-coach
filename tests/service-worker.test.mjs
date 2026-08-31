import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function loadServiceWorker({
  fetchImpl,
  cacheAddAll = async () => {},
  cachePut = async () => {},
  cacheMatch = async () => null,
  cacheNames = [],
  onCacheDelete = () => {},
  onCacheOpen = () => {},
  windowClients = [],
} = {}) {
  const listeners = new Map();
  const source = await readFile(new URL("../docs/sw.js", import.meta.url), "utf8");
  const cache = { addAll: cacheAddAll, put: cachePut };
  const context = vm.createContext({
    URL,
    Request,
    Response,
    fetch: fetchImpl,
    caches: {
      open: async (name) => {
        onCacheOpen(name);
        return cache;
      },
      match: cacheMatch,
      keys: async () => [...cacheNames],
      delete: async (name) => { onCacheDelete(name); return true; },
    },
    self: {
      location: { origin: "https://peterguy326.github.io" },
      registration: { scope: "https://peterguy326.github.io/senior-architect-pass-coach/" },
      addEventListener(type, listener) { listeners.set(type, listener); },
      skipWaiting: async () => {},
      clients: {
        claim: async () => {},
        matchAll: async () => [...windowClients],
      },
    },
  });
  vm.runInContext(source, context, { filename: "docs/sw.js" });
  return listeners;
}

test("Service Worker v22 precaches only the Agent-first landing assets", async () => {
  const opened = [];
  let coreAssets = [];
  const listeners = await loadServiceWorker({
    onCacheOpen: (name) => opened.push(name),
    cacheAddAll: async (assets) => { coreAssets = [...assets]; },
  });
  const lifetime = [];
  listeners.get("install")({
    waitUntil(value) { lifetime.push(Promise.resolve(value)); },
  });
  await Promise.all(lifetime);

  assert.deepEqual(opened, ["architect-pass-coach-pages-v22"]);
  assert.ok(coreAssets.includes("./src/landing.mjs"));
  assert.ok(coreAssets.includes("./assets/landing.css"));
  assert.ok(!coreAssets.includes("./src/app.mjs"));
  assert.ok(!coreAssets.includes("./pair.html"));
  assert.ok(!coreAssets.includes("./privacy.html"));
  assert.ok(coreAssets.includes("./index.html"));
});

function dispatchFetch(listener, request) {
  let responsePromise = null;
  const lifetime = [];
  listener({
    request,
    respondWith(value) { responsePromise = Promise.resolve(value); },
    waitUntil(value) { lifetime.push(Promise.resolve(value)); },
  });
  return { responsePromise, lifetime };
}

test("Service Worker serves the cached copy immediately and revalidates in the background", async () => {
  const cached = new Response("cached", { status: 200 });
  let resolveNetwork;
  const networkGate = new Promise((resolve) => { resolveNetwork = resolve; });
  let puts = 0;
  const listeners = await loadServiceWorker({
    fetchImpl: async () => { await networkGate; return new Response("fresh", { status: 200 }); },
    cacheMatch: (request) => (String(request.url).endsWith("/src/landing.mjs") ? cached : null),
    cachePut: async () => { puts += 1; },
  });
  const event = dispatchFetch(
    listeners.get("fetch"),
    new Request("https://peterguy326.github.io/senior-architect-pass-coach/src/landing.mjs"),
  );
  assert.equal(await (await event.responsePromise).text(), "cached");
  resolveNetwork();
  await Promise.all(event.lifetime);
  assert.equal(puts, 1);
});

test("Service Worker navigation is network-first even when an old shell is cached", async () => {
  let cacheReads = 0;
  const listeners = await loadServiceWorker({
    fetchImpl: async () => new Response("fresh landing", { status: 200 }),
    cacheMatch: async () => {
      cacheReads += 1;
      return new Response("stale Runtime shell", { status: 200 });
    },
  });
  const request = {
    method: "GET",
    url: "https://peterguy326.github.io/senior-architect-pass-coach/",
    mode: "navigate",
    cache: "default",
    headers: new Headers(),
  };
  const event = dispatchFetch(listeners.get("fetch"), request);
  assert.equal(await (await event.responsePromise).text(), "fresh landing");
  await Promise.all(event.lifetime);
  assert.equal(cacheReads, 0);
});

test("Service Worker activation deletes only older caches owned by this Page", async () => {
  const deleted = [];
  const listeners = await loadServiceWorker({
    cacheNames: [
      "architect-pass-coach-pages-v22",
      "architect-pass-coach-pages-v18",
      "other-github-pages-project-v9",
    ],
    onCacheDelete: (name) => deleted.push(name),
  });
  const lifetime = [];
  listeners.get("activate")({
    waitUntil(value) { lifetime.push(Promise.resolve(value)); },
  });
  await Promise.all(lifetime);

  assert.deepEqual(deleted, ["architect-pass-coach-pages-v18"]);
});

test("Service Worker reloads old controlled windows once after the v21 migration", async () => {
  const navigations = [];
  const listeners = await loadServiceWorker({
    cacheNames: ["architect-pass-coach-pages-v21", "architect-pass-coach-pages-v22"],
    windowClients: [
      {
        url: "https://peterguy326.github.io/senior-architect-pass-coach/today",
        navigate: async (url) => { navigations.push(["coach", url]); },
      },
      {
        url: "https://peterguy326.github.io/another-project/",
        navigate: async (url) => { navigations.push(["other", url]); },
      },
    ],
  });
  const lifetime = [];
  listeners.get("activate")({
    waitUntil(value) { lifetime.push(Promise.resolve(value)); },
  });
  await Promise.all(lifetime);

  assert.deepEqual(navigations, [[
    "coach",
    "https://peterguy326.github.io/senior-architect-pass-coach/",
  ]]);
});

test("Service Worker does not reload current v22 windows on a normal activation", async () => {
  let navigations = 0;
  const listeners = await loadServiceWorker({
    cacheNames: ["architect-pass-coach-pages-v22"],
    windowClients: [{ navigate: async () => { navigations += 1; } }],
  });
  const lifetime = [];
  listeners.get("activate")({
    waitUntil(value) { lifetime.push(Promise.resolve(value)); },
  });
  await Promise.all(lifetime);

  assert.equal(navigations, 0);
});

test("Service Worker cache write failures never replace a successful network response", async () => {
  const networkResponse = new Response("fresh", { status: 200 });
  const listeners = await loadServiceWorker({
    fetchImpl: async () => networkResponse,
    cachePut: async () => { throw new DOMException("Cache.put network error", "NetworkError"); },
  });
  const event = dispatchFetch(
    listeners.get("fetch"),
    new Request("https://peterguy326.github.io/senior-architect-pass-coach/src/landing.mjs"),
  );
  assert.equal(await (await event.responsePromise).text(), "fresh");
  await assert.doesNotReject(Promise.all(event.lifetime));
});

test("Service Worker skips Range, 206, request/response no-store and Vary-star responses", async (t) => {
  const cases = [
    ["Range request", new Request("https://peterguy326.github.io/file", { headers: { Range: "bytes=0-9" } }), new Response("part", { status: 200 })],
    ["206 response", new Request("https://peterguy326.github.io/file"), new Response("part", { status: 206 })],
    ["no-store request", new Request("https://peterguy326.github.io/file", { cache: "no-store" }), new Response("body", { status: 200 })],
    ["no-store response", new Request("https://peterguy326.github.io/file"), new Response("body", { status: 200, headers: { "Cache-Control": "private, no-store" } })],
    ["Vary star response", new Request("https://peterguy326.github.io/file"), new Response("body", { status: 200, headers: { Vary: "*" } })],
  ];
  for (const [name, request, response] of cases) {
    await t.test(name, async () => {
      let puts = 0;
      const listeners = await loadServiceWorker({
        fetchImpl: async () => response,
        cachePut: async () => { puts += 1; },
      });
      const event = dispatchFetch(listeners.get("fetch"), request);
      await event.responsePromise;
      await Promise.all(event.lifetime);
      assert.equal(puts, 0);
    });
  }
});

test("Service Worker never intercepts loopback Agent POSTs or cross-origin GETs", async () => {
  let fetches = 0;
  const listeners = await loadServiceWorker({
    fetchImpl: async () => { fetches += 1; return new Response("unexpected"); },
  });
  const post = dispatchFetch(
    listeners.get("fetch"),
    new Request("http://127.0.0.1:43127/v1/coach", { method: "POST" }),
  );
  const get = dispatchFetch(
    listeners.get("fetch"),
    new Request("http://127.0.0.1:43127/v1/health"),
  );
  assert.equal(post.responsePromise, null);
  assert.equal(get.responsePromise, null);
  assert.equal(fetches, 0);
});

test("Service Worker serves an exact cached response when the network is offline", async () => {
  const cached = new Response("cached asset", { status: 200 });
  const listeners = await loadServiceWorker({
    fetchImpl: async () => { throw new TypeError("offline"); },
    cacheMatch: async (request) => (
      typeof request !== "string" && request.url.endsWith("/src/landing.mjs") ? cached : null
    ),
  });
  const event = dispatchFetch(
    listeners.get("fetch"),
    new Request("https://peterguy326.github.io/senior-architect-pass-coach/src/landing.mjs"),
  );
  assert.equal(await (await event.responsePromise).text(), "cached asset");
  await assert.doesNotReject(Promise.all(event.lifetime));
});

test("Service Worker falls back to the cached shell for an offline navigation", async () => {
  const shell = new Response("cached shell", { status: 200 });
  const listeners = await loadServiceWorker({
    fetchImpl: async () => { throw new TypeError("offline"); },
    cacheMatch: async (request) => (request === "./index.html" ? shell : null),
  });
  const request = {
    method: "GET",
    url: "https://peterguy326.github.io/senior-architect-pass-coach/today",
    mode: "navigate",
    cache: "default",
    headers: new Headers(),
  };
  const event = dispatchFetch(listeners.get("fetch"), request);
  assert.equal(await (await event.responsePromise).text(), "cached shell");
  await assert.doesNotReject(Promise.all(event.lifetime));
});

test("Service Worker reports a stable error for an offline uncached asset", async () => {
  const listeners = await loadServiceWorker({
    fetchImpl: async () => { throw new TypeError("private network detail"); },
    cacheMatch: async () => null,
  });
  const event = dispatchFetch(
    listeners.get("fetch"),
    new Request("https://peterguy326.github.io/senior-architect-pass-coach/missing.mjs"),
  );
  await assert.rejects(event.responsePromise, /OFFLINE_ASSET_UNAVAILABLE/u);
  await assert.doesNotReject(Promise.all(event.lifetime));
});
