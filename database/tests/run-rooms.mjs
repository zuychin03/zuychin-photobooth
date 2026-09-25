import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";

const container = process.env.PB_TEST_CONTAINER ?? "pb-v2-p1-postgres";
if (!/^pb-v2-[a-z0-9-]+$/.test(container)) throw new Error("Use an isolated task-owned container");
const database = `pb_v2_rooms_${Date.now()}`;
const docker = (args, input = "") => new Promise((resolve, reject) => {
  const child = spawn("docker", ["--context", "desktop-linux", ...args], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let output = "", error = "";
  child.stdout.on("data", value => { output += value; }); child.stderr.on("data", value => { error += value; });
  child.on("error", reject); child.on("close", code => resolve({ code, output, error })); child.stdin.end(input);
});
const q = value => `'${String(value).replaceAll("'", "''")}'`;
const sql = async (source, failure = false) => {
  const result = await docker(["exec", "-i", container, "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", database], source);
  if (!failure && result.code) throw new Error(result.error);
  return result;
};
const service = "SET ROLE service_role; SET request.jwt.claim.role='service_role';";
const rpc = async (fn, args = [], failure = false) => {
  const result = await sql(`${service} SELECT public.${fn}(${args.map(value => value === null ? "NULL" : q(typeof value === "object" ? JSON.stringify(value) : value)).join(",")});`, failure);
  return failure ? result : JSON.parse(result.output.trim());
};
const hash = () => createHash("sha256").update(randomUUID()).digest("hex");
const call = (room, token, action, body = {}, next = null, failure = false) => rpc("pb_room_call", [room, token, action, body, next], failure);
const deny = async (promise, expected = /PB_ROOM_DENIED|permission denied/) => { const result = await promise; assert.notEqual(result.code, 0); assert.match(result.error, expected); };

assert.equal((await docker(["exec", container, "createdb", "-U", "postgres", database])).code, 0);
console.log(`Isolated PostgreSQL room fixture: ${database}`);
await sql(await readFile(new URL("./bootstrap.sql", import.meta.url), "utf8"));
await sql(await readFile(new URL("../../supabase-setup.sql", import.meta.url), "utf8"));
const migration = await readFile(new URL("../migrations/003_v2_rooms.sql", import.meta.url), "utf8");
await sql(migration); await sql(migration);
assert.equal((await rpc("pb_room_capabilities")).protocol, 2);
await deny(sql("SET ROLE anon; SELECT * FROM public.pb_rooms", true));
await deny(sql("SET ROLE authenticated; SELECT public.pb_room_capabilities()", true));
await deny(sql("SET ROLE service_role; SELECT public.pb_room_snapshot(gen_random_uuid(),gen_random_uuid())", true));
console.log("Migration reruns; direct table and internal-function access are denied.");

const room = randomUUID(), host = randomUUID(), hostHash = hash();
const other = randomUUID(), otherHost = randomUUID(), otherHash = hash();
await rpc("pb_room_create", [room, host, "ABCD23", hostHash, "Host", hash()]);
await rpc("pb_room_create", [other, otherHost, "EFGH45", otherHash, "Other host", hash()]);
await deny(call(other, hostHash, "state", {}, null, true));
const members = Array.from({ length: 8 }, () => ({ id: randomUUID(), pending: hash(), token: hash() }));
for (const member of members) await rpc("pb_room_join", ["ABCD23", member.id, member.pending, "Guest", hash()]);
const admission = await Promise.all(members.map(member => call(room, hostHash, "admit", { memberId: member.id }, null, true)));
assert.equal(admission.filter(result => result.code === 0).length, 3);
for (const result of admission.filter(result => result.code !== 0)) assert.match(result.error, /PB_ROOM_CAPACITY/);
const accepted = members.filter((_member, index) => admission[index].code === 0);
const rejected = members.find((_member, index) => admission[index].code !== 0);
for (const member of accepted) {
  await deny(call(room, member.pending, "poll", { cursor: 0 }, null, true));
  const exchange = await call(room, member.pending, "state", {}, member.token);
  assert.equal(exchange.exchanged, true);
  assert.equal((await call(room, member.pending, "state", {}, member.token)).exchanged, true);
}
await deny(call(room, rejected.pending, "signal", {}, null, true));
await deny(call(room, accepted[0].token, "lock", { locked: true }, null, true));
console.log("Eight concurrent admissions admit three guests; pending, foreign and non-host authority denied.");

const member = accepted[0], state = await call(room, member.token, "state"), epoch = state.connectionEpoch;
const input = { messageId: randomUUID(), toMemberId: host, connectionEpoch: epoch, kind: "sdp", payload: '{"type":"offer","sdp":"fixture"}' };
const sent = await call(room, member.token, "signal", input);
assert.deepEqual(await call(room, member.token, "signal", input), sent);
await deny(call(room, member.token, "signal", { ...input, payload: "different" }, null, true), /PB_ROOM_CONFLICT/);
await deny(call(room, member.token, "signal", { ...input, messageId: randomUUID(), toMemberId: otherHost }, null, true));
assert.equal((await call(other, otherHash, "poll", { cursor: 0 })).signals.length, 0);
assert.equal((await call(room, hostHash, "poll", { cursor: 0 })).signals[0].fromMemberId, member.id);
for (let i = 0; i < 15; i++) await call(room, member.token, "signal", { ...input, messageId: randomUUID(), kind: "ice", payload: "{}" });
await deny(call(room, member.token, "signal", { ...input, messageId: randomUUID() }, null, true), /PB_ROOM_CAPACITY/);
const otherMember = accepted[1], otherState = await call(room, otherMember.token, "state");
await call(room, otherMember.token, "signal", { ...input, messageId: randomUUID(), connectionEpoch: otherState.connectionEpoch });
await call(room, member.token, "state", { renewConnection: true });
await deny(call(room, member.token, "signal", { ...input, messageId: randomUUID() }, null, true), /PB_ROOM_INVALID/);
assert.equal((await call(room, hostHash, "poll", { cursor: 0 })).resetRequired, true);
console.log("Signals bind sender/epoch, deduplicate, isolate rooms, reserve per-member capacity and report reset gaps.");

let hostState = await call(room, hostHash, "state");
const proposal = { captureId: randomUUID(), rosterRevision: hostState.rosterRevision, recipeHash: "a".repeat(64), shotIds: ["one", "two", "three", "four"], fireAt: Date.now() + 28000, intervalMs: 1000, profile: { maxPhotoBytes: 3145728, maxPhotoPixels: 2359296, shotsPerMember: 4 } };
await deny(call(room, hostHash, "prepare", { ...proposal, profile: { ...proposal.profile, maxPhotoBytes: 3145729 } }, null, true), /PB_ROOM_CAPACITY/);
await deny(call(room, hostHash, "prepare", { ...proposal, profile: { ...proposal.profile, maxPhotoPixels: null } }, null, true), /PB_ROOM_INVALID/);
const prepared = await call(room, hostHash, "prepare", proposal);
assert.equal(prepared.memberIds.length, 4);
await deny(call(room, hostHash, "commit", { captureId: proposal.captureId }, null, true), /PB_ROOM_NOT_READY/);
const ack = { captureId: proposal.captureId, recipeHash: proposal.recipeHash, rosterRevision: proposal.rosterRevision };
await call(room, hostHash, "ack", ack);
for (const guest of accepted) await call(room, guest.token, "ack", ack);
const commits = await Promise.all(Array.from({ length: 6 }, () => call(room, hostHash, "commit", { captureId: proposal.captureId })));
assert(commits.every(value => value.state === "committed"));
assert.equal((await sql(`SELECT count(*) FROM public.pb_room_captures WHERE state='committed';`)).output.trim(), "1");
assert.equal((await call(room, member.token, "capture", { captureId: proposal.captureId, peerId: host })).state, "committed");
await deny(call(other, otherHash, "capture", { captureId: proposal.captureId }, null, true));
await deny(call(room, member.token, "commit", { captureId: proposal.captureId }, null, true));
console.log("Capture budget, exact acknowledgements and six concurrent idempotent commits passed.");

await call(room, hostHash, "remove", { memberId: member.id });
await deny(call(room, hostHash, "capture", { captureId: proposal.captureId, peerId: member.id }, null, true));
await deny(call(room, member.token, "state", {}, null, true));
await deny(call(room, member.pending, "state", {}, member.token, true));
await call(other, otherHash, "lock", { locked: true });
await deny(rpc("pb_room_join", ["EFGH45", randomUUID(), hash(), "Blocked", hash()], true));
await call(other, otherHash, "end");
await deny(call(other, otherHash, "state", {}, null, true));
await sql(`UPDATE public.pb_rooms SET expires_at=clock_timestamp()-interval '1 second' WHERE id=${q(room)};`);
await deny(call(room, hostHash, "state", {}, null, true));
await sql(migration);
assert.equal((await sql("SELECT count(*) FROM public.pb_rooms;")).output.trim(), "2");
console.log("Removal, lock, end, exact expiry and populated migration rerun passed. No hosted services used.");
