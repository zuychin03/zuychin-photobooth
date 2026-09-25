import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { proxy } from "../proxy";

async function inEnvironment(mode: string, run: () => Promise<void>) {
  const keys = ["NODE_ENV", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"] as const;
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { NODE_ENV: mode, NEXT_PUBLIC_SUPABASE_URL: "", NEXT_PUBLIC_SUPABASE_ANON_KEY: "" });
  try { await run(); } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else Object.assign(process.env, { [key]: previous[key] });
    }
  }
}

test("production rejects lab routes before layout streaming without blocking similarly named routes", async () => {
  await inEnvironment("production", async () => {
    for (const path of ["/v2-lab", "/v2-lab/events/kiosk", "/v2-lab/voice/pcm"]) {
      const response = await proxy(new NextRequest(`https://booth.example${path}`));
      assert.equal(response.status, 404);
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      assert.equal(response.headers.get("referrer-policy"), "no-referrer");
      assert.equal(await response.text(), "Not found");
    }
    const ordinary = await proxy(new NextRequest("https://booth.example/v2-laboratory"));
    assert.equal(ordinary.headers.get("x-middleware-next"), "1");
  });
});

test("development still reaches the guarded lab pages", async () => {
  await inEnvironment("development", async () => {
    const response = await proxy(new NextRequest("http://localhost:3005/v2-lab/room"));
    assert.equal(response.headers.get("x-middleware-next"), "1");
  });
});

test("a locked kiosk keeps precedence over the production lab rejection", async () => {
  await inEnvironment("production", async () => {
    const event = "11111111-1111-4111-8111-111111111111", device = "22222222-2222-4222-8222-222222222222";
    for (const [cookie, destination] of [[`${event}.${device}`, `/e/${event}/kiosk`], ["invalid", "/kiosk-locked"]]) {
      const response = await proxy(new NextRequest("https://booth.example/v2-lab/events", { headers: { cookie: `pb-kiosk-lock=${cookie}` } }));
      assert.equal(response.status, 307);
      assert.equal(response.headers.get("location"), `https://booth.example${destination}`);
      assert.equal(response.headers.get("cache-control"), "private, no-store");
    }
  });
});
