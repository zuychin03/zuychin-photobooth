import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { startRollbackProxy } from "./local-rollback-rehearsal.mjs";

async function upstream(label) {
  const seen = [], server = createServer((req, res) => { seen.push(req.headers); res.setHeader("set-cookie", "secret=must-not-escape"); res.end(label); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { port: server.address().port, seen, close: () => new Promise(resolve => { server.closeIdleConnections(); server.close(resolve); }) };
}
test("same-origin public editor switch, explicit receipt sidecar, network isolation and idempotent cleanup controls", async () => {
  const current = await upstream("current"), fallback = await upstream("frozen"); let restart = 0, drains = 0;
  const database = { database: "pb_v2_synthetic", check: async () => ({ wrongTokenDenied: true }), pauseAndRestart: async () => ({ generation: ++restart, newReservationRefused: true }), drainAndCleanup: async () => { drains++; return { derivativeDeletionConfirmed: true }; } };
  const proxy = await startRollbackProxy({ upstream: current.port, fallbackPort: fallback.port, port: 0, fixture: Buffer.from("synthetic"), database, artifact: { buildId: "test", integrity: "a".repeat(64) } });
  try {
    const request = (path, method = "GET", origin = proxy.origin, body = "{}") => fetch(proxy.origin + path, { method, ...(method === "POST" ? { headers: { origin, "content-type": "application/json" }, body } : { headers: { cookie: "real-cookie=never-forward", authorization: "Bearer never-forward" } }) });
    const before = await request("/projects"); assert.equal(await before.text(), "current"); assert.equal(before.headers.get("set-cookie"), null); assert.match(before.headers.get("content-security-policy"), /connect-src 'self'/); assert.equal(current.seen[0].cookie, undefined); assert.equal(current.seen[0].authorization, undefined);
    for (const path of ["/api/events", "/auth/callback", "/login", "/timeline"]) assert.equal((await request(path)).status, 403);
    assert.equal((await request("/__rollback/switch", "POST", "https://foreign.invalid")).status, 403); assert.equal(restart, 0);
    assert.equal((await request("/__rollback/switch", "POST", proxy.origin, '{"actor":"foreign"}')).status, 400);
    assert.equal((await request("/__rollback/drain", "POST")).status, 409);
    const switched = await (await request("/__rollback/switch", "POST")).json(); assert.equal(switched.editor.source, "frozen artifact runtime"); assert.match(switched.receipt.source, /sidecar/); assert.equal(switched.differentApplicationVersionsVerified, false);
    assert.equal(await (await request("/projects")).text(), "frozen");
    await request("/__rollback/drain", "POST"); await request("/__rollback/drain", "POST"); assert.equal(drains, 1);
    const html = await (await request("/__rollback")).text(); assert.match(html, /do not run through the frozen Next API/);
  } finally { await proxy.close(); await current.close(); await fallback.close(); }
});
test("the body deadline cannot terminate a valid slow SQL action after the body has finished", async () => {
  const current = await upstream("current"), fallback = await upstream("frozen");
  const database = { database: "pb_v2_synthetic", check: async () => { await new Promise(resolve => setTimeout(resolve, 5500)); return { wrongTokenDenied: true }; } };
  const proxy = await startRollbackProxy({ upstream: current.port, fallbackPort: fallback.port, port: 0, fixture: Buffer.from("synthetic"), database, artifact: { buildId: "test", integrity: "a".repeat(64) } });
  try { const response = await fetch(proxy.origin + "/__rollback/receipt", { method: "POST", headers: { origin: proxy.origin, "content-type": "application/json" }, body: "{}" }); assert.equal(response.status, 200); assert.equal((await response.json()).checks.wrongTokenDenied, true); }
  finally { await proxy.close(); await current.close(); await fallback.close(); }
});
