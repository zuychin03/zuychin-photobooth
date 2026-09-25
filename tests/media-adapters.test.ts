import assert from "node:assert/strict";
import test from "node:test";
import { createClient } from "@supabase/supabase-js";
import { supabaseServiceOrigin } from "../lib/server/cron-auth";
import { supabaseMediaStore } from "../lib/server/media-store";
import { executeMediaJob, type ArchiveProvider, type MediaJob } from "../lib/server/media-worker";
import { fetchWithDeadline } from "../lib/supabase/server";

const OWNER = "11111111-1111-4111-8111-111111111111";
const SOURCE = "22222222-2222-4222-8222-222222222222";
const strip = {
  id: SOURCE, owner: OWNER, storage_path: `${OWNER}/${SOURCE}.png`, kept: true, purged: false,
  cloudinary_public_id: `zuychin-photobooth/${OWNER}/${SOURCE}`, cloudinary_url: "https://res.cloudinary.com/fixture/image.png",
};
const job: MediaJob = {
  id: "33333333-3333-4333-8333-333333333333", kind: "release", source_type: "strip", source_id: SOURCE, owner: OWNER,
  snapshot: strip, checkpoint: {}, stage: "pending", lease_token: "44444444-4444-4444-8444-444444444444", attempts: 1, max_attempts: 5,
};

function fixtureStore(status: number) {
  const methods: string[] = [];
  const client = createClient("http://127.0.0.1:54321", "fixture-public-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async (_input, init) => {
      methods.push(init?.method ?? "GET");
      return new Response(null, { status });
    } },
  });
  return { store: supabaseMediaStore(client, job), methods };
}

test("the shared service origin validator accepts local HTTP but rejects remote HTTP", () => {
  for (const value of ["http://127.0.0.1:54321", "http://localhost:54321", "http://[::1]:54321"]) {
    assert.equal(supabaseServiceOrigin(value), value);
  }
  for (const value of ["http://remote.example.test", "http://localhost.evil.test:54321", "http://user:pass@127.0.0.1:54321", "http://127.0.0.1:54321/rest/v1"]) {
    assert.equal(supabaseServiceOrigin(value), null);
  }
});

test("Storage exists interprets the installed SDK's missing-object 404 as absent", async () => {
  const absent = fixtureStore(404);
  assert.equal(await absent.store.sourceExists(strip.storage_path), false);
  assert.deepEqual(absent.methods, ["HEAD"]);
  assert.equal(await fixtureStore(200).store.sourceExists(strip.storage_path), true);
  for (const status of [400, 401, 403, 500, 503]) {
    await assert.rejects(fixtureStore(status).store.sourceExists(strip.storage_path));
  }
});

test("a missing source through the actual Storage adapter refuses release without touching Cloudinary", async () => {
  const { store } = fixtureStore(404);
  store.checkpoint = async () => {};
  store.finish = async () => {};
  store.readStrip = async () => strip;
  let removals = 0;
  const provider: ArchiveProvider = { configured: () => true, upload: async () => { throw new Error("unexpected upload"); }, verify: async () => true, remove: async () => { removals++; } };
  assert.deepEqual(await executeMediaJob(job, store, provider), { outcome: "failed", code: "archive_is_only_copy" });
  assert.equal(removals, 0);
});

test("authenticated fetch deadline aborts a stalled request", async t => {
  let signal: AbortSignal | undefined;
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    signal = init?.signal ?? undefined;
    assert.ok(signal);
    return new Promise<Response>((_resolve, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }));
  });
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(fetchWithDeadline(20)("https://fixture.example.test/auth/v1/user"), { name: "TimeoutError" });
    assert.equal(signal?.aborted, true);
  } finally { clearTimeout(keepAlive); }
});

test("fetch deadline preserves both caller and Request cancellation", async t => {
  const signals: AbortSignal[] = [];
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    signals.push(init!.signal!);
    return new Response("fixture");
  });
  const caller = new AbortController();
  const original = new AbortController();
  const bounded = fetchWithDeadline(10_000);
  await bounded("https://fixture.example.test/rest/v1/rpc/job", { signal: caller.signal });
  await bounded(new Request("https://fixture.example.test/auth/v1/user", { signal: original.signal }));
  caller.abort();
  original.abort();
  assert.equal(signals[0].aborted, true);
  assert.equal(signals[1].aborted, true);
});

test("fetch deadline remains active after headers while a response body stalls", async t => {
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    const body = new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode("{"));
      init!.signal!.addEventListener("abort", () => controller.error(init!.signal!.reason), { once: true });
    } });
    return new Response(body);
  });
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const response = await fetchWithDeadline(20)("https://fixture.example.test/rest/v1/rpc/job");
    await assert.rejects(response.text(), { name: "TimeoutError" });
  } finally { clearTimeout(keepAlive); }
});
