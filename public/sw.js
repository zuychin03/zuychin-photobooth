/* Public shells and curated images only; private navigation stays network-only. */
importScripts("/scenes/v2/pack-index.js");
const VERSION = "v4-photobooth-icons";
const STATIC_CACHE = `pb-static-${VERSION}`;
const PAGE_CACHE = `pb-pages-${VERSION}`;
const PACK_CACHE = `pb-assets-${self.PB_ASSET_PACK.version}`;
const OFFLINE_URL = "/offline.html";
const ICON_FILES = new Set(["/favicon-v2.svg", "/zuychin-logo.svg", "/icon-192-v2.png", "/icon-512-v2.png", "/icon-512-maskable-v2.png", "/apple-touch-icon-v2.png", "/badge-v2.png"]);
const PRECACHE = [OFFLINE_URL, ...ICON_FILES];
const PUBLIC_SHELLS = new Set(["/", "/booth", "/customize", "/projects"]);
const STATIC_PREFIXES = ["/_next/static/", "/mediapipe/", "/models/", "/stickers/"];
const PACK_FILES = new Map(self.PB_ASSET_PACK.packs.flatMap(pack => pack.files.map(file => [file.path, { ...file, category: pack.category }])));
const PACK_BYTES = 8 * 1024 * 1024;
const PACK_ENTRIES = 48;
let packWrites = Promise.resolve();
let packGeneration = 0;
let packOperation = false;
const serialPackWrite = operation => {
  const result = packWrites.then(operation);
  packWrites = result.catch(() => {});
  return result;
};
const publicResponse = response => response.ok && !response.redirected && !/(?:private|no-store)/i.test(response.headers.get("cache-control") || "");

