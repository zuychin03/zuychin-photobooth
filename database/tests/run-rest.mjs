import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";

const suffix = randomBytes(5).toString("hex");
const network = `pb-v2-rest-${suffix}`;
const database = `${network}-db`;
const api = `${network}-api`;
const jwtSecret = randomBytes(32).toString("hex");
const created = [];
let networkCreated = false;
const docker = (args, input = "") => new Promise((resolve, reject) => {
  const child = spawn("docker", ["--context", "desktop-linux", ...args], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", data => { stdout += data; });
  child.stderr.on("data", data => { stderr += data; });
  child.on("error", reject);
  child.on("close", code => resolve({ code, stdout, stderr }));
  child.stdin.end(input);
});
const command = async (args, input) => {
  const result = await docker(args, input);
  if (result.code) throw new Error(result.stderr.slice(-4000));
  return result.stdout.trim();
};
const sql = source => command(["exec", "-i", database, "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres"], source);
const token = (role, sub) => {
  const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  const input = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ role, ...(sub ? { sub } : {}), exp: Math.floor(Date.now() / 1000) + 600 })}`;
  return `${input}.${createHmac("sha256", jwtSecret).update(input).digest("base64url")}`;
};
const owner = "11111111-1111-4111-8111-111111111111";
const partner = "22222222-2222-4222-8222-222222222222";
const foreign = "44444444-4444-4444-8444-444444444444";
const couple = "33333333-3333-4333-8333-333333333333";

try {
  await command(["network", "create", network]);
  networkCreated = true;
  await command(["run", "--detach", "--name", database, "--network", network, "--memory", "512m", "--cpus", "2", "--env", "POSTGRES_HOST_AUTH_METHOD=trust", "postgres:16-alpine"]);
  created.push(database);
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    if ((await docker(["exec", database, "pg_isready", "-U", "postgres"])).code === 0) { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert(ready, "The isolated PostgreSQL process did not become ready");
  await sql(await readFile(new URL("./bootstrap.sql", import.meta.url), "utf8"));
  const setup = await readFile(new URL("../../supabase-setup.sql", import.meta.url), "utf8");
  const migration = await readFile(new URL("../migrations/001_v2_lifecycle.sql", import.meta.url), "utf8");
  assert.equal(setup.split("-- BEGIN PB_LIFECYCLE_V1")[1]?.split("-- END PB_LIFECYCLE_V1")[0].trim(), migration.trim(), "The setup must embed the exact reviewed lifecycle migration");
  await sql(setup);
  await sql(migration);
  await sql(`
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
 SELECT coalesce(nullif(current_setting('request.jwt.claim.sub',true),''),nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid $$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$
 SELECT coalesce(nullif(current_setting('request.jwt.claim.role',true),''),nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'role') $$;
CREATE ROLE pb_rest_auth LOGIN NOINHERIT;
GRANT anon,authenticated,service_role TO pb_rest_auth;
INSERT INTO auth.users(id,email) VALUES('${owner}','a@example.invalid'),('${partner}','b@example.invalid'),('${foreign}','outsider@example.invalid');
INSERT INTO public.pb_couples(id,member_a,member_b) VALUES('${couple}','${owner}','${partner}');
SELECT set_config('request.jwt.claim.role','service_role',false);
SELECT public.pb_configure_lifecycle('Australia/Sydney');
`);
  const port = await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  });
  await command(["run", "--detach", "--name", api, "--network", network, "--memory", "256m", "--cpus", "1", "--publish", `127.0.0.1:${port}:3000`, "--env", `PGRST_DB_URI=postgres://pb_rest_auth@${database}:5432/postgres`, "--env", "PGRST_DB_ANON_ROLE=anon", "--env", `PGRST_JWT_SECRET=${jwtSecret}`, "postgrest/postgrest:v14.16"]);
  created.push(api);
  const binding = JSON.parse(await command(["inspect", "--format", "{{json .HostConfig.PortBindings}}", api]));
  assert.deepEqual(binding["3000/tcp"], [{ HostIp: "127.0.0.1", HostPort: String(port) }]);
  const origin = `http://127.0.0.1:${port}`;
  const request = async (path, role, sub, body, method = body === undefined ? "GET" : "POST") => {
    const response = await fetch(origin + path, { method, headers: { ...(role ? { authorization: `Bearer ${token(role, sub)}` } : {}), "content-type": "application/json", prefer: "return=representation" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000) });
    const text = await response.text();
    return { status: response.status, data: text ? JSON.parse(text) : null };
  };
  let online = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const result = await request("/rpc/pb_lifecycle_capabilities", "authenticated", owner, {});
      if (result.status === 200) { online = true; break; }
    } catch { /* The container may still be establishing its first DB connection. */ }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert(online, "The isolated PostgREST API did not become ready");
  console.log("PostgREST 14.16 is serving the isolated PostgreSQL 16 fixture on loopback.");
  const ids = Array.from({ length: 24 }, () => randomUUID());
  await sql(ids.map((id, index) => `INSERT INTO storage.objects(bucket_id,name,metadata) VALUES('photobooth-strips','${index % 2 ? partner : owner}/${id}.png','{"size":1024}');`).join("\n"));
  const replies = await Promise.all(ids.map((id, index) => request("/pb_strips", "authenticated", index % 2 ? partner : owner, { id, owner: index % 2 ? partner : owner, couple_id: couple, storage_path: `${index % 2 ? partner : owner}/${id}.png`, layout_id: "strip4", created_at: "1999-01-01T00:00:00Z" })));
  assert.equal(replies.filter(reply => reply.status === 201).length, 10);
  for (const reply of replies.filter(reply => reply.status !== 201)) assert.match(reply.data.message, /PB_WEEKLY_QUOTA_EXCEEDED/);
  const rows = (await request("/pb_strips?select=id,owner,caption,cloudinary_public_id,created_at", "authenticated", owner)).data;
  assert.equal(rows.length, 10);
  assert(rows.every(row => row.created_at.startsWith(String(new Date().getUTCFullYear()))));
  const target = rows.find(row => row.owner === owner) ?? rows[0];
  assert.deepEqual((await request("/pb_strips?select=id", "authenticated", foreign)).data, []);
  assert([401, 403].includes((await request("/pb_media_jobs?select=id", "authenticated", owner)).status));
  assert([401, 403].includes((await request("/rpc/pb_claim_media_jobs", "authenticated", owner, { p_worker_id: randomUUID() })).status));
  assert([401, 403].includes((await request("/rpc/pb_enqueue_strip_operation", "authenticated", foreign, { p_strip_id: target.id, p_operation: "delete", p_request_id: randomUUID() })).status));
  const forged = await request(`/pb_strips?id=eq.${target.id}`, "authenticated", target.owner, { created_at: "1999-01-01", purged: true }, "PATCH");
  assert.equal(forged.status, 403);
  const forgedArchive = await request(`/pb_strips?id=eq.${target.id}`, "authenticated", target.owner, { cloudinary_public_id: "another-private-asset", cloudinary_url: "https://example.invalid/private", archive_verified_at: new Date().toISOString() }, "PATCH");
  assert.equal(forgedArchive.status, 403);
  assert.equal((await request(`/pb_strips?id=eq.${target.id}&select=cloudinary_public_id`, "authenticated", target.owner)).data[0].cloudinary_public_id, null);
  const enqueued = await request("/rpc/pb_enqueue_strip_operation", "authenticated", target.owner, { p_strip_id: target.id, p_operation: "archive", p_request_id: randomUUID() });
  assert.equal(enqueued.status, 200);
  const job = Array.isArray(enqueued.data) ? enqueued.data[0] : enqueued.data;
  assert.equal(job.source_id, target.id);
  const claims = await Promise.all(Array.from({ length: 8 }, () => request("/rpc/pb_claim_media_jobs", "service_role", null, { p_worker_id: randomUUID(), p_limit: 1, p_lease_seconds: 120, p_job_id: job.id })));
  assert(claims.every(reply => reply.status === 200));
  assert.equal(claims.reduce((sum, reply) => sum + reply.data.length, 0), 1);
  const falseLease = await request("/rpc/pb_checkpoint_media_job", "service_role", null, { p_job_id: job.id, p_lease_token: randomUUID(), p_stage: "pending", p_checkpoint: {} });
  assert(falseLease.status >= 400);
  console.log("REST evidence: exact consolidated setup and migration rerun passed; 24 legacy writes admitted exactly 10; foreign reads and privileged calls denied; timestamp and forged archive-reference PATCH denied; 8 claimers obtained one lease; false lease rejected; Gallery field projection preserved.");
  console.log("Storage metadata is a fixture. Hosted Storage, signing/CDN, providers and production configuration remain unverified.");
} catch (error) {
  if (created.includes(api)) {
    const logs = await docker(["logs", "--tail", "20", api]);
    console.error(logs.stderr.slice(-3000));
  }
  throw error;
} finally {
  for (const name of created.reverse()) await command(["rm", "--force", "--volumes", name]);
  if (networkCreated) await command(["network", "rm", network]);
}
