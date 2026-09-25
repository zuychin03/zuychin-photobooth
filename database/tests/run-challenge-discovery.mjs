import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

const container = process.env.PB_TEST_CONTAINER ?? "pb-v2-p1-postgres";
if (!/^pb-v2-[a-z0-9-]+$/.test(container)) throw new Error("Use a task-owned pb-v2-* container");
const database = `pb_v2_discovery_${Date.now()}`;
const docker = (args, input = "") => new Promise((resolve, reject) => {
  const child = spawn("docker", ["--context", "desktop-linux", ...args], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = ""; child.stdout.on("data", v => { stdout += v; }); child.stderr.on("data", v => { stderr += v; }); child.on("error", reject); child.on("close", code => resolve({ code, stdout, stderr })); child.stdin.end(input);
});
const sql = async (source, failure = false) => { const result = await docker(["exec", "-i", container, "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", database], source); if (result.code && !failure) throw new Error(result.stderr); return result; };
const q = value => `'${String(value).replaceAll("'", "''")}'`, json = value => `${q(JSON.stringify(value))}::jsonb`;
const service = "SET ROLE service_role; SET request.jwt.claim.role='service_role'; ";
const call = async expression => JSON.parse((await sql(`${service} SELECT ${expression};`)).stdout.trim());
const denied = async (expression, pattern = /PB_CHALLENGE_DENIED/) => { const result = await sql(`${service} SELECT ${expression};`, true); assert.notEqual(result.code, 0); assert.match(result.stderr, pattern); };
const [owner, guest, unrelated, outsider] = Array.from({ length: 4 }, () => randomUUID()), project = randomUUID(), anotherProject = randomUUID();
const design = { canvas: { width: 536, height: 1600 }, requiredSources: { A: 1, B: 1 }, slots: ["A", "B"].map((role, i) => ({ id: `slot-${i}`, role, sourceIndex: 0, x: 0, y: i / 2, width: 1, height: 0.5, crop: { zoom: 1, offsetX: 0, offsetY: 0, rotation: 0, mirror: false } })), layers: [], decorations: [], look: { frameId: "film", filterId: "none", patternId: "none", themeId: null, sceneId: null, materialId: null }, defaults: { caption: "concealed-fixture-caption", showDate: true } };
const listing = (actor = owner, projectId = project, after = null, limit = 20) => `public.pb_challenge_list(${q(actor)},${q(projectId)},${after ? q(after) : "NULL"},${limit})`;
const created = await docker(["exec", container, "createdb", "-U", "postgres", database]); assert.equal(created.code, 0, created.stderr);
try {
  await sql(await readFile(new URL("./bootstrap.sql", import.meta.url), "utf8"));
  await sql("CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);");
  await sql((await readFile(new URL("../../supabase-setup.sql", import.meta.url), "utf8")).split("-- BEGIN PB_LIFECYCLE_V1")[0]);
  for (const name of ["001_v2_lifecycle.sql", "002_v2_projects.sql", "004_v2_memories.sql"]) await sql(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  const before = await call("public.pb_challenge_capabilities()"); assert.equal(before.version, 2); assert.equal(before.discoveryVersion, undefined);
  const migration = await readFile(new URL("../migrations/007_v2_challenge_discovery.sql", import.meta.url), "utf8"); await sql(migration); await sql(migration);
  const capabilities = await call("public.pb_challenge_capabilities()"); assert.equal(capabilities.version, 2); assert.equal(capabilities.recipeVersion, 1); assert.equal(capabilities.discoveryVersion, 1); assert.equal(capabilities.listMaximum, 20);
  await call("public.pb_project_configure(1073741824)");
  await sql(`INSERT INTO auth.users(id,email) VALUES ${[owner, guest, unrelated, outsider].map((user, i) => `(${q(user)},'discovery-${i}@example.invalid')`).join(",")};`);
  for (const p of [project, anotherProject]) {
    await call(`public.pb_project_create(${q(owner)},${q(p)},'friend','Discovery fixture',67108864)`);
    await call(`public.pb_project_member(${q(owner)},${q(p)},${q(guest)},'invite')`);
  }
  await call(`public.pb_project_member(${q(owner)},${q(project)},${q(unrelated)},'invite')`);
  await call(`public.pb_project_member(${q(unrelated)},${q(project)},${q(unrelated)},'accept')`);
  const ids = Array.from({ length: 24 }, () => randomUUID()).sort();
  const create = (id, p = project) => call(`public.pb_challenge_create(${q(owner)},${q(p)},${json({ id, design, policy: "all_submitted", expiresAt: "2030-01-02T00:00:00.000Z", members: [{ userId: owner, role: "A" }, { userId: guest, role: "B" }], assignments: [{ slot: 0, userId: owner, sourceIndex: 0 }, { slot: 1, userId: guest, sourceIndex: 0 }] })})`);
  for (const id of ids) await create(id); const differentId = randomUUID(); await create(differentId, anotherProject);
  const first = await call(listing()); assert.equal(first.challenges.length, 20); assert.equal(first.nextCursor, ids[19]); assert.equal(first.version, 1);
  const second = await call(listing(owner, project, first.nextCursor)); assert.deepEqual([...first.challenges, ...second.challenges].map(c => c.id), ids); assert.equal(second.nextCursor, null);
  assert(!JSON.stringify(first).includes(differentId));
  const allowed = ["id", "projectId", "status", "policy", "membership", "createdAt", "expiresAt", "unsupported"].sort();
  for (const item of first.challenges) assert.deepEqual(Object.keys(item).sort(), allowed);
  assert(!JSON.stringify(first).includes("concealed-fixture-caption")); assert(!JSON.stringify(first).includes(owner)); assert(!JSON.stringify(first).includes(guest));
  const small = []; let after = null;
  do { const page = await call(listing(owner, project, after, 3)); small.push(...page.challenges.map(c => c.id)); after = page.nextCursor; } while (after);
  assert.deepEqual(small, ids); assert.deepEqual((await call(listing(owner, project, ids.at(-1)))).challenges, []);
  for (const limit of [0, 21, "NULL"]) await denied(listing(owner, project, null, limit), /PB_CHALLENGE_INVALID/);
  for (const role of ["anon", "authenticated"]) { const result = await sql(`SET ROLE ${role}; SET request.jwt.claim.role='service_role'; SELECT ${listing()};`, true); assert.notEqual(result.code, 0); assert.match(result.stderr, /permission denied/); }
  const falseService = await sql(`SET ROLE service_role; SET request.jwt.claim.role='authenticated'; SELECT ${listing()};`, true); assert.notEqual(falseService.code, 0);
  assert.deepEqual((await call(listing(unrelated))).challenges, []); await denied(listing(outsider)); await denied(listing(owner, randomUUID()));
  const invited = await call(listing(guest)); assert.equal(invited.challenges.length, 20); assert(invited.challenges.every(c => c.membership === "invited"));
  await sql(`UPDATE public.pb_challenge_members SET status='declined' WHERE challenge_id=${q(ids[0])} AND user_id=${q(guest)}; UPDATE public.pb_challenges SET design=NULL WHERE id=${q(ids[1])}; UPDATE public.pb_challenges SET expires_at='2000-01-01T00:00:00Z' WHERE id=${q(ids[2])};`);
  const invitedAgain = await call(listing(guest)); assert(!invitedAgain.challenges.some(c => c.id === ids[0])); assert.equal(invitedAgain.challenges.find(c => c.id === ids[1]).unsupported, true); assert.equal(invitedAgain.challenges.find(c => c.id === ids[2]).status, "expired");
  await call(`public.pb_project_member(${q(guest)},${q(project)},${q(guest)},'accept')`);
  assert.equal((await call(listing(guest))).challenges[0].membership, "declined");
  await call(`public.pb_project_member(${q(owner)},${q(project)},${q(guest)},'revoke')`); await denied(listing(guest));
  await call(`public.pb_project_delete(${q(owner)},${q(project)})`); await denied(listing());
  console.log("Challenge discovery SQL passed: service-only actor boundary, exact-project participant isolation, invited-only summaries, revocation/deletion, bounded stable pagination, legacy/expiry projections and idempotent migration.");
} finally {
  const dropped = await docker(["exec", container, "dropdb", "-U", "postgres", "--force", database]); assert.equal(dropped.code, 0, dropped.stderr);
}
