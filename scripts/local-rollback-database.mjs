import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import sharp from "sharp";
import { createEventStore } from "../lib/server/event-store.ts";
import { createEventHandler } from "../lib/server/event-requests.ts";
import { createEventReadinessStore } from "../lib/server/event-readiness-store.ts";
import { createEventObjects } from "../lib/server/event-objects.ts";
import { processEventMaintenance } from "../lib/server/event-maintenance.ts";

const q = value => `'${String(value).replaceAll("'", "''")}'`;
const json = value => `${q(JSON.stringify(value))}::jsonb`;
const digest = value => createHash("sha256").update(value).digest("hex");
const service = "SET ROLE service_role; SET request.jwt.claim.role='service_role'; ";
export async function createRollbackDatabase({ container = "pb-v2-p1-postgres" } = {}) {
  if (!/^pb-v2-[a-z0-9-]+$/.test(container)) throw new Error("Task-owned local PostgreSQL container required");
  const database = `pb_v2_rollback_${Date.now()}_${randomBytes(4).toString("hex")}`;
  const docker = (args, input = "") => new Promise((resolve, reject) => {
    const child = spawn("docker", ["--context", "desktop-linux", ...args], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = ""; const timer = setTimeout(() => child.kill(), 120000);
    child.stdout.on("data", value => { stdout += value; if (stdout.length > 2_000_000) child.kill(); }); child.stderr.on("data", value => { stderr = (stderr + value).slice(-8000); });
    child.on("error", error => { clearTimeout(timer); reject(error); }); child.on("close", code => { clearTimeout(timer); resolve({ code, stdout, stderr }); }); child.stdin.end(input);
  });
  const sql = async (source, allowFailure = false) => { const result = await docker(["exec", "-i", container, "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", database], source); if (result.code && !allowFailure) throw new Error(`Disposable rollback SQL failed: ${result.stderr.match(/PB_[A-Z_]+/)?.[0] ?? "fixture setup"}`); return result; };
  const call = async expression => JSON.parse((await sql(`${service} SELECT ${expression};`)).stdout.trim());
  let created = false, closed;
  const close = () => closed ??= (async () => { if (created) { assert.match(database, /^pb_v2_rollback_\d+_[a-f0-9]{8}$/); const result = await docker(["exec", container, "dropdb", "--force", "-U", "postgres", database]); if (result.code) throw new Error("Owned rollback database cleanup failed"); } })();
  try {
    const result = await docker(["exec", container, "createdb", "-U", "postgres", database]); if (result.code) throw new Error("Local disposable PostgreSQL is unavailable"); created = true;
    await sql(await readFile(new URL("../database/tests/bootstrap.sql", import.meta.url), "utf8"));
    await sql("CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]); ALTER TABLE storage.objects ADD COLUMN user_metadata jsonb;");
    await sql(await readFile(new URL("../supabase-setup.sql", import.meta.url), "utf8"));
    const migrations = (await readdir(new URL("../database/migrations/", import.meta.url))).filter(name => /^\d{3}_.*\.sql$/.test(name)).sort();
    assert.deepEqual(migrations.map(name => Number(name.slice(0, 3))), Array.from({ length: migrations.length }, (_, i) => i + 1));
    for (const name of migrations.slice(1)) await sql(await readFile(new URL(`../database/migrations/${name}`, import.meta.url), "utf8"));
    const owner = randomUUID(), eventId = randomUUID(), guestId = randomUUID(), token = randomBytes(32).toString("base64url"), invitation = randomBytes(32).toString("hex");
    const rows = [0, 1].map(() => ({ id: randomUUID(), requestId: randomUUID(), receipt: randomBytes(32).toString("base64url") }));
    const env = { NODE_ENV: "development", PB_EVENTS_ENABLED: "true", PB_EVENT_TRANSPORT_SECRET: randomBytes(32).toString("hex"), NEXT_PUBLIC_SUPABASE_URL: "https://synthetic-storage.invalid", SUPABASE_SERVICE_ROLE_KEY: "synthetic-service-only" };
    const rpc = async (name, args) => {
      assert.match(name, /^pb_event_[a-z_]+$/);
      const value = item => item === null ? "NULL" : Array.isArray(item) ? `ARRAY[${item.map(q)}]::uuid[]` : typeof item === "number" || typeof item === "boolean" ? String(item) : typeof item === "object" ? json(item) : q(item);
      const response = await sql(`${service} SELECT public.${name}(${Object.entries(args).map(([key, item]) => { assert.match(key, /^p_[a-z_]+$/); return `${key}=>${value(item)}`; }).join(",")});`, true);
      return response.code ? { data: null, error: { message: response.stderr.match(/PB_EVENT_[A-Z_]+/)?.[0] ?? "fixture_error" } } : { data: JSON.parse(response.stdout.trim()), error: null };
    };
    let store = createEventStore(env, { rpc }), readiness = createEventReadinessStore(env, { rpc });
    const bytes = new Map(), objects = createEventObjects({ origin: env.NEXT_PUBLIC_SUPABASE_URL, serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY }, { fetch: async (input, init) => {
      const url = String(input), path = new URL(url).pathname.replace("/storage/v1/object/", "").replace(/^authenticated\//, ""), slash = path.indexOf("/"), bucket = slash < 0 ? path : path.slice(0, slash), name = path.slice(slash + 1);
      const reply = (body, status = 200) => Object.defineProperty(new Response(body, { status }), "url", { value: url });
      if (init.method === "POST") {
        assert.equal(new Headers(init.headers).get("x-upsert"), "false"); const metadata = JSON.parse(Buffer.from(new Headers(init.headers).get("x-metadata"), "base64").toString());
        const inserted = await sql(`${service} INSERT INTO storage.objects(bucket_id,name,metadata,user_metadata) VALUES(${q(bucket)},${q(name)},${json({ size: init.body.byteLength, mimetype: "image/jpeg" })},${json(metadata)});`, true);
        if (inserted.code) return reply("{}", 403); bytes.set(path, new Uint8Array(init.body)); return reply("{}", 201);
      }
      if (init.method === "DELETE") { const paths = JSON.parse(init.body).prefixes; assert.equal(paths.length, 1); await sql(`${service} DELETE FROM storage.objects WHERE bucket_id=${q(bucket)} AND name=${q(paths[0])};`); bytes.delete(`${bucket}/${paths[0]}`); return reply("[]"); }
      assert(["GET", "HEAD"].includes(init.method)); return reply(init.method === "HEAD" ? null : bytes.has(path) ? new Uint8Array(bytes.get(path)) : "missing", bytes.has(path) ? 200 : 404);
    } });
    await sql(`INSERT INTO auth.users(id,email) VALUES(${q(owner)},'rollback@example.invalid');`); await call("public.pb_event_configure(10000000)");
    const body = { title: "Local rollback fixture", timezone: "Australia/Sydney", startsAt: new Date(Date.now() - 60000).toISOString(), closesAt: new Date(Date.now() + 3600000).toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString(), maxGuests: 25, maxContributions: 100, maxBytes: 8200000 };
    await call(`public.pb_event_create(${q(owner)},${q(eventId)},${json(body)})`); await call(`public.pb_event_manage(${q(owner)},${q(eventId)},'open','{}')`);
    await call(`public.pb_event_manage(${q(owner)},${q(eventId)},'invite',${json({ hash: invitation, expiresAt: body.closesAt })})`); await call(`public.pb_event_redeem(${q(eventId)},${q(invitation)},${q(guestId)},${q(digest(token))})`); await readiness.verified();
    const source = await sharp({ create: { width: 80, height: 60, channels: 3, background: "#b76e79" } }).png().toBuffer();
    for (const [index, row] of rows.entries()) {
      await store.reserve({ eventId, tokenHash: digest(token), submissionId: row.id, requestId: row.requestId, receiptHash: digest(row.receipt), contributors: [guestId], consent: { submission: true, gallery: false, wall: false } });
      await store.authoriseUpload(eventId, digest(token), row.id);
      const path = `${eventId}/${row.id}/source`; bytes.set(`photobooth-event-images-staging-v2/${path}`, new Uint8Array(source));
      await sql(`INSERT INTO storage.objects(bucket_id,name,metadata) VALUES('photobooth-event-images-staging-v2',${q(path)},${json({ size: source.length })});`);
      if (index === 0) { await store.enqueueFinalise(eventId, digest(token), row.id); assert.equal((await processEventMaintenance({ store, objects })).job, "ready"); }
    }
    const handler = route => createEventHandler(route, { store: () => store, readiness: () => readiness, authenticate: async () => { throw new Error("No real authentication in rollback fixture"); } }, () => env);
    let receiptHandler = handler("receipt"), guestHandler = handler("guest"), generation = 0, pauseReceipt = null;
    const request = (origin, route, row, body, wrong = false) => new Request(`${origin}/api/events/${eventId}/${route === "receipt" ? `receipts/${row.id}` : "guest"}`, { method: "POST", headers: { origin, "content-type": "application/json", cookie: `pb-event-${route === "receipt" ? "receipt" : "contribute"}=${wrong ? randomBytes(32).toString("base64url") : route === "receipt" ? row.receipt : token}` }, body: JSON.stringify(body) });
    async function check(origin) {
      assert.equal(new URL(origin).hostname, "127.0.0.1");
      const response = await receiptHandler(request(origin, "receipt", rows[0], { operation: "read" }), eventId, rows[0].id); assert.equal(response.status, 200); const receipt = await response.json(); assert.equal(receipt.state, "ready");
      assert.equal((await receiptHandler(request(origin, "receipt", rows[0], { operation: "read" }, true), eventId, rows[0].id)).status, 403);
      if (pauseReceipt) { const denied = await guestHandler(request(origin, "guest", rows[0], { operation: "reserve", expectedGuestId: guestId, requestId: randomUUID(), submissionId: randomUUID(), consent: { submission: true, gallery: false, wall: false } }), eventId); assert.equal(denied.status, 409); assert.equal((await denied.json()).error, "not_ready"); }
      return { generation, pause: pauseReceipt, receipt, wrongTokenDenied: true, newReservationRefused: pauseReceipt ? true : null };
    }
    return {
      database, eventId, submissionId: rows[0].id, close, check,
      async pauseAndRestart(origin) {
        if (!pauseReceipt) pauseReceipt = await call("public.pb_event_admission_control(true,0)");
        store = createEventStore(env, { rpc }); readiness = createEventReadinessStore(env, { rpc }); receiptHandler = handler("receipt"); guestHandler = handler("guest"); generation++;
        assert.equal((await readiness.verified()).ready, false); return check(origin);
      },
      async drainAndCleanup(origin) {
        assert(pauseReceipt, "Pause before cleanup rehearsal");
        const response = await guestHandler(request(origin, "guest", rows[1], { operation: "finalise", expectedGuestId: guestId, submissionId: rows[1].id }), eventId); assert.equal(response.status, 200);
        assert.equal((await processEventMaintenance({ store, objects })).job, "ready"); assert.equal((await store.receipt(eventId, digest(rows[1].receipt), rows[1].id)).state, "ready");
        await call(`public.pb_event_manage(${q(owner)},${q(eventId)},'remove_submission',${json({ submissionId: rows[1].id })})`);
        assert.equal((await processEventMaintenance({ store, objects })).job, "deleted");
        const held = Number((await sql(`SELECT staging_held_bytes FROM public.pb_event_submissions WHERE id=${q(rows[1].id)};`)).stdout.trim()); assert.equal(held, 2000000);
        return { acceptedStagedFinalisedDuringPause: true, derivativeDeletionConfirmed: true, stagingStillCharged: held, existingReceipt: (await check(origin)).receipt };
      },
    };
  } catch (error) { await close(); throw error; }
}
