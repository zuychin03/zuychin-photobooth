import assert from "node:assert/strict";
import test from "node:test";
import { BACKFILL_DEFAULTS, parseBackfillOptions, runActivityBackfill } from "../lib/server/activity-backfill";

const env = { NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321", SUPABASE_SERVICE_ROLE_KEY: "synthetic-service-key-for-tests" };
const capability = { version: 1, ready: true, detailLimit: 2000, annotatedLimit: 500, chapterLimit: 100, pageLimit: 50, summaryTimezone: "UTC" };
const apply = { ...BACKFILL_DEFAULTS, apply: true };

test("default dry-run validates configuration without making a request or exposing the service key", async () => {
  let calls = 0;
  const result = await runActivityBackfill(parseBackfillOptions([]), env, { fetch: async () => { calls++; throw new Error("unexpected"); } });
  assert.equal(calls, 0); assert.equal(result.stop, "dry_run"); assert.equal(result.processed, 0);
  assert(!JSON.stringify(result).includes(env.SUPABASE_SERVICE_ROLE_KEY));
  for (const args of [["--apply=true"], ["--apply", "--apply"], ["--batch-size=101"], ["--max-batches=21"], ["--deadline-ms=120001"], ["--key=secret"], ["--batch-size=2.5"]]) assert.throws(() => parseBackfillOptions(args));
  for (const origin of ["http://example.invalid", "https://user:secret@example.invalid", "https://example.invalid/path", "https://example.invalid?key=secret"]) {
    await assert.rejects(runActivityBackfill(apply, { ...env, NEXT_PUBLIC_SUPABASE_URL: origin }));
  }
  await assert.rejects(runActivityBackfill(apply, { ...env, SUPABASE_SERVICE_ROLE_KEY: "" }));
});

test("capability failure is sanitised and never invokes the mutation", async () => {
  const calls: string[] = [];
  const result = await runActivityBackfill(apply, env, { fetch: async input => { calls.push(String(input)); return Response.json({ ...capability, version: 99, detail: "private remote error" }); } });
  assert.equal(result.stop, "unavailable"); assert.equal(calls.length, 1); assert(calls[0].endsWith("/pb_memory_capabilities"));
  assert(!JSON.stringify(result).includes("private"));
});

test("sequential batches use only the service RPC and stop on a validated empty batch", async () => {
  const pending = ["a", "b", "c"], marked = new Set<string>(), progress: number[] = [], requests: number[] = [];
  let inFlight = 0, peak = 0;
  const request: typeof fetch = async (input, init) => {
    assert.equal(init?.redirect, "error"); assert.equal(init?.cache, "no-store");
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`);
    if (String(input).endsWith("capabilities")) return Response.json(capability);
    assert.equal(String(input), `${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/rpc/pb_memory_backfill`);
    inFlight++; peak = Math.max(peak, inFlight); await Promise.resolve();
    const { p_limit } = JSON.parse(String(init?.body)); requests.push(p_limit);
    const batch = pending.filter(id => !marked.has(id)).slice(0, p_limit); batch.forEach(id => marked.add(id));
    inFlight--; return Response.json({ processed: batch.length });
  };
  const result = await runActivityBackfill({ ...apply, batchSize: 2 }, env, { fetch: request, progress: value => progress.push(value.processed) });
  assert.equal(result.stop, "no_unlocked_work"); assert.equal(result.processed, 3); assert.equal(result.acknowledgedBatches, 3);
  assert.deepEqual(requests, [2, 2, 2]); assert.deepEqual(progress, [2, 3, 3]); assert.equal(peak, 1);
});

test("batch and elapsed limits stop before another mutation", async () => {
  let mutations = 0, clock = 0;
  const request: typeof fetch = async input => {
    if (String(input).endsWith("capabilities")) return Response.json(capability);
    mutations++; clock += 1000; return Response.json({ processed: 1 });
  };
  assert.equal((await runActivityBackfill({ ...apply, maxBatches: 2 }, env, { fetch: request })).stop, "batch_limit");
  assert.equal(mutations, 2); mutations = 0; clock = 0;
  const result = await runActivityBackfill({ ...apply, deadlineMs: 1000 }, env, { fetch: request, now: () => clock });
  assert.equal(result.stop, "deadline"); assert.equal(mutations, 1); assert.equal(result.processed, 1);
});

test("lost mutation acknowledgement stops without retry; rerun uses the existing server checkpoint", async () => {
  const pending = ["a", "b"], marked = new Set<string>(); let lose = true, calls = 0;
  const request: typeof fetch = async input => {
    if (String(input).endsWith("capabilities")) return Response.json(capability);
    calls++; const batch = pending.filter(id => !marked.has(id)).slice(0, 1); batch.forEach(id => marked.add(id));
    if (lose) { lose = false; throw new Error("provider message containing a synthetic credential"); }
    return Response.json({ processed: batch.length });
  };
  const first = await runActivityBackfill({ ...apply, batchSize: 1 }, env, { fetch: request });
  assert.equal(first.stop, "uncertain"); assert.equal(first.processed, 0); assert.equal(calls, 1); assert.deepEqual([...marked], ["a"]);
  const resumed = await runActivityBackfill({ ...apply, batchSize: 1 }, env, { fetch: request });
  assert.equal(resumed.stop, "no_unlocked_work"); assert.equal(resumed.processed, 1); assert.equal(marked.size, 2);
});

test("invalid mutation projections retain uncertainty and cannot trigger additional work", async () => {
  for (const value of [{ processed: 26 }, { processed: -1 }, { processed: 0, sourceIds: ["private"] }, { processed: "1" }]) {
    let calls = 0;
    const result = await runActivityBackfill(apply, env, { fetch: async input => {
      if (String(input).endsWith("capabilities")) return Response.json(capability);
      calls++; return Response.json(value);
    } });
    assert.equal(result.stop, "uncertain"); assert.equal(calls, 1); assert.equal(result.acknowledgedBatches, 0);
  }
});

test("oversized, excessively chunked and redirected responses fail before mutation", async () => {
  for (const response of [
    new Response("x".repeat(4097), { headers: { "content-type": "application/json" } }),
    new Response(new ReadableStream({ start(controller) { for (let i = 0; i < 130; i++) controller.enqueue(new Uint8Array()); controller.close(); } }), { headers: { "content-type": "application/json" } }),
    Response.redirect("https://elsewhere.invalid", 302),
  ]) {
    let calls = 0; const result = await runActivityBackfill(apply, env, { fetch: async () => { calls++; return response; } });
    assert.equal(result.stop, "unavailable"); assert.equal(calls, 1);
  }
});

test("cancellation during an uncooperative mutation returns uncertain without starting more requests", async () => {
  const controller = new AbortController(); let calls = 0, settle: ((value: Response) => void) | undefined;
  const result = await runActivityBackfill(apply, env, { signal: controller.signal, fetch: async input => {
    if (String(input).endsWith("capabilities")) return Response.json(capability);
    calls++; queueMicrotask(() => controller.abort()); return new Promise<Response>(resolve => { settle = resolve; });
  } });
  assert.equal(result.stop, "uncertain"); assert.equal(calls, 1);
  settle!(Response.json({ processed: 1 })); await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 1);
  const before = await runActivityBackfill(apply, env, { signal: controller.signal, fetch: async () => { throw new Error("must not run"); } });
  assert.equal(before.stop, "interrupted");
});
