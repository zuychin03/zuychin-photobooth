import assert from "node:assert/strict";
import test from "node:test";
import { MAX_UPLOAD_BYTES, readBoundedImage, relayUploadRequestId, uploadImmutable, withUploadIntent, type UploadIntent, type UploadRpc } from "../lib/upload-intent";
import { saveStrip, deleteStrip, setStripKept, type StripRow } from "../lib/couple";
import { completeRelay, createRelay, deleteRelay, validateRelayMeta, type Relay } from "../lib/relay";

const OWNER = "11111111-1111-4111-8111-111111111111";
const SOURCE = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const intent: UploadIntent = { requestId: SOURCE, sourceId: SOURCE, sourceType: "strip", owner: OWNER, paths: [`${OWNER}/${SOURCE}.png`] };
const intentRow = (status = "registered", value = intent) => ({ id: value.requestId, owner: value.owner, source_id: value.sourceId, source_type: value.sourceType, paths: value.paths, status, generation: 1 });
const photo = () => new Blob(["fixture-photo"], { type: "image/png" });

function rpcFixture() {
  const calls: string[] = [];
  let reference = false;
  let cleanup = false;
  const client: UploadRpc = { rpc: async (name, args) => {
    calls.push(name === "pb_register_upload" ? "register" : `finish:${args.p_success}`);
    if (name === "pb_register_upload") return { data: intentRow(), error: null };
    assert.equal(args.p_generation, 1);
    if (!args.p_success && !reference) cleanup = true;
    return { data: intentRow(reference ? "complete" : "failed"), error: null };
  } };
  return { client, calls, get reference() { return reference; }, set reference(value: boolean) { reference = value; }, get cleanup() { return cleanup; } };
}

test("missing migration and malformed registration fail before any upload", async () => {
  for (const response of [{ data: null, error: { code: "PGRST202" } }, { data: { ...intentRow(), owner: OTHER }, error: null }]) {
    let writes = 0;
    await assert.rejects(withUploadIntent({ rpc: async () => response }, intent, async () => null, async () => { writes++; return SOURCE; }));
    assert.equal(writes, 0);
  }
});

test("upload intent is registered before bytes and completed after the durable reference", async () => {
  const f = rpcFixture();
  const result = await withUploadIntent(f.client, intent, async () => null, async () => {
    assert.deepEqual(f.calls, ["register"]);
    f.calls.push("upload");
    f.reference = true;
    f.calls.push("insert");
    return SOURCE;
  });
  assert.equal(result, SOURCE);
  assert.deepEqual(f.calls, ["register", "upload", "insert", "finish:true"]);
  assert.equal(f.cleanup, false);
});

test("upload or metadata failure queues durable cleanup without client deletion", async () => {
  for (const failure of ["upload", "insert"]) {
    const f = rpcFixture();
    await assert.rejects(withUploadIntent(f.client, intent, async () => null, async () => { throw new Error(`fixture ${failure}`); }), /fixture/);
    assert.equal(f.cleanup, true);
    assert.deepEqual(f.calls, ["register", "finish:false"]);
  }
});

test("lost insert acknowledgement reconciles an existing reference instead of cleaning it up", async () => {
  const f = rpcFixture();
  const result = await withUploadIntent(f.client, intent, async () => f.reference ? SOURCE : null, async () => {
    f.reference = true;
    throw new Error("fixture network acknowledgement lost");
  });
  assert.equal(result, SOURCE);
  assert.equal(f.cleanup, false);
  assert.deepEqual(f.calls, ["register", "finish:false"]);
});

test("completed stable-ID retry creates no duplicate upload or metadata", async () => {
  const f = rpcFixture();
  f.reference = true;
  let writes = 0;
  assert.equal(await withUploadIntent(f.client, intent, async () => SOURCE, async () => { writes++; return SOURCE; }), SOURCE);
  assert.equal(writes, 0);
  assert.deepEqual(f.calls, ["register", "finish:true"]);
});

