import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { config, proxy } from "../proxy";
import { incomingFeature, isLocalRelease, localReleaseApiAllowed, localReleaseKioskAllowed } from "../lib/release-mode";
import { createEventKioskHandler, type EventKioskRequestPorts } from "../lib/server/event-kiosk-requests";

test("local kiosk permits recovery operations but refuses new work before opening service ports", async () => {
  for (const operation of ["session", "context", "status", "finalise", "reset", "unlock", "operator", "exit"]) assert.equal(localReleaseKioskAllowed(operation), true, operation);
  let opened = 0;
  const refuse = (): never => { opened++; throw new Error("Unexpected service port"); };
  const ports: EventKioskRequestPorts = { kiosk: refuse, core: refuse, host: refuse, objects: refuse, authenticate: refuse };
  const handler = createEventKioskHandler(ports, () => ({ NODE_ENV: "production", PB_RELEASE_MODE: "local", PB_EVENTS_ENABLED: "true", PB_PUBLIC_ORIGIN: "https://booth.example", PB_EVENT_TRANSPORT_SECRET: "synthetic-test-secret-".repeat(3), PB_EVENT_TRUSTED_IP_HEADER: "x-fixture-ip" }));
  for (const operation of ["create", "begin", "reserve", "upload", "unknown"]) {
    assert.equal(localReleaseKioskAllowed(operation), false, operation);
    const response = await handler(new Request("https://booth.example/api/events/00000000-0000-4000-8000-000000000001/kiosk", { method: "POST", headers: { origin: "https://booth.example", "content-type": "application/json", "x-fixture-ip": "192.0.2.1" }, body: JSON.stringify({ operation }) }), "00000000-0000-4000-8000-000000000001");
    assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: "unavailable" });
  }
  assert.equal(opened, 0);
});

test("release defaults fail closed in production and explicit modes override", () => {
  for (const value of [undefined, "", "FULL", "unexpected"]) assert.equal(isLocalRelease({ NODE_ENV: "production", PB_RELEASE_MODE: value }), true);
  assert.equal(isLocalRelease({ NODE_ENV: "production", PB_RELEASE_MODE: "full" }), false);
  assert.equal(isLocalRelease({ NODE_ENV: "development" }), false);
  assert.equal(isLocalRelease({ NODE_ENV: "test" }), false);
  assert.equal(isLocalRelease({ NODE_ENV: "development", PB_RELEASE_MODE: "local" }), true);
});

test("online page prefixes respect route boundaries", () => {
  for (const path of ["/", "/booth", "/customize", "/projects", "/projects/", "/templates", "/templates/design", "/eventsmith", "/projects/cloudy", "/rooms", "/ｅ", "/together"]) assert.equal(incomingFeature(path), null, path);
  for (const path of ["/projects/cloud", "/projects/cloud/", "/projects/cloud/a", "/events/a.png", "/e/a/gallery", "/room/code", "/relay/new", "/challenges/a", "/memories/rituals", "/timeline", "/login", "/auth/callback"]) assert.ok(incomingFeature(path), path);
});

test("legacy room codes allow host and join while every explicit V2 value stays incoming", () => {
  for (const code of ["ABC234", "abc234", "aBc234", "999999"]) {
    for (const query of ["", "host=1", "v=1", "v=1&host=1"]) assert.equal(incomingFeature(`/room/${code}`, new URLSearchParams(query)), null, `${code}?${query}`);
    for (const query of ["v=2", "host=1&v=2", "v=1&v=2", "v=2&v=1", "v=%32"]) assert.ok(incomingFeature(`/room/${code}`, new URLSearchParams(query)), `${code}?${query}`);
  }
  for (const path of ["/room", "/room/new", "/room/ABC23", "/room/ABC2345", "/room/ABC230", "/room/ABO234", "/room/ABI234", "/room/ABL234", "/room/ABC234.png", "/room/ABC234/extra"]) assert.ok(incomingFeature(path), path);
});

