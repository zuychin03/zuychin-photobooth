import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import manifest from "../lib/assets/manifest.json";

const origin = "https://photobooth.test";
const cacheKey = (value: Request | string) => typeof value === "string" ? new URL(value, origin).href : value.url;
class MemoryCache {
  entries = new Map<string, Response>();
  async match(key: Request | string) { return this.entries.get(cacheKey(key))?.clone(); }
  async put(key: Request | string, response: Response) { this.entries.set(cacheKey(key), response.clone()); }
  async delete(key: Request | string) { return this.entries.delete(cacheKey(key)); }
  async keys() { return [...this.entries.keys()].map(url => new Request(url)); }
  async addAll(paths: string[]) { for (const path of paths) await this.put(path, new Response("offline")); }
}
async function harness() {
  const stores = new Map<string, MemoryCache>(), listeners = new Map<string, (event: Record<string, unknown>) => void>();
  let failNetwork = false, invalidAssets = false, skippedWaiting = 0;
  const caches = {
    async open(key: string) { if (!stores.has(key)) stores.set(key, new MemoryCache()); return stores.get(key)!; },
    async keys() { return [...stores.keys()]; },
    async delete(key: string) { return stores.delete(key); },
    async match(key: Request | string) { for (const store of stores.values()) { const found = await store.match(key); if (found) return found; } },
  };
  const self = { location: { origin }, PB_ASSET_PACK: { version: manifest.version, packs: manifest.assets.map(asset => ({ category: asset.category, files: [asset.full, asset.thumbnail] })) }, addEventListener: (type: string, callback: (event: Record<string, unknown>) => void) => listeners.set(type, callback), clients: { claim: async () => {}, get: async () => ({ url: origin + "/projects" }) }, skipWaiting: async () => { skippedWaiting++; } };
  const fetcher = async (request: Request) => {
    if (failNetwork) throw new Error("offline");
    const path = new URL(request.url).pathname;
    if (path.endsWith(".webp")) return new Response(invalidAssets ? new Uint8Array(4) : await readFile(new URL(`../public${path}`, import.meta.url)), { headers: { "Content-Type": "image/webp" } });
    return new Response("public shell", { headers: { "Content-Type": "text/html" } });
  };
  vm.runInNewContext(await readFile(new URL("../public/sw.js", import.meta.url), "utf8"), { self, caches, importScripts() {}, fetch: fetcher, URL, Request, Response, Uint8Array, crypto, AbortController, setTimeout, clearTimeout });
  async function dispatch(type: string, properties: Record<string, unknown> = {}) {
    let result: Promise<unknown> | undefined;
    listeners.get(type)!({ ...properties, waitUntil: (promise: Promise<unknown>) => { result = promise; }, respondWith: (promise: Promise<unknown>) => { result = promise; } });
    return result ? await result : undefined;
  }
  const navigation = (path: string) => ({ url: origin + path, method: "GET", mode: "navigate", headers: new Headers() });
  return { stores, caches, dispatch, navigation, skippedWaiting: () => skippedWaiting, offline: () => { failNetwork = true; }, corrupt: () => { invalidAssets = true; } };
}

test("service worker caches only four query-free public shells and never private routes", async () => {
  const h = await harness(); await h.dispatch("install");
  for (const path of ["/", "/booth", "/customize", "/projects", "/timeline", "/login", "/room/123", "/relay/123", "/events/123", "/receipt/123", "/api/private", "/auth/callback"]) await h.dispatch("fetch", { request: h.navigation(path) });
  assert.equal(await h.dispatch("fetch", { request: h.navigation("/booth?token=secret") }), undefined);
  const paths = [...h.stores.get("pb-pages-v4-photobooth-icons")!.entries.keys()].map(url => new URL(url).pathname);
  assert.deepEqual(paths, ["/", "/booth", "/customize", "/projects"]);
  h.offline();
  assert.equal(await (await h.dispatch("fetch", { request: h.navigation("/booth") }) as Response).text(), "public shell");
  assert.equal(await (await h.dispatch("fetch", { request: h.navigation("/receipt/123") }) as Response).text(), "offline");
});
test("icon update waits for existing sessions and serves revisioned install icons offline from its own cache", async () => {
  const h = await harness();
  const old = await h.caches.open("pb-static-v3-curated-shells");
  await old.put("/icon-192-v2.png", new Response("stale icon"));
  await h.dispatch("install");
  assert.equal(h.skippedWaiting(), 0);
  h.offline();
  for (const path of ["/icon-192-v2.png", "/icon-512-v2.png", "/icon-512-maskable-v2.png", "/apple-touch-icon-v2.png", "/badge-v2.png", "/favicon-v2.svg"]) {
    const response = await h.dispatch("fetch", { request: new Request(origin + path) }) as Response;
    assert.equal(await response.text(), "offline");
  }
  assert.equal(await h.dispatch("fetch", { request: new Request(origin + "/icon-192-v2.png?token=private") }), undefined);
});

test("activation removes legacy generic page snapshots while retaining rollback build assets", async () => {
  const h = await harness();
  await h.caches.open("pb-pages-v2-code-z"); await h.caches.open("pb-static-v2-code-z"); await h.caches.open("pb-assets-previous");
  await h.dispatch("activate");
  assert(!h.stores.has("pb-pages-v2-code-z")); assert(h.stores.has("pb-static-v2-code-z")); assert(h.stores.has("pb-assets-previous"));
});

test("curated cache is empty on install and caches only requested registered images", async () => {
  const h = await harness(); await h.dispatch("install");
  assert(!h.stores.has("pb-assets-2.0.0"));
  const path = manifest.assets[0].thumbnail.path;
  await h.dispatch("fetch", { request: new Request(origin + path) });
  assert.equal(h.stores.get("pb-assets-2.0.0")!.entries.size, 1);
  assert.equal(await h.dispatch("fetch", { request: new Request(origin + "/scenes/v2/unregistered.webp") }), undefined);
  h.offline(); assert.equal((await h.dispatch("fetch", { request: new Request(origin + path) }) as Response).status, 200);
});

test("explicit packs are bounded, integrity-checked and clearable without touching old static assets", async () => {
  const h = await harness(); let reply: { ok: boolean; files?: number } | undefined;
  const message = (type: string, category: string) => h.dispatch("message", { source: { id: "local-client" }, data: { type, category }, ports: [{ postMessage: (value: typeof reply) => { reply = value; } }] });
  await message("PB_CACHE_ASSET_PACK", "all");
  assert.equal(reply?.ok, true); assert.equal(reply?.files, 48);
  const cache = h.stores.get("pb-assets-2.0.0")!;
  assert.equal(cache.entries.size, 48);
  let bytes = 0; for (const response of cache.entries.values()) bytes += (await response.clone().arrayBuffer()).byteLength;
  assert(bytes <= 8 * 1024 * 1024);
  await message("PB_CLEAR_ASSET_PACK", "material"); assert.equal(cache.entries.size, 36);
  await message("PB_CLEAR_ASSET_PACK", "all"); assert.equal(cache.entries.size, 0);
  h.corrupt(); await message("PB_CACHE_ASSET_PACK", "together"); assert.equal(reply?.ok, false); assert.equal(cache.entries.size, 0);
});