test("an unavailable finish RPC reports uncertainty and never authorises a fresh retry ID", async () => {
  const client: UploadRpc = { rpc: async name => name === "pb_register_upload" ? { data: intentRow(), error: null } : { data: null, error: { message: "fixture offline" } } };
  await assert.rejects(withUploadIntent(client, intent, async () => null, async () => SOURCE), error => {
    assert.match((error as Error).message, /could not be confirmed/);
    assert.ok(!("restartRequired" in (error as object)));
    return true;
  });
});

test("cross-owner, mixed-role and oversized relay intents are rejected without RPC calls", async () => {
  let calls = 0;
  const client: UploadRpc = { rpc: async () => { calls++; return { data: null, error: null }; } };
  for (const paths of [[`${OTHER}/${SOURCE}.png`], [`${OWNER}/relay-${SOURCE}/A-0.jpg`, `${OWNER}/relay-${SOURCE}/B-1.jpg`], Array.from({ length: 5 }, (_, i) => `${OWNER}/relay-${SOURCE}/A-${i}.jpg`)]) {
    await assert.rejects(withUploadIntent(client, { ...intent, sourceType: "relay", paths }, async () => null, async () => SOURCE));
  }
  assert.equal(calls, 0);
});

test("immutable retry accepts identical uploaded bytes and refuses to replace different bytes", async () => {
  let uploads = 0;
  const store = {
    upload: async (_path: string, _blob: Blob, options: { upsert: false }) => { assert.equal(options.upsert, false); uploads++; return { error: new Error("fixture already exists") }; },
    download: async () => ({ data: photo(), error: null }),
  };
  await uploadImmutable(store, intent.paths[0], photo(), "image/png");
  await assert.rejects(uploadImmutable(store, intent.paths[0], new Blob(["other-content"], { type: "image/png" }), "image/png"), /already exists/);
  assert.equal(uploads, 2);
});

test("relay downloads reject HTTP errors, non-images and oversized chunked bodies", async () => {
  await assert.rejects(readBoundedImage(new Response("missing", { status: 404 })), /could not be downloaded/);
  await assert.rejects(readBoundedImage(new Response("html", { headers: { "Content-Type": "text/html" } })), /unsupported/);
  let cancelled = false;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(MAX_UPLOAD_BYTES + 1)); }, cancel() { cancelled = true; } });
  await assert.rejects(readBoundedImage(new Response(stream, { headers: { "Content-Type": "image/jpeg" } })), /exceeds/);
  assert.equal(cancelled, true);
  assert.equal((await readBoundedImage(new Response(photo(), { headers: { "Content-Type": "image/png" } }))).size, photo().size);
});

test("relay metadata rejects missing, excessive and mismatched frames before client creation", async () => {
  const meta = { layoutId: "duo-split", filterId: "none", sceneId: null, shots: 4 };
  assert.doesNotThrow(() => validateRelayMeta(meta, 4));
  for (const count of [0, 1, 5]) assert.throws(() => validateRelayMeta(meta, count));
  assert.throws(() => validateRelayMeta({ ...meta, filterId: "unknown" }));
  await assert.rejects(createRelay(OWNER, OTHER, meta, []));
  assert.equal(await relayUploadRequestId(SOURCE, OWNER), await relayUploadRequestId(SOURCE, OWNER));
  assert.notEqual(await relayUploadRequestId(SOURCE, OWNER), await relayUploadRequestId(SOURCE, OTHER));
});

