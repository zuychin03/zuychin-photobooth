import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

const container = process.env.PB_TEST_CONTAINER ?? "pb-v2-p1-postgres";
if (!/^pb-v2-[a-z0-9-]+$/.test(container)) throw new Error("Use a task-owned pb-v2-* container");
const database = `pb_v2_event_worker_${Date.now()}`;
const docker = (args, input = "") => new Promise((resolve, reject) => {
  const child = spawn("docker", ["--context", "desktop-linux", ...args], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = ""; child.stdout.on("data", value => { stdout += value; }); child.stderr.on("data", value => { stderr += value; }); child.on("error", reject); child.on("close", code => resolve({ code, stdout, stderr })); child.stdin.end(input);
});
const sql = async (source, failure = false) => {
  const result = await docker(["exec", "-i", container, "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", database], source);
  if (result.code && !failure) throw new Error(result.stderr); return result;
};
const q = value => `'${String(value).replaceAll("'", "''")}'`;
const json = value => `${q(JSON.stringify(value))}::jsonb`;
const service = "SET ROLE service_role; SET request.jwt.claim.role='service_role'; ";
const call = async expression => JSON.parse((await sql(`${service} SELECT ${expression};`)).stdout.trim());
const { createEventStore } = await import("../../lib/server/event-store.ts");
const { createEventObjects } = await import("../../lib/server/event-objects.ts");
const { processEventMaintenance } = await import("../../lib/server/event-maintenance.ts");
const { default: sharp } = await import("sharp");
const owner = randomUUID(), event = randomUUID(), guest = randomUUID(), submission = randomUUID(), token = "a".repeat(64), invite = "b".repeat(64), receipt = "c".repeat(64);
const bytes = new Map(), origin = "https://synthetic-storage.invalid", env = { PB_EVENTS_ENABLED: "true", NEXT_PUBLIC_SUPABASE_URL: origin, SUPABASE_SERVICE_ROLE_KEY: "synthetic-service" };
const rpc = async (name, args) => {
  assert.match(name, /^pb_event_[a-z_]+$/);
  const value = x => x === null ? "NULL" : Array.isArray(x) ? `ARRAY[${x.map(q)}]::uuid[]` : typeof x === "number" ? String(x) : typeof x === "object" ? json(x) : q(x);
  const result = await sql(`${service} SELECT public.${name}(${Object.entries(args).map(([key, item]) => { assert.match(key, /^p_[a-z_]+$/); return `${key}=>${value(item)}`; }).join(",")});`, true);
  return result.code ? { data: null, error: { message: result.stderr.match(/PB_EVENT_[A-Z_]+/)?.[0] ?? "fixture_error" } } : { data: JSON.parse(result.stdout.trim()), error: null };
};
const store = createEventStore(env, { rpc });
const objects = createEventObjects({ origin, serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY }, { fetch: async (input, init) => {
  const url = String(input), path = new URL(url).pathname.replace("/storage/v1/object/", "").replace(/^authenticated\//, ""), slash = path.indexOf("/"), bucket = slash === -1 ? path : path.slice(0, slash), name = path.slice(slash + 1);
  const reply = (body, status = 200) => Object.defineProperty(new Response(body, { status }), "url", { value: url });
  if (init.method === "POST") {
    assert.equal(new Headers(init.headers).get("x-upsert"), "false");
    const metadata = JSON.parse(Buffer.from(new Headers(init.headers).get("x-metadata"), "base64").toString());
    const inserted = await sql(`${service} INSERT INTO storage.objects(bucket_id,name,metadata,user_metadata) VALUES(${q(bucket)},${q(name)},${json({ size: init.body.byteLength, mimetype: "image/jpeg" })},${json(metadata)});`, true);
    if (inserted.code) return reply("{}", 403);
    bytes.set(path, new Uint8Array(init.body)); return reply("{}", 201);
  }
  if (init.method === "DELETE") {
    const prefixes = JSON.parse(init.body).prefixes; assert.equal(prefixes.length, 1);
    await sql(`${service} DELETE FROM storage.objects WHERE bucket_id=${q(bucket)} AND name=${q(prefixes[0])};`); bytes.delete(`${bucket}/${prefixes[0]}`); return reply("[]");
  }
  assert(["GET", "HEAD"].includes(init.method));
  return reply(init.method === "HEAD" ? null : bytes.has(path) ? new Uint8Array(bytes.get(path)) : "missing", bytes.has(path) ? 200 : 404);
} });
const created = await docker(["exec", container, "createdb", "-U", "postgres", database]); assert.equal(created.code, 0, created.stderr);
try {
  await sql(await readFile(new URL("./bootstrap.sql", import.meta.url), "utf8"));
  await sql("CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]); ALTER TABLE storage.objects ADD COLUMN user_metadata jsonb;");
  await sql((await readFile(new URL("../../supabase-setup.sql", import.meta.url), "utf8")).split("-- BEGIN PB_LIFECYCLE_V1")[0]);
  for (const name of ["001_v2_lifecycle.sql", "003_v2_rooms.sql", "005_v2_events.sql"]) await sql(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  await sql(`INSERT INTO auth.users VALUES(${q(owner)},'worker@example.invalid');`);
  await call("public.pb_event_configure(10000000)");
  const now = Date.now(), eventBody = { title: "Worker fixture", timezone: "Australia/Sydney", startsAt: new Date(now - 60000).toISOString(), closesAt: new Date(now + 86400000).toISOString(), expiresAt: new Date(now + 7 * 86400000).toISOString(), maxGuests: 25, maxContributions: 100, maxBytes: 8200000 };
  await call(`public.pb_event_create(${q(owner)},${q(event)},${json(eventBody)})`);
  await call(`public.pb_event_manage(${q(owner)},${q(event)},'open','{}')`);
  await call(`public.pb_event_manage(${q(owner)},${q(event)},'invite',${json({ hash: invite, expiresAt: eventBody.closesAt })})`);
  await call(`public.pb_event_redeem(${q(event)},${q(invite)},${q(guest)},${q(token)})`);
  await store.reserve({ eventId: event, tokenHash: token, submissionId: submission, requestId: randomUUID(), receiptHash: receipt, contributors: [guest], consent: { submission: true, gallery: true, wall: false } });
  await store.authoriseUpload(event, token, submission);
  const source = await sharp({ create: { width: 80, height: 60, channels: 3, background: "#d64563" } }).png().withMetadata().toBuffer(), sourcePath = `${event}/${submission}/source`;
  bytes.set(`photobooth-event-images-staging-v2/${sourcePath}`, new Uint8Array(source));
  await sql(`INSERT INTO storage.objects(bucket_id,name,metadata) VALUES('photobooth-event-images-staging-v2',${q(sourcePath)},${json({ size: source.length })});`);
  await store.enqueueFinalise(event, token, submission);
  const result = await processEventMaintenance({ store, objects }); assert.equal(result.job, "ready");
  assert.equal((await store.receipt(event, receipt, submission)).state, "ready");
  const image = bytes.get(`photobooth-events-v2/${event}/${submission}/image`), thumbnail = bytes.get(`photobooth-events-v2/${event}/${submission}/thumbnail`);
  assert(image?.length > 0 && thumbnail?.length > 0);
  const metadata = await sharp(image).metadata(); assert.equal(metadata.format, "jpeg"); assert.equal(metadata.exif, undefined);
  const used = await call(`public.pb_event_dashboard(${q(owner)},${q(event)})`); assert.equal(used.usage.bytes, 2000000 + image.length + thumbnail.length);
  const late = await sql(`${service} UPDATE storage.objects SET metadata='{"size":1}' WHERE bucket_id='photobooth-events-v2' AND name=${q(`${event}/${submission}/image`)};`, true); assert.notEqual(late.code, 0); assert.match(late.stderr, /PB_EVENT_DENIED/);
  await call(`public.pb_event_manage(${q(owner)},${q(event)},'remove_submission',${json({ submissionId: submission })})`);
  assert.equal((await processEventMaintenance({ store, objects })).job, "deleted");
  const held = await call(`public.pb_event_dashboard(${q(owner)},${q(event)})`); assert.equal(held.usage.bytes, 2000000); assert.equal(held.usage.count, 1);
  assert.equal((await processEventMaintenance({ store, objects })).job, "idle");
  await sql(`UPDATE public.pb_event_upload_intents SET authorisation_until=clock_timestamp()-interval '301 seconds',cleanup_after=clock_timestamp()-interval '1 second' WHERE submission_id=${q(submission)}; UPDATE public.pb_event_jobs SET available_at=clock_timestamp()-interval '1 second' WHERE submission_id=${q(submission)} AND kind='delete_staging';`);
  assert.equal((await processEventMaintenance({ store, objects })).job, "deleted");
  const cleared = await call(`public.pb_event_dashboard(${q(owner)},${q(event)})`); assert.equal(cleared.usage.bytes, 0); assert.equal(cleared.usage.count, 0); assert.equal(bytes.size, 0);
  console.log("Event worker integration passed: real Sharp decode/metadata stripping, actual EventStore RPC/PG lease fences, service metadata insertion, exact derivative accounting, terminal write denial and confirmed cleanup after staged-token expiry. Provider HTTP/storage bytes are synthetic fixtures, not hosted evidence.");
} finally { const dropped = await docker(["exec", container, "dropdb", "-U", "postgres", "--force", database]); assert.equal(dropped.code, 0, dropped.stderr); }
