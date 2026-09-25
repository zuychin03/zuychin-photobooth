import { createServer, request as httpRequest } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import sharp from "sharp";
import { appendProjectMedia, createProject } from "../lib/projects/model.ts";
import { exportProjectBundle } from "../lib/projects/bundle.ts";
import { DEFAULT_EXPORT_SETTINGS } from "../lib/exports/settings.ts";

const PREFIX = "/__sw-rehearsal";
const CSP = "default-src 'self'; connect-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'";
const fail = (response, code, message) => { response.removeHeader("Content-Length"); response.writeHead(code, { "Content-Type": "text/plain", "Cache-Control": "no-store" }); response.end(message); };

export function releaseWorker(source, version) {
  if (!/^[a-zA-Z0-9-]{1,80}$/.test(version) || (source.match(/^const VERSION = "[^"]+";$/gm) ?? []).length !== 1) throw new Error("Unexpected worker VERSION declaration");
  return source.replace(/^const VERSION = "[^"]+";$/m, `const VERSION = "${version}";`);
}

export async function syntheticDraft() {
  const at = "2026-09-23T00:00:00.000Z", media = new Map(), declarations = [];
  let project = createProject({ id: "sw-rehearsal-original", name: "Worker update rehearsal", createdAt: at, captureTimeZone: "Australia/Sydney", participants: [{ id: "synthetic-a", role: "A" }], editor: { caption: "Saved before worker update", exportSettings: { ...DEFAULT_EXPORT_SETTINGS, profileId: "square", format: "jpeg", quality: .8 } } });
  for (const [index, background] of ["#b76e79", "#8a9676", "#748d99", "#c79a65"].entries()) {
    const bytes = await sharp({ create: { width: 640, height: 480, channels: 3, background } }).png().toBuffer();
    const id = `synthetic-${index + 1}`, blob = new Blob([bytes], { type: "image/png" });
    media.set(id, blob); declarations.push({ id, kind: "photo", mime: "image/png", width: 640, height: 480, bytes: blob.size, participantId: "synthetic-a" });
  }
  project = appendProjectMedia(project, declarations, { A: [...media.keys()], B: [], C: [], D: [] }, at, at);
  return Buffer.from(await (await exportProjectBundle(project, media)).arrayBuffer());
}

function page(runId) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Local worker update rehearsal</title><style>body{font:17px/1.5 system-ui;max-width:850px;margin:2rem auto;padding:0 1rem;background:#faf8f5;color:#292524}button,a{display:inline-block;min-height:44px;margin:.25rem;padding:.65rem .9rem;border:1px solid #9b8680;border-radius:.6rem;background:white;color:#292524;box-sizing:border-box}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#eee8e4;padding:1rem}li{margin:.5rem 0}</style><main><h1>Local worker update rehearsal</h1><p>Run ${runId}. This is one production app build with two worker VERSION values. It does not prove compatibility between two different app builds.</p><ol><li>Register release A, then open Projects in another tab. Import the synthetic project, open it, change the caption, and wait for “Saved on this device”. Check its Square / JPEG / 80% export settings.</li><li>Keep that editor tab open. Return here, serve B and request an update. Observe active=activated and waiting=installed. Confirm the editor still works.</li><li>Close <strong>every tab on this origin, including this diagnostic page</strong>. Do not unregister or force activation.</li><li>Reopen this URL, then open Projects and resume the same saved project. Confirm caption, originals and export settings. Observe B's page cache and the removal of A's page cache after B handles navigation.</li></ol><p>Only use synthetic local data here. This proxy blocks API/auth routes, external connections and mutation requests. Closing this terminal stops the proxy; it does not delete browser storage.</p><div><button id="register">Register current worker</button><button id="release">Serve release B</button><button id="update">Request worker update</button><button id="observe">Observe state</button><a href="${PREFIX}/fixture" download="worker-update.pbproject">Download synthetic project</a><a href="/projects" target="_blank" rel="noopener">Open Projects in another tab</a></div><h2>Observed state</h2><pre id="state" role="status">Not observed yet</pre><h2>Session log</h2><pre id="log"></pre></main><script>
const state=document.getElementById('state'),log=document.getElementById('log'),lines=[];
function note(message){lines.push(new Date().toISOString()+' '+message);if(lines.length>40)lines.shift();log.textContent=lines.join('\\n');}
let observing=false;async function observe(){if(observing)return;observing=true;try{const release=await(await fetch('${PREFIX}/state',{cache:'no-store'})).json();const r=await navigator.serviceWorker.getRegistration('/');const keys=await caches.keys();state.textContent=JSON.stringify({servedRelease:release.release,versions:release.versions,controller:navigator.serviceWorker.controller?.state??null,active:r?.active?.state??null,waiting:r?.waiting?.state??null,installing:r?.installing?.state??null,foreignStaticCaches:keys.filter(k=>k.startsWith('pb-static-')&&!Object.values(release.versions).some(v=>k==='pb-static-'+v)),caches:keys.filter(k=>k.startsWith('pb-'))},null,2);}finally{observing=false;}}
async function run(work){try{await work();await observe();}catch(e){note(e.message);}}
function watch(r){r.addEventListener('updatefound',()=>{const w=r.installing;note('updatefound');w?.addEventListener('statechange',()=>{note('installing worker: '+w.state);void run(observe);});});}
document.getElementById('register').onclick=()=>run(async()=>{const info=await(await fetch('${PREFIX}/state',{cache:'no-store'})).json();const keys=await caches.keys();const prior=await navigator.serviceWorker.getRegistration('/');if(keys.some(k=>k.startsWith('pb-static-')&&!Object.values(info.versions).some(v=>k==='pb-static-'+v))||(prior&&!keys.some(k=>Object.values(info.versions).some(v=>k==='pb-static-'+v))))throw new Error('Existing worker from another run. Restart on an unused port; do not clear unrelated storage.');const r=await navigator.serviceWorker.register('/sw.js',{updateViaCache:'none'});watch(r);note('Registered current server release');});
document.getElementById('release').onclick=()=>run(async()=>{const r=await fetch('${PREFIX}/release',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({release:'B'})});if(!r.ok)throw new Error('Release switch refused');note('Server now serves B; this does not activate it');});
document.getElementById('update').onclick=()=>run(async()=>{const r=await navigator.serviceWorker.getRegistration('/');if(!r)throw new Error('Register A first');watch(r);await r.update();note('Update requested; activation remains browser-controlled');});
document.getElementById('observe').onclick=()=>run(observe);
navigator.serviceWorker.addEventListener('controllerchange',()=>{note('controllerchange');void run(observe);});
void run(observe);const timer=setInterval(()=>void run(observe),2000);addEventListener('pagehide',()=>clearInterval(timer));
</script></html>`;
}

export async function startWorkerHarness({ upstream = 3006, port = 3007, source, fixture } = {}) {
  if (!Number.isInteger(upstream) || upstream < 1024 || upstream > 65535 || !Number.isInteger(port) || port < 0 || port > 65535 || port === upstream) throw new Error("Invalid loopback ports");
  const worker = source ?? await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
  const draft = fixture ?? await syntheticDraft(), runId = randomBytes(5).toString("hex");
  const versions = { A: `rehearsal-${runId}-A`, B: `rehearsal-${runId}-B` };
  const workers = { A: releaseWorker(worker, versions.A), B: releaseWorker(worker, versions.B) };
  let release = "A", origin;
  const server = createServer(async (request, response) => {
    if (request.headers.host !== new URL(origin).host || !request.url?.startsWith("/") || request.url.startsWith("//")) return fail(response, 400, "Loopback host required");
    response.setHeader("Content-Security-Policy", CSP); response.setHeader("Referrer-Policy", "no-referrer"); response.setHeader("X-Content-Type-Options", "nosniff");
    const url = new URL(request.url, origin);
    if (url.pathname === `${PREFIX}/release`) {
      if (request.method !== "POST" || request.headers.origin !== origin || request.headers["content-type"] !== "application/json") return fail(response, 403, "Same-origin operator action required");
      let body = "";
      request.setTimeout(5000, () => request.destroy());
      try { for await (const chunk of request) { body += chunk; if (Buffer.byteLength(body) > 64) return fail(response, 413, "Request too large"); } if (body !== '{"release":"B"}') return fail(response, 400, "Only release B is supported"); }
      catch { return fail(response, 400, "Incomplete request"); }
      release = "B"; response.writeHead(200, { "Cache-Control": "no-store", "Content-Type": "application/json" }); return response.end('{"release":"B"}');
    }
    if (!["GET", "HEAD"].includes(request.method)) return fail(response, 405, "Rehearsal does not forward mutations");
    if (url.pathname.startsWith("/api/") || url.pathname === "/api" || url.pathname.startsWith("/auth/") || url.pathname === "/login") return fail(response, 503, "Accounts and APIs are disabled in this local rehearsal");
    if (url.pathname.startsWith(PREFIX) || url.pathname === "/sw.js") {
      let body, type = "text/html; charset=utf-8";
      if (url.pathname === PREFIX || url.pathname === `${PREFIX}/`) body = page(runId);
      else if (url.pathname === `${PREFIX}/state`) { body = JSON.stringify({ release, versions, upstream }); type = "application/json"; }
      else if (url.pathname === `${PREFIX}/fixture`) { body = draft; type = "application/x-photobooth-project"; response.setHeader("Content-Disposition", 'attachment; filename="worker-update.pbproject"'); }
      else if (url.pathname === "/sw.js") { body = workers[release]; type = "application/javascript"; response.setHeader("Service-Worker-Allowed", "/"); }
      else return fail(response, 404, "Unknown rehearsal control");
      response.writeHead(200, { "Content-Type": type, "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store" }); return response.end(request.method === "HEAD" ? undefined : body);
    }
    const allowed = ["/", "/projects", "/booth", "/customize", "/offline.html", "/manifest.webmanifest"].includes(url.pathname)
      || ["/_next/static/", "/mediapipe/", "/models/", "/stickers/", "/scenes/", "/materials/"].some(prefix => url.pathname.startsWith(prefix))
      || /^\/[a-zA-Z0-9_-]+\.(png|svg|ico|woff2)$/.test(url.pathname);
    if (!allowed || /%2f|%5c|%2e/i.test(url.pathname)) return fail(response, 404, "Only public editor routes and static assets are proxied");
    const forwarded = Object.fromEntries(["rsc", "next-router-state-tree", "next-router-prefetch", "next-router-segment-prefetch", "next-url"].filter(key => typeof request.headers[key] === "string" && request.headers[key].length <= 16384).map(key => [key, request.headers[key]]));
    const proxy = httpRequest({ hostname: "127.0.0.1", port: upstream, path: url.pathname + url.search, method: request.method, headers: { ...forwarded, host: `127.0.0.1:${upstream}`, accept: request.headers.accept ?? "*/*", "accept-encoding": "identity", ...(request.headers.range ? { range: request.headers.range } : {}) }, timeout: 30000 }, incoming => {
      for (const key of ["content-type", "content-length", "cache-control", "etag", "last-modified", "content-range", "accept-ranges", "vary"]) if (incoming.headers[key]) response.setHeader(key, incoming.headers[key]);
      if (incoming.headers.location) {
        const location = new URL(incoming.headers.location, `http://127.0.0.1:${upstream}`);
        if (location.origin !== `http://127.0.0.1:${upstream}`) { incoming.destroy(); return fail(response, 502, "External redirect refused"); }
        response.setHeader("Location", location.pathname + location.search + location.hash);
      }
      response.writeHead(incoming.statusCode ?? 502); let bytes = 0;
      incoming.on("data", chunk => { bytes += chunk.length; if (bytes > 128 * 1024 * 1024) { incoming.destroy(); response.destroy(); } });
      incoming.on("error", () => response.destroy()); incoming.pipe(response);
    });
    proxy.on("timeout", () => proxy.destroy(new Error("Upstream timed out")));
    proxy.on("error", () => { if (!response.headersSent) fail(response, 502, "Production upstream is unavailable"); else response.destroy(); });
    response.on("close", () => proxy.destroy()); proxy.end();
  });
  server.requestTimeout = 35000; server.headersTimeout = 10000;
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, url: `${origin}${PREFIX}`, versions, close: () => new Promise((resolve, reject) => { server.closeIdleConnections(); server.close(error => error ? reject(error) : resolve()); }) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2); if (args.length % 2 || args.some((value, index) => index % 2 === 0 && !["--upstream", "--port"].includes(value))) throw new Error("Use --upstream 3006 --port 3007");
  const options = Object.fromEntries(Array.from({ length: args.length / 2 }, (_, index) => [args[index * 2].slice(2), Number(args[index * 2 + 1])]));
  const harness = await startWorkerHarness(options);
  console.log(`Local worker rehearsal: ${harness.url}\nProxy only; upstream must already be a production server. No forced activation or browser storage deletion.`);
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { void harness.close().then(() => process.exit(0)); });
}
