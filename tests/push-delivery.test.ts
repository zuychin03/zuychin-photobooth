import assert from "node:assert/strict";
import test from "node:test";
import { POST } from "../app/api/push/notify/route";
import { deliverPush, type SubscriptionRow } from "../lib/push";

const row = (id: string, endpoint: string): SubscriptionRow => ({ id, endpoint, p256dh: "synthetic-public", auth: "synthetic-auth" });

test("partner pushes only reach allow-listed push services and prune gone subscriptions", async () => {
  const contacted: string[] = [];
  const payload = { title: "Synthetic", body: "Synthetic body", url: "/timeline" };
  const result = await deliverPush([
    row("metadata", "https://169.254.169.254/latest/meta-data"),
    row("loopback", "https://127.0.0.1:8443/internal"),
    row("plain-http", "http://fcm.googleapis.com/fcm/send/a"),
    row("lookalike", "https://fcm.googleapis.com.attacker.invalid/a"),
    row("fcm", "https://fcm.googleapis.com/fcm/send/a"),
    row("gone", "https://updates.push.services.mozilla.com/wpush/v2/b"),
    row("down", "https://web.push.apple.com/c"),
  ], payload, async (sub, body) => {
    contacted.push(sub.id);
    assert.equal(body, JSON.stringify(payload));
    if (sub.id === "gone") throw Object.assign(new Error("gone"), { statusCode: 410 });
    if (sub.id === "down") throw Object.assign(new Error("unavailable"), { statusCode: 503 });
  });
  assert.deepEqual(contacted, ["fcm", "gone", "down"]);
  assert.deepEqual(result, { sent: 1, stale: ["gone"] });
});

test("partner notifications refuse foreign origins before reading the session", async () => {
  const previous = process.env.PB_PUBLIC_ORIGIN;
  const post = (headers: Record<string, string>, body = JSON.stringify({ type: "strip", id: "synthetic" })) =>
    POST(new Request("https://booth.example/api/push/notify", { method: "POST", headers: { "content-type": "application/json", ...headers }, body }));
  try {
    process.env.PB_PUBLIC_ORIGIN = "https://booth.example";
    const refused: Record<string, string>[] = [{}, { origin: "https://attacker.example" }, { origin: "null" }, { origin: "https://booth.example", "sec-fetch-site": "cross-site" }];
    for (const headers of refused) {
      const response = await post(headers);
      assert.equal(response.status, 403);
      assert.deepEqual(await response.json(), { error: "origin_denied" });
    }
    const sameOrigin = await post({ origin: "https://booth.example", "sec-fetch-site": "same-origin" }, "{}");
    assert.equal(sameOrigin.status, 400);
    delete process.env.PB_PUBLIC_ORIGIN;
    const unconfigured = await post({ origin: "https://booth.example" });
    assert.equal(unconfigured.status, 503);
    assert.deepEqual(await unconfigured.json(), { error: "unavailable" });
  } finally {
    if (previous === undefined) delete process.env.PB_PUBLIC_ORIGIN;
    else process.env.PB_PUBLIC_ORIGIN = previous;
  }
});