test("maintenance and existing receipts permit only their narrow methods and paths", () => {
  for (const path of ["/api/media/maintenance", "/api/retention", "/api/projects/maintenance", "/api/events/maintenance"]) {
    assert.equal(localReleaseApiAllowed(path, "GET"), true);
    assert.equal(localReleaseApiAllowed(`${path}/`, "GET"), true);
    for (const method of ["POST", "PUT", "DELETE", "HEAD", "OPTIONS"]) assert.equal(localReleaseApiAllowed(path, method), false);
    for (const suffix of [".png", "/extra", "-extra"]) assert.equal(localReleaseApiAllowed(path + suffix, "GET"), false);
  }
  const receipt = "/api/events/event/receipts/submission";
  for (const method of ["GET", "POST"]) assert.equal(localReleaseApiAllowed(receipt, method), true);
  for (const method of ["PUT", "DELETE", "PATCH", "HEAD"]) assert.equal(localReleaseApiAllowed(receipt, method), false);
  for (const path of ["/api/events/event/receipts", `${receipt}/extra`, "/api/events/event/exports", "/api/reminders", "/api/keep", "/api/push/notify"]) assert.equal(localReleaseApiAllowed(path, "GET"), false);
});

test("actual proxy gates pages and APIs before configured Supabase access, preserving kiosk precedence", async () => {
  const keys = ["NODE_ENV", "PB_RELEASE_MODE", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"];
  const saved = keys.map(key => [key, process.env[key]] as const), originalFetch = globalThis.fetch;
  let networkCalls = 0;
  try {
    Object.assign(process.env, { NODE_ENV: "production", PB_RELEASE_MODE: "local", NEXT_PUBLIC_SUPABASE_URL: "https://release-canary.invalid", NEXT_PUBLIC_SUPABASE_ANON_KEY: "synthetic-canary-must-not-be-used" });
    globalThis.fetch = async () => { networkCalls++; throw new Error("Unexpected network call"); };
    for (const path of ["/events/a.png", "/projects/cloud/a.jpg", "/room/code.webp", "/room/new", "/room/ABO234", "/room/ABC234/extra", "/room/ABC234?v=2", "/room/abc234?host=1&v=2", "/room/ABC234?v=1&v=2", "/room/ABC234?v=2&v=1", "/room/ABC234?v=%32", "/auth/callback?code=synthetic", "/memories/"]) {
      assert.equal(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url: `https://booth.example${path}` }), true, path);
      const result = await proxy(new NextRequest(`https://booth.example${path}`));
      const rewrite = new URL(result.headers.get("x-middleware-rewrite")!);
      assert.equal(rewrite.pathname, "/incoming");
      assert.equal(rewrite.searchParams.has("code"), false);
      assert.equal(result.headers.get("cache-control"), "private, no-store");
    }
    for (const path of ["/api/projects", "/api/events/photo.png", "/api/rooms", "/api/rooms/join", "/api/rooms/ABC234?v=1", "/api/rooms/ABC234?v=2", "/api/keep", "/api/reminders"]) {
      assert.equal(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url: `https://booth.example${path}` }), true, path);
      const result = await proxy(new NextRequest(`https://booth.example${path}`, { method: "POST" }));
      assert.equal(result.status, 503); assert.deepEqual(await result.json(), { error: "feature_incoming" });
    }
    for (const path of ["/", "/together", "/room/ABC234", "/room/ABC234?host=1", "/room/abc234", "/room/aBc234?host=1&v=1", "/projects", "/templates/design", "/receipt/existing", "/api/projects/maintenance", "/api/events/event/receipts/submission"]) {
      const result = await proxy(new NextRequest(`https://booth.example${path}`));
      assert.equal(result.headers.get("x-middleware-next"), "1", path);
    }
    const cookie = "pb-kiosk-lock=00000000-0000-4000-8000-000000000001.00000000-0000-4000-8000-000000000002";
    const locked = await proxy(new NextRequest("https://booth.example/api/projects", { headers: { cookie } }));
    assert.equal(locked.status, 403); assert.deepEqual(await locked.json(), { error: "kiosk_locked" });
    const recovery = await proxy(new NextRequest("https://booth.example/api/events/00000000-0000-4000-8000-000000000001/kiosk", { method: "POST", headers: { cookie } }));
    assert.equal(recovery.headers.get("x-middleware-next"), "1");
    assert.equal(networkCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