test("actual strip saver registers before Storage and safely repeats a stable ID", async t => {
  let row: Record<string, unknown> | null = null;
  let uploads = 0;
  let inserts = 0;
  const events: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const method = init?.method ?? "GET";
    if (url.pathname.endsWith("pb_register_upload")) { events.push("register"); return Response.json([intentRow(row ? "complete" : "registered")]); }
    if (url.pathname.includes("/storage/")) { events.push("upload"); uploads++; return Response.json({ Key: intent.paths[0] }); }
    if (url.pathname.endsWith("pb_finish_upload")) return Response.json([intentRow(row ? "complete" : "failed")]);
    if (url.pathname.endsWith("pb_strips") && method === "POST") { events.push("insert"); inserts++; row = JSON.parse(init?.body as string); return new Response(null, { status: 201 }); }
    if (url.pathname.endsWith("pb_strips")) return Response.json(row);
    throw new Error(`unexpected fixture route ${url.pathname}`);
  });
  const meta = { layoutId: "strip4", caption: "fixture" };
  assert.equal(await saveStrip(OWNER, null, photo(), meta, { id: SOURCE }), SOURCE);
  assert.equal(await saveStrip(OWNER, null, photo(), meta, { id: SOURCE }), SOURCE);
  assert.deepEqual(events, ["register", "upload", "insert", "register"]);
  assert.equal(uploads, 1);
  assert.equal(inserts, 1);
});

test("actual strip saver with missing migration performs no Storage requests", async t => {
  const paths: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    paths.push(url.pathname);
    return Response.json({ code: "PGRST202", message: "fixture missing migration" }, { status: 404 });
  });
  await assert.rejects(saveStrip(OWNER, null, photo(), { layoutId: "strip4", caption: "fixture" }, { id: SOURCE }), /storage setup is complete/);
  assert.equal(paths.length, 1);
  assert.ok(paths[0].endsWith("pb_register_upload"));
});

test("client media operations preserve pending server state and use authenticated API routes", async t => {
  const paths: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string, init: RequestInit) => {
    paths.push(input);
    assert.equal(JSON.parse(init.body as string).requestId, SOURCE);
    return Response.json({ kept: true, pushed: false, pending: true, jobId: OTHER }, { status: 202 });
  });
  assert.deepEqual(await setStripKept(SOURCE, true, SOURCE), { kept: true, pushed: false, pending: true, jobId: OTHER });
  assert.deepEqual(await deleteStrip({ id: SOURCE } as StripRow, SOURCE), { pending: true });
  assert.deepEqual(paths, ["/api/keep", `/api/media/strips/${SOURCE}`]);
});

test("actual relay creation registers all owned frames before upload and queues cleanup on metadata failure", async t => {
  const events: string[] = [];
  let registered: UploadIntent | null = null;
  const frames = Array.from({ length: 4 }, () => ({ width: 8, height: 8, toBlob(callback: BlobCallback, type: string) { callback(new Blob(["fixture-frame"], { type })); } } as HTMLCanvasElement));
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const method = init?.method ?? "GET";
    assert.notEqual(method, "DELETE");
    if (url.pathname.endsWith("pb_register_upload")) {
      events.push("register");
      const args = JSON.parse(init?.body as string);
      assert.deepEqual(args.p_paths, frames.map((_, i) => `${OWNER}/relay-${SOURCE}/A-${i}.jpg`));
      registered = { requestId: args.p_request_id, sourceId: args.p_source_id, sourceType: "relay", owner: OWNER, paths: args.p_paths };
      return Response.json(intentRow("registered", registered));
    }
    if (url.pathname.includes("/storage/")) { events.push("upload"); assert.ok(registered); return Response.json({ Key: "fixture" }); }
    if (url.pathname.endsWith("pb_finish_upload")) {
      const args = JSON.parse(init?.body as string);
      assert.equal(args.p_success, false);
      events.push("cleanup");
      return Response.json(intentRow("failed", registered!));
    }
    if (url.pathname.endsWith("pb_relays") && method === "POST") { events.push("insert"); return Response.json({ code: "fixture_failure", message: "fixture metadata failure" }, { status: 400 }); }
    if (url.pathname.endsWith("pb_relays")) return Response.json(null);
    throw new Error(`unexpected fixture route ${url.pathname}`);
  });
  await assert.rejects(createRelay(OWNER, OTHER, { layoutId: "duo-split", filterId: "none", sceneId: null, shots: 4 }, frames, { id: SOURCE }), /Cloud saving failed/);
  assert.deepEqual(events, ["register", "upload", "upload", "upload", "upload", "insert", "cleanup"]);
  assert.equal(frames.length, 4);
  assert.equal(frames[0].width, 8);
});

