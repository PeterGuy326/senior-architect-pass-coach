import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function loadServiceWorker({ fetchImpl, cachePut = async () => {}, cacheMatch = async () => null } = {}) {
  const listeners = new Map();
  const source = await readFile(new URL("../docs/sw.js", import.meta.url), "utf8");
  const cache = { addAll: async () => {}, put: cachePut };
  const context = vm.createContext({
    URL,
    Request,
    Response,
    fetch: fetchImpl,
    caches: {
      open: async () => cache,
      match: cacheMatch,
      keys: async () => [],
      delete: async () => true,
    },
    self: {
      location: { origin: "https://peterguy326.github.io" },
      addEventListener(type, listener) { listeners.set(type, listener); },
      skipWaiting: async () => {},
      clients: { claim: async () => {} },
    },
  });
  vm.runInContext(source, context, { filename: "docs/sw.js" });
  return listeners;
}

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

test("Service Worker cache write failures never replace a successful network response", async () => {
  const networkResponse = new Response("fresh", { status: 200 });
  const listeners = await loadServiceWorker({
    fetchImpl: async () => networkResponse,
    cachePut: async () => { throw new DOMException("Cache.put network error", "NetworkError"); },
  });
  const event = dispatchFetch(
    listeners.get("fetch"),
    new Request("https://peterguy326.github.io/senior-architect-pass-coach/src/app.mjs"),
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
      typeof request !== "string" && request.url.endsWith("/src/app.mjs") ? cached : null
    ),
  });
  const event = dispatchFetch(
    listeners.get("fetch"),
    new Request("https://peterguy326.github.io/senior-architect-pass-coach/src/app.mjs"),
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
