import { createServer, request as httpRequest } from "node:http";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { launchFallback } from "./local-fallback-artifact.mjs";
import { createRollbackDatabase } from "./local-rollback-database.mjs";
import { syntheticDraft } from "./sw-update-harness.mjs";

const prefix = "/__rollback";
const csp = "default-src 'self'; connect-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'";
const fail = (response, code, message) => { if (response.headersSent) return response.destroy(); response.writeHead(code, { "Content-Type": "text/plain", "Cache-Control": "private, no-store" }); response.end(message); };
const publicPath = path => ["/", "/projects", "/booth", "/customize", "/offline.html", "/manifest.webmanifest", "/sw.js"].includes(path) || ["/_next/static/", "/mediapipe/", "/models/", "/stickers/", "/scenes/", "/materials/"].some(p => path.startsWith(p)) || /^\/[a-zA-Z0-9_-]+\.(png|svg|ico|woff2)$/.test(path);
function diagnostic() {
  return `<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Local fallback rehearsal</title><style>body{font:17px/1.5 system-ui;max-width:850px;margin:2rem auto;padding:0 1rem;background:#faf8f5;color:#292524}button,a{display:inline-block;min-height:44px;margin:.3rem;padding:.65rem .9rem;border:1px solid #9b8680;border-radius:.6rem;background:white;color:#292524}pre{white-space:pre-wrap;overflow-wrap:anywhere}button:disabled{opacity:.5}</style><main><h1>Local fallback rehearsal</h1><p>Only synthetic data. The public editor switches to a checksummed frozen production build. Receipt checks separately restart the real TypeScript HTTP handler against a disposable PostgreSQL database. They do not run through the frozen Next API or real provider. This is not evidence of compatibility between two different application versions.</p><ol><li>Download the synthetic project and import it through Projects. Change the caption, wait for Saved on this device, and check Square / JPEG / 80% export settings. Keep the editor tab open.</li><li>Check the already accepted private receipt and wrong-token denial.</li><li>Pause new event admission and switch editor upstream. This preserves this origin and browser storage. Reload the editor, reopen the project and download a portable backup or image through its ordinary UI. Verify originals, caption and settings.</li><li>Check the same accepted receipt after handler restart. New reservations must be refused. Run the synthetic accepted-work cleanup check; the separate ready receipt remains readable.</li></ol><p>No real accounts, browser tokens or provider addresses enter this fixture. Compiled public configuration is blocked by this proxy's content security policy. Open the editor only through this origin, never its upstream port.</p><p><a href="${prefix}/fixture" download="rollback-draft.pbproject">Download synthetic project</a><a href="/projects" target="_blank" rel="noopener">Open Projects</a></p><button data-action="receipt">Check accepted receipt</button><button data-action="switch">Pause admission and switch to frozen build</button><button data-action="drain">Check accepted finalisation and cleanup</button><button data-action="state">Observe build state</button><h2 tabindex="-1" id="heading">Rehearsal evidence</h2><pre id="result" role="status">Not checked</pre><script>const result=document.getElementById('result'),buttons=[...document.querySelectorAll('button')];let busy=false;for(const button of buttons)button.onclick=async()=>{if(busy)return;busy=true;buttons.forEach(b=>b.disabled=true);try{const response=await fetch('${prefix}/'+button.dataset.action,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',cache:'no-store'});if(!response.ok)throw new Error(await response.text());result.textContent=JSON.stringify(await response.json(),null,2);}catch(e){result.textContent=e.message;}finally{busy=false;buttons.forEach(b=>b.disabled=false);button.focus();}};</script></main></html>`;
}
export async function startRollbackProxy({ upstream, fallbackPort, port = 3017, fixture, database, artifact }) {
  if (![upstream, fallbackPort].every(v => Number.isInteger(v) && v >= 1024 && v <= 65535) || upstream === fallbackPort || !Number.isInteger(port) || port < 0 || port > 65535 || [upstream, fallbackPort].includes(port)) throw new Error("Distinct loopback ports required");
  let origin, switched = false, busy = false, drained = null;
  const state = () => ({ editor: { source: switched ? "frozen artifact runtime" : "current production process", buildId: artifact.buildId, integrity: artifact.integrity }, receipt: { source: "real handler and disposable PostgreSQL sidecar", database: database.database }, provider: "synthetic in-memory bytes", differentApplicationVersionsVerified: false });
  const server = createServer(async (request, response) => {
    response.setHeader("Content-Security-Policy", csp); response.setHeader("Referrer-Policy", "no-referrer"); response.setHeader("X-Content-Type-Options", "nosniff"); response.setHeader("Cache-Control", "private, no-store");
    if (request.headers.host !== new URL(origin).host || !request.url?.startsWith("/") || request.url.startsWith("//")) return fail(response, 400, "Loopback host required");
    const url = new URL(request.url, origin);
    if (url.pathname.startsWith(prefix)) {
      if (request.method === "GET" && url.pathname === prefix && !url.search) { response.setHeader("Content-Type", "text/html; charset=utf-8"); return response.end(diagnostic()); }
      if (request.method === "GET" && url.pathname === `${prefix}/fixture` && !url.search) { response.setHeader("Content-Type", "application/x-photobooth-project"); response.setHeader("Content-Disposition", 'attachment; filename="rollback-draft.pbproject"'); return response.end(fixture); }
      if (request.method !== "POST" || request.headers.origin !== origin || request.headers["content-type"] !== "application/json" || url.search) return fail(response, 403, "Same-origin operator action required");
      if (busy) return fail(response, 409, "Previous fixture check is still running");
      busy = true;
      try {
        request.setTimeout(5000, () => request.destroy()); let body = "", chunks = 0;
        for await (const chunk of request) { body += chunk; if (++chunks > 8 || Buffer.byteLength(body) > 32) return fail(response, 413, "Request too large"); }
        request.setTimeout(0);
        if (body !== "{}") return fail(response, 400, "Empty fixture action required");
        let result;
        if (url.pathname === `${prefix}/state`) result = state();
        else if (url.pathname === `${prefix}/receipt`) result = { ...state(), checks: await database.check(origin) };
        else if (url.pathname === `${prefix}/switch`) { const checks = await database.pauseAndRestart(origin); switched = true; result = { ...state(), checks }; }
        else if (url.pathname === `${prefix}/drain`) { if (!switched) return fail(response, 409, "Switch and pause first"); drained ??= await database.drainAndCleanup(origin); result = { ...state(), checks: drained }; }
        else return fail(response, 404, "Unknown fixture action");
        response.setHeader("Content-Type", "application/json"); return response.end(JSON.stringify(result));
      } catch { return fail(response, 500, "Local fixture assertion failed. No hosted operation was attempted; inspect the runner's focused tests."); }
      finally { busy = false; }
    }
    if (!["GET", "HEAD"].includes(request.method) || !publicPath(url.pathname) || /%2f|%5c|%2e/i.test(url.pathname)) return fail(response, 403, "Only public editor routes are forwarded; accounts and APIs are blocked");
    const target = switched ? fallbackPort : upstream;
    const headers = { host: `127.0.0.1:${target}`, accept: "*/*", "accept-encoding": "identity" };
    for (const key of ["rsc", "next-router-state-tree", "next-router-prefetch", "next-router-segment-prefetch", "next-url"]) if (typeof request.headers[key] === "string" && request.headers[key].length <= 16384) headers[key] = request.headers[key];
    const proxy = httpRequest({ hostname: "127.0.0.1", port: target, path: url.pathname + url.search, method: request.method, headers, timeout: 30000 }, incoming => {
      for (const key of ["content-type", "content-length", "etag", "last-modified", "vary"]) if (incoming.headers[key]) response.setHeader(key, incoming.headers[key]);
      if (incoming.headers.location) { const location = new URL(incoming.headers.location, `http://127.0.0.1:${target}`); if (location.origin !== `http://127.0.0.1:${target}` || !publicPath(location.pathname)) { incoming.destroy(); return fail(response, 502, "Redirect refused"); } response.setHeader("Location", location.pathname + location.search); }
      response.writeHead(incoming.statusCode ?? 502); let bytes = 0;
      incoming.on("data", chunk => { bytes += chunk.length; if (bytes > 128 * 1024 * 1024) { incoming.destroy(); response.destroy(); } }); incoming.on("error", () => response.destroy()); incoming.pipe(response);
    });
    proxy.on("timeout", () => proxy.destroy()); proxy.on("error", () => fail(response, 502, "Local production process unavailable")); response.on("close", () => proxy.destroy()); proxy.end();
  });
  server.requestTimeout = 120000; server.headersTimeout = 10000;
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); }); origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, url: origin + prefix, close: () => new Promise((resolve, reject) => { server.closeIdleConnections(); server.close(error => error ? reject(error) : resolve()); }) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [directory, upstreamText = "3006", portText = "3017", fallbackText = "3016"] = process.argv.slice(2);
  if (!directory || process.argv.length > 6) throw new Error("Usage: node --import tsx scripts/local-rollback-rehearsal.mjs ARTIFACT [CURRENT_PORT] [PROXY_PORT] [FALLBACK_PORT]. Local Docker fixture only. Start after the authorised final build snapshot; no hosted credentials are read.");
  let fallback, database, proxy, closing, stopping = false;
  const close = () => closing ??= (async () => { const proxyResult = await Promise.allSettled([proxy?.close()]); const failures = await Promise.allSettled([fallback?.close(), database?.close()]); if ([...proxyResult, ...failures].some(result => result.status === "rejected")) throw new Error("A local rehearsal cleanup was incomplete"); })();
  const initialising = (async () => {
    const sourceHash = createHash("sha256").update(await readFile(new URL("../lib/server/event-requests.ts", import.meta.url))).digest("hex");
    console.log(`Preparing local fallback runtime and disposable SQL sidecar. EventHandler source SHA-256 ${sourceHash}; this source is separate from the frozen Next API.`);
    fallback = await launchFallback(directory, Number(fallbackText));
    const artifact = { buildId: fallback.buildId, integrity: fallback.integrity };
    void fallback.done.then(end => { if (!end.expected) { console.error("Frozen runtime stopped unexpectedly"); stop(1); } });
    if (stopping) throw new Error("Local rehearsal stopped during startup");
    database = await createRollbackDatabase();
    if (stopping) throw new Error("Local rehearsal stopped during startup");
    proxy = await startRollbackProxy({ upstream: Number(upstreamText), fallbackPort: fallback.port, port: Number(portText), artifact, database, fixture: await syntheticDraft() });
    console.log(`Open only ${proxy.url}\nArtifact ${artifact.integrity}; disposable database ${database.database}. Stop this runner to remove only its own runtime/database. Browser data is preserved.`);
  })();
  function stop(code) { stopping = true; void initialising.catch(() => {}).then(close).then(() => process.exit(code), () => process.exit(1)); }
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => stop(0));
  try { await initialising; } catch (error) { await close(); throw error; }
}