test("a complete intent whose reference cannot be read remains uncertain", async () => {
  const client: UploadRpc = { rpc: async () => ({ data: intentRow("complete"), error: null }) };
  await assert.rejects(withUploadIntent(client, intent, async () => null, async () => SOURCE), error => {
    assert.match((error as Error).message, /could not be confirmed/);
    assert.ok(!("restartRequired" in (error as object)));
    return true;
  });
});

test("partner relay retry uses the same intent and never writes a completed half twice", async t => {
  let row: Relay = { id: SOURCE, couple_id: OTHER, initiator: OTHER, partner: null, layout_id: "duo-split", filter_id: "none", scene_id: null, shots: 4, a_done: true, b_done: false, status: "pending", created_at: "2026-09-23T00:00:00Z" };
  const original = { ...row };
  const frames = Array.from({ length: 4 }, () => ({ width: 8, height: 8, toBlob(callback: BlobCallback, type: string) { callback(new Blob(["fixture-frame"], { type })); } } as HTMLCanvasElement));
  const requestIds: string[] = [];
  let registered: UploadIntent;
  let uploads = 0;
  let updates = 0;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.pathname.endsWith("pb_register_upload")) {
      const args = JSON.parse(init?.body as string);
      requestIds.push(args.p_request_id);
      registered = { requestId: args.p_request_id, sourceId: SOURCE, sourceType: "relay", owner: OWNER, paths: args.p_paths };
      assert.deepEqual(args.p_paths, frames.map((_, i) => `${OWNER}/relay-${SOURCE}/B-${i}.jpg`));
      return Response.json(intentRow(row.b_done ? "complete" : "registered", registered));
    }
    if (url.pathname.includes("/storage/")) { uploads++; return Response.json({ Key: "fixture" }); }
    if (url.pathname.endsWith("pb_finish_upload")) return Response.json(intentRow("complete", registered));
    if (url.pathname.endsWith("pb_relays") && init?.method === "PATCH") {
      updates++;
      row = { ...row, partner: OWNER, b_done: true, status: "complete" };
      return Response.json([{ id: SOURCE }]);
    }
    if (url.pathname.endsWith("pb_relays")) return Response.json(row);
    throw new Error(`unexpected fixture route ${url.pathname}`);
  });
  await completeRelay(OWNER, original, frames);
  await completeRelay(OWNER, original, frames);
  assert.equal(uploads, 4);
  assert.equal(updates, 1);
  assert.equal(requestIds.length, 2);
  assert.equal(requestIds[0], requestIds[1]);
});

test("relay cancellation requires the cleanup migration before deleting metadata", async t => {
  const methods: string[] = [];
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    methods.push(init?.method ?? "GET");
    return Response.json({ code: "PGRST202", message: "fixture missing migration" }, { status: 404 });
  });
  await assert.rejects(deleteRelay(SOURCE), /storage setup is complete/);
  assert.ok(!methods.includes("DELETE"));
});

test("upload completion is fenced to its registered generation", async () => {
  const generations: unknown[] = [];
  const client: UploadRpc = { rpc: async (name, args) => {
    if (name === "pb_register_upload") return { data: { ...intentRow(), generation: 3 }, error: null };
    generations.push(args.p_generation);
    return { data: null, error: { message: "PB_UPLOAD_GENERATION_MISMATCH" } };
  } };
  await assert.rejects(withUploadIntent(client, intent, async () => null, async () => SOURCE), /could not be confirmed/);
  assert.deepEqual(generations, [3, 3]);
});
