import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { Script } from "node:vm";
import { releaseWorker, startWorkerHarness, syntheticDraft } from "./sw-update-harness.mjs";
import { importProjectBundle } from "../lib/projects/bundle.ts";
import { inspectImageHeader } from "../lib/projects/images.ts";

test("worker releases differ only in VERSION and retain natural activation", async () => {
  const original = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
  const changed = releaseWorker(original, "test-release-B");
  assert.equal(changed.replace('const VERSION = "test-release-B";', original.match(/^const VERSION = "[^"]+";$/m)[0]), original);
  assert.doesNotMatch(changed, /skipWaiting\s*\(/);
  assert.throws(() => releaseWorker(original + '\nconst VERSION = "other";', "test"));
});

test("synthetic bundle imports through the real codec with four originals and durable export settings", async () => {
  const bytes = await syntheticDraft();
  const result = await importProjectBundle(new Blob([bytes]), { newId: () => "rehearsal-import", now: () => "2026-09-23T12:00:00.000Z", inspect: async blob => inspectImageHeader(new Uint8Array(await blob.arrayBuffer())) });
  assert.equal(result.project.scope.kind, "device"); assert.equal(result.media.size, 4);
  assert.equal(result.project.editor.caption, "Saved before worker update");
  assert.equal(result.project.editor.exportSettings.profileId, "square"); assert.equal(result.project.editor.exportSettings.quality, .8);
  for (const blob of result.media.values()) assert.deepEqual(inspectImageHeader(new Uint8Array(await blob.arrayBuffer())), { mime: "image/png", width: 640, height: 480 });
});

test("loopback proxy isolates controls, blocks account/mutation routes and forwards actual public navigation", async () => {
  const seen = [];
  const upstream = createServer((request, response) => { seen.push({ path: request.url, cookie: request.headers.cookie, rsc: request.headers.rsc }); response.setHeader("Content-Type", "text/html"); response.setHeader("Set-Cookie", "private=discard"); response.end("public production shell"); });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const harness = await startWorkerHarness({ upstream: upstream.address().port, port: 0, fixture: Buffer.from("fixture") });
  const get = path => fetch(harness.origin + path);
  try {
    const a = await (await get("/sw.js")).text(); assert.match(a, new RegExp(harness.versions.A));
    assert.equal((await fetch(harness.origin + "/__sw-rehearsal/release", { method: "POST", headers: { Origin: "http://foreign.invalid", "Content-Type": "application/json" }, body: '{"release":"B"}' })).status, 403);
    assert.equal((await fetch(harness.origin + "/__sw-rehearsal/release", { method: "POST", headers: { Origin: harness.origin, "Content-Type": "application/json" }, body: '{"release":"B"}' })).status, 200);
    const b = await (await get("/sw.js")).text(); assert.equal(b.replace(harness.versions.B, harness.versions.A), a);
    for (const path of ["/api/projects", "/auth/callback", "/login", "/api%2fprojects", "/_next/image?url=https://external.invalid/image", "/timeline"]) assert.notEqual((await get(path)).status, 200);
    assert.equal((await fetch(harness.origin + "/projects", { method: "POST" })).status, 405);
    const page = await fetch(harness.origin + "/projects", { headers: { Cookie: "secret=discard", RSC: "1" } });
    assert.equal(await page.text(), "public production shell"); assert.equal(page.headers.get("set-cookie"), null);
    assert.match(page.headers.get("content-security-policy"), /connect-src 'self'/);
    assert.deepEqual(seen, [{ path: "/projects", cookie: undefined, rsc: "1" }]);
    const diagnostic = await (await get("/__sw-rehearsal")).text();
    assert.doesNotThrow(() => new Script(diagnostic.match(/<script>([\s\S]+)<\/script>/)[1]));
    assert.match(diagnostic, /including this diagnostic page/); assert.doesNotMatch(diagnostic, /\.unregister\(|\.skipWaiting\(/);
  } finally { await harness.close(); await new Promise(resolve => upstream.close(resolve)); }
});
