import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, readdir, realpath, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const LOCAL_RECEIPTS = Object.freeze([
  "readiness.json", "auth-redirect-readiness.json", "storage-access-readiness.json",
  "event-lifecycle-readiness.json", "event-lifecycle-retry-readiness.json", "event-lifecycle-cleanup-readiness.json",
]);
export async function removeLocalRuntimeFiles(path) {
  const marker = await owned(path);
  const entries = await readdir(marker.workdir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "local-supabase-owner.json") continue;
    if (entry.isFile() && LOCAL_RECEIPTS.includes(entry.name)) continue;
    const target = resolve(marker.workdir, entry.name);
    assert.equal(dirname(target), marker.workdir);
    await rm(target, { recursive: true, force: true });
  }
  await rm(join(marker.workdir, "local-supabase-owner.json"));
}
export function localEnvironment(source = process.env) {
  const env = {};
  for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "HOME"]) if (source[key]) env[key] = source[key];
  return { ...env, DOCKER_CONTEXT: "desktop-linux", SUPABASE_TELEMETRY_DISABLED: "1", DO_NOT_TRACK: "1" };
}
export function assertLocalOrigin(value) {
  const url = new URL(value);
  assert.equal(url.origin, value); assert.equal(url.protocol, "http:"); assert.equal(url.hostname, "127.0.0.1"); assert(url.port);
  return value;
}
export function assertLoopbackBindings(containers) {
  for (const container of containers) {
    for (const bindings of Object.values(container.NetworkSettings.Ports ?? {})) {
      for (const binding of bindings ?? []) assert.equal(binding.HostIp, "127.0.0.1", `Non-loopback binding on ${container.Name}`);
    }
  }
}
async function owned(input) {
  const path = await realpath(input), temporary = await realpath(tmpdir());
  assert.equal(dirname(path).toLowerCase(), temporary.toLowerCase());
  assert.match(basename(path), /^pb-local-supabase-[a-f0-9]{10}$/);
  const marker = JSON.parse(await readFile(join(path, "local-supabase-owner.json"), "utf8"));
  assert.deepEqual(marker, { version: 1, kind: "photobooth-local-supabase", projectId: basename(path), workdir: path });
  return marker;
}
const run = (file, args, input = "", timeout = 120_000) => new Promise((resolveRun, reject) => {
  const child = spawn(file, args, { env: localEnvironment(), windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "", timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeout);
  child.stdout.on("data", value => { stdout += value; if (stdout.length > 8_000_000) child.kill(); });
  child.stderr.on("data", value => { stderr += value; if (stderr.length > 8_000_000) child.kill(); });
  child.on("error", error => { clearTimeout(timer); reject(error); });
  child.on("close", code => { clearTimeout(timer); resolveRun({ code, stdout, stderr, timedOut }); });
  child.stdin.end(input);
});
const docker = (...args) => run("docker", ["--context", "desktop-linux", ...args]);
const cli = (marker, ...args) => run(process.execPath, [join(marker.workdir, "node_modules/supabase/dist/supabase.js"), ...args, "--workdir", marker.workdir, "--agent", "no"]);
async function request(origin, path, key, body, method = "POST", bearer = key) {
  assertLocalOrigin(origin);
  const response = await fetch(`${origin}${path}`, { method, redirect: "error", signal: AbortSignal.timeout(15_000), headers: { apikey: key, Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text(); assert(text.length < 1_000_000);
  if (!response.ok) throw new Error(`Local service request ${path.split("?")[0]} failed (${response.status})`);
  return text ? JSON.parse(text) : null;
}
export async function prepareLocalSupabase(input, finishOnly = false) {
  const marker = await owned(input);
  const status = await cli(marker, "status", "--output", "json");
  assert.equal(status.code, 0, "Local Supabase status unavailable");
  const data = JSON.parse(status.stdout);
  const connection = { supabaseUrl: assertLocalOrigin(data.API_URL), anonKey: data.ANON_KEY, serviceRoleKey: data.SERVICE_ROLE_KEY, projectId: marker.projectId, workdir: marker.workdir };
  assert.equal(typeof connection.anonKey, "string"); assert.equal(typeof connection.serviceRoleKey, "string");
  const listed = await docker("ps", "-a", "--filter", `label=com.supabase.cli.project=${marker.projectId}`, "--format", "{{.Names}}");
  const names = listed.stdout.trim().split(/\r?\n/).filter(Boolean); assert(names.length >= 5);
  assert(names.every(name => name.endsWith(`_${marker.projectId}`)));
  const inspected = await docker("inspect", ...names); assert.equal(inspected.code, 0);
  const containers = JSON.parse(inspected.stdout); assertLoopbackBindings(containers);
  assert(containers.every(container => container.State.Running));
  const db = `supabase_db_${marker.projectId}`; assert(names.includes(db));
  const sql = async text => {
    const result = await run("docker", ["--context", "desktop-linux", "exec", "-i", db, "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"], text);
    if (result.code !== 0) throw new Error(`Local migration failed: ${result.stderr.slice(-3000)}`);
    return result.stdout.trim();
  };
  assert.equal(await sql("SELECT to_regclass('auth.identities') IS NOT NULL AND to_regclass('storage.migrations') IS NOT NULL;"), "t", "Genuine Auth and Storage schemas are required");
  const baseline = await readFile(join(root, "supabase-setup.sql"), "utf8");
  const first = await readFile(join(root, "database/migrations/001_v2_lifecycle.sql"), "utf8");
  assert.equal(baseline.split("-- BEGIN PB_LIFECYCLE_V1")[1].split("-- END PB_LIFECYCLE_V1")[0].trim().replaceAll("\r\n", "\n"), first.trim().replaceAll("\r\n", "\n"));
  const migrations = (await readdir(join(root, "database/migrations"))).filter(name => /^\d{3}_.*\.sql$/.test(name)).sort();
  assert.deepEqual(migrations.map(name => Number(name.slice(0, 3))), Array.from({ length: 28 }, (_, i) => i + 1));
  if (!finishOnly) {
    assert.equal(await sql("SELECT to_regclass('public.pb_strips') IS NULL AND to_regclass('public.pb_projects') IS NULL AND to_regclass('public.pb_events') IS NULL;"), "t", "Preparation requires a fresh database; never replay the legacy baseline over V2");
    await sql(baseline); console.log("Applied baseline including001 to genuine Supabase schemas");
    for (const name of migrations.slice(1)) { await sql(await readFile(join(root, "database/migrations", name), "utf8")); console.log(`Applied ${name}`); }
  }
  await sql("NOTIFY pgrst, 'reload schema';");
  const designCapabilities = await request(connection.supabaseUrl, "/rest/v1/rpc/pb_project_design_capabilities", connection.serviceRoleKey, {});
  assert.equal(designCapabilities.exportSettingsVersion, 1, "Migration028 is required before finish-only setup");
  await sql("INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types) VALUES('photobooth-strips','photobooth-strips',false,16777216,ARRAY['image/png','image/jpeg']) ON CONFLICT(id) DO UPDATE SET public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;");
  for (const [name, body] of [["pb_configure_lifecycle", { p_timezone: "Australia/Sydney" }], ["pb_project_configure", { p_bytes: 100000000 }], ["pb_event_configure", { p_bytes: 250000000 }], ["pb_voice_configure", { p_bytes: 20000000 }]]) await request(connection.supabaseUrl, `/rest/v1/rpc/${name}`, connection.serviceRoleKey, body);
  assert.equal(await sql("SELECT count(*) FROM storage.buckets WHERE id LIKE 'photobooth-%' AND (public OR file_size_limit IS NULL OR allowed_mime_types IS NULL);"), "0");
  const users = [], credentialsPath = join(marker.workdir, "synthetic-users.private.json");
  const priorUsers = await readFile(credentialsPath, "utf8").then(JSON.parse).catch(error => { if (error.code === "ENOENT") return []; throw error; });
  const password = priorUsers[0]?.password ?? "LocalOnly-Photobooth-2026!";
  await writeFile(credentialsPath, JSON.stringify([{ label: "Alex", email: "alex@photobooth.invalid", password }, { label: "Bao", email: "bao@photobooth.invalid", password }]), { mode: 0o600 });
  const existing = await request(connection.supabaseUrl, "/auth/v1/admin/users?page=1&per_page=20", connection.serviceRoleKey, undefined, "GET");
  for (const [label, email] of [["Alex", "alex@photobooth.invalid"], ["Bao", "bao@photobooth.invalid"]]) {
    const user = existing.users.find(user => user.email === email) ?? await request(connection.supabaseUrl, "/auth/v1/admin/users", connection.serviceRoleKey, { email, password, email_confirm: true, user_metadata: { name: label } });
    assert.match(user.id, /^[a-f0-9-]{36}$/); users.push({ label, email, password, id: user.id });
    const session = await request(connection.supabaseUrl, "/auth/v1/token?grant_type=password", connection.anonKey, { email, password });
    assert.equal(session.user.id, user.id); assert(session.access_token && session.refresh_token);
    const refreshed = await request(connection.supabaseUrl, "/auth/v1/token?grant_type=refresh_token", connection.anonKey, { refresh_token: session.refresh_token });
    assert.equal(refreshed.user.id, user.id);
    await request(connection.supabaseUrl, "/auth/v1/logout", connection.anonKey, undefined, "POST", refreshed.access_token);
  }
  const buckets = await request(connection.supabaseUrl, "/storage/v1/bucket", connection.serviceRoleKey, undefined, "GET");
  assert(buckets.some(bucket => bucket.id === "photobooth-strips")); assert(buckets.filter(bucket => bucket.id.startsWith("photobooth-")).every(bucket => bucket.public === false));
  await writeFile(join(marker.workdir, "connection.json"), JSON.stringify(connection), { mode: 0o600 });
  await writeFile(join(marker.workdir, "synthetic-users.private.json"), JSON.stringify(users), { mode: 0o600 });
  const receipt = { version: 1, projectId: marker.projectId, api: connection.supabaseUrl, mail: "http://127.0.0.1:55434", migrations: migrations.length, users: users.map(({ label, email, id }) => ({ label, email, id })), buckets: buckets.map(({ id, public: isPublic }) => ({ id, public: isPublic })), containers: containers.map(container => ({ name: container.Name, image: container.Config.Image, ports: container.NetworkSettings.Ports })) };
  await writeFile(join(marker.workdir, "readiness.json"), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ ready: true, workdir: marker.workdir, connectionFile: join(marker.workdir, "connection.json"), readinessFile: join(marker.workdir, "readiness.json"), userCredentialsFile: join(marker.workdir, "synthetic-users.private.json") }));
}
export async function cleanupLocalSupabase(input) {
  const marker = await owned(input), stopped = await cli(marker, "stop", "--no-backup"); assert.equal(stopped.code, 0, "Local stack stop failed");
  const network = await docker("network", "inspect", marker.projectId);
  if (network.code === 0) { const descriptor = JSON.parse(network.stdout)[0]; assert.equal(descriptor.Labels?.["pb.task"], marker.projectId.replace("pb-", "")); assert.equal(Object.keys(descriptor.Containers ?? {}).length, 0); assert.equal((await docker("network", "rm", marker.projectId)).code, 0); }
  await removeLocalRuntimeFiles(marker.workdir);
  console.log("Owned local Supabase services stopped; only sanitised readiness receipts retained");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [action, path] = process.argv.slice(2);
  try { if (action === "prepare" || action === "finish") await prepareLocalSupabase(path, action === "finish"); else if (action === "cleanup") await cleanupLocalSupabase(path); else throw new Error("Usage: local-supabase-prepare.mjs prepare|finish|cleanup OWNED_TEMP_WORKDIR"); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