self.addEventListener("install", event => {
  event.waitUntil(caches.open(STATIC_CACHE).then(cache => cache.addAll(PRECACHE)));
});
self.addEventListener("activate", event => {
  // Earlier generic page caches may contain private snapshots; retain static rollback assets.
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith("pb-pages-") && key !== PAGE_CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", event => {
  const request = event.request, url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || url.search || url.hash || request.headers.has("authorization")) return;
  if (ICON_FILES.has(url.pathname)) event.respondWith(iconFirst(request));
  else if (PACK_FILES.has(url.pathname)) event.respondWith(curatedFirst(request));
  else if (STATIC_PREFIXES.some(prefix => url.pathname.startsWith(prefix))) event.respondWith(cacheFirst(request));
  else if (request.mode === "navigate") event.respondWith(pageNetworkFirst(request, PUBLIC_SHELLS.has(url.pathname)));
});
async function iconFirst(request) {
  let cache, cached;
  try { cache = await caches.open(STATIC_CACHE); cached = await cache.match(request); }
  catch { return fetch(request); }
  if (cached) return cached;
  const response = await fetch(request);
  if (publicResponse(response)) { try { await cache.put(request, response.clone()); } catch { /* Online icons remain available when storage is full. */ } }
  return response;
}
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (publicResponse(response)) {
    try { await (await caches.open(STATIC_CACHE)).put(request, response.clone()); } catch { /* Storage failure must not break an online asset. */ }
  }
  return response;
}
async function verifiedPackResponse(response, descriptor) {
  if (!publicResponse(response) || response.headers.get("content-type")?.split(";")[0].trim() !== "image/webp" || !response.body) throw new Error("Asset unavailable");
  const reader = response.body.getReader(), bytes = new Uint8Array(descriptor.bytes);
  let offset = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (offset + chunk.value.length > bytes.length) throw new Error("Asset exceeds budget");
      bytes.set(chunk.value, offset); offset += chunk.value.length;
    }
    if (offset !== bytes.length) throw new Error("Incomplete asset");
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), value => value.toString(16).padStart(2, "0")).join("");
  if (digest !== descriptor.sha256) throw new Error("Asset integrity mismatch");
  return new Response(bytes, { headers: { "Content-Type": "image/webp", "Content-Length": String(bytes.length), "Cache-Control": "public, max-age=31536000, immutable" } });
}
async function savePack(request, response, descriptor, generation) {
  const verified = await verifiedPackResponse(response, descriptor);
  await serialPackWrite(async () => {
    if (generation !== packGeneration) throw new Error("Asset cache request cancelled");
    const cache = await caches.open(PACK_CACHE), keys = await cache.keys();
    let bytes = keys.reduce((total, key) => total + (PACK_FILES.get(new URL(key.url).pathname)?.bytes ?? PACK_BYTES), 0), count = keys.length;
    const existing = keys.find(key => key.url === request.url);
    if (existing) { bytes -= descriptor.bytes; count--; }
    for (const key of keys) {
      if (bytes + descriptor.bytes <= PACK_BYTES && count + 1 <= PACK_ENTRIES) break;
      if (key.url === request.url) continue;
      await cache.delete(key); bytes -= PACK_FILES.get(new URL(key.url).pathname)?.bytes ?? PACK_BYTES; count--;
    }
    if (descriptor.bytes > PACK_BYTES) throw new Error("Asset exceeds cache budget");
    await cache.put(request, verified);
  });
}
async function curatedFirst(request, strict = false) {
  const generation = packGeneration;
  let cached;
  try { cached = await (await caches.open(PACK_CACHE)).match(request); } catch { /* Online loading remains available without Cache Storage. */ }
  if (cached) return cached;
  const response = await fetch(request);
  try { await savePack(request, response.clone(), PACK_FILES.get(new URL(request.url).pathname), generation); }
  catch (error) { if (strict) throw error; }
  return response;
}
self.addEventListener("message", event => {
  const data = event.data;
  if (!data || !["PB_CACHE_ASSET_PACK", "PB_CLEAR_ASSET_PACK"].includes(data.type) || !["together", "create", "events", "material", "all"].includes(data.category)) return;
  event.waitUntil((async () => {
    const client = event.source?.id ? await self.clients.get(event.source.id) : null;
    if (!client || new URL(client.url).origin !== self.location.origin) return;
    let ownsOperation = false;
    try {
      const files = [...PACK_FILES].filter(([, descriptor]) => data.category === "all" || descriptor.category === data.category);
      if (data.type === "PB_CLEAR_ASSET_PACK") {
        packGeneration++;
        await serialPackWrite(async () => {
          const cache = await caches.open(PACK_CACHE);
          for (const [path] of files) await cache.delete(new URL(path, self.location.origin).href);
        });
      } else {
        if (packOperation) throw new Error("A pack request is already active");
        packOperation = true; ownsOperation = true;
        const generation = packGeneration;
        for (const [path] of files) {
          if (generation !== packGeneration) throw new Error("Asset cache request cancelled");
          const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10000);
          try { await curatedFirst(new Request(new URL(path, self.location.origin), { credentials: "omit", redirect: "error", signal: controller.signal }), true); }
          finally { clearTimeout(timer); }
        }
      }
      event.ports[0]?.postMessage({ ok: true, version: self.PB_ASSET_PACK.version, files: files.length });
    } catch { event.ports[0]?.postMessage({ ok: false, error: "The requested pack could not be cached. Try again online or use the procedural backgrounds." }); }
    finally { if (ownsOperation) packOperation = false; }
  })());
});
async function pageNetworkFirst(request, cacheable) {
  try {
    const response = await fetch(request);
    if (cacheable && publicResponse(response) && response.headers.get("content-type")?.includes("text/html")) {
      try { await (await caches.open(PAGE_CACHE)).put(request, response.clone()); } catch { /* Keep the live public shell when storage is full. */ }
    }
    return response;
  } catch {
    const cached = cacheable ? await (await caches.open(PAGE_CACHE)).match(request) : null;
    return cached ?? (await (await caches.open(STATIC_CACHE)).match(OFFLINE_URL));
  }
}
self.addEventListener("push", event => {
  if (!event.data) return;
  const data = event.data.json();
  event.waitUntil(self.registration.showNotification(data.title, { body: data.body, icon: "/icon-192-v2.png", badge: "/badge-v2.png", data: { url: data.url || "/" } }));
});
self.addEventListener("notificationclick", event => {
  event.notification.close();
  const url = event.notification.data?.url || "/";
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(windows => {
    for (const client of windows) { if ("focus" in client) { client.navigate(url); return client.focus(); } }
    return self.clients.openWindow(url);
  }));
});
